import { execFileSync } from "node:child_process";

const commitShaEnvVars = [
  "ROSSBOT_COMMIT_SHA",
  "COMMIT_SHA",
  "GIT_COMMIT_SHA",
  "GITHUB_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "RAILWAY_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "HEROKU_SLUG_COMMIT",
];

export function resolveCommitSha(): string | undefined {
  for (const envVar of commitShaEnvVars) {
    const value = process.env[envVar]?.trim();
    if (value) return value;
  }

  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}
