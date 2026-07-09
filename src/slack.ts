import { homedir } from "node:os";
import { resolve } from "node:path";
import { App, LogLevel } from "@slack/bolt";
import type { ProjectConfig, RossbotConfig, RunnerAttachment, SlackEnv, WorkflowRecord } from "./types.js";
import { normalizeSlackText, parseCommand } from "./commands.js";
import { errorContext, logDebug, logError, logInfo, logWarn } from "./logger.js";
import { appendObsidianPlanLinks } from "./obsidian-links.js";
import { enqueue, PiHostRunner } from "./pi-host-runner.js";
import {
  allowedAttachmentExtensionsDescription,
  downloadSlackAttachments,
  type SlackFileAttachment,
} from "./slack-attachments.js";
import { workflowKey } from "./workflow-store.js";

const maxSlackMessageLength = 3900;

type SlackEvent = {
  type: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
  files?: SlackFileAttachment[];
};

type SlackStatusReaction = "eyes" | "white_check_mark" | "x";
type SlackReaction = SlackStatusReaction | "hourglass_flowing_sand";

type SlackStatusClient = {
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
};

type SlackLogger = {
  debug?(message: string): void;
  warn(message: string): void;
};

const statusReactions: SlackStatusReaction[] = ["eyes", "white_check_mark", "x"];

const personalAgentPrompt = `## Rossbot DM Personal Intake Agent

You are Ross's private Slack DM intake agent for unscoped personal notes.

Primary capability whitelist for this version:
- Update notes inside ~/notes/my-brain only.
- Capture, organize, summarize, and append personal notes, inbox items, ideas, and lightweight task lists as Markdown notes.
- Ask clarifying questions when the destination note, wording, or intent is ambiguous.

Current exclusions:
- Do not create calendar events, reminders, external todo items, GitHub issues, commits, pull requests, emails, Slack messages to other people, infrastructure changes, purchases, or destructive changes.
- If Ross asks for an excluded capability, offer to capture the request as a note in my-brain instead.

Behavior policy:
- Be optimistic for low-risk note updates: if Ross clearly asks you to capture or update a note in my-brain, do it without asking for confirmation, then briefly report the file path and what changed.
- Ask before high-risk or ambiguous actions: deleting/replacing large content, moving/renaming files, changing project files outside my-brain, public/external actions, or anything with unclear intent.
- Keep Slack replies concise and practical.
- Prefer an inbox-style capture location when no better destination is obvious.
- Preserve Ross's wording when capturing vents or raw thoughts; lightly structure only when it helps retrieval.
`;

export async function startSlackApp(input: {
  config: RossbotConfig;
  env: SlackEnv;
  runner: PiHostRunner;
}): Promise<void> {
  logInfo("Starting Slack app", { projectCount: input.config.projects.length });
  const app = new App({
    token: input.env.botToken,
    appToken: input.env.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  for (const slashCommand of ["/plan", "/implement", "/pull-request"] as const) {
    app.command(slashCommand, async ({ command, ack, client, logger, respond }) => {
      await ack();

      logInfo("Received Slack slash command", {
        command: command.command,
        channelId: command.channel_id,
        userId: command.user_id,
        textLength: command.text?.length ?? 0,
      });

      if (command.user_id !== input.env.allowedUserId) {
        logger.warn(
          `Ignoring unauthorized Slack slash command from user ${command.user_id} in channel ${command.channel_id}`,
        );
        logWarn("Ignoring unauthorized Slack slash command", { userId: command.user_id, channelId: command.channel_id });
        await respond({ response_type: "ephemeral", text: "You are not authorized to use rossbot." });
        return;
      }

      const channelId = command.channel_id;
      const project = findProject(input.config, channelId);
      if (!project) {
        logWarn("Ignoring slash command for unregistered channel", { channelId });
        await respond({ response_type: "ephemeral", text: "This channel is not registered with rossbot." });
        return;
      }

      const parsedCommand = parseSlashCommand(command.command, command.text ?? "");
      logInfo("Creating parent Slack message for slash command", {
        channelId,
        projectId: project.id,
        commandType: parsedCommand.type,
      });
      const parent = await postTopLevelMessage(client, channelId, formatSlashCommandParentMessage(parsedCommand));
      const threadTs = parent.ts;
      await setStatusReaction(client, logger, { channel: channelId, timestamp: threadTs, to: "eyes" });
      const workflow = await input.runner.getOrCreateWorkflow({ project, channelId, threadTs });

      await enqueue(workflow, async () => {
        try {
          await handleParsedCommand({
            command: parsedCommand,
            runner: input.runner,
            workflow,
            client,
            channelId,
            threadTs,
          });
          await setStatusReaction(client, logger, { channel: channelId, timestamp: threadTs, to: "white_check_mark" });
        } catch (error) {
          await setStatusReaction(client, logger, { channel: channelId, timestamp: threadTs, to: "x" });
          logger.error(error);
          logError("Slash command workflow failed", { channelId, threadTs, projectId: project.id, ...errorContext(error) });
          await postThreadReply(client, channelId, threadTs, formatError(error));
        }
      });
    });
  }

  app.message(async ({ message, client, logger }) => {
    const slackEvent = message as SlackEvent;
    logDebug("Received Slack message event", {
      channelId: slackEvent.channel,
      userId: slackEvent.user,
      ts: slackEvent.ts,
      threadTs: slackEvent.thread_ts,
      channelType: slackEvent.channel_type,
      hasText: Boolean(slackEvent.text),
      fileCount: slackEvent.files?.length ?? 0,
      hasBotId: Boolean(slackEvent.bot_id),
    });
    if (!isAuthorized(slackEvent, input.env, logger)) return;
    if (!slackEvent.channel || !slackEvent.ts) {
      logDebug("Ignoring Slack message missing channel or timestamp");
      return;
    }
    if (!slackEvent.text && !slackEvent.files?.length) {
      logDebug("Ignoring Slack message with no text or files", { channelId: slackEvent.channel, ts: slackEvent.ts });
      return;
    }

    const channelId = slackEvent.channel;
    const messageTs = slackEvent.ts;
    const isDm = isDirectMessage(slackEvent);
    const project = isDm ? personalAgentProject(channelId) : findProject(input.config, channelId);
    if (!project) {
      logDebug("Ignoring Slack message for unregistered channel", { channelId });
      return;
    }

    const isTopLevel = !slackEvent.thread_ts;
    const replyThreadTs = isDm ? undefined : (slackEvent.thread_ts ?? messageTs);
    const workflowThreadTs = isDm ? "dm" : (slackEvent.thread_ts ?? messageTs);
    const workflow = isDm
      ? await input.runner.getOrCreateWorkflow({ project, channelId, threadTs: workflowThreadTs })
      : slackEvent.thread_ts
        ? await input.runner.getExistingWorkflow({
            project,
            channelId,
            threadTs: workflowThreadTs,
          })
        : await input.runner.getOrCreateWorkflow({ project, channelId, threadTs: workflowThreadTs });

    if (!workflow || workflow.record.key !== workflowKey(channelId, workflowThreadTs)) {
      logDebug("Ignoring Slack reply without existing workflow", { channelId, threadTs: workflowThreadTs, projectId: project.id });
      return;
    }
    if (workflow.record.status === "closed") {
      const command = isDm
        ? parsePersonalAgentCommand(slackEvent.text ?? "", input.env.botUserId)
        : parseCommand(slackEvent.text ?? "", input.env.botUserId);
      if (command.type !== "followUp") {
        await postThreadReply(
          client,
          channelId,
          replyThreadTs,
          "This workflow is closed. Use `/reset` to start a fresh session in this thread.",
        );
      }
      return;
    }

    const command = isDm
      ? parsePersonalAgentCommand(slackEvent.text ?? "", input.env.botUserId)
      : parseCommand(slackEvent.text ?? "", input.env.botUserId);
    logInfo("Routing Slack message to workflow", {
      channelId,
      messageTs,
      workflowThreadTs,
      projectId: project.id,
      isDm,
      isTopLevel,
      commandType: command.type,
      workflowStatus: workflow.record.status,
      fileCount: slackEvent.files?.length ?? 0,
    });
    const attachmentResult = slackEvent.files?.length
      ? await downloadSlackAttachments({
          botToken: input.env.botToken,
          cwd: project.cwd,
          channelId,
          messageTs,
          files: slackEvent.files,
        })
      : { accepted: [], ignored: [] };

    if (attachmentResult.accepted.length || attachmentResult.ignored.length) {
      logInfo("Slack attachments processed", {
        channelId,
        messageTs,
        projectId: project.id,
        acceptedCount: attachmentResult.accepted.length,
        ignoredCount: attachmentResult.ignored.length,
        ignored: attachmentResult.ignored,
      });
    }

    if (attachmentResult.ignored.length) {
      await postThreadReply(
        client,
        channelId,
        replyThreadTs,
        `Ignored unsupported Slack attachment(s): ${attachmentResult.ignored.join(", ")}. Allowed extensions: ${allowedAttachmentExtensionsDescription}`,
      );
    }

    if (command.type === "followUp" && command.text.trim() === "" && attachmentResult.accepted.length === 0) return;
    const commandWithAttachments = withAttachments(command, attachmentResult.accepted);

    if (isTopLevel) {
      await setStatusReaction(client, logger, { channel: channelId, timestamp: messageTs, to: "eyes" });
    }

    await enqueue(workflow, async () => {
      try {
        if (!isTopLevel) {
          await addReaction(client, logger, { channel: channelId, timestamp: messageTs, name: "hourglass_flowing_sand" });
        }
        await handleParsedCommand({
          command: commandWithAttachments,
          runner: input.runner,
          workflow,
          client,
          channelId,
          threadTs: replyThreadTs,
        });
        if (isTopLevel) {
          await setStatusReaction(client, logger, { channel: channelId, timestamp: messageTs, to: "white_check_mark" });
        }
      } catch (error) {
        if (isTopLevel) {
          await setStatusReaction(client, logger, { channel: channelId, timestamp: messageTs, to: "x" });
        }
        logger.error(error);
        logError("Slack message workflow failed", { channelId, threadTs: replyThreadTs, projectId: project.id, ...errorContext(error) });
        await postThreadReply(client, channelId, replyThreadTs, formatError(error));
      } finally {
        if (!isTopLevel) {
          await removeReaction(client, logger, { channel: channelId, timestamp: messageTs, name: "hourglass_flowing_sand" });
        }
      }
    });
  });

  await app.start();
  logInfo("Rossbot Slack Socket Mode app started");
}

async function setStatusReaction(
  client: SlackStatusClient,
  logger: SlackLogger,
  input: { channel: string; timestamp: string; to: SlackStatusReaction },
): Promise<void> {
  for (const reaction of statusReactions.filter((reaction) => reaction !== input.to)) {
    await removeReaction(client, logger, { ...input, name: reaction });
  }
  await addReaction(client, logger, { ...input, name: input.to });
}

async function removeReaction(
  client: SlackStatusClient,
  logger: SlackLogger,
  input: { channel: string; timestamp: string; name: SlackReaction },
): Promise<void> {
  try {
    await client.reactions.remove({ channel: input.channel, timestamp: input.timestamp, name: input.name });
  } catch (error) {
    const code = slackErrorCode(error);
    if (code === "no_reaction" || code === "not_reacted") {
      logger.debug?.(`Slack status reaction ${input.name} was not present on ${input.channel}/${input.timestamp}`);
      logDebug("Slack reaction not present", { channelId: input.channel, timestamp: input.timestamp, reaction: input.name });
      return;
    }
    logger.warn(
      `Unable to remove Slack status reaction ${input.name} from ${input.channel}/${input.timestamp}: ${formatSlackError(error)}`,
    );
    logWarn("Unable to remove Slack reaction", {
      channelId: input.channel,
      timestamp: input.timestamp,
      reaction: input.name,
      slackError: formatSlackError(error),
    });
  }
}

async function addReaction(
  client: SlackStatusClient,
  logger: SlackLogger,
  input: { channel: string; timestamp: string; name: SlackReaction },
): Promise<void> {
  try {
    await client.reactions.add({ channel: input.channel, timestamp: input.timestamp, name: input.name });
  } catch (error) {
    const code = slackErrorCode(error);
    if (code === "already_reacted") {
      logger.debug?.(`Slack status reaction ${input.name} already present on ${input.channel}/${input.timestamp}`);
      logDebug("Slack reaction already present", { channelId: input.channel, timestamp: input.timestamp, reaction: input.name });
      return;
    }
    logger.warn(
      `Unable to add Slack status reaction ${input.name} to ${input.channel}/${input.timestamp}: ${formatSlackError(error)}`,
    );
    logWarn("Unable to add Slack reaction", {
      channelId: input.channel,
      timestamp: input.timestamp,
      reaction: input.name,
      slackError: formatSlackError(error),
    });
  }
}

function slackErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { error?: unknown } }).data;
    return typeof data?.error === "string" ? data.error : undefined;
  }
  return undefined;
}

function formatSlackError(error: unknown): string {
  const code = slackErrorCode(error);
  if (code) return code;
  return error instanceof Error ? error.message : String(error);
}

function isAuthorized(
  event: SlackEvent,
  env: SlackEnv,
  logger: { warn(message: string): void },
): boolean {
  if (event.bot_id || event.user === undefined) return false;
  if (event.user === env.allowedUserId) return true;

  logger.warn(
    `Ignoring unauthorized Slack message from user ${event.user} in channel ${event.channel ?? "unknown"} at ${event.ts ?? "unknown"}`,
  );
  logWarn("Ignoring unauthorized Slack message", {
    userId: event.user,
    channelId: event.channel ?? "unknown",
    ts: event.ts ?? "unknown",
  });
  return false;
}

function findProject(config: RossbotConfig, channelId: string): ProjectConfig | undefined {
  return config.projects.find((project) => project.channelId === channelId);
}

function isDirectMessage(event: SlackEvent): boolean {
  return event.channel_type === "im" || event.channel?.startsWith("D") === true;
}

function personalAgentProject(channelId: string): ProjectConfig {
  return {
    id: "personal-intake",
    name: "Personal Intake",
    cwd: resolve(homedir(), "notes", "my-brain"),
    channelId,
    appendSystemPrompt: personalAgentPrompt,
  };
}

function parsePersonalAgentCommand(text: string, botUserId: string): ReturnType<typeof parseCommand> {
  const command = parseCommand(text, botUserId);
  if (command.type === "status" || command.type === "close" || command.type === "reset") return command;
  return { type: "followUp", text: normalizeSlackText(text, botUserId) };
}

type ParsedCommandWithAttachments = ReturnType<typeof parseCommand> & { attachments?: RunnerAttachment[] };

function withAttachments(command: ReturnType<typeof parseCommand>, attachments: RunnerAttachment[]): ParsedCommandWithAttachments {
  if (attachments.length === 0) return command;
  return { ...command, attachments };
}

function parseSlashCommand(command: string, text: string): Extract<ReturnType<typeof parseCommand>, { type: "plan" | "implement" | "pr" }> {
  switch (command) {
    case "/plan":
      return { type: "plan", args: text.trim() };
    case "/implement":
      return { type: "implement", args: text.trim() };
    case "/pull-request":
      return { type: "pr", args: text.trim() };
    default:
      throw new Error(`Unsupported slash command: ${command}`);
  }
}

function formatSlashCommandParentMessage(command: ReturnType<typeof parseSlashCommand>): string {
  const target = command.args ? ` for ${command.args}` : "";
  switch (command.type) {
    case "plan":
      return `Creating concrete plan${target}`;
    case "implement":
      return `Implementing ${command.args ?? "next plan"}`;
    case "pr":
      return `Preparing pull request${target}`;
  }
}

async function postTopLevelMessage(
  client: { chat: { postMessage(args: { channel: string; text: string }): Promise<unknown> } },
  channelId: string,
  text: string,
): Promise<{ ts: string }> {
  const response = await client.chat.postMessage({ channel: channelId, text });
  if (!response || typeof response !== "object" || !("ts" in response) || typeof response.ts !== "string") {
    throw new Error("Slack chat.postMessage did not return a message timestamp.");
  }
  return { ts: response.ts };
}

async function handleParsedCommand(input: {
  command: ParsedCommandWithAttachments;
  runner: PiHostRunner;
  workflow: Awaited<ReturnType<PiHostRunner["getOrCreateWorkflow"]>>;
  client: { chat: { postMessage(args: { channel: string; thread_ts?: string; text: string }): Promise<unknown> } };
  channelId: string;
  threadTs?: string;
}): Promise<void> {
  switch (input.command.type) {
    case "status":
      await postThreadReply(input.client, input.channelId, input.threadTs, formatStatus(input.workflow.record));
      return;
    case "close":
      await input.runner.close({ workflow: input.workflow });
      await postThreadReply(input.client, input.channelId, input.threadTs, "Workflow closed.");
      return;
    case "reset":
      await input.runner.reset({ workflow: input.workflow });
      await postThreadReply(input.client, input.channelId, input.threadTs, "Workflow reset with a fresh pi session.");
      return;
    case "plan": {
      const response = await input.runner.send({ workflow: input.workflow, command: input.command });
      await postThreadReply(input.client, input.channelId, input.threadTs, appendObsidianPlanLinks(response.text));
      return;
    }
    case "implement":
    case "pr":
    case "followUp": {
      const response = await input.runner.send({ workflow: input.workflow, command: input.command });
      await postThreadReply(input.client, input.channelId, input.threadTs, response.text);
      return;
    }
  }
}

async function postThreadReply(
  client: { chat: { postMessage(args: { channel: string; thread_ts?: string; text: string }): Promise<unknown> } },
  channelId: string,
  threadTs: string | undefined,
  text: string,
): Promise<void> {
  const slackText = formatMarkdownForSlack(text || "Done.");
  const chunks = chunkText(slackText, maxSlackMessageLength);
  for (const chunk of chunks) {
    await client.chat.postMessage({ channel: channelId, ...(threadTs ? { thread_ts: threadTs } : {}), text: chunk });
  }
}

function formatMarkdownForSlack(text: string): string {
  return mapOutsideCode(text, (segment) =>
    segment
      // Slack mrkdwn uses single asterisks for bold; CommonMark/GitHub Markdown uses double.
      .replace(/\*\*([^\n]+?)\*\*/g, "*$1*")
      .replace(/__([^\n]+?)__/g, "*$1*"),
  );
}

function mapOutsideCode(text: string, transform: (segment: string) => string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((fencedSegment) => {
      if (fencedSegment.startsWith("```") && fencedSegment.endsWith("```")) return fencedSegment;
      return fencedSegment
        .split(/(`[^`\n]*`)/g)
        .map((inlineSegment) =>
          inlineSegment.startsWith("`") && inlineSegment.endsWith("`") ? inlineSegment : transform(inlineSegment),
        )
        .join("");
    })
    .join("");
}

function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += maxLength) {
    chunks.push(text.slice(start, start + maxLength));
  }
  return chunks;
}

function formatStatus(record: WorkflowRecord): string {
  return [
    `project: ${record.projectId}`,
    `status: ${record.status}`,
    `cwd: ${record.cwd}`,
    `sessionId: ${record.sessionId}`,
    `createdAt: ${record.createdAt}`,
    `updatedAt: ${record.updatedAt}`,
    record.lastError ? `lastError: ${record.lastError}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Rossbot error: ${message}`;
}
