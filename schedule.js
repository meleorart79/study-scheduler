// schedule.js
//
// The sole source of truth for assessments and academic blackout periods.
// The scheduler never infers exams from the university ICS feed — it only
// reads this file. Edit this file and hit POST /admin/regenerate (or wait
// for the 05:00 Europe/Paris cron) to pick up changes.
//
// Dates without an explicit timezone are interpreted as Europe/Paris.
//
// `type` is a free-text label. Only types listed under
// `assessments.protectedTypes` in your config (default: ["partiel"])
// create an exam-protection blackout.
//
// For multi-day assessment periods, startTime/endTime are null so the
// entire day is protected.

const EXAM_SCHEDULE = [
    {
        id: "s1-partiels-1",
        subject: "Semester 1",
        type: "partiel",
        date: "2026-10-19",
        startTime: null,
        endTime: null,
        title: "Partiels 1 — 19–23 October",
    },
    {
        id: "s1-partiels-2",
        subject: "Semester 1",
        type: "partiel",
        date: "2026-12-14",
        startTime: null,
        endTime: null,
        title: "Partiels 2 — 14–18 December",
    },
    {
        id: "s2-partiels-1",
        subject: "Semester 2",
        type: "partiel",
        date: "2027-03-15",
        startTime: null,
        endTime: null,
        title: "Partiels 1 — 15–19 March",
    },
    {
        id: "s2-partiels-2",
        subject: "Semester 2",
        type: "partiel",
        date: "2027-05-24",
        startTime: null,
        endTime: null,
        title: "Partiels 2 — 24–28 May",
    },
];

const SEMESTER_START = "2026-09-01";

module.exports = { EXAM_SCHEDULE, SEMESTER_START };