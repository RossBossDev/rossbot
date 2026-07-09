#!/usr/bin/env node
import { loadConfig, loadSlackEnv, parseCliArgs } from "./config.js";
import { errorContext, logError, logInfo } from "./logger.js";
import { PiHostRunner } from "./pi-host-runner.js";
import { runProjectOnboarding } from "./project-onboarding.js";
import { startSlackApp } from "./slack.js";
import { WorkflowStore } from "./workflow-store.js";

async function main(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2));
  logInfo("Rossbot command parsed", { command: command.command });

  if (command.command === "projectAdd") {
    await runProjectOnboarding();
    return;
  }

  const env = loadSlackEnv();
  const config = loadConfig(command.configPath);
  logInfo("Rossbot config loaded", { configPath: command.configPath, projectCount: config.projects.length });

  const runner = new PiHostRunner(new WorkflowStore());
  await startSlackApp({ config, env, runner });
}

main().catch((error) => {
  logError("Rossbot process failed", errorContext(error));
  process.exitCode = 1;
});
