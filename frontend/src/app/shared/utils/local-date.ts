import type { KcalEntry } from '../../core/models/kcal.model';

export function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function toDateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDateKey(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00`);
}

export function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function startOfDay(date: Date): Date {
  return parseDateKey(toDateKey(date));
}

export function addDays(date: Date, days: number): Date {
  const result = startOfDay(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function toLocalDateKey(iso: string): string {
  return toDateKey(new Date(iso));
}

export function entriesForDay(entries: KcalEntry[], dateKey: string): KcalEntry[] {
  const from = parseDateKey(dateKey).getTime();
  const to = addDays(parseDateKey(dateKey), 1).getTime();
  return entries
    .filter((entry) => {
      const timestamp = Date.parse(entry.happened_at);
      return timestamp >= from && timestamp < to;
    })
    .sort((left, right) => Date.parse(right.happened_at) - Date.parse(left.happened_at));
}

// Count calendar dates, including days with a daylight-saving clock change.
export function calendarDaysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}
