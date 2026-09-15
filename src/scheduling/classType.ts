import type { Config, SourceEvent } from "../types.js";

export type ClassType = "CM" | "TD" | "TP" | null;

const patternCache = new Map<string, RegExp>();
function getPattern(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern, "i");
    patternCache.set(pattern, re);
  }
  return re;
}

export function sessionId(canonicalId: string, reviewName: string): string {
  return `study-${canonicalId}-${reviewName}`;
}

/** Extracts the CM/TD/TP tag from a class title, per `config.classTypeReviews.pattern`. */
export function detectClassType(summary: string, config: Config): ClassType {
  const re = getPattern(config.classTypeReviews.pattern);
  const m = re.exec(summary);
  if (!m) return null;
  const raw = (m[1] ?? m[0]).toUpperCase();
  return raw === "CM" || raw === "TD" || raw === "TP" ? (raw as ClassType) : null;
}

/**
 * The class title with its type tag (and any resulting double-spacing/empty
 * parens) stripped -- used to group same-subject TP occurrences for
 * pairing. E.g. "Algorithms (TP)" -> "Algorithms".
 */
export function extractSubject(summary: string, config: Config): string {
  const re = getPattern(config.classTypeReviews.pattern);
  return summary
    .replace(re, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface PendingReview {
  ev: SourceEvent;
  reviewIndex: number;
  id: string;
}

/**
 * Builds the (sourceEvent, reviewSpec) pairs to schedule.
 *
 * When `classTypeReviews.enabled` is false (the default), every source
 * event gets every entry in `config.reviews` -- the original behavior.
 *
 * When enabled, review count/target depends on the CM/TD/TP tag found in
 * the class title:
 *   - CM-tagged (or untagged) classes get `cmReviewNames` (default: every
 *     configured review, same as the original behavior).
 *   - TD-tagged classes get only `tdReviewNames`.
 *   - TP-tagged classes are grouped by subject (title with the tag
 *     stripped) and paired off chronologically within each subject; the
 *     *second* class of each pair gets `tpPairReviewNames`, and a trailing
 *     unpaired TP class (odd count) gets its own `tpPairReviewNames`
 *     immediately, anchored on itself, rather than waiting for a partner
 *     that may never arrive.
 */
export function buildPendingReviews(sourceEvents: SourceEvent[], config: Config): PendingReview[] {
  const pending: PendingReview[] = [];
  const reviewIndexByName = new Map(config.reviews.map((r, idx) => [r.name, idx]));
  const allReviewNames = config.reviews.map((r) => r.name);

  function pushReviews(ev: SourceEvent, names: string[]) {
    for (const name of names) {
      const idx = reviewIndexByName.get(name);
      if (idx === undefined) continue; // unknown review name in config; skip defensively
      pending.push({ ev, reviewIndex: idx, id: sessionId(ev.canonicalId, name) });
    }
  }

  if (!config.classTypeReviews.enabled) {
    for (const ev of sourceEvents) pushReviews(ev, allReviewNames);
    return pending;
  }

  const tpBySubject = new Map<string, SourceEvent[]>();

  for (const ev of sourceEvents) {
    const type = detectClassType(ev.summary, config);
    if (type === "TP") {
      const subject = extractSubject(ev.summary, config);
      const list = tpBySubject.get(subject) ?? [];
      list.push(ev);
      tpBySubject.set(subject, list);
      continue; // resolved below, once every TP occurrence for the subject is collected
    }
    if (type === "TD") {
      pushReviews(ev, config.classTypeReviews.tdReviewNames);
    } else {
      // CM, or untagged -- full review set unless overridden in config.
      pushReviews(ev, config.classTypeReviews.cmReviewNames ?? allReviewNames);
    }
  }

  for (const events of tpBySubject.values()) {
    events.sort((a, b) => new Date(a.startUtc).getTime() - new Date(b.startUtc).getTime());
    for (let i = 0; i < events.length; i += 2) {
      const anchor = events[i + 1] ?? events[i]!; // 2nd of the pair, or the leftover itself
      pushReviews(anchor, config.classTypeReviews.tpPairReviewNames);
    }
  }

  return pending;
}
