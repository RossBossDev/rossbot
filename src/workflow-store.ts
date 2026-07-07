import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
      return parsed as WorkflowRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async find(key: string): Promise<WorkflowRecord | undefined> {
    return (await this.load()).find((record) => record.key === key);
  }

  async upsert(record: WorkflowRecord): Promise<void> {
    const records = await this.load();
    const index = records.findIndex((candidate) => candidate.key === record.key);
    if (index >= 0) records[index] = record;
    else records.push(record);
    await this.save(records);
  }

  private async save(records: WorkflowRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
  }
}

export function workflowKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}
