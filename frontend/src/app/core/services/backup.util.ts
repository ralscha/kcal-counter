import {
  PERIOD_START_ID,
  targetIdForDate,
  type KcalEntry,
  type KcalMeal,
  type KcalPeriod,
  type KcalSyncChange,
  type KcalTarget,
  type KcalTemplateItem,
} from '../models/kcal.model';
import { calendarDaysBetween, isDateKey, toLocalDateKey } from '../../shared/utils/local-date';
import { createPeriodSummarizer } from '../../shared/utils/kcal-statistics';
import { MAX_ARCHIVED_PERIODS, prepareSyncChange } from './sync-validation.util';

export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const MAX_BACKUP_RECORDS = 50_000;

export interface BackupData {
  entries: KcalEntry[];
  templates: KcalTemplateItem[];
  targets: KcalTarget[];
  periods: KcalPeriod[];
  active_period_start: string | null;
  meals: KcalMeal[];
}

export interface BackupDocument {
  format: 'kcal-counter-backup';
  version: 1;
  exported_at: string;
  data: BackupData;
}

export type CsvExport = 'entries' | 'daily' | 'templates' | 'periods';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const DECIMAL = /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function invalid(message: string): never {
  throw new Error(`Invalid backup: ${message}`);
}

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    return invalid(`${label} has missing or unsupported fields.`);
  }
  return record;
}

function text(value: unknown, label: string, maxLength = MAX_BACKUP_BYTES): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    (maxLength < MAX_BACKUP_BYTES ? Array.from(value.trim()).length : value.length) > maxLength
  ) {
    return invalid(
      `${label} must be nonempty text${maxLength < MAX_BACKUP_BYTES ? ` of at most ${maxLength} characters` : ''}.`,
    );
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value) || value === ZERO_UUID) {
    return invalid(`${label} must be a nonzero UUID.`);
  }
  return value.toLowerCase();
}

function date(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isDateKey(value)) {
    return invalid(`${label} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    return invalid(`${label} must be a timestamp with a time zone.`);
  }
  const match =
    /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match || !isDateKey(match[1]) || !Number.isFinite(Date.parse(value))) {
    return invalid(`${label} must be a valid timestamp with a time zone.`);
  }
  return value;
}

function integer(value: unknown, label: string, positive = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value === 0 ||
    value < (positive ? 1 : -2147483648) ||
    value > 2147483647
  ) {
    return invalid(`${label} is outside the supported calorie range.`);
  }
  return value;
}

function list<T extends { id: string }>(
  value: unknown,
  label: string,
  parse: (value: unknown, label: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length > MAX_BACKUP_RECORDS) {
    return invalid(`${label} must be an array of at most ${MAX_BACKUP_RECORDS} records.`);
  }
  const ids = new Set<string>();
  return value.map((item, index) => {
    const parsed = parse(item, `${label}[${index + 1}]`);
    if (ids.has(parsed.id)) {
      return invalid(`${label} contains duplicate IDs.`);
    }
    ids.add(parsed.id);
    return parsed;
  });
}

export function validatePeriodLayout(periods: KcalPeriod[], activeStart: string | null): void {
  if (periods.length > MAX_ARCHIVED_PERIODS) {
    invalid(`At most ${MAX_ARCHIVED_PERIODS} archived periods can be stored.`);
  }
  const sorted = [...periods].sort((a, b) => a.start_date.localeCompare(b.start_date));
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].end_date < sorted[i].start_date) {
      invalid('An archived period ends before it starts.');
    }
    if (i && sorted[i].start_date <= sorted[i - 1].end_date) {
      invalid('Archived periods overlap.');
    }
    if (activeStart !== null && activeStart <= sorted[i].end_date) {
      invalid('The active period must start after all archived periods.');
    }
  }
}

export function parseBackup(source: string): BackupDocument {
  if (
    source.length > MAX_BACKUP_BYTES ||
    new TextEncoder().encode(source).length > MAX_BACKUP_BYTES
  ) {
    return invalid('The file exceeds the 10 MB limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return invalid('The file is not valid JSON.');
  }
  const document = object(parsed, ['format', 'version', 'exported_at', 'data'], 'document');
  if (document['format'] !== 'kcal-counter-backup' || document['version'] !== 1) {
    return invalid('This backup format or version is not supported.');
  }
  const raw = object(
    document['data'],
    ['entries', 'templates', 'targets', 'periods', 'active_period_start', 'meals'],
    'data',
  );
  const entries = list(raw['entries'], 'entries', (value, label): KcalEntry => {
    const row = object(value, ['id', 'kcal_delta', 'happened_at'], label);
    return {
      id: uuid(row['id'], label),
      kcal_delta: integer(row['kcal_delta'], label),
      happened_at: timestamp(row['happened_at'], label),
    };
  });
  const templates = list(raw['templates'], 'templates', (value, label): KcalTemplateItem => {
    const row = object(value, ['id', 'kind', 'name', 'amount', 'unit', 'kcal_amount'], label);
    const kind = row['kind'];
    if (kind !== 'food' && kind !== 'activity') {
      return invalid(`${label}.kind must be food or activity.`);
    }
    const amount = text(row['amount'], `${label}.amount`);
    if (!DECIMAL.test(amount) || Number(amount) < 0.001 || Number(amount) > 999999999.999) {
      return invalid(`${label}.amount is outside the supported range.`);
    }
    return {
      id: uuid(row['id'], label),
      kind,
      name: text(row['name'], `${label}.name`),
      amount,
      unit: text(row['unit'], `${label}.unit`),
      kcal_amount: integer(row['kcal_amount'], label, true),
    };
  });
  const targets = list(raw['targets'], 'targets', (value, label): KcalTarget => {
    const row = object(value, ['id', 'effective_from', 'kcal_limit'], label);
    const effective_from = date(row['effective_from'], label);
    const id = uuid(row['id'], label);
    if (id !== targetIdForDate(effective_from)) {
      return invalid(`${label}.id does not match its effective date.`);
    }
    return {
      id,
      effective_from,
      kcal_limit: row['kcal_limit'] === null ? null : integer(row['kcal_limit'], label, true),
    };
  });
  const periods = list(raw['periods'], 'periods', (value, label): KcalPeriod => {
    const row = object(value, ['id', 'start_date', 'end_date'], label);
    return {
      id: uuid(row['id'], label),
      start_date: date(row['start_date'], label),
      end_date: date(row['end_date'], label),
    };
  });
  const meals = list(raw['meals'], 'meals', (value, label): KcalMeal => {
    const row = object(value, ['id', 'name', 'items'], label);
    const items = row['items'];
    if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
      return invalid(`${label} must contain between 1 and 100 items.`);
    }
    return {
      id: uuid(row['id'], label),
      name: text(row['name'], `${label}.name`, 200),
      items: items.map((item, index) => {
        const itemLabel = `${label}.items[${index + 1}]`;
        const fields = object(item, ['template_id', 'name', 'kcal_delta'], itemLabel);
        return {
          template_id: uuid(fields['template_id'], itemLabel),
          name: text(fields['name'], `${itemLabel}.name`, 200),
          kcal_delta: integer(fields['kcal_delta'], itemLabel, true),
        };
      }),
    };
  });
  const count =
    entries.length +
    templates.length +
    targets.length +
    periods.length +
    meals.length +
    meals.reduce((sum, meal) => sum + meal.items.length, 0);
  if (count > MAX_BACKUP_RECORDS) {
    return invalid(`The file exceeds ${MAX_BACKUP_RECORDS} records and meal items.`);
  }
  const active_period_start =
    raw['active_period_start'] === null
      ? null
      : date(raw['active_period_start'], 'active_period_start');
  validatePeriodLayout(periods, active_period_start);
  const backup: BackupDocument = {
    format: 'kcal-counter-backup',
    version: 1,
    exported_at: timestamp(document['exported_at'], 'exported_at'),
    data: { entries, templates, targets, periods, active_period_start, meals },
  };
  for (const change of backupChanges(backup)) {
    prepareSyncChange(change, '1970-01-01T00:00:00.000Z');
  }
  return backup;
}

// Pick only portable app data: account/session IDs and sync metadata never enter a backup.
export function serializeBackup(data: BackupData, now = new Date()): string {
  const document: BackupDocument = {
    format: 'kcal-counter-backup',
    version: 1,
    exported_at: now.toISOString(),
    data: {
      entries: data.entries.map(({ id, kcal_delta, happened_at }) => ({
        id,
        kcal_delta,
        happened_at,
      })),
      templates: data.templates.map(({ id, kind, name, amount, unit, kcal_amount }) => ({
        id,
        kind,
        name,
        amount,
        unit,
        kcal_amount,
      })),
      targets: data.targets.map(({ id, effective_from, kcal_limit }) => ({
        id,
        effective_from,
        kcal_limit,
      })),
      periods: data.periods.map(({ id, start_date, end_date }) => ({ id, start_date, end_date })),
      active_period_start: data.active_period_start,
      meals: data.meals.map(({ id, name, items }) => ({
        id,
        name,
        items: items.map(({ template_id, name, kcal_delta }) => ({
          template_id,
          name,
          kcal_delta,
        })),
      })),
    },
  };
  const json = JSON.stringify(document, null, 2);
  parseBackup(json);
  return json;
}

export function backupChanges(backup: BackupDocument): KcalSyncChange[] {
  const { data } = backup;
  // applyChanges assigns fresh timestamps when the import commits.
  const metadata = { deleted: false as const, client_updated_at: '1970-01-01T00:00:00.000Z' };
  return [
    ...data.templates.map((row) => ({
      ...row,
      ...metadata,
      entity_table: 'kcal_template_items' as const,
    })),
    ...data.entries.map((row) => ({ ...row, ...metadata, entity_table: 'kcal_entries' as const })),
    ...data.targets.map((row) => ({ ...row, ...metadata, entity_table: 'kcal_targets' as const })),
    ...data.periods.map((row) => ({ ...row, ...metadata, entity_table: 'kcal_periods' as const })),
    ...data.meals.map((row) => ({ ...row, ...metadata, entity_table: 'kcal_meals' as const })),
    {
      ...metadata,
      entity_table: 'kcal_period_starts',
      id: PERIOD_START_ID,
      cycle_start_date: data.active_period_start,
    },
  ];
}

function csvCell(value: string | number | null): string {
  if (value === null) {
    return '""';
  }
  // Numeric cells are generated locally. Untrusted strings must not become formulas.
  const raw =
    typeof value === 'string' && (/^[\s\uFEFF]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value))
      ? `'${value}`
      : String(value);
  return `"${raw.replaceAll('"', '""')}"`;
}

function csv(rows: (string | number | null)[][]): string {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

interface DayTotal {
  date: string;
  total: number;
  count: number;
  target: number | null;
}

function dailyTotals(data: BackupData): DayTotal[] {
  const logged = new Map<string, { total: number; count: number }>();
  for (const entry of data.entries) {
    const date = toLocalDateKey(entry.happened_at);
    const row = logged.get(date) ?? { total: 0, count: 0 };
    row.total += entry.kcal_delta;
    row.count++;
    logged.set(date, row);
  }
  const dates = [...logged.keys()].sort();
  const start = dates[0];
  const end = dates.at(-1);
  if (!start || !end) {
    return [];
  }
  const length = calendarDaysBetween(start, end) + 1;
  if (length < 1 || length > MAX_BACKUP_RECORDS) {
    throw new Error(`CSV date ranges must contain at most ${MAX_BACKUP_RECORDS} days.`);
  }
  const targets = [...data.targets].sort((a, b) =>
    a.effective_from.localeCompare(b.effective_from),
  );
  let targetIndex = 0;
  let target: number | null = null;
  const day = new Date(`${start}T00:00:00Z`);
  return Array.from({ length }, () => {
    const date = day.toISOString().slice(0, 10);
    while (targetIndex < targets.length && targets[targetIndex].effective_from <= date) {
      target = targets[targetIndex++].kcal_limit;
    }
    const value = logged.get(date);
    const row = { date, total: value?.total ?? 0, count: value?.count ?? 0, target };
    day.setUTCDate(day.getUTCDate() + 1);
    return row;
  });
}

export function exportCsv(data: BackupData, kind: CsvExport): string {
  switch (kind) {
    case 'entries':
      return csv([
        ['id', 'happened_at', 'local_date', 'kcal_delta'],
        ...[...data.entries]
          .sort((a, b) => Date.parse(a.happened_at) - Date.parse(b.happened_at))
          .map((entry) => [
            entry.id,
            entry.happened_at,
            toLocalDateKey(entry.happened_at),
            entry.kcal_delta,
          ]),
      ]);
    case 'templates':
      return csv([
        ['id', 'kind', 'name', 'amount', 'unit', 'kcal_amount'],
        ...data.templates.map((item) => [
          item.id,
          item.kind,
          item.name,
          item.amount,
          item.unit,
          item.kcal_amount,
        ]),
      ]);
    case 'daily':
      return csv([
        ['local_date', 'total_kcal', 'entry_count', 'target_kcal', 'difference_kcal'],
        ...dailyTotals(data).map((day) => [
          day.date,
          day.total,
          day.count,
          day.target,
          day.target === null ? null : day.total - day.target,
        ]),
      ]);
    case 'periods': {
      const summarize = createPeriodSummarizer(data.entries, data.targets);
      return csv([
        [
          'id',
          'start_date',
          'end_date',
          'days',
          'days_with_entries',
          'total_kcal',
          'target_kcal',
          'difference_kcal',
        ],
        ...[...data.periods]
          .sort((a, b) => a.start_date.localeCompare(b.start_date))
          .map((period) => {
            const stats = summarize(period.start_date, period.end_date);
            return [
              period.id,
              period.start_date,
              period.end_date,
              stats.days,
              stats.loggedDays,
              stats.total,
              stats.targetDays === stats.days ? stats.targetTotal : null,
              stats.difference,
            ];
          }),
      ]);
    }
  }
}
