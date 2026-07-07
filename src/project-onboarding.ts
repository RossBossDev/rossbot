import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { defaultConfigPath, loadSlackEnv, parseConfig, validateProjects } from "./config.js";
import type { ProjectConfig, RossbotConfig, SlackChannelSummary } from "./types.js";

const execFileAsync = promisify(execFile);

type SlackListResponse = {
  ok: boolean;
  error?: string;
  channels?: Array<{ id?: string; name?: string; is_archived?: boolean }>;
  response_metadata?: { next_cursor?: string };
};

type SlackCreateResponse = {
  ok: boolean;
  error?: string;
  channel?: { id?: string; name?: string };
};

type SlackInfoResponse = {
  ok: boolean;
  error?: string;
  channel?: { id?: string; name?: string };
};

export async function runProjectOnboarding(): Promise<void> {
  const repoRoot = await getCurrentGitRoot();
  const projectId = basename(repoRoot);
  const projectName = projectId;

  // Validate Slack env before any channel prompts so failures are immediate and consistent with daemon startup.
  const env = loadSlackEnv();
  const config = await loadOnboardingConfig(defaultConfigPath);
  const existingProject = config.projects.find((project) => project.id === projectId);

  const rl = createInterface({ input, output });
  try {
    if (existingProject) {
      await updateExistingProject({ rl, config, project: existingProject, repoRoot, token: env.botToken });
    } else {
      const channel = await promptForChannel({ rl, token: env.botToken, defaultChannelName: projectId });
      config.projects.push({ id: projectId, name: projectName, cwd: repoRoot, channelId: channel.id });
      await saveOnboardingConfig(defaultConfigPath, config);
      console.log(`Added project "${projectName}" using #${channel.name}.`);
    }
  } finally {
    rl.close();
  }
}

async function updateExistingProject(input: {
  rl: Interface;
  config: RossbotConfig;
  project: ProjectConfig;
  repoRoot: string;
  token: string;
}): Promise<void> {
  const { rl, config, project, repoRoot, token } = input;

  if (resolve(project.cwd) !== repoRoot) {
    throw new Error(
      `A config entry for project id "${project.id}" already exists with cwd ${project.cwd}. ` +
        `This repo root is ${repoRoot}. Rename one project before onboarding.`,
    );
  }

  const channelName = await resolveChannelName(token, project.channelId);
  const label = channelName ? `#${channelName}` : project.channelId;
  const shouldChange = await promptYesNo(
    rl,
    `A config for this project already exists and is tied to ${label}. Do you want to change the channel?`,
  );

  if (!shouldChange) {
    console.log("No changes made.");
    return;
  }

  const channel = await promptForChannel({ rl, token, defaultChannelName: project.id });
  project.channelId = channel.id;
  await saveOnboardingConfig(defaultConfigPath, config);
  console.log(`Updated project "${project.name}" to use #${channel.name}.`);
}

async function promptForChannel(input: {
  rl: Interface;
  token: string;
  defaultChannelName: string;
}): Promise<SlackChannelSummary> {
  const mode = await promptChoice(input.rl, "Use an existing public Slack channel or create a new one?", [
    { key: "1", label: "Use existing channel", value: "existing" },
    { key: "2", label: "Create new public channel", value: "create" },
  ] as const);

  if (mode === "existing") {
    return promptForExistingChannel(input.rl, input.token);
  }

  return promptForNewChannel(input.rl, input.token, input.defaultChannelName);
}

async function promptForExistingChannel(rl: Interface, token: string): Promise<SlackChannelSummary> {
  const channels = await listPublicChannels(token);
  if (channels.length === 0) {
    throw new Error("No public Slack channels were returned by conversations.list.");
  }

  console.log("Public Slack channels:");
  channels.forEach((channel, index) => {
    console.log(`${index + 1}. #${channel.name}`);
  });

  while (true) {
    const answer = (await rl.question("Choose a channel number: ")).trim();
    const selectedIndex = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(selectedIndex) && channels[selectedIndex]) {
      return channels[selectedIndex];
    }
    console.log(`Enter a number from 1 to ${channels.length}.`);
  }
}

async function promptForNewChannel(
  rl: Interface,
  token: string,
  defaultChannelName: string,
): Promise<SlackChannelSummary> {
  const normalizedDefault = normalizeSlackChannelName(defaultChannelName);
  while (true) {
    const answer = (await rl.question(`New public channel name (${normalizedDefault}): `)).trim();
    const name = normalizeSlackChannelName(answer || normalizedDefault);
    if (!name) {
      console.log("Enter a channel name containing at least one letter or number.");
      continue;
    }
    return createPublicChannel(token, name);
  }
}

async function getCurrentGitRoot(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() }));
  } catch {
    throw new Error("rossbot project add must be run from a git repo root. This directory is not in a git repo.");
  }

  const repoRoot = resolve(stdout.trim());
  const cwd = resolve(process.cwd());
  if (repoRoot !== cwd) {
    throw new Error(`rossbot project add must be run from the git repo root: ${repoRoot}`);
  }

  return repoRoot;
}

async function loadOnboardingConfig(configPath: string): Promise<RossbotConfig> {
  if (!existsSync(configPath)) return { projects: [] };
  const raw = await readFile(configPath, "utf8");
  return parseConfig(raw);
}

async function saveOnboardingConfig(configPath: string, config: RossbotConfig): Promise<void> {
  validateProjects(config.projects);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function listPublicChannels(token: string): Promise<SlackChannelSummary[]> {
  const channels: SlackChannelSummary[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ types: "public_channel", exclude_archived: "true", limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const response = await callSlackApi<SlackListResponse>(token, "conversations.list", params);
    for (const channel of response.channels ?? []) {
      if (channel.id && channel.name && !channel.is_archived) {
        channels.push({ id: channel.id, name: channel.name });
      }
    }
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return channels.sort((a, b) => a.name.localeCompare(b.name));
}

async function createPublicChannel(token: string, name: string): Promise<SlackChannelSummary> {
  const params = new URLSearchParams({ name, is_private: "false" });
  const response = await callSlackApi<SlackCreateResponse>(token, "conversations.create", params);
  if (!response.channel?.id || !response.channel.name) {
    throw new Error("Slack conversations.create did not return a channel id and name.");
  }
  return { id: response.channel.id, name: response.channel.name };
}

async function resolveChannelName(token: string, channelId: string): Promise<string | undefined> {
  try {
    const response = await callSlackApi<SlackInfoResponse>(
      token,
      "conversations.info",
      new URLSearchParams({ channel: channelId }),
    );
    return response.channel?.name;
  } catch {
    return undefined;
  }
}

async function callSlackApi<T extends { ok: boolean; error?: string }>(
  token: string,
  method: string,
  params: URLSearchParams,
): Promise<T> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!response.ok) {
    throw new Error(`Slack ${method} failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as T;
  if (!body.ok) {
    throw new Error(`Slack ${method} failed: ${body.error ?? "unknown_error"}`);
  }
  return body;
}

async function promptYesNo(rl: Interface, question: string): Promise<boolean> {
  while (true) {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    if (answer === "" || answer === "n" || answer === "no") return false;
    if (answer === "y" || answer === "yes") return true;
    console.log("Enter yes or no.");
  }
}

async function promptChoice<const T extends readonly { key: string; label: string; value: string }[]>(
  rl: Interface,
  question: string,
  choices: T,
): Promise<T[number]["value"]> {
  console.log(question);
  for (const choice of choices) {
    console.log(`${choice.key}. ${choice.label}`);
  }

  while (true) {
    const answer = (await rl.question("Choose an option: ")).trim();
    const choice = choices.find((item) => item.key === answer);
    if (choice) return choice.value;
    console.log(`Enter one of: ${choices.map((choice) => choice.key).join(", ")}.`);
  }
}

export function normalizeSlackChannelName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}
