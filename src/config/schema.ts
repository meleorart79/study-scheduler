import { z } from "zod";

const timeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm 24h time");

const weekdayEnum = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

const timeWindowSchema = z
  .object({
    start: timeString,
    end: timeString,
  })
  .refine((w) => w.start < w.end, {
    message: "window start must be before end",
  });

export const configSchema = z.object({
  timezone: z.string().min(1),
  sourceFeed: z
    .object({
      url: z.string().url().optional(),
      file: z.string().min(1).optional(),
      fetchTimeoutSeconds: z.number().int().positive().default(15),
      maxResponseBytes: z.number().int().positive().default(5_000_000),
    })
    .refine((v) => !!v.url !== !!v.file, {
      message:
        "sourceFeed: set exactly one of `url` (fetch over HTTP) or `file` (read a local .ics file), not both/neither",
    }),
  studyWindows: z.object({
    weekdays: z.array(timeWindowSchema).min(1),
    weekends: z.array(timeWindowSchema).min(1),
  }),
  grid: z.object({
    blockMinutes: z.number().int().positive().default(15),
    sessionMinutes: z.number().int().positive().default(90),
    minBufferMinutes: z.number().int().nonnegative().default(15),
  }),
    reviews: z
        .array(
            z.object({
                name: z.string().min(1),
                targetOffsetDays: z.number().int().default(0),
                flexibilityDays: z.number().int().nonnegative().default(0),
                /** First-fit mode: ignore target/flexibility, take first free slot. */
                anySlot: z.boolean().default(false),
            })
        )
        .min(1),
  workload: z.object({
    preferredDailyMinutes: z.number().int().positive().default(180),
    maxDailyMinutes: z.number().int().positive().nullable().default(null),
    classLoadAdjustment: z.object({
      enabled: z.boolean().default(true),
      minutesReducedPerClassHour: z.number().nonnegative().default(30),
      floorMinutes: z.number().nonnegative().default(30),
    }),
    compactionBonusDays: z.number().nonnegative().default(1),
  }),
  classWeighting: z
    .object({
      defaultWeight: z.number().positive().default(1),
      rules: z
        .array(
          z.object({
            pattern: z.string().min(1),
            weight: z.number().nonnegative(),
          })
        )
        .default([]),
    })
    .default({ defaultWeight: 1, rules: [] }),
  assessments: z.object({
    file: z.string().min(1),
    protectedTypes: z.array(z.string()).default([]),
  }),
  blockedPeriods: z
    .array(
      z.object({
        startUtc: z.string().min(1),
        endUtc: z.string().min(1),
        visible: z.boolean().default(true),
        reason: z.string().min(1),
      })
    )
    .default([]),
  recurringBlockedPeriods: z
    .array(
      z.object({
        weekday: weekdayEnum,
        start: timeString,
        end: timeString,
        reason: z.string().min(1),
        visible: z.boolean().default(true),
        // Scheduling-only margin padded onto each side of this block (see
        // RecurringBlockedPeriod in types.ts). Never shown on the calendar.
        bufferMinutes: z.number().int().nonnegative().default(0),
      })
    )
    .default([]),
  examProtection: z.object({
    scope: z.literal("all-subjects").default("all-subjects"),
    blackoutDays: z.number().int().nonnegative().default(7),
    pullForwardMaxDays: z.number().int().nonnegative().default(6),
    approachPenaltyDays: z.number().int().nonnegative().default(5),
    approachPenaltyWeight: z.number().nonnegative().default(2),
  }),
  horizon: z.object({
    lookaheadDays: z.number().int().positive().default(60),
    lookbackDays: z.number().int().nonnegative().default(14),
  }),
  regeneration: z.object({
    cronTime: timeString.default("05:00"),
    cronTimezone: z.string().default("Europe/Paris"),
  }),
});

export type ConfigInput = z.infer<typeof configSchema>;
