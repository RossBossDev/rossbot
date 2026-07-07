import { homedir } from "node:os";
import path from "node:path";

const vaultName = "my-brain";

export function appendObsidianPlanLinks(text: string): string {
  const links = findObsidianPlanLinks(text);
  if (links.length === 0) return text;

  const lines = links.length === 1
    ? [`Open plan in Obsidian: ${links[0]!.slackLink}`]
    : ["Open plans in Obsidian:", ...links.map((link) => `- ${link.slackLink}`)];

  return `${text.trimEnd()}\n\n${lines.join("\n")}`;
}

type ObsidianPlanLink = {
  path: string;
  slackLink: string;
};

function findObsidianPlanLinks(text: string): ObsidianPlanLink[] {
  const vaultRoot = path.join(homedir(), "notes", vaultName);
  const planPathPattern = new RegExp(`${escapeRegExp(vaultRoot)}\/20 Projects\/[^\r\n<>]*?\/plans\/[^\r\n<>]*?\\.md`, "g");
  const seen = new Set<string>();
  const links: ObsidianPlanLink[] = [];

  for (const match of text.matchAll(planPathPattern)) {
    const absolutePath = trimTrailingPunctuation(match[0]);
    if (seen.has(absolutePath)) continue;

    seen.add(absolutePath);
    links.push({
      path: absolutePath,
      slackLink: formatSlackObsidianLink({ absolutePath, vaultRoot }),
    });
  }

  return links;
}

function formatSlackObsidianLink(input: { absolutePath: string; vaultRoot: string }): string {
  const vaultRelativePath = path.relative(input.vaultRoot, input.absolutePath).split(path.sep).join("/");
  const filename = path.basename(input.absolutePath);
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(vaultRelativePath)}`;

  return `<${uri}|${filename}>`;
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.)\]]+$/u, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
