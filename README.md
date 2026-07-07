# rossbot

Local Mac daemon that connects Slack threads to persistent pi agent sessions for registered local projects.

## Setup

```bash
pnpm install
```

Required environment variables:

```bash
export ROSSBOT_TOKEN=xoxb-...
export ROSSBOT_APP_TOKEN=xapp-...
export ROSSBOT_USER_ID=U...
# Optional: defaults to Ross's Slack user id (U0ABQAC1RKJ)
export ROSSBOT_ALLOWED_USER_ID=U0ABQAC1RKJ
```

Rossbot defaults to `~/.rossbot/config.json`. You can override it with `--config` when starting the daemon.

## Project onboarding

From the git repo root for a project Rossbot should manage, run:

```bash
pnpm dev -- project add
# or, after build/install:
rossbot project add
```

The onboarding command derives the project id, name, and cwd from the current repo root, then helps select or create a public Slack channel. It writes to `~/.rossbot/config.json`.

Example config:

```json
{
  "projects": [
    {
      "id": "acme-ops",
      "name": "Acme Ops",
      "cwd": "/Users/ross/projects/sandcastle-playground/acme-ops",
      "channelId": "C1234567890"
    }
  ]
}
```

Each project `cwd` must exist. Project ids and Slack channel ids must be unique.

## Run

```bash
pnpm dev -- start --config ~/.rossbot/config.json
```

The daemon uses Slack Socket Mode and stores workflow records in:

```text
~/.rossbot/workflows.json
```

pi session files are managed by the pi SDK for each project cwd.

## Slack behavior

In registered project channels, top-level messages from the allowed Slack user create or reuse a workflow for that message's thread, with or without mentioning the bot:

```text
plan Add an operations dashboard
hello from top level
@rossbot plan Add an operations dashboard
```

Accepted top-level messages get a single status reaction that is updated as the queued work progresses: `:eyes:` accepted/queued, `:rocket:` running, `:white_check_mark:` completed, or `:x:` failed. Reaction updates are best-effort UI hints; failures are logged without changing workflow behavior.

Thread replies are routed only when a workflow already exists for that Slack thread. Accepted thread replies get a transient `:hourglass_flowing_sand:` reaction while the agent is processing the message, then the reaction is removed. Separate Slack threads map to separate pi sessions and can run concurrently; messages inside one thread are queued serially. Messages from other human users are ignored and logged without a Slack reply.

Commands:

- `plan <topic>` or `/plan <topic>` — loads and follows Ross's `ross-plan` skill. Replies include Obsidian deep links when they mention handoff plans under `~/notes/my-brain/20 Projects/<repo>/plans/`.
- `implement [request]` or `/implement [request]` — loads and follows Ross's `implement` skill.
- `pr [request]` or `/pr [request]` — loads and follows Ross's `commit-pr` skill.
- `status` — prints workflow metadata.
- `close` — marks the workflow closed and disposes the loaded session.
- `reset` — creates a fresh pi session for the same Slack thread.

Registered Slack slash commands are supported for `/plan`, `/implement`, and `/pr`. Slash command invocations post a new top-level rossbot message and run the workflow in that message's thread.

Plain top-level messages and thread replies are sent directly to the corresponding pi session as follow-up prompts.

## Validation

```bash
pnpm typecheck
pnpm build
```
