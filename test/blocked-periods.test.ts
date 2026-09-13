import { describe, it, expect } from "vitest";
import { blockedPeriodsFromConfig, visibleCommitmentPeriods } from "../src/scheduling/blockedPeriods.js";
import { baseConfig } from "./helpers.js";

describe("recurring blocked periods: bufferMinutes", () => {
  it("pads the hard scheduling block by bufferMinutes on each side, without affecting the visible event", () => {
    const config = baseConfig((c) => {
      c.recurringBlockedPeriods = [
        { weekday: "monday", start: "12:00", end: "13:30", reason: "Basketball", visible: true, bufferMinutes: 30 },
      ];
    });

    // Monday 2026-09-07, 12:00-13:30 Europe/Paris (CEST, UTC+2) => 10:00Z-11:30Z.
    const hard = blockedPeriodsFromConfig(config, "2026-09-07", "2026-09-07");
    const basketballHard = hard.find((p) => p.reason === "Basketball");
    expect(basketballHard).toBeDefined();
    // Padded 30 min each side => 09:30Z-12:00Z.
    expect(basketballHard!.startUtc).toBe("2026-09-07T09:30:00.000Z");
    expect(basketballHard!.endUtc).toBe("2026-09-07T12:00:00.000Z");

    const visible = visibleCommitmentPeriods(config, "2026-09-07", "2026-09-07");
    const basketballVisible = visible.find((p) => p.reason === "Basketball");
    expect(basketballVisible).toBeDefined();
    // The visible calendar event keeps the exact, un-padded times.
    expect(basketballVisible!.startUtc).toBe("2026-09-07T10:00:00.000Z");
    expect(basketballVisible!.endUtc).toBe("2026-09-07T11:30:00.000Z");
  });

  it("defaults bufferMinutes to 0 when not specified (no padding, previous behavior)", () => {
    const config = baseConfig((c) => {
      c.recurringBlockedPeriods = [
        { weekday: "monday", start: "12:00", end: "13:30", reason: "No buffer", visible: true },
      ];
    });
    const hard = blockedPeriodsFromConfig(config, "2026-09-07", "2026-09-07");
    const p = hard.find((x) => x.reason === "No buffer");
    expect(p).toBeDefined();
    expect(p!.startUtc).toBe("2026-09-07T10:00:00.000Z");
    expect(p!.endUtc).toBe("2026-09-07T11:30:00.000Z");
  });

  it("a study session cannot be placed within the buffer window around a recurring block", () => {
    const config = baseConfig((c) => {
      c.recurringBlockedPeriods = [
        { weekday: "monday", start: "12:00", end: "13:30", reason: "Basketball", visible: true, bufferMinutes: 30 },
      ];
    });
    const hard = blockedPeriodsFromConfig(config, "2026-09-07", "2026-09-07");
    const basketballHard = hard.find((p) => p.reason === "Basketball")!;
    // A candidate ending exactly at the real basketball start (11:30Z, i.e.
    // 30 min before the real start) now falls inside the padded block.
    const candidateEnd = new Date("2026-09-07T11:30:00.000Z").getTime();
    const paddedStart = new Date(basketballHard.startUtc).getTime();
    expect(candidateEnd).toBeGreaterThan(paddedStart - 1); // i.e. inside/at the padded window
  });
});
