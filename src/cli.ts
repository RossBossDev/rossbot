#!/usr/bin/env node
import { loadConfig, loadSlackEnv, parseCliArgs } from "./config.js";
import { PiHostRunner } from "./pi-host-runner.js";
import { startSlackApp } from "./slack.js";
import { WorkflowStore } from "./workflow-store.js";

async function main(): Promise<void> {
  const { configPath } = parseCliArgs(process.argv.slice(2));
  const env = loadSlackEnv();
  const config = loadConfig(configPath);
  const runner = new PiHostRunner(new WorkflowStore());

  await startSlackApp({ config, env, runner });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
