import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { logDebug, logInfo } from "./logger.js";
import type { WorkflowRecord } from "./types.js";

export const rossbotHome = resolve(homedir(), ".rossbot");
export const workflowsPath = resolve(rossbotHome, "workflows.json");

export class WorkflowStore {
  constructor(private readonly filePath = workflowsPath) {}

  async load(): Promise<WorkflowRecord[]> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) throw new Error("workflows.json must contain an array");
      logDebug("Loaded workflow store", { filePath: this.filePath, workflowCount: parsed.length });
      return parsed as WorkflowRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        logInfo("Workflow store does not exist yet", { filePath: this.filePath });
        return [];
      }
      throw error;
    }
  }

  async find(key: string): Promise<WorkflowRecord | undefined> {
    const record = (await this.load()).find((candidate) => candidate.key === key);
    logDebug(record ? "Workflow store hit" : "Workflow store miss", { key, filePath: this.filePath });
    return record;
  }

  async upsert(record: WorkflowRecord): Promise<void> {
    const records = await this.load();
    const index = records.findIndex((candidate) => candidate.key === record.key);
    if (index >= 0) records[index] = record;
    else records.push(record);
    logDebug(index >= 0 ? "Updating workflow record" : "Inserting workflow record", {
      key: record.key,
      projectId: record.projectId,
      status: record.status,
    });
    await this.save(records);
  }

  private async save(records: WorkflowRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
    logDebug("Saved workflow store", { filePath: this.filePath, workflowCount: records.length });
  }
}

export function workflowKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}
