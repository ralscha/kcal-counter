import type { KcalEntry, KcalTarget } from '../../core/models/kcal.model';
import {
  addDays,
  calendarDaysBetween,
  isDateKey,
  parseDateKey,
  toDateKey,
  toLocalDateKey,
} from './local-date';

export interface PeriodStatistics {
  days: number;
  loggedDays: number;
  total: number;
  average: number;
  targetDays: number;
  targetTotal: number;
  difference: number | null;
}

export interface DailyStatistics {
  date: string;
  total: number;
  entryCount: number;
  target: number | null;
  difference: number | null;
  rollingAverage: number;
  cumulativeDifference: number | null;
}

export function targetForDate(targets: readonly KcalTarget[], date: string): number | null {
  let effective: KcalTarget | undefined;
  for (const target of targets) {
    if (
      target.effective_from <= date &&
      (!effective || target.effective_from > effective.effective_from)
    ) {
      effective = target;
    }
  }
  return effective?.kcal_limit ?? null;
}

function rangeDays(start: string, end: string): number {
  if (!isDateKey(start) || !isDateKey(end) || end < start) {
    throw new Error('Choose a valid date range.');
  }
  return calendarDaysBetween(start, end) + 1;
}

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

function lowerBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

// Prepare once so each inclusive period needs only binary searches and prefix differences.
export function createPeriodSummarizer(
  entries: readonly KcalEntry[],
  targets: readonly KcalTarget[],
): (start: string, end: string) => PeriodStatistics {
  const loggedTotals = new Map<number, number>();
  for (const entry of entries) {
    const day = dayNumber(toLocalDateKey(entry.happened_at));
    loggedTotals.set(day, (loggedTotals.get(day) ?? 0) + entry.kcal_delta);
  }
  const loggedDays = [...loggedTotals.keys()].sort((a, b) => a - b);
  const entryTotals = [0];
  for (const day of loggedDays) {
    entryTotals.push(entryTotals[entryTotals.length - 1] + loggedTotals.get(day)!);
  }

  const orderedTargets = targets
    .slice()
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  const targetStarts = orderedTargets.map((target) => dayNumber(target.effective_from));
  const targetTotals = [0];
  const coveredDays = [0];
  for (let i = 1; i < orderedTargets.length; i++) {
    const limit = orderedTargets[i - 1].kcal_limit;
    const length = targetStarts[i] - targetStarts[i - 1];
    targetTotals.push(targetTotals[i - 1] + length * (limit ?? 0));
    coveredDays.push(coveredDays[i - 1] + (limit === null ? 0 : length));
  }
  const targetsBefore = (day: number): { total: number; days: number } => {
    const index = lowerBound(targetStarts, day) - 1;
    if (index < 0) {
      return { total: 0, days: 0 };
    }
    const limit = orderedTargets[index].kcal_limit;
    const length = day - targetStarts[index];
    return {
      total: targetTotals[index] + length * (limit ?? 0),
      days: coveredDays[index] + (limit === null ? 0 : length),
    };
  };

  return (start, end) => {
    const days = rangeDays(start, end);
    const firstDay = dayNumber(start);
    const afterLastDay = dayNumber(end) + 1;
    const firstEntry = lowerBound(loggedDays, firstDay);
    const afterLastEntry = lowerBound(loggedDays, afterLastDay);
    const total = entryTotals[afterLastEntry] - entryTotals[firstEntry];
    const before = targetsBefore(firstDay);
    const after = targetsBefore(afterLastDay);
    const targetDays = after.days - before.days;
    const targetTotal = after.total - before.total;
    return {
      days,
      loggedDays: afterLastEntry - firstEntry,
      total,
      average: total / days,
      targetDays,
      targetTotal,
      difference: targetDays === days ? total - targetTotal : null,
    };
  };
}

export function summarizePeriod(
  entries: readonly KcalEntry[],
  targets: readonly KcalTarget[],
  start: string,
  end: string,
): PeriodStatistics {
  return createPeriodSummarizer(entries, targets)(start, end);
}

export function buildDailyStatistics(
  entries: readonly KcalEntry[],
  targets: readonly KcalTarget[],
  start: string,
  end: string,
): DailyStatistics[] {
  const days = rangeDays(start, end);
  if (days > 366) {
    throw new Error('Choose a chart range of at most 366 days.');
  }
  const totals = new Map<string, { total: number; count: number }>();
  for (const entry of entries) {
    const date = toLocalDateKey(entry.happened_at);
    const current = totals.get(date) ?? { total: 0, count: 0 };
    totals.set(date, { total: current.total + entry.kcal_delta, count: current.count + 1 });
  }
  const result: DailyStatistics[] = [];
  const orderedTargets = targets
    .slice()
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  let targetIndex = 0;
  let target: number | null = null;
  let cumulative: number | null = 0;
  for (let i = 0; i < days; i++) {
    const day = addDays(parseDateKey(start), i);
    const date = toDateKey(day);
    while (
      targetIndex < orderedTargets.length &&
      orderedTargets[targetIndex].effective_from <= date
    ) {
      target = orderedTargets[targetIndex++].kcal_limit;
    }
    const { total, count } = totals.get(date) ?? { total: 0, count: 0 };
    const difference = target === null ? null : total - target;
    cumulative = cumulative === null || difference === null ? null : cumulative + difference;
    let rollingTotal = 0;
    for (let offset = 0; offset < 7; offset++) {
      rollingTotal += totals.get(toDateKey(addDays(day, -offset)))?.total ?? 0;
    }
    result.push({
      date,
      total,
      entryCount: count,
      target,
      difference,
      rollingAverage: rollingTotal / 7,
      cumulativeDifference: cumulative,
    });
  }
  return result;
}
