import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export class FeedFetchError extends Error {}

export interface FetchedFeed {
  text: string;
  hash: string;
}

/**
 * Reads the university ICS timetable from a local file instead of fetching
 * a URL. Used when `sourceFeed.file` is configured. Enforces the same
 * `maxBytes` cap as the HTTP path (protects against accidentally pointing
 * this at something huge, and keeps behavior consistent between the two
 * input modes).
 */
export function readIcsFeedFromFile(path: string, maxBytes: number): FetchedFeed {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new FeedFetchError(
      `Failed to read feed file "${path}": ${(err as Error).message}`
    );
  }
  assertSize(text, maxBytes, path);
  return { text, hash: hashOf(text) };
}

/**
 * Fetches the university ICS feed as plain text, enforcing a timeout and a
 * maximum response size (to avoid a misbehaving/hostile feed exhausting
 * memory). Returns the raw text plus a content hash used to detect
 * "nothing changed" no-op runs.
 */
export async function fetchIcsFeed(
  url: string,
  timeoutSeconds: number,
  maxBytes: number
): Promise<FetchedFeed> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new FeedFetchError(
        `Feed fetch failed: HTTP ${res.status} ${res.statusText}`
      );
    }

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new FeedFetchError(
        `Feed response too large: ${contentLength} bytes exceeds limit of ${maxBytes}`
      );
    }

    if (!res.body) {
      const text = await res.text();
      assertSize(text, maxBytes);
      return { text, hash: hashOf(text) };
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          throw new FeedFetchError(
            `Feed response exceeded max size of ${maxBytes} bytes while streaming`
          );
        }
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return { text, hash: hashOf(text) };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new FeedFetchError(
        `Feed fetch timed out after ${timeoutSeconds}s`
      );
    }
    if (err instanceof FeedFetchError) throw err;
    throw new FeedFetchError(`Feed fetch failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function assertSize(text: string, maxBytes: number, path?: string) {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new FeedFetchError(
      path
        ? `Feed file "${path}" exceeded max size of ${maxBytes} bytes`
        : `Feed response exceeded max size of ${maxBytes} bytes`
    );
  }
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
