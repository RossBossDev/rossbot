import type { CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";

export type AgentSession = CreateAgentSessionResult["session"];

export type ProjectConfig = {
  id: string;
  name: string;
  cwd: string;
  channelId: string;
};

export type RossbotConfig = {
  projects: ProjectConfig[];
};

export type SlackEnv = {
  botToken: string;
  appToken: string;
  botUserId: string;
};

export type WorkflowStatus = "idle" | "running" | "failed" | "closed";

export type WorkflowRecord = {
  key: string;
  projectId: string;
  channelId: string;
  threadTs: string;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
};

export type WorkflowRuntime = {
  record: WorkflowRecord;
  session: AgentSession;
  queue: Promise<void>;
};

export type RunnerCommand =
  | { type: "plan"; args: string }
  | { type: "implement"; args: string }
  | { type: "pr"; args: string }
  | { type: "followUp"; text: string };

export type RunnerResponse = {
  text: string;
};

export interface AgentRunner {
  getExistingWorkflow(input: {
    project: ProjectConfig;
    channelId: string;
    threadTs: string;
  }): Promise<WorkflowRuntime | undefined>;

  getOrCreateWorkflow(input: {
    project: ProjectConfig;
    channelId: string;
    threadTs: string;
  }): Promise<WorkflowRuntime>;

  send(input: {
    workflow: WorkflowRuntime;
    command: RunnerCommand;
  }): Promise<RunnerResponse>;

  reset(input: { workflow: WorkflowRuntime }): Promise<WorkflowRuntime>;
  close(input: { workflow: WorkflowRuntime }): Promise<void>;
}
