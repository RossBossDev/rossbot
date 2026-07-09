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
    if (cached) return cached;

    const existing = await this.store.find(key);
    if (!existing) return undefined;
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
    if (cached) return cached;

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

    const runtime: WorkflowRuntime = { project, record, session, queue: Promise.resolve() };
    this.workflows.set(key, runtime);
    return runtime;
  }

  async send(input: { workflow: WorkflowRuntime; command: RunnerCommand }): Promise<RunnerResponse> {
    const workflow = input.workflow;
    const prompt = commandToPrompt(input.command);
    const images = await attachmentsToNativeImages(input.command.attachments);

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
      return { text: text.trim() || finalAssistantText.trim() || "Done." };
    } catch (error) {
      workflow.record.status = "failed";
      workflow.record.lastError = error instanceof Error ? error.message : String(error);
      workflow.record.updatedAt = new Date().toISOString();
      await this.store.upsert(workflow.record);
      throw error;
    } finally {
      unsubscribe();
    }
  }

  async reset(input: { workflow: WorkflowRuntime }): Promise<WorkflowRuntime> {
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
    return input.workflow;
  }

  async close(input: { workflow: WorkflowRuntime }): Promise<void> {
    input.workflow.record.status = "closed";
    input.workflow.record.updatedAt = new Date().toISOString();
    await this.store.upsert(input.workflow.record);
    input.workflow.session.dispose();
    this.workflows.delete(input.workflow.record.key);
  }

  private async openSession(project: ProjectConfig, sessionFile?: string): Promise<AgentSession> {
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
  workflow.queue = workflow.queue.then(task, task);
  return workflow.queue;
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
