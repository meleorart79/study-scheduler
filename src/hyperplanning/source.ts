import { createHash } from "node:crypto";
import type { RawNormalizedEvent } from "../ics-input/types.js";
import type { Config } from "../types.js";
import type { Logger } from "../logging/logger.js";
import { createHyperplanningSession, fetchHyperplanningParameters } from "./session.js";
import { resolvePromotionAndGroup } from "./resources.js";
import { fetchCourseList } from "./timetable.js";
import { decodeHyperplanningSchedule } from "./decoder.js";

export interface HyperplanningFetchResult { events: RawNormalizedEvent[]; hash: string; sessionId: number; promotion: string; group: string }

export async function fetchHyperplanningEvents(config: Config, logger?: Logger): Promise<HyperplanningFetchResult> {
    const hp = config.hyperplanning;
    if (!hp?.enabled) throw new Error("Hyperplanning is not enabled");
    const timeoutMs = hp.requestTimeoutSeconds * 1000;
    const session = await createHyperplanningSession(hp.url, timeoutMs);
    const period = await fetchHyperplanningParameters(session, session.start, timeoutMs);
    if (period.placesParJour !== 56) {
        throw new Error(`Unexpected Hyperplanning PlacesParJour=${period.placesParJour}; refusing to guess the grid`);
    }

    const { promotion, group } = await resolvePromotionAndGroup(session, hp.promotion, hp.group, timeoutMs);
    logger?.info({ sessionId: session.sessionId, promotion: promotion.L, group: group.L }, "Hyperplanning session established");

    const courses = await fetchCourseList(session, group, hp.filter, timeoutMs);
    const decoded = decodeHyperplanningSchedule(
        { ListeCours: courses },
        { academicWeek1Monday: period.premierLundi, timezone: config.timezone, placesPerDay: period.placesParJour }
    );
    const events = decoded.events;

    if (events.length < 1) throw new Error("Hyperplanning returned zero decoded events");
    const hash = createHash("sha256").update(JSON.stringify(events.map(e => ({
        uid: e.uid, summary: e.summary, start: e.startUtc.toISOString(), end: e.endUtc.toISOString(), location: e.location
    })))).digest("hex");
    return { events, hash, sessionId: session.sessionId, promotion: promotion.L, group: group.L };
}