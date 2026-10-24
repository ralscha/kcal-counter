import { describe, expect, it } from 'vitest';
import type { KcalEntry, KcalTarget } from '../../core/models/kcal.model';
import {
  buildDailyStatistics,
  createPeriodSummarizer,
  summarizePeriod,
  targetForDate,
} from './kcal-statistics';

const targets: KcalTarget[] = [
  { id: 'a', effective_from: '2026-10-01', kcal_limit: 2000 },
  { id: 'b', effective_from: '2026-10-03', kcal_limit: 2200 },
];
const entry = (date: string, kcal: number): KcalEntry => ({
  id: date,
  happened_at: new Date(`${date}T12:00:00`).toISOString(),
  kcal_delta: kcal,
});

describe('dated calorie statistics', () => {
  it('uses the target effective on each day, independent of array order', () => {
    expect(targetForDate([...targets].reverse(), '2026-10-02')).toBe(2000);
    expect(targetForDate(targets, '2026-09-30')).toBeNull();
    expect(targetForDate(targets, '2026-10-04')).toBe(2200);
    expect(
      summarizePeriod(
        [entry('2026-10-01', 2000), entry('2026-10-03', 2200)],
        targets,
        '2026-10-01',
        '2026-10-03',
      ),
    ).toEqual({
      days: 3,
      loggedDays: 2,
      total: 4200,
      average: 1400,
      targetDays: 3,
      targetTotal: 6200,
      difference: -2000,
    });
  });

  it('does not report a full-period difference when a target is missing or disabled', () => {
    const disabled = [...targets, { id: 'c', effective_from: '2026-10-04', kcal_limit: null }];
    expect(summarizePeriod([], disabled, '2026-10-01', '2026-10-05')).toMatchObject({
      targetDays: 3,
      targetTotal: 6200,
      difference: null,
    });
    expect(summarizePeriod([], targets, '2026-09-30', '2026-10-02').difference).toBeNull();
  });

  it('reuses prepared history across ranges before, during, and after disabled targets', () => {
    const summarize = createPeriodSummarizer(
      [
        entry('2026-10-07', 1200),
        entry('2026-10-01', 2300),
        entry('2026-09-30', 500),
        entry('2026-10-01', -300),
        entry('2026-10-03', 2200),
        entry('2026-10-05', 300),
        entry('2026-10-05', -300),
      ],
      [
        { id: 'd', effective_from: '2026-10-07', kcal_limit: 1800 },
        { id: 'c', effective_from: '2026-10-04', kcal_limit: null },
        ...targets.slice().reverse(),
      ],
    );
    const cases = [
      {
        start: '2026-09-28',
        end: '2026-09-29',
        days: 2,
        loggedDays: 0,
        total: 0,
        targetDays: 0,
        targetTotal: 0,
        difference: null,
      },
      {
        start: '2026-09-30',
        end: '2026-10-02',
        days: 3,
        loggedDays: 2,
        total: 2500,
        targetDays: 2,
        targetTotal: 4000,
        difference: null,
      },
      {
        start: '2026-10-01',
        end: '2026-10-03',
        days: 3,
        loggedDays: 2,
        total: 4200,
        targetDays: 3,
        targetTotal: 6200,
        difference: -2000,
      },
      {
        start: '2026-10-04',
        end: '2026-10-06',
        days: 3,
        loggedDays: 1,
        total: 0,
        targetDays: 0,
        targetTotal: 0,
        difference: null,
      },
      {
        start: '2026-10-07',
        end: '2026-10-08',
        days: 2,
        loggedDays: 1,
        total: 1200,
        targetDays: 2,
        targetTotal: 3600,
        difference: -2400,
      },
      {
        start: '2026-09-30',
        end: '2026-10-08',
        days: 9,
        loggedDays: 5,
        total: 5900,
        targetDays: 5,
        targetTotal: 9800,
        difference: null,
      },
    ];
    for (const { start, end, ...expected } of cases) {
      expect(summarize(start, end)).toEqual({
        ...expected,
        average: expected.total / expected.days,
      });
    }
    expect(summarize('2026-10-01', '2026-10-01').difference).toBe(0);
    expect(() => summarize('2026-10-02', '2026-10-01')).toThrow('valid');
  });

  it('supports empty histories and the full supported date boundaries', () => {
    const summarize = createPeriodSummarizer(
      [],
      [
        { id: 'first', effective_from: '0001-01-01', kcal_limit: 100 },
        { id: 'last', effective_from: '9999-12-31', kcal_limit: 200 },
      ],
    );
    expect(summarize('0001-01-01', '0001-01-01')).toMatchObject({
      days: 1,
      loggedDays: 0,
      targetDays: 1,
      targetTotal: 100,
      difference: -100,
    });
    expect(summarize('9999-12-30', '9999-12-31')).toMatchObject({
      days: 2,
      loggedDays: 0,
      targetDays: 2,
      targetTotal: 300,
      difference: -300,
    });
    expect(createPeriodSummarizer([], [])('2026-10-01', '2026-10-01')).toEqual({
      days: 1,
      loggedDays: 0,
      total: 0,
      average: 0,
      targetDays: 0,
      targetTotal: 0,
      difference: null,
    });
  });

  it('includes days before the visible range in the seven-calendar-day average', () => {
    const rows = buildDailyStatistics(
      [entry('2026-09-27', 700), entry('2026-10-03', 2100)],
      targets,
      '2026-10-03',
      '2026-10-04',
    );
    expect(rows[0]).toMatchObject({
      total: 2100,
      rollingAverage: 400,
      cumulativeDifference: -100,
      entryCount: 1,
    });
    expect(rows[1]).toMatchObject({
      total: 0,
      rollingAverage: 300,
      cumulativeDifference: -2300,
      entryCount: 0,
    });
  });

  it('counts calendar days across daylight-saving changes and includes activity', () => {
    const rows = buildDailyStatistics(
      [entry('2026-10-25', 2200), entry('2026-10-25', -200)],
      targets,
      '2026-10-24',
      '2026-10-26',
    );
    expect(rows.map((row) => row.date)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(rows[1].total).toBe(2000);
  });

  it('keeps an exact zero difference and refuses invalid or unbounded chart ranges', () => {
    expect(
      summarizePeriod([entry('2026-10-01', 2000)], targets, '2026-10-01', '2026-10-01').difference,
    ).toBe(0);
    expect(() => buildDailyStatistics([], [], '2026-01-01', '2027-01-02')).toThrow('366');
    expect(() => summarizePeriod([], [], '2026-02-30', '2026-03-01')).toThrow('valid');
  });
});
