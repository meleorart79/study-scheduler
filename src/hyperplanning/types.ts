import type { RawNormalizedEvent } from "../ics-input/types.js";

export interface HyperplanningCourse {
  N: string;
  G: number;
  p: number;
  d: number;
  e: number;
  nbE?: number;
  dom?: string;
  listeC?: Array<{ G: number; C?: unknown }>;
}

export interface HyperplanningScheduleData {
  ListeCours: HyperplanningCourse[];
}

export interface HyperplanningCourseMeta {
  subject: string | null;
  teacher: string | null;
  room: string | null;
  type: string | null;
  group: string | null;
}

export interface HyperplanningDecoderOptions {
  academicWeek1Monday: string;
  timezone: string;
}

export interface DecodedHyperplanning {
  events: RawNormalizedEvent[];
  courseCount: number;
  expandedOccurrenceCount: number;
}
