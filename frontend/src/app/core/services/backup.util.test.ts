import { backupFixture } from './backup.test-data';
import { describe, expect, it } from 'vitest';
import { PERIOD_START_ID } from '../models/kcal.model';
import {
  backupChanges,
  exportCsv,
  parseBackup,
  serializeBackup,
  type BackupData,
} from './backup.util';

describe('portable backups', () => {
  it('round-trips every collection and explicit null values without server or account metadata', () => {
    const data = backupFixture();
    data.active_period_start = null;
    Object.assign(data.entries[0], {
      user_id: 'secret',
      global_version: 99,
      client_updated_at: 'foreign',
      session: 'secret',
    });
    const json = serializeBackup(data, new Date('2026-01-04T12:00:00Z'));
    const restored = parseBackup(json);
    expect(restored.data).toEqual({ ...backupFixture(), active_period_start: null });
    expect(json).not.toMatch(/secret|global_version|client_updated_at|user_id|session/);
    const changes = backupChanges(restored);
    expect(changes).toHaveLength(8);
    expect(changes.at(-1)).toMatchObject({
      id: PERIOD_START_ID,
      entity_table: 'kcal_period_starts',
      cycle_start_date: null,
      deleted: false,
    });
    expect(changes.every((change) => !change.deleted && !('global_version' in change))).toBe(true);
  });

  it.each([
    [
      'unsupported version',
      (value: Record<string, unknown>) => {
        value['version'] = 2;
      },
    ],
    [
      'extra credentials',
      (value: Record<string, unknown>) => {
        value['session'] = 'secret';
      },
    ],
    [
      'missing collection',
      (value: Record<string, unknown>) => {
        delete (value['data'] as Record<string, unknown>)['meals'];
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const value = JSON.parse(serializeBackup(backupFixture())) as Record<string, unknown>;
    mutate(value);
    expect(() => parseBackup(JSON.stringify(value))).toThrow('Invalid backup');
  });

  it.each([
    ['duplicate IDs', (data: BackupData) => data.entries.push({ ...data.entries[0] })],
    [
      'fractional calories',
      (data: BackupData) => {
        data.entries[0].kcal_delta = 1.5;
      },
    ],
    [
      'missing time zone',
      (data: BackupData) => {
        data.entries[0].happened_at = '2026-01-01T12:00:00';
      },
    ],
    [
      'invalid date',
      (data: BackupData) => {
        data.active_period_start = '2026-02-30';
      },
    ],
    [
      'wrong target ID',
      (data: BackupData) => {
        data.targets[0].effective_from = '2026-01-02';
      },
    ],
    [
      'unsafe amount',
      (data: BackupData) => {
        data.templates[0].amount = '0x100';
      },
    ],
    [
      'empty meal',
      (data: BackupData) => {
        data.meals[0].items = [];
      },
    ],
    [
      'negative meal calories',
      (data: BackupData) => {
        data.meals[0].items[0].kcal_delta = -1;
      },
    ],
    [
      'overlapping archives',
      (data: BackupData) =>
        data.periods.push({
          id: '30000000-0000-0000-0000-000000000002',
          start_date: '2026-01-02',
          end_date: '2026-01-03',
        }),
    ],
    [
      'active period overlap',
      (data: BackupData) => {
        data.active_period_start = '2026-01-02';
      },
    ],
  ])('rejects the complete import for %s', (_label, mutate) => {
    const document = JSON.parse(serializeBackup(backupFixture()));
    mutate(document.data);
    expect(() => parseBackup(JSON.stringify(document))).toThrow('Invalid backup');
  });

  it('rejects over-size files before parsing', () => {
    expect(() => parseBackup(' '.repeat(10 * 1024 * 1024 + 1))).toThrow('10 MB');
  });

  it('rejects a single record that cannot fit in an upload request', () => {
    const document = JSON.parse(serializeBackup(backupFixture()));
    document.data.templates[0].name = 'x'.repeat(128 * 1024);
    expect(() => parseBackup(JSON.stringify(document))).toThrow();
  });

  it('preserves meal names with 200 Unicode characters', () => {
    const data = backupFixture();
    data.meals[0].name = '🍚'.repeat(200);
    expect(parseBackup(serializeBackup(data)).data.meals[0].name).toBe(data.meals[0].name);
  });
});

describe('spreadsheet CSV', () => {
  it('quotes commas, quotes, and line breaks, while neutralizing formula text', () => {
    const data = backupFixture();
    data.templates[0].name = '  =HYPERLINK("https://example.test"),\nclick';
    data.templates[0].unit = '\t@SUM(1)';
    const output = exportCsv(data, 'templates');
    expect(output).toContain('"\'  =HYPERLINK(""https://example.test""),\nclick"');
    expect(output).toContain('"\'\t@SUM(1)"');
    expect(output.startsWith('\uFEFF')).toBe(true);
    expect(exportCsv(data, 'entries')).toContain('"-50"');
    expect(exportCsv(data, 'entries')).not.toContain('"\'-50"');
  });

  it('includes zero-entry days and applies dated target changes and clears', () => {
    const output = exportCsv(backupFixture(), 'daily');
    expect(output).toContain('"2026-01-01","150","1","2000","-1850"');
    expect(output).toContain('"2026-01-02","0","0","2000","-2000"');
    expect(output).toContain('"2026-01-03","-50","1","",""');
  });

  it('summarizes inclusive archived dates and leaves incomplete target differences blank', () => {
    const data = backupFixture();
    expect(exportCsv(data, 'periods')).toContain(
      '"2026-01-01","2026-01-02","2","1","150","4000","-3850"',
    );
    data.targets = [];
    expect(exportCsv(data, 'periods')).toContain('"2","1","150","",""');
  });

  it('exports a long archived period without creating a row for each date', () => {
    const data = backupFixture();
    data.periods[0].start_date = '0001-01-01';
    data.periods[0].end_date = '9999-12-31';
    data.targets = [];
    expect(exportCsv(data, 'periods')).toContain('"0001-01-01","9999-12-31","3652059"');
  });
});
