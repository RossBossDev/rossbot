export type ParsedCommand =
  | { type: "plan"; args: string }
  | { type: "implement"; args: string }
  | { type: "pr"; args: string }
  | { type: "status" }
  | { type: "close" }
  | { type: "reset" }
  | { type: "followUp"; text: string };

export function normalizeSlackText(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`^\\s*<@${escapeRegExp(botUserId)}>\\s*`), "")
    .trim();
}

export function parseCommand(text: string, botUserId: string): ParsedCommand {
  const normalized = normalizeSlackText(text, botUserId);
  const match = normalized.match(/^\/?(plan|implement|pr|pull-request|status|close|reset)(?:\s+([\s\S]*))?$/);
  if (!match) return { type: "followUp", text: normalized };

  const [, command, args = ""] = match;
  switch (command) {
    case "plan":
    case "implement":
      return { type: command, args: args.trim() };
    case "pr":
    case "pull-request":
      return { type: "pr", args: args.trim() };
    case "status":
    case "close":
    case "reset":
      return { type: command };
    default:
      return { type: "followUp", text: normalized };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
