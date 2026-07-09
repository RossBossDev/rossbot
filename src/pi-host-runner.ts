import { readFile } from "node:fs/promises";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AgentRunner,
  AgentSession,
  ProjectConfig,
  RunnerAttachment,
  RunnerCommand,
  RunnerResponse,
  WorkflowRecord,
  WorkflowRuntime,
} from "./types.js";
import { errorContext, logDebug, logError, logInfo } from "./logger.js";
import { WorkflowStore, workflowKey } from "./workflow-store.js";

export class PiHostRunner implements AgentRunner {
  private readonly workflows = new Map<string, WorkflowRuntime>();

  constructor(private readonly store: WorkflowStore) {}

  async getExistingWorkflow(input: {
    project: ProjectConfig;
    channelId: string;
    threadTs: string;
  }): Promise<WorkflowRuntime | undefined> {
    const key = workflowKey(input.channelId, input.threadTs);
    const cached = this.workflows.get(key);
    if (cached) {
      logDebug("Workflow cache hit", { key, projectId: cached.record.projectId, status: cached.record.status });
      return cached;
    }

    const existing = await this.store.find(key);
    if (!existing) {
      logDebug("Workflow not found", { key, projectId: input.project.id });
      return undefined;
    }
    logInfo("Workflow restored from store", { key, projectId: existing.projectId, status: existing.status });
    return this.materializeWorkflow(input.project, input.channelId, input.threadTs, existing);
  }

  async getOrCreateWorkflow(input: {
    project: ProjectConfig;
    channelId: string;
    threadTs: string;
  }): Promise<WorkflowRuntime> {
    return this.materializeWorkflow(input.project, input.channelId, input.threadTs, await this.store.find(workflowKey(input.channelId, input.threadTs)));
  }

  private async materializeWorkflow(
    project: ProjectConfig,
    channelId: string,
    threadTs: string,
    existing?: WorkflowRecord,
  ): Promise<WorkflowRuntime> {
    const key = workflowKey(channelId, threadTs);
    const cached = this.workflows.get(key);
    if (cached) {
      logDebug("Workflow materialize cache hit", { key, projectId: cached.record.projectId, status: cached.record.status });
      return cached;
    }

    logInfo(existing ? "Opening existing workflow session" : "Creating workflow session", {
      key,
      projectId: project.id,
      cwd: project.cwd,
      hasSessionFile: Boolean(existing?.sessionFile),
    });
    const session = await this.openSession(project, existing?.sessionFile);
    const now = new Date().toISOString();
    const record: WorkflowRecord = existing ?? {
      key,
      projectId: project.id,
      channelId,
      threadTs,
      cwd: project.cwd,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };

    record.status = record.status === "closed" ? "closed" : "idle";
    record.sessionId = session.sessionId;
    record.sessionFile = session.sessionFile;
    record.updatedAt = now;
    await this.store.upsert(record);
    logInfo("Workflow materialized", {
      key,
      projectId: project.id,
      status: record.status,
      sessionId: record.sessionId,
      hasSessionFile: Boolean(record.sessionFile),
    });

    const runtime: WorkflowRuntime = { project, record, session, queue: Promise.resolve() };
    this.workflows.set(key, runtime);
    return runtime;
  }

  async send(input: { workflow: WorkflowRuntime; command: RunnerCommand }): Promise<RunnerResponse> {
    const workflow = input.workflow;
    const prompt = commandToPrompt(input.command);
    const images = await attachmentsToNativeImages(input.command.attachments);

    logInfo("Sending command to pi session", {
      key: workflow.record.key,
      projectId: workflow.record.projectId,
      commandType: input.command.type,
      attachmentCount: input.command.attachments?.length ?? 0,
      nativeImageCount: images.length,
      promptLength: prompt.length,
    });

    workflow.record.status = "running";
    workflow.record.lastError = undefined;
    workflow.record.updatedAt = new Date().toISOString();
    await this.store.upsert(workflow.record);

    let text = "";
    let finalAssistantText = "";
    const unsubscribe = workflow.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
      }
      if (event.type === "message_end") {
        finalAssistantText = extractAssistantText(event.message) || finalAssistantText;
      }
      if (event.type === "turn_end") {
        finalAssistantText = extractAssistantText(event.message) || finalAssistantText;
      }
    });

    try {
      await workflow.session.prompt(prompt, images.length ? { images } : undefined);
      workflow.record.status = "idle";
      workflow.record.sessionId = workflow.session.sessionId;
      workflow.record.sessionFile = workflow.session.sessionFile;
      workflow.record.updatedAt = new Date().toISOString();
      await this.store.upsert(workflow.record);
      const responseText = text.trim() || finalAssistantText.trim() || "Done.";
      logInfo("Pi session command completed", {
        key: workflow.record.key,
        projectId: workflow.record.projectId,
        responseLength: responseText.length,
        sessionId: workflow.record.sessionId,
      });
      return { text: responseText };
    } catch (error) {
      workflow.record.status = "failed";
      workflow.record.lastError = error instanceof Error ? error.message : String(error);
      workflow.record.updatedAt = new Date().toISOString();
      await this.store.upsert(workflow.record);
      logError("Pi session command failed", {
        key: workflow.record.key,
        projectId: workflow.record.projectId,
        ...errorContext(error),
      });
      throw error;
    } finally {
      unsubscribe();
    }
  }

  async reset(input: { workflow: WorkflowRuntime }): Promise<WorkflowRuntime> {
    logInfo("Resetting workflow", { key: input.workflow.record.key, projectId: input.workflow.record.projectId });
    input.workflow.session.dispose();
    const session = await this.openSession(input.workflow.project);
    const now = new Date().toISOString();
    input.workflow.record.sessionId = session.sessionId;
    input.workflow.record.sessionFile = session.sessionFile;
    input.workflow.record.status = "idle";
    input.workflow.record.lastError = undefined;
    input.workflow.record.updatedAt = now;
    input.workflow.session = session;
    input.workflow.queue = Promise.resolve();
    await this.store.upsert(input.workflow.record);
    logInfo("Workflow reset", {
      key: input.workflow.record.key,
      projectId: input.workflow.record.projectId,
      sessionId: input.workflow.record.sessionId,
    });
    return input.workflow;
  }

  async close(input: { workflow: WorkflowRuntime }): Promise<void> {
    logInfo("Closing workflow", { key: input.workflow.record.key, projectId: input.workflow.record.projectId });
    input.workflow.record.status = "closed";
    input.workflow.record.updatedAt = new Date().toISOString();
    await this.store.upsert(input.workflow.record);
    input.workflow.session.dispose();
    this.workflows.delete(input.workflow.record.key);
  }

  private async openSession(project: ProjectConfig, sessionFile?: string): Promise<AgentSession> {
    logInfo(sessionFile ? "Opening pi session from file" : "Creating new pi session", {
      projectId: project.id,
      cwd: project.cwd,
      hasAppendSystemPrompt: Boolean(project.appendSystemPrompt),
      hasSessionFile: Boolean(sessionFile),
    });
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, undefined, project.cwd)
      : SessionManager.create(project.cwd);

    if (!project.appendSystemPrompt) {
      const { session } = await createAgentSession({ cwd: project.cwd, sessionManager });
      return session;
    }

    const resourceLoader = new DefaultResourceLoader({
      cwd: project.cwd,
      agentDir: getAgentDir(),
      appendSystemPromptOverride: (base) => [...base, project.appendSystemPrompt!],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({ cwd: project.cwd, sessionManager, resourceLoader });
    return session;
  }
}

export function enqueue(workflow: WorkflowRuntime, task: () => Promise<void>): Promise<void> {
  const queuedAt = Date.now();
  logDebug("Queueing workflow task", { key: workflow.record.key, projectId: workflow.record.projectId });
  workflow.queue = workflow.queue.then(
    () => runQueuedTask(workflow, task, queuedAt, false),
    () => runQueuedTask(workflow, task, queuedAt, true),
  );
  return workflow.queue;
}

async function runQueuedTask(
  workflow: WorkflowRuntime,
  task: () => Promise<void>,
  queuedAt: number,
  previousFailed: boolean,
): Promise<void> {
  logInfo(previousFailed ? "Starting workflow task after previous queue failure" : "Starting workflow task", {
    key: workflow.record.key,
    projectId: workflow.record.projectId,
    queuedMs: Date.now() - queuedAt,
  });
  try {
    await task();
    logInfo("Workflow task completed", { key: workflow.record.key, projectId: workflow.record.projectId });
  } catch (error) {
    logError("Workflow task failed", { key: workflow.record.key, projectId: workflow.record.projectId, ...errorContext(error) });
    throw error;
  }
}

function commandToPrompt(command: RunnerCommand): string {
  const attachmentSection = formatAttachmentPromptSection(command.attachments);

  switch (command.type) {
    case "plan":
      return `Load and follow \`~/.pi/agent/skills/ross-plan/SKILL.md\`.

Plan topic/request from this Slack thread:
${command.args}${attachmentSection}`;
    case "implement":
      return `Load and follow \`~/.pi/agent/skills/implement/SKILL.md\`.

Use the plan/context already discussed in this Slack thread unless I specify otherwise.
Additional request:
${command.args}${attachmentSection}`;
    case "pr":
      return `Load and follow \`~/.pi/agent/skills/commit-pr/SKILL.md\`.

Use the current repo state and the context already discussed in this Slack thread.
Additional request:
${command.args}${attachmentSection}`;
    case "followUp":
      return `${command.text}${attachmentSection}`;
  }
}

function formatAttachmentPromptSection(attachments: RunnerAttachment[] | undefined): string {
  if (!attachments?.length) return "";

  const files = attachments
    .map((attachment) => {
      const nativeNote = attachment.nativeImage ? " (also provided as native image input)" : "";
      return `- ${attachment.filename}: ${attachment.path}${nativeNote}`;
    })
    .join("\n");

  return `

Attachments saved from Slack:
${files}

Use the read tool to inspect relevant attachment files before acting. Images marked as native image input are also available directly in this prompt.`;
}

async function attachmentsToNativeImages(attachments: RunnerAttachment[] | undefined): Promise<NativeImageContent[]> {
  if (!attachments?.length) return [];

  const images: NativeImageContent[] = [];
  for (const attachment of attachments) {
    if (!attachment.nativeImage || !attachment.mediaType?.startsWith("image/")) continue;
    const data = await readFile(attachment.path, "base64");
    images.push({
      type: "image",
      data,
      mimeType: attachment.mediaType,
    });
  }
  return images;
}

function extractAssistantText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant") return "";
  return extractTextContent(message.content).trim();
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!isRecord(part) || part.type !== "text") return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type NativeImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};
