import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { RunnerAttachment } from "./types.js";

export type SlackFileAttachment = {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
};

export type AttachmentDownloadResult = {
  accepted: RunnerAttachment[];
  ignored: string[];
};

const maxAttachmentBytes = 5 * 1024 * 1024;
const maxAttachmentsPerMessage = 5;

const allowedAttachmentExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
  ".log",
  ".diff",
  ".patch",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".sql",
  ".sh",
  ".zsh",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
]);

const nativeImageMediaTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

export const allowedAttachmentExtensionsDescription = [...allowedAttachmentExtensions].sort().join(", ");

export async function downloadSlackAttachments(input: {
  botToken: string;
  cwd: string;
  channelId: string;
  messageTs: string;
  files: SlackFileAttachment[];
}): Promise<AttachmentDownloadResult> {
  const accepted: RunnerAttachment[] = [];
  const ignored: string[] = [];

  for (const file of input.files.slice(0, maxAttachmentsPerMessage)) {
    const filename = safeFilename(file.name || file.title || file.id);
    const extension = extname(filename).toLowerCase();

    if (!allowedAttachmentExtensions.has(extension)) {
      ignored.push(`${filename} (unsupported extension)`);
      continue;
    }

    if (file.size !== undefined && file.size > maxAttachmentBytes) {
      ignored.push(`${filename} (larger than ${formatBytes(maxAttachmentBytes)})`);
      continue;
    }

    const downloadUrl = file.url_private_download ?? file.url_private;
    if (!downloadUrl) {
      ignored.push(`${filename} (no private download URL)`);
      continue;
    }

    let bytes: Buffer;
    try {
      const response = await fetch(downloadUrl, { headers: { authorization: `Bearer ${input.botToken}` } });
      if (!response.ok) {
        ignored.push(`${filename} (download failed: HTTP ${response.status})`);
        continue;
      }
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      ignored.push(`${filename} (download failed: ${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (bytes.byteLength > maxAttachmentBytes) {
      ignored.push(`${filename} (larger than ${formatBytes(maxAttachmentBytes)})`);
      continue;
    }

    const directory = join(input.cwd, ".rossbot", "slack-attachments", safePathSegment(input.channelId), safePathSegment(input.messageTs));
    await mkdir(directory, { recursive: true });

    const outputFilename = uniqueFilename(filename, accepted);
    const outputPath = join(directory, outputFilename);
    await writeFile(outputPath, bytes);

    accepted.push({
      filename: outputFilename,
      path: outputPath,
      mediaType: normalizeMediaType(file.mimetype, extension),
      size: bytes.byteLength,
      nativeImage: nativeImageMediaTypes.has(extension),
    });
  }

  const extraCount = input.files.length - maxAttachmentsPerMessage;
  if (extraCount > 0) {
    ignored.push(`${extraCount} additional attachment(s) (limit is ${maxAttachmentsPerMessage} per message)`);
  }

  return { accepted, ignored };
}

function safeFilename(filename: string): string {
  const safe = basename(filename).replace(/[^a-zA-Z0-9._ -]/g, "_").trim();
  return safe || "attachment";
}

function safePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function uniqueFilename(filename: string, accepted: RunnerAttachment[]): string {
  if (!accepted.some((attachment) => attachment.filename === filename)) return filename;

  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  let index = 2;
  while (accepted.some((attachment) => attachment.filename === `${stem}-${index}${extension}`)) {
    index += 1;
  }
  return `${stem}-${index}${extension}`;
}

function normalizeMediaType(mimetype: string | undefined, extension: string): string | undefined {
  return mimetype ?? nativeImageMediaTypes.get(extension);
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
