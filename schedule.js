const EXAM_SCHEDULE = [
    {
        id: "s1-partiels-1",
        subject: "Semester 1",
        type: "partiel",
        date: "2026-10-19",
        endDate: "2026-10-23",
        startTime: null,
        endTime: null,
        title: "Partiels 1 — 19–23 October",
    },
    {
        id: "s1-partiels-2",
        subject: "Semester 1",
        type: "partiel",
        date: "2026-12-14",
        endDate: "2026-12-18",
        startTime: null,
        endTime: null,
        title: "Partiels 2 — 14–18 December",
    },
    {
        id: "s2-partiels-1",
        subject: "Semester 2",
        type: "partiel",
        date: "2027-03-15",
        endDate: "2027-03-19",
        startTime: null,
        endTime: null,
        title: "Partiels 1 — 15–19 March",
    },
    {
        id: "s2-partiels-2",
        subject: "Semester 2",
        type: "partiel",
        date: "2027-05-24",
        endDate: "2027-05-28",
        startTime: null,
        endTime: null,
        title: "Partiels 2 — 24–28 May",
    },
];

const HOLIDAYS_SCHEDULE = [
    { name: "Vacances d'automne", startDate: "2026-10-26T00:00:00", endDate: "2026-10-31T23:59:59" },
    { name: "Vacances de Noël", startDate: "2026-12-21T00:00:00", endDate: "2027-01-03T23:59:59" },
    { name: "Vacances d'hiver", startDate: "2027-02-15T00:00:00", endDate: "2027-02-21T23:59:59" },
    { name: "Vacances de printemps", startDate: "2027-04-05T00:00:00", endDate: "2027-04-18T23:59:59" },
];

const SEMESTER_START = "2026-09-01";

module.exports = { EXAM_SCHEDULE, HOLIDAYS_SCHEDULE, SEMESTER_START };