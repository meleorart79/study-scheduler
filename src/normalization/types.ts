export interface RawSourceEventCandidate {
  uid: string;
  recurrenceKey: string | null;
  summary: string;
  startUtc: Date;
  endUtc: Date;
  sourceTimezone: string | null;
  wasFloating: boolean;
  location: string | null;
}
