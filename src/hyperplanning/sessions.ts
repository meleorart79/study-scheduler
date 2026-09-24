import type { RawNormalizedEvent } from "../ics-input/types.js";
import { addDaysToDateString, zonedTimeToUtc } from "../util/timezone.js";
import { hyperplanningRequest, type HyperplanningSession } from "./session.js";
import type { HyperplanningCourseMeta } from "./types.js";

interface DateSessionResponse {
  PeriodeConsultation?: { V?: string };
  listeElements?: Array<{
    L?: string;
    N?: string;
    ListeCours?: Array<{
      N?: string;
      p?: number;
      d?: number;
      dom?: { V?: string } | string;
    }>;
  }>;
}

export interface HyperplanningAcademicPeriod {
  premierLundi: string;
  derniereDate: string;
  placesParJour: number;
}

function parseWeeks(value: string | { V?: string } | undefined): number[] {
  const text = typeof value === "string" ? value : value?.V;
  if (!text) return [];
  const inner = text.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  const out: number[] = [];
  for (const token of inner.split(",")) {
    const t = token.trim();
    const range = /^(\d+)\.\.(\d+)$/.exec(t);
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n++) out.push(n);
    } else if (/^\d+$/.test(t)) out.push(Number(t));
    else throw new Error(`Invalid Hyperplanning week set: ${t}`);
  }
  return [...new Set(out)];
}

export async function fetchAcademicSessions(
  session: HyperplanningSession,
  group: { L: string; N: string; G: number },
  filter: string,
  period: HyperplanningAcademicPeriod,
  timeoutMs: number,
): Promise<RawNormalizedEvent[]> {
  const data = await hyperplanningRequest<DateSessionResponse>(
    session,
    "FonctionDateDebutCours",
    {
      Signature: {
        Onglet: "DIPLOME.RECAPCOURS",
        listeRecherche: [group],
      },
      avecDetailSeances: true,
      FiltreRessources: { _T: 26, V: filter },
      dateDebutConsultation: { _T: 7, V: `${dateToFrench(period.premierLundi)} 0:0:0` },
      dateFinConsultation: { _T: 7, V: `${dateToFrench(period.derniereDate)} 0:0:0` },
      avecCoursNonPlaces: true,
    },
    timeoutMs,
  );

  if (!Array.isArray(data?.listeElements) || !data.listeElements.length) {
    throw new Error("FonctionDateDebutCours returned no course elements");
  }

  const events: RawNormalizedEvent[] = [];
  const metadataByCourse = new Map<string, HyperplanningCourseMeta>();
  // The full-year endpoint deliberately omits labels; metadata is supplied
  // separately by the timetable endpoint and keyed by stable course N.
  for (const element of data.listeElements) {
    const subject = element.L ?? "Matière à préciser";
    for (const course of element.ListeCours ?? []) {
      if (course.N) metadataByCourse.set(course.N, {
        subject, teacher: null, room: null, type: null, group: group.L,
      });
    }
  }

  // metadataByCourse is only a fallback; the caller enriches the returned
  // events with the timetable map because rooms/teachers can vary by session.
  for (const element of data.listeElements) {
    const subject = element.L ?? "Matière à préciser";
    for (const course of element.ListeCours ?? []) {
      if (!course.N || !Number.isInteger(course.p) || !Number.isInteger(course.d)) {
        throw new Error("FonctionDateDebutCours contained a malformed course session");
      }
      const weeks = parseWeeks(course.dom);
      if (!weeks.length) throw new Error(`Course ${course.N} has no session weeks`);

      const dayIndex = Math.floor(course.p / period.placesParJour);
      const slotIndex = course.p % period.placesParJour;
      const startMinutes = 8 * 60 + slotIndex * 15;
      const endMinutes = startMinutes + course.d * 15;
      if (dayIndex < 0 || dayIndex > 6 || course.d <= 0 || endMinutes > 24 * 60) {
        throw new Error(`Invalid Hyperplanning session position p=${course.p} d=${course.d}`);
      }

      for (const week of weeks) {
        if (week < 1) throw new Error(`Invalid Hyperplanning week ${week}`);
        const date = addDaysToDateString(
          period.premierLundi,
          (week - 1) * 7 + dayIndex,
        );
        if (date < period.premierLundi || date > period.derniereDate) {
          throw new Error(`Decoded Hyperplanning date ${date} outside requested period`);
        }
        const sh = Math.floor(startMinutes / 60);
        const sm = startMinutes % 60;
        const eh = Math.floor(endMinutes / 60);
        const em = endMinutes % 60;
        const startUtc = zonedTimeToUtc(
          Number(date.slice(0,4)), Number(date.slice(5,7)), Number(date.slice(8,10)),
          sh, sm, 0, "Europe/Paris",
        );
        const endUtc = zonedTimeToUtc(
          Number(date.slice(0,4)), Number(date.slice(5,7)), Number(date.slice(8,10)),
          eh, em, 0, "Europe/Paris",
        );
        if (endUtc <= startUtc) throw new Error(`Decoded session has end <= start: ${course.N}`);

        events.push({
          uid: `hyperplanning:${course.N}:${date}:${startMinutes}`,
          recurrenceKey: date,
          summary: subject,
          startUtc,
          endUtc,
          sourceTimezone: "Europe/Paris",
          wasFloating: false,
          location: null,
        });
      }
    }
  }
  return events;
}

function dateToFrench(iso: string): string {
  const [y,m,d] = iso.split("-");
  return `${d}/${Number(m)}/${y}`;
}
