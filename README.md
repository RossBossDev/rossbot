# rossbot

Local Mac daemon that connects Slack threads to persistent pi agent sessions for registered local projects.

## Setup

```bash
pnpm install
```

Required environment variables:

```bash
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_USER_ID=U...
```

Rossbot defaults to `~/.rossbot/config.json`. You can override it with `--config`.

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
pnpm dev -- --config ~/.rossbot/config.json
```

The daemon uses Slack Socket Mode and stores workflow records in:

```text
~/.rossbot/workflows.json
```

pi session files are managed by the pi SDK for each project cwd.

## Slack behavior

Top-level app mentions create or reuse a workflow for that thread:

```text
@rossbot /plan Add an operations dashboard
```

Thread replies are routed only when a workflow already exists for that Slack thread. Separate Slack threads map to separate pi sessions and can run concurrently; messages inside one thread are queued serially.

Commands:

- `/plan <topic>` — loads and follows Ross's `ross-plan` skill.
- `/implement [request]` — loads and follows Ross's `implement` skill.
- `/pr [request]` — loads and follows Ross's `commit-pr` skill.
- `/status` — prints workflow metadata.
- `/close` — marks the workflow closed and disposes the loaded session.
- `/reset` — creates a fresh pi session for the same Slack thread.

Plain thread replies are sent directly to the same pi session as follow-up prompts.

## Validation

```bash
pnpm typecheck
```
