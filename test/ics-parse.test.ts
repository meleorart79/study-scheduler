import { describe, it, expect } from "vitest";
import { parseIcsFeed } from "../src/ics-input/parse.js";

const TZ = "Europe/Paris";

function range(startIso: string, endIso: string) {
  return { rangeStartUtc: new Date(startIso), rangeEndUtc: new Date(endIso), fallbackTimezone: TZ };
}

describe("ICS parsing", () => {
  it("parses a simple UTC one-off event", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-1@example.com
SUMMARY:Algorithms Lecture
DTSTART:20260910T090000Z
DTEND:20260910T110000Z
LOCATION:Room 101
END:VEVENT
END:VCALENDAR`;
    const { events, warnings } = parseIcsFeed(ics, range("2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z"));
    expect(warnings).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid: "evt-1@example.com",
      summary: "Algorithms Lecture",
      location: "Room 101",
      wasFloating: false,
    });
    expect(events[0]!.startUtc.toISOString()).toBe("2026-09-10T09:00:00.000Z");
  });

  it("parses a TZID-qualified (zoned) event correctly across DST", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:zoned-1
SUMMARY:Databases TD
DTSTART;TZID=Europe/Paris:20260715T140000
DTEND;TZID=Europe/Paris:20260715T160000
END:VEVENT
END:VCALENDAR`;
    const { events } = parseIcsFeed(ics, range("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z"));
    expect(events).toHaveLength(1);
    // CEST = UTC+2 in July
    expect(events[0]!.startUtc.toISOString()).toBe("2026-07-15T12:00:00.000Z");
    expect(events[0]!.wasFloating).toBe(false);
    expect(events[0]!.sourceTimezone).toBe("Europe/Paris");
  });

  it("treats a floating (no TZID, no Z) event as being in the fallback timezone", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:floating-1
SUMMARY:Networks Lab
DTSTART:20260112T100000
DTEND:20260112T120000
END:VEVENT
END:VCALENDAR`;
    const { events } = parseIcsFeed(ics, range("2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z"));
    expect(events).toHaveLength(1);
    expect(events[0]!.wasFloating).toBe(true);
    // Winter, Europe/Paris = UTC+1
    expect(events[0]!.startUtc.toISOString()).toBe("2026-01-12T09:00:00.000Z");
  });

  it("expands a WEEKLY RRULE with BYDAY into individual occurrences", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:weekly-1
SUMMARY:Algorithms Lecture
DTSTART;TZID=Europe/Paris:20260907T090000
DTEND;TZID=Europe/Paris:20260907T110000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6
END:VEVENT
END:VCALENDAR`;
    const { events } = parseIcsFeed(ics, range("2026-09-01T00:00:00Z", "2026-10-15T00:00:00Z"));
    expect(events).toHaveLength(6);
    // First occurrence should be the Monday DTSTART itself.
    expect(events[0]!.startUtc.toISOString()).toBe("2026-09-07T07:00:00.000Z");
    // All occurrences 2h long, on Mon/Wed only.
    for (const e of events) {
      const dow = new Date(e.startUtc).getUTCDay();
      expect([1, 3]).toContain(dow);
      expect(e.recurrenceKey).not.toBeNull();
    }
  });

  it("respects EXDATE exclusions on a recurring series", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:weekly-exdate
SUMMARY:Networks Lecture
DTSTART;TZID=Europe/Paris:20260907T090000
DTEND;TZID=Europe/Paris:20260907T110000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4
EXDATE;TZID=Europe/Paris:20260921T090000
END:VEVENT
END:VCALENDAR`;
    const { events } = parseIcsFeed(ics, range("2026-09-01T00:00:00Z", "2026-10-15T00:00:00Z"));
    expect(events).toHaveLength(3);
    expect(events.some((e) => e.recurrenceKey === "2026-09-21")).toBe(false);
  });

  it("applies a RECURRENCE-ID override (time/room change for one instance)", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:weekly-override
SUMMARY:Networks Lecture
DTSTART;TZID=Europe/Paris:20260907T090000
DTEND;TZID=Europe/Paris:20260907T110000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3
END:VEVENT
BEGIN:VEVENT
UID:weekly-override
RECURRENCE-ID;TZID=Europe/Paris:20260914T090000
SUMMARY:Networks Lecture (moved)
DTSTART;TZID=Europe/Paris:20260914T130000
DTEND;TZID=Europe/Paris:20260914T150000
END:VEVENT
END:VCALENDAR`;
    const { events } = parseIcsFeed(ics, range("2026-09-01T00:00:00Z", "2026-10-15T00:00:00Z"));
    expect(events).toHaveLength(3);
    const moved = events.find((e) => e.summary.includes("moved"));
    expect(moved).toBeDefined();
    expect(moved!.startUtc.toISOString()).toBe("2026-09-14T11:00:00.000Z");
  });

  it("skips a malformed event (missing DTSTART) with a warning, keeps the rest", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:bad-1
SUMMARY:Broken Event
DTEND:20260910T110000Z
END:VEVENT
BEGIN:VEVENT
UID:good-1
SUMMARY:Fine Event
DTSTART:20260910T090000Z
DTEND:20260910T100000Z
END:VEVENT
END:VCALENDAR`;
    const { events, warnings } = parseIcsFeed(ics, range("2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z"));
    expect(events).toHaveLength(1);
    expect(events[0]!.uid).toBe("good-1");
    expect(warnings.some((w) => w.message.includes("malformed"))).toBe(true);
  });

  it("generates a synthetic UID and warns when UID is missing", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:No UID Event
DTSTART:20260910T090000Z
DTEND:20260910T100000Z
END:VEVENT
END:VCALENDAR`;
    const { events, warnings } = parseIcsFeed(ics, range("2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z"));
    expect(events).toHaveLength(1);
    expect(events[0]!.uid).toMatch(/^generated-/);
    expect(warnings.some((w) => w.message.includes("missing UID"))).toBe(true);
  });

  it("warns and skips the repeat on a duplicate UID for non-recurring events", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:dup-1
SUMMARY:First
DTSTART:20260910T090000Z
DTEND:20260910T100000Z
END:VEVENT
BEGIN:VEVENT
UID:dup-1
SUMMARY:Second (duplicate uid)
DTSTART:20260911T090000Z
DTEND:20260911T100000Z
END:VEVENT
END:VCALENDAR`;
    const { events, warnings } = parseIcsFeed(ics, range("2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z"));
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe("First");
    expect(warnings.some((w) => w.message.includes("Duplicate UID"))).toBe(true);
  });

  it("filters occurrences outside the requested range", () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:out-of-range
SUMMARY:Far Future Event
DTSTART:20270101T090000Z
DTEND:20270101T100000Z
END:VEVENT
END:VCALENDAR`;
    const { events } = parseIcsFeed(ics, range("2026-09-01T00:00:00Z", "2026-12-01T00:00:00Z"));
    expect(events).toHaveLength(0);
  });
});
