import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { logDebug, logInfo, logWarn } from "./logger.js";
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
  logInfo("Processing Slack attachments", {
    channelId: input.channelId,
    messageTs: input.messageTs,
    fileCount: input.files.length,
  });

  for (const file of input.files.slice(0, maxAttachmentsPerMessage)) {
    const filename = safeFilename(file.name || file.title || file.id);
    const extension = extname(filename).toLowerCase();

    if (!allowedAttachmentExtensions.has(extension)) {
      ignored.push(`${filename} (unsupported extension)`);
      logDebug("Ignoring Slack attachment with unsupported extension", { filename, extension });
      continue;
    }

    if (file.size !== undefined && file.size > maxAttachmentBytes) {
      ignored.push(`${filename} (larger than ${formatBytes(maxAttachmentBytes)})`);
      logDebug("Ignoring Slack attachment over size limit before download", { filename, size: file.size });
      continue;
    }

    const downloadUrl = file.url_private_download ?? file.url_private;
    if (!downloadUrl) {
      ignored.push(`${filename} (no private download URL)`);
      logWarn("Ignoring Slack attachment without download URL", { filename });
      continue;
    }

    let bytes: Buffer;
    let responseContentType: string | undefined;
    try {
      logDebug("Downloading Slack attachment", { filename, size: file.size, mimetype: file.mimetype });
      const response = await fetchSlackAttachment(downloadUrl, input.botToken);
      if (!response.ok) {
        ignored.push(`${filename} (download failed: HTTP ${response.status})`);
        logWarn("Slack attachment download failed", { filename, httpStatus: response.status, finalUrl: response.url });
        continue;
      }
      responseContentType = response.headers.get("content-type") ?? undefined;
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      ignored.push(`${filename} (download failed: ${error instanceof Error ? error.message : String(error)})`);
      logWarn("Slack attachment download threw", { filename, errorMessage: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (looksLikeHtml(bytes, responseContentType)) {
      ignored.push(`${filename} (download returned HTML instead of the file; check Slack file permissions/scopes)`);
      logWarn("Slack attachment download returned HTML", { filename, contentType: responseContentType, size: bytes.byteLength });
      continue;
    }
    if (nativeImageMediaTypes.has(extension) && !isValidImageBytes(bytes, extension)) {
      ignored.push(`${filename} (downloaded content is not a valid ${extension} image)`);
      logWarn("Slack image attachment failed signature validation", { filename, extension, contentType: responseContentType, size: bytes.byteLength });
      continue;
    }
    if (bytes.byteLength > maxAttachmentBytes) {
      ignored.push(`${filename} (larger than ${formatBytes(maxAttachmentBytes)})`);
      logDebug("Ignoring Slack attachment over size limit after download", { filename, size: bytes.byteLength });
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
    logInfo("Slack attachment saved", {
      filename: outputFilename,
      path: outputPath,
      size: bytes.byteLength,
      nativeImage: nativeImageMediaTypes.has(extension),
    });
  }

  const extraCount = input.files.length - maxAttachmentsPerMessage;
  if (extraCount > 0) {
    ignored.push(`${extraCount} additional attachment(s) (limit is ${maxAttachmentsPerMessage} per message)`);
    logWarn("Slack attachment count exceeded limit", { fileCount: input.files.length, maxAttachmentsPerMessage });
  }

  logInfo("Finished processing Slack attachments", {
    channelId: input.channelId,
    messageTs: input.messageTs,
    acceptedCount: accepted.length,
    ignoredCount: ignored.length,
  });
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

async function fetchSlackAttachment(downloadUrl: string, botToken: string): Promise<Response> {
  let url = downloadUrl;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${botToken}` },
      redirect: "manual",
    });

    if (!isRedirect(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    url = new URL(location, url).toString();
  }

  throw new Error("too many redirects while downloading Slack attachment");
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function looksLikeHtml(bytes: Buffer, contentType: string | undefined): boolean {
  if (contentType?.toLowerCase().includes("text/html")) return true;
  const prefix = bytes.subarray(0, 64).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<!doctype html") || prefix.startsWith("<html");
}

function isValidImageBytes(bytes: Buffer, extension: string): boolean {
  switch (extension) {
    case ".png":
      return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case ".jpg":
    case ".jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case ".webp":
      return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    default:
      return true;
  }
}

function normalizeMediaType(mimetype: string | undefined, extension: string): string | undefined {
  return nativeImageMediaTypes.get(extension) ?? mimetype;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
