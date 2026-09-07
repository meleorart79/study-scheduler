import { createHash } from "node:crypto";

export class FeedFetchError extends Error {}

export interface FetchedFeed {
  text: string;
  hash: string;
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

function assertSize(text: string, maxBytes: number) {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new FeedFetchError(`Feed response exceeded max size of ${maxBytes} bytes`);
  }
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
