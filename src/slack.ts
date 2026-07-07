import { App, LogLevel } from "@slack/bolt";
import type { ProjectConfig, RossbotConfig, SlackEnv, WorkflowRecord } from "./types.js";
import { parseCommand } from "./commands.js";
import { appendObsidianPlanLinks } from "./obsidian-links.js";
import { enqueue, PiHostRunner } from "./pi-host-runner.js";
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

export async function startSlackApp(input: {
  config: RossbotConfig;
  env: SlackEnv;
  runner: PiHostRunner;
}): Promise<void> {
  const app = new App({
    token: input.env.botToken,
    appToken: input.env.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  for (const slashCommand of ["/plan", "/implement", "/pr"] as const) {
    app.command(slashCommand, async ({ command, ack, client, logger, respond }) => {
      await ack();

      if (command.user_id !== input.env.allowedUserId) {
        logger.warn(
          `Ignoring unauthorized Slack slash command from user ${command.user_id} in channel ${command.channel_id}`,
        );
        await respond({ response_type: "ephemeral", text: "You are not authorized to use rossbot." });
        return;
      }

      const channelId = command.channel_id;
      const project = findProject(input.config, channelId);
      if (!project) {
        await respond({ response_type: "ephemeral", text: "This channel is not registered with rossbot." });
        return;
      }

      const parsedCommand = parseSlashCommand(command.command, command.text ?? "");
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
          await postThreadReply(client, channelId, threadTs, formatError(error));
        }
      });
    });
  }

  app.message(async ({ message, client, logger }) => {
    const slackEvent = message as SlackEvent;
    if (!isAuthorized(slackEvent, input.env, logger)) return;
    if (!slackEvent.channel || !slackEvent.text || !slackEvent.ts) return;

    const channelId = slackEvent.channel;
    const messageTs = slackEvent.ts;
    const project = findProject(input.config, channelId);
    if (!project) return;

    const isTopLevel = !slackEvent.thread_ts;
    const threadTs = slackEvent.thread_ts ?? messageTs;
    const workflow = slackEvent.thread_ts
      ? await input.runner.getExistingWorkflow({
          project,
          channelId,
          threadTs,
        })
      : await input.runner.getOrCreateWorkflow({ project, channelId, threadTs });

    if (!workflow || workflow.record.key !== workflowKey(channelId, threadTs)) return;
    if (workflow.record.status === "closed") {
      const command = parseCommand(slackEvent.text, input.env.botUserId);
      if (command.type !== "followUp") {
        await postThreadReply(
          client,
          channelId,
          threadTs,
          "This workflow is closed. Use `/reset` to start a fresh session in this thread.",
        );
      }
      return;
    }

    const command = parseCommand(slackEvent.text, input.env.botUserId);
    if (command.type === "followUp" && command.text.trim() === "") return;

    if (isTopLevel) {
      await setStatusReaction(client, logger, { channel: channelId, timestamp: messageTs, to: "eyes" });
    }

    await enqueue(workflow, async () => {
      try {
        if (!isTopLevel) {
          await addReaction(client, logger, { channel: channelId, timestamp: messageTs, name: "hourglass_flowing_sand" });
        }
        await handleParsedCommand({
          command,
          runner: input.runner,
          workflow,
          client,
          channelId,
          threadTs,
        });
        if (isTopLevel) {
          await setStatusReaction(client, logger, { channel: channelId, timestamp: messageTs, to: "white_check_mark" });
        }
      } catch (error) {
        if (isTopLevel) {
          await setStatusReaction(client, logger, { channel: channelId, timestamp: messageTs, to: "x" });
        }
        logger.error(error);
        await postThreadReply(client, channelId, threadTs, formatError(error));
      } finally {
        if (!isTopLevel) {
          await removeReaction(client, logger, { channel: channelId, timestamp: messageTs, name: "hourglass_flowing_sand" });
        }
      }
    });
  });

  await app.start();
  console.log("rossbot Slack Socket Mode app started");
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
      return;
    }
    logger.warn(
      `Unable to remove Slack status reaction ${input.name} from ${input.channel}/${input.timestamp}: ${formatSlackError(error)}`,
    );
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
      return;
    }
    logger.warn(
      `Unable to add Slack status reaction ${input.name} to ${input.channel}/${input.timestamp}: ${formatSlackError(error)}`,
    );
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
  return false;
}

function findProject(config: RossbotConfig, channelId: string): ProjectConfig | undefined {
  return config.projects.find((project) => project.channelId === channelId);
}

function parseSlashCommand(command: string, text: string): Extract<ReturnType<typeof parseCommand>, { type: "plan" | "implement" | "pr" }> {
  switch (command) {
    case "/plan":
      return { type: "plan", args: text.trim() };
    case "/implement":
      return { type: "implement", args: text.trim() };
    case "/pr":
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
  command: ReturnType<typeof parseCommand>;
  runner: PiHostRunner;
  workflow: Awaited<ReturnType<PiHostRunner["getOrCreateWorkflow"]>>;
  client: { chat: { postMessage(args: { channel: string; thread_ts: string; text: string }): Promise<unknown> } };
  channelId: string;
  threadTs: string;
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
  client: { chat: { postMessage(args: { channel: string; thread_ts: string; text: string }): Promise<unknown> } },
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  const chunks = chunkText(text || "Done.", maxSlackMessageLength);
  for (const chunk of chunks) {
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: chunk });
  }
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
