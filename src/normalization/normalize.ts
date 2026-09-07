import type { RawNormalizedEvent } from "../ics-input/types.js";
import type { SourceEvent } from "../types.js";
import { computeCanonicalId, normalizeSummary } from "./canonicalId.js";
import type { Logger } from "../logging/logger.js";

export function normalizeSourceEvents(
  rawEvents: RawNormalizedEvent[],
  prevSourceEvents: SourceEvent[],
  nowUtc: string,
  runId: string,
  logger?: Logger
): SourceEvent[] {
  const prevByCanonicalId = new Map(prevSourceEvents.map((e) => [e.canonicalId, e]));
  const prevRawUidByCanonicalId = new Map(
    prevSourceEvents.map((e) => [e.canonicalId, e.rawUid])
  );

  const byCanonicalId = new Map<string, SourceEvent>();

  for (const raw of rawEvents) {
    const summary = normalizeSummary(raw.summary);
    const canonicalId = computeCanonicalId(
      summary,
      raw.startUtc.toISOString(),
      raw.endUtc.toISOString()
    );

    if (byCanonicalId.has(canonicalId)) {
      // True content duplicate (identical summary+start+end) seen twice in
      // this feed pull; keep the first, log the collision.
      logger?.warn(
        { canonicalId, uid: raw.uid },
        "Duplicate source event content detected in feed; keeping first occurrence"
      );
      continue;
    }

    const prev = prevByCanonicalId.get(canonicalId);
    const prevRawUid = prevRawUidByCanonicalId.get(canonicalId);
    if (prev && prevRawUid && prevRawUid !== raw.uid) {
      logger?.info(
        { canonicalId, oldUid: prevRawUid, newUid: raw.uid },
        "Source event UID changed across regenerations (UID churn); canonical identity preserved by content match"
      );
    }

    byCanonicalId.set(canonicalId, {
      canonicalId,
      rawUid: raw.uid,
      recurrenceKey: raw.recurrenceKey,
      summary: raw.summary,
      startUtc: raw.startUtc.toISOString(),
      endUtc: raw.endUtc.toISOString(),
      sourceTimezone: raw.sourceTimezone,
      wasFloating: raw.wasFloating,
      location: raw.location,
      firstSeenAt: prev?.firstSeenAt ?? nowUtc,
      lastSeenRunId: runId,
    });
  }

  return [...byCanonicalId.values()].sort(
    (a, b) => new Date(a.startUtc).getTime() - new Date(b.startUtc).getTime()
  );
}
