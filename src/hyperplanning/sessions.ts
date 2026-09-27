import type { RawNormalizedEvent } from "../ics-input/types.js";
import { addDaysToDateString, zonedTimeToUtc } from "../util/timezone.js";
import { hyperplanningRequest, type HyperplanningSession } from "./session.js";
import type { HyperplanningCourseMeta } from "./types.js";
import { decodePeriodPosition, HyperplanningDecodeError } from "./decoder.js";

interface DateSessionResponse { listeElements?: Array<{ L?: string; ListeCours?: Array<{ N?: string; p?: number; d?: number; nbE?: number; dom?: { V?: string } | string }> }> }
export interface HyperplanningAcademicPeriod { premierLundi: string; derniereDate: string; placesParJour: number }

function weeks(value: string | { V?: string } | undefined): number[] {
    const text = typeof value === "string" ? value : value?.V;
    if (!text) return [];
    const out: number[] = [];
    for (const t of text.replace(/^\[/, "").replace(/\]$/, "").split(",")) {
        const r = /^(\d+)\.\.(\d+)$/.exec(t.trim());
        if (r) {
            const start = Number(r[1]);
            const end = Number(r[2]);
            if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Invalid Hyperplanning week set");
            for (let n = start; n <= end; n++) out.push(n);
        }
        else if (/^\d+$/.test(t.trim())) out.push(+t.trim());
        else throw new Error("Invalid Hyperplanning week set");
    }
    return [...new Set(out)];
}

export async function fetchAcademicSessions(
    session: HyperplanningSession,
    group: { L: string; N: string; G: number },
    filter: string,
    period: HyperplanningAcademicPeriod,
    metadata: Map<string, HyperplanningCourseMeta>,
    timezone: string,
    timeoutMs: number,
): Promise<RawNormalizedEvent[]> {
    const data = await hyperplanningRequest<DateSessionResponse>(session, "FonctionDateDebutCours", {
        Signature: { Onglet: "DIPLOME.RECAPCOURS", listeRecherche: [group] },
        data: { avecDetailSeances: true, FiltreRessources: { _T: 26, V: filter }, dateDebutConsultation: { _T: 7, V: `${fr(period.premierLundi)} 0:0:0` }, dateFinConsultation: { _T: 7, V: `${fr(period.derniereDate)} 0:0:0` }, avecCoursNonPlaces: true },
    }, timeoutMs);
    if (!Array.isArray(data?.listeElements) || !data.listeElements.length) throw new Error("FonctionDateDebutCours returned no course elements");

    const events: RawNormalizedEvent[] = [];
    for (const el of data.listeElements) for (const c of el.ListeCours ?? []) {
        // Unplaced/placeholder course (nbE === 0) -- no concrete position to
        // decode. Same convention as FonctionEmploiDuTemps's ListeCours (see
        // hyperplanning-decoder.test.ts's fixture); previously this branch had
        // no equivalent skip and would hard-fail the whole Hyperplanning
        // source the first time the API returned one of these.
        if (c.nbE === 0) continue;
        // typeof-narrows c.p/c.d to `number` for the rest of this iteration --
        // Number.isInteger() alone doesn't narrow (it's not a type predicate),
        // which is what decodePeriodPosition below needs.
        if (!c.N || typeof c.p !== "number" || !Number.isInteger(c.p) || typeof c.d !== "number" || !Number.isInteger(c.d)) {
            throw new Error("Malformed Hyperplanning session");
        }
        const ws = weeks(c.dom); if (!ws.length) throw new Error("Hyperplanning session has no weeks");
        // Delegate to the same validated position math as decoder.ts's
        // decodePeriodPosition (p >= 0, d > 0, day/end-of-day bounds) instead
        // of a duplicated, weaker inline version -- the duplicate was missing
        // the p >= 0 check, so a negative p could previously decode to a wrong
        // day silently rather than throwing.
        let position: { dayIndex: number; startMinutes: number; endMinutes: number };
        try {
            position = decodePeriodPosition(c.p, c.d, period.placesParJour);
        } catch (err) {
            throw err instanceof HyperplanningDecodeError
                ? new Error(`Invalid Hyperplanning session position: ${err.message}`)
                : err;
        }
        const { dayIndex: day, startMinutes: start, endMinutes: end } = position;
        const m = metadata.get(c.N), subject = m?.subject ?? el.L ?? "Matière à préciser";
        for (const w of ws) {
            const date = addDaysToDateString(period.premierLundi, (w - 1) * 7 + day);
            if (date < period.premierLundi || date > period.derniereDate) throw new Error("Decoded date outside Hyperplanning period");
            const sh = Math.floor(start / 60), sm = start % 60, eh = Math.floor(end / 60), em = end % 60;
            const s = zonedTimeToUtc(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10), sh, sm, 0, timezone);
            const e = zonedTimeToUtc(+date.slice(0, 4), +date.slice(5, 7), +date.slice(8, 10), eh, em, 0, timezone);
            if (e <= s) throw new Error("Decoded session has invalid duration");
            events.push({ uid: `hyperplanning:${c.N}:${date}:${start}`, recurrenceKey: date, summary: m?.type ? `${subject} (${m.type})` : subject, startUtc: s, endUtc: e, sourceTimezone: timezone, wasFloating: false, location: m?.room ?? null });
        }
    }
    if (!events.length) throw new Error("FonctionDateDebutCours decoded zero sessions");
    return events;
}
function fr(iso: string) { const [y, m, d] = iso.split("-"); return `${d}/${Number(m)}/${y}`; }