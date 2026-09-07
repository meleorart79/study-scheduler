import { createHash } from "node:crypto";
import type { BlockedPeriod, Config } from "../types.js";

export function blockedPeriodsFromConfig(config: Config): BlockedPeriod[] {
  return config.blockedPeriods.map((bp) => ({
    id: `cfg-${createHash("sha1").update(`${bp.startUtc}|${bp.endUtc}|${bp.reason}`).digest("hex").slice(0, 12)}`,
    startUtc: bp.startUtc,
    endUtc: bp.endUtc,
    reason: bp.reason,
  }));
}
