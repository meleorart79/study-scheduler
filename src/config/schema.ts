import { z } from "zod";

const timeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm 24h time");

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
        targetOffsetDays: z.number().int(),
        flexibilityDays: z.number().int().nonnegative(),
      })
    )
    .min(1),
  workload: z.object({
    preferredDailyMinutes: z.number().int().positive().default(180),
    maxDailyMinutes: z.number().int().positive().default(270),
    classLoadAdjustment: z.object({
      enabled: z.boolean().default(true),
      minutesReducedPerClassHour: z.number().nonnegative().default(30),
      floorMinutes: z.number().nonnegative().default(30),
    }),
  }),
  assessments: z.object({
    file: z.string().min(1),
    protectedTypes: z.array(z.string()).default([]),
  }),
  blockedPeriods: z
    .array(
      z.object({
        startUtc: z.string().min(1),
        endUtc: z.string().min(1),
        reason: z.string().min(1),
      })
    )
    .default([]),
  examProtection: z.object({
    scope: z.literal("all-subjects").default("all-subjects"),
    blackoutDays: z.number().int().nonnegative().default(7),
    pullForwardMaxDays: z.number().int().nonnegative().default(6),
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
