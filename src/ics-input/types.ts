export interface RawNormalizedEvent {
  uid: string;
  /** Local-date key ("YYYY-MM-DD") of the original recurrence slot, or null if not recurring. */
  recurrenceKey: string | null;
  summary: string;
  startUtc: Date;
  endUtc: Date;
  sourceTimezone: string | null;
  wasFloating: boolean;
  location: string | null;
}

export interface ParseWarning {
  message: string;
  uid: string | null;
}

export interface ParseResult {
  events: RawNormalizedEvent[];
  warnings: ParseWarning[];
}
