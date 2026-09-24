import { hyperplanningRequest, type HyperplanningSession } from "./session.js";
import type { HyperplanningCourse, HyperplanningCourseMeta } from "./types.js";

interface TimetableResponse { ListeCours?: HyperplanningCourse[]; }

function labelFrom(value: unknown): string | null {
  if (typeof value === "object" && value !== null) {
    const l = (value as Record<string, unknown>).L;
    if (typeof l === "string") return l;
  }
  return null;
}

export function extractCourseMeta(course: HyperplanningCourse): HyperplanningCourseMeta {
  const entries = course.listeC ?? [];
  const one = (g: number) => entries.find(x => x.G === g)?.C;
  const labels = (v: unknown): string | null => Array.isArray(v)
    ? v.map(labelFrom).filter((x): x is string => !!x).join(" / ") || null
    : labelFrom(v);
  return {
    subject: labels(one(0)),
    teacher: labels(one(1)),
    room: labels(one(3)),
    type: labels(one(7)),
    group: labels(one(14)),
  };
}

export async function fetchTimetable(
  session: HyperplanningSession,
  resource: { L: string; N: string; G: number },
  filter: string,
  timeoutMs: number,
): Promise<Map<string, HyperplanningCourseMeta>> {
  const data = await hyperplanningRequest<TimetableResponse>(session, "FonctionEmploiDuTemps", {
    Signature: { Onglet: "DIPLOME.EDT.EDT_GRILLE", listeRecherche: [resource] },
    data: {
      GenrePeriodeEDT: 2,
      GenreAffichageEDT: 0,
      FiltreRessources: { _T: 26, V: filter },
      AvecIndisponibilites: true,
      AvecDomaineCours: true,
      AvecDomainePere: false,
      filterPlagesHoraires: false,
      ignorerCoursAnnules: false,
      avecInfosAppel: false,
      Domaine: { _T: 8, V: "[6]" },
    },
  }, timeoutMs);

  if (!Array.isArray(data?.ListeCours)) throw new Error("Hyperplanning timetable response has no ListeCours");
  const result = new Map<string, HyperplanningCourseMeta>();
  for (const course of data.ListeCours) if (course?.N) result.set(course.N, extractCourseMeta(course));
  if (!result.size) throw new Error("Hyperplanning timetable response contained no courses");
  return result;
}
