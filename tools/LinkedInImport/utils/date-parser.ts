// Multi-format date parser for LinkedIn export dates
// Formats seen in data:
//   "2026-02-19 22:38:09 UTC"  — messages.csv
//   "2023/01/14 11:25:34 UTC"  — endorsements
//   "7/7/24, 8:22 AM"          — job applications
//   "07/28/20, 08:42 PM"       — recommendations
//   "06/18/20, 04:00 PM"       — recommendations
//   "Feb 21 04:06"             — potential format
//   "YYYY-MM-DD"               — ISO date

export function parseDate(dateStr: string): Date | null {
  if (!dateStr || dateStr.trim() === "") return null;

  const s = dateStr.trim();

  // Format: "2026-02-19 22:38:09 UTC" or "2023/01/14 11:25:34 UTC"
  const isoLikeMatch = s.match(
    /^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+UTC$/i
  );
  if (isoLikeMatch) {
    const [, year, month, day, hour, min, sec] = isoLikeMatch;
    return new Date(
      `${year}-${month}-${day}T${hour}:${min}:${sec}.000Z`
    );
  }

  // Format: "7/7/24, 8:22 AM" or "07/28/20, 08:42 PM"
  const usDateMatch = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?$/i
  );
  if (usDateMatch) {
    const [, month, day, yearStr, hourStr, min, ampm] = usDateMatch;
    let year = parseInt(yearStr, 10);
    if (year < 100) year += year >= 50 ? 1900 : 2000;
    let hour = parseInt(hourStr, 10);
    if (ampm) {
      const ispm = ampm.toUpperCase() === "PM";
      if (ispm && hour !== 12) hour += 12;
      if (!ispm && hour === 12) hour = 0;
    }
    const d = new Date(year, parseInt(month, 10) - 1, parseInt(day, 10), hour, parseInt(min, 10));
    return isNaN(d.getTime()) ? null : d;
  }

  // Format: "2026-02-19" (ISO date only)
  const isoDayMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDayMatch) {
    return new Date(`${s}T12:00:00.000Z`);
  }

  // Attempt generic Date.parse as last resort
  const parsed = Date.parse(s);
  if (!isNaN(parsed)) return new Date(parsed);

  return null;
}

// Format a Date as ISO8601 date string (YYYY-MM-DD)
export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Format a Date as full ISO8601 string
export function toISO(date: Date): string {
  return date.toISOString();
}

// Check if a date is within N days from a reference date
export function isWithinDays(date: Date, refDate: Date, days: number): boolean {
  const diffMs = refDate.getTime() - date.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= days;
}

// Check if date is in February 2026 (layoff period)
export function isLayoffPeriod(date: Date): boolean {
  return date.getFullYear() === 2026 && date.getMonth() === 1; // February = 1
}
