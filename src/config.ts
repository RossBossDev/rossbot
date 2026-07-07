import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import "dotenv/config";
import type { ProjectConfig, RossbotConfig, SlackEnv } from "./types.js";

export const defaultConfigPath = resolve(homedir(), ".rossbot/config.json");

export function parseCliArgs(argv: string[]): { command: "start"; configPath: string } {
  const [command = "start", ...rest] = argv;
  if (command !== "start") {
    throw new Error(`Unsupported command: ${command}. Expected "start".`);
  }

  let configPath = defaultConfigPath;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--") continue;
    if (arg === "--config") {
      const value = rest[i + 1];
      if (!value) throw new Error("--config requires a path");
      configPath = resolve(value.replace(/^~(?=$|\/)/, homedir()));
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command: "start", configPath };
}

export function loadSlackEnv(env = process.env): SlackEnv {
  const botToken = env.ROSSBOT_TOKEN;
  const appToken = env.ROSSBOT_APP_TOKEN;
  const botUserId = env.ROSSBOT_USER_ID;

  const missing = [
    ["ROSSBOT_TOKEN", botToken],
    ["ROSSBOT_APP_TOKEN", appToken],
    ["ROSSBOT_USER_ID", botUserId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  return { botToken: botToken!, appToken: appToken!, botUserId: botUserId! };
}

export function loadConfig(configPath: string): RossbotConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  if (!isConfig(raw)) {
    throw new Error("Config must be an object with a projects array");
  }

  validateProjects(raw.projects);
  return raw;
}

function isConfig(value: unknown): value is RossbotConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { projects?: unknown }).projects)
  );
}

function validateProjects(projects: ProjectConfig[]): void {
  const ids = new Set<string>();
  const channelIds = new Set<string>();

  for (const project of projects) {
    for (const field of ["id", "name", "cwd", "channelId"] as const) {
      if (typeof project[field] !== "string" || project[field].trim() === "") {
        throw new Error(`Project is missing required string field: ${field}`);
      }
    }

    if (ids.has(project.id)) throw new Error(`Duplicate project id: ${project.id}`);
    if (channelIds.has(project.channelId)) {
      throw new Error(`Duplicate channel id: ${project.channelId}`);
    }
    if (!existsSync(project.cwd)) throw new Error(`Project cwd does not exist: ${project.cwd}`);

    ids.add(project.id);
    channelIds.add(project.channelId);
  }
}
