import { App, LogLevel } from "@slack/bolt";
import type { ProjectConfig, RossbotConfig, SlackEnv, WorkflowRecord } from "./types.js";
import { parseCommand } from "./commands.js";
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

  app.event("app_mention", async ({ event, client, logger }) => {
    const slackEvent = event as SlackEvent;
    if (shouldIgnore(slackEvent)) return;

    const channelId = slackEvent.channel;
    const threadTs = slackEvent.thread_ts ?? slackEvent.ts;
    if (!channelId || !threadTs || !slackEvent.text) return;

    const project = findProject(input.config, channelId);
    if (!project) {
      logger.info(`No project registered for channel ${channelId}`);
      return;
    }

    const command = parseCommand(slackEvent.text, input.env.botUserId);
    if (command.type === "followUp" && command.text.trim() === "") return;

    const workflow = await input.runner.getOrCreateWorkflow({ project, channelId, threadTs });
    await enqueue(workflow, async () => {
      await handleParsedCommand({ command, runner: input.runner, workflow, client, channelId, threadTs });
    });
  });

  app.message(async ({ message, client, logger }) => {
    const slackEvent = message as SlackEvent;
    if (shouldIgnore(slackEvent)) return;
    if (!slackEvent.thread_ts || !slackEvent.channel || !slackEvent.text) return;

    const project = findProject(input.config, slackEvent.channel);
    if (!project) return;

    const workflow = await input.runner.getExistingWorkflow({
      project,
      channelId: slackEvent.channel,
      threadTs: slackEvent.thread_ts,
    });

    if (!workflow || workflow.record.key !== workflowKey(slackEvent.channel, slackEvent.thread_ts)) return;
    if (workflow.record.status === "closed") {
      const command = parseCommand(slackEvent.text, input.env.botUserId);
      if (command.type !== "followUp") {
        await postThreadReply(client, slackEvent.channel, slackEvent.thread_ts, "This workflow is closed. Use `/reset` to start a fresh session in this thread.");
      }
      return;
    }

    const command = parseCommand(slackEvent.text, input.env.botUserId);
    if (command.type === "followUp" && command.text.trim() === "") return;

    await enqueue(workflow, async () => {
      try {
        await handleParsedCommand({
          command,
          runner: input.runner,
          workflow,
          client,
          channelId: slackEvent.channel!,
          threadTs: slackEvent.thread_ts!,
        });
      } catch (error) {
        logger.error(error);
        await postThreadReply(client, slackEvent.channel!, slackEvent.thread_ts!, formatError(error));
      }
    });
  });

  await app.start();
  console.log("rossbot Slack Socket Mode app started");
}

function shouldIgnore(event: SlackEvent): boolean {
  return Boolean(event.bot_id) || event.type === "message" && event.user === undefined;
}

function findProject(config: RossbotConfig, channelId: string): ProjectConfig | undefined {
  return config.projects.find((project) => project.channelId === channelId);
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
    case "plan":
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
