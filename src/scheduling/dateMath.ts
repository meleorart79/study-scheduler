/** Integer day difference between two "YYYY-MM-DD" strings (b - a). */
export function dayDiff(aDate: string, bDate: string): number {
  const a = Date.UTC(...splitDate(aDate));
  const b = Date.UTC(...splitDate(bDate));
  return Math.round((b - a) / 86_400_000);
}

function splitDate(dateStr: string): [number, number, number] {
  const [y, m, d] = dateStr.split("-").map(Number);
  return [y!, m! - 1, d!];
}
