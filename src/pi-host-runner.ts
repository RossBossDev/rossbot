import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AgentRunner,
  AgentSession,
  ProjectConfig,
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

    const session = await this.openSession(project.cwd, existing?.sessionFile);
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

    const runtime: WorkflowRuntime = { record, session, queue: Promise.resolve() };
    this.workflows.set(key, runtime);
    return runtime;
  }

  async send(input: { workflow: WorkflowRuntime; command: RunnerCommand }): Promise<RunnerResponse> {
    const workflow = input.workflow;
    const prompt = commandToPrompt(input.command);

    workflow.record.status = "running";
    workflow.record.lastError = undefined;
    workflow.record.updatedAt = new Date().toISOString();
    await this.store.upsert(workflow.record);

    let text = "";
    const unsubscribe = workflow.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
      }
    });

    try {
      await workflow.session.prompt(prompt);
      workflow.record.status = "idle";
      workflow.record.sessionId = workflow.session.sessionId;
      workflow.record.sessionFile = workflow.session.sessionFile;
      workflow.record.updatedAt = new Date().toISOString();
      await this.store.upsert(workflow.record);
      return { text: text.trim() || "Done." };
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
    const session = await this.openSession(input.workflow.record.cwd);
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

  private async openSession(cwd: string, sessionFile?: string): Promise<AgentSession> {
    const sessionManager = sessionFile ? SessionManager.open(sessionFile, undefined, cwd) : SessionManager.create(cwd);
    const { session } = await createAgentSession({ cwd, sessionManager });
    return session;
  }
}

export function enqueue(workflow: WorkflowRuntime, task: () => Promise<void>): Promise<void> {
  workflow.queue = workflow.queue.then(task, task);
  return workflow.queue;
}

function commandToPrompt(command: RunnerCommand): string {
  switch (command.type) {
    case "plan":
      return `Load and follow \`~/.pi/agent/skills/ross-plan/SKILL.md\`.

Plan topic/request from this Slack thread:
${command.args}`;
    case "implement":
      return `Load and follow \`~/.pi/agent/skills/implement/SKILL.md\`.

Use the plan/context already discussed in this Slack thread unless I specify otherwise.
Additional request:
${command.args}`;
    case "pr":
      return `Load and follow \`~/.pi/agent/skills/commit-pr/SKILL.md\`.

Use the current repo state and the context already discussed in this Slack thread.
Additional request:
${command.args}`;
    case "followUp":
      return command.text;
  }
}
