import { describe, expect, it } from 'vitest';
import { calendarDaysBetween, entriesForDay, parseDateKey, addDays } from './local-date';

describe('local dates', () => {
  it('includes midnight regardless of fractional seconds or UTC offset formatting', () => {
    const midnight = parseDateKey('2026-09-06');
    const start = midnight.toISOString();
    const next = addDays(midnight, 1).toISOString();
    const result = entriesForDay(
      [
        { id: 'start', kcal_delta: 100, happened_at: start.replace('.000Z', 'Z') },
        { id: 'offset', kcal_delta: 100, happened_at: start.replace('Z', '+00:00') },
        { id: 'end', kcal_delta: 100, happened_at: new Date(Date.parse(next) - 1).toISOString() },
        { id: 'tomorrow', kcal_delta: 100, happened_at: next },
      ],
      '2026-09-06',
    );
    expect(result.map((entry) => entry.id)).toEqual(['end', 'start', 'offset']);
  });

  it('counts calendar days across daylight-saving and year boundaries', () => {
    expect(calendarDaysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(calendarDaysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(calendarDaysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });
});
