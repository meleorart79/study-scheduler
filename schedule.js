// schedule.js
//
// The sole source of truth for assessments (exams, partiels, etc).
// The scheduler never infers exams from the university ICS feed — it only
// reads this file. Edit this file and hit POST /admin/regenerate (or wait
// for the 05:00 Europe/Paris cron) to pick up changes.
//
// Dates without an explicit timezone are interpreted as Europe/Paris.
//
// `type` is a free-text label. Only types listed under
// `assessments.protectedTypes` in your config (default: ["partiel"])
// create an exam-protection blackout. Other types (e.g. "quiz", "td") are
// still visible in /admin data but do not block scheduling.

const EXAM_SCHEDULE = [
  {
    id: "algo-partiel-1",
    subject: "Algorithms",
    type: "partiel",
    date: "2026-10-12",
    startTime: "09:00",
    endTime: "11:00",
    title: "Algorithms — Partiel 1",
  },
  {
    id: "dbs-quiz-1",
    subject: "Databases",
    type: "quiz",
    date: "2026-09-18",
    startTime: "14:00",
    endTime: "14:30",
    title: "Databases — Pop quiz",
  },
  {
    id: "networks-partiel-1",
    subject: "Networks",
    type: "partiel",
    date: "2026-11-03",
    startTime: null,
    endTime: null,
    title: "Networks — Partiel 1 (all-day protection)",
  },
];

const SEMESTER_START = "2026-09-01";

module.exports = { EXAM_SCHEDULE, SEMESTER_START };
