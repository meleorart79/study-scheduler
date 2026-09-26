import type { RawNormalizedEvent } from "../ics-input/types.js";
import { addDaysToDateString, zonedTimeToUtc } from "../util/timezone.js";
import { hyperplanningRequest, type HyperplanningSession } from "./session.js";
import type { HyperplanningCourseMeta } from "./types.js";

interface DateSessionResponse { listeElements?: Array<{ L?: string; ListeCours?: Array<{ N?: string; p?: number; d?: number; dom?: { V?: string } | string }> }> }
export interface HyperplanningAcademicPeriod { premierLundi: string; derniereDate: string; placesParJour: number }

function weeks(value: string | { V?: string } | undefined): number[] {
  const text = typeof value === "string" ? value : value?.V;
  if (!text) return [];
  const out: number[] = [];
  for (const t of text.replace(/^\[/,"").replace(/\]$/,"").split(",")) {
    const r = /^(\d+)\.\.(\d+)$/.exec(t.trim());
    if (r) for (let n=+r[1]!; n<=+r[2]!; n++) out.push(n);
    else if (/^\d+$/.test(t.trim())) out.push(+t.trim());
    else throw new Error("Invalid Hyperplanning week set");
  }
  return [...new Set(out)];
}

export async function fetchAcademicSessions(
  session: HyperplanningSession,
  group: {L:string;N:string;G:number},
  filter: string,
  period: HyperplanningAcademicPeriod,
  metadata: Map<string, HyperplanningCourseMeta>,
  timezone: string,
  timeoutMs: number,
): Promise<RawNormalizedEvent[]> {
  const data = await hyperplanningRequest<DateSessionResponse>(session, "FonctionDateDebutCours", {
    Signature: {Onglet:"DIPLOME.RECAPCOURS", listeRecherche:[group]},
    data: {avecDetailSeances:true, FiltreRessources:{_T:26,V:filter}, dateDebutConsultation:{_T:7,V:`${fr(period.premierLundi)} 0:0:0`}, dateFinConsultation:{_T:7,V:`${fr(period.derniereDate)} 0:0:0`}, avecCoursNonPlaces:true},
  }, timeoutMs);
  if (!Array.isArray(data?.listeElements) || !data.listeElements.length) throw new Error("FonctionDateDebutCours returned no course elements");

  const events: RawNormalizedEvent[] = [];
    for (const el of data.listeElements) for (const c of el.ListeCours ?? []) {
        if (!c.N || !Number.isInteger(c.p) || !Number.isInteger(c.d))
            throw new Error("Malformed Hyperplanning session");

        const p = c.p!;
        const d = c.d!;

        const day = Math.floor(p / period.placesParJour);
        const slot = p % period.placesParJour;

        const start = 8 * 60 + slot * 15;
        const end = start + d * 15;

        if (day > 6 || d <= 0 || end > 1440)
            throw new Error("Invalid Hyperplanning session position");

        const m = metadata.get(c.N);
        const subject = m?.subject ?? el.L ?? "Matière à préciser";

        const ws = weeks(c.dom);
        if (!ws.length)
            throw new Error("Hyperplanning session has no weeks");

        for (const w of ws) {
            const date = addDaysToDateString(
                period.premierLundi,
                (w - 1) * 7 + day
            );

            if (date < period.premierLundi || date > period.derniereDate)
                throw new Error("Decoded date outside Hyperplanning period");

            const sh = Math.floor(start / 60);
            const sm = start % 60;
            const eh = Math.floor(end / 60);
            const em = end % 60;

            const s = zonedTimeToUtc(
                +date.slice(0, 4),
                +date.slice(5, 7),
                +date.slice(8, 10),
                sh, sm, 0, timezone
            );

            const e = zonedTimeToUtc(
                +date.slice(0, 4),
                +date.slice(5, 7),
                +date.slice(8, 10),
                eh, em, 0, timezone
            );

            if (e <= s)
                throw new Error("Decoded session has invalid duration");

            events.push({
                uid: `hyperplanning:${c.N}:${date}:${start}`,
                recurrenceKey: date,
                summary: m?.type ? `${subject} (${m.type})` : subject,
                startUtc: s,
                endUtc: e,
                sourceTimezone: timezone,
                wasFloating: false,
                location: m?.room ?? null,
            });
        }
    }
  if (!events.length) throw new Error("FonctionDateDebutCours decoded zero sessions");
  return events;
}
function fr(iso:string){const [y,m,d]=iso.split("-");return `${d}/${Number(m)}/${y}`;}
