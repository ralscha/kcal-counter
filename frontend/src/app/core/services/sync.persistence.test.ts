import Dexie from 'dexie';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { afterEach, describe, expect, it } from 'vitest';
import { of, Subject, throwError } from 'rxjs';
import {
  PERIOD_START_ID,
  targetIdForDate,
  periodIdForDate,
  type KcalSyncChange,
  type KcalMeal,
  type KcalEntry,
  type KcalSyncPeriodChange,
  type KcalSyncArchiveChange,
  type KcalSyncRequest,
  type KcalSyncResponse,
} from '../models/kcal.model';
import { AccountDb, DbService } from './db.service';
import { StorageService } from './storage.service';
import { SyncService } from './sync.service';
import { LocalDateService } from './local-date.service';
import { toLocalDateKey } from '../../shared/utils/local-date';

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

const cleanups: (() => Promise<void>)[] = [];
const entry = (id: string, kcal = 100): KcalEntry => ({
  id,
  kcal_delta: kcal,
  happened_at: '2026-09-06T12:00:00Z',
});
const response = (body: KcalSyncRequest, seq = 1): KcalSyncResponse => ({
  data: {
    reset_required: false,
    last_sync_seq: seq,
    min_valid_seq: 0,
    push_results: body.changes.map((record) => ({ applied: true, record })),
    pull_changes: [],
  },
});
const period = (date: string | null): KcalSyncPeriodChange => ({
  entity_table: 'kcal_period_starts',
  id: PERIOD_START_ID,
  cycle_start_date: date,
  deleted: false,
  client_updated_at: '2026-09-06T12:00:00Z',
});

async function setup(post: (url: string, body: KcalSyncRequest) => unknown) {
  const today = signal('2026-10-22');
  const databases = new Map<string, AccountDb>();
  const values = new Map<string, unknown>();
  const dbService = {
    forUser(userId: string) {
      let db = databases.get(userId);
      if (!db) {
        db = new AccountDb(`sync-test-${crypto.randomUUID()}`);
        databases.set(userId, db);
      }
      return db;
    },
  };
  const injector = Injector.create({
    providers: [
      {
        provide: DOCUMENT,
        useValue: { visibilityState: 'visible', addEventListener: () => undefined },
      },
      { provide: HttpClient, useValue: { post } },
      { provide: DbService, useValue: dbService },
      { provide: LocalDateService, useValue: { today } },
      {
        provide: StorageService,
        useValue: {
          get: (key: string) => values.get(key) ?? null,
          set: (key: string, value: unknown) => values.set(key, value),
        },
      },
    ],
  });
  const service = runInInjectionContext(injector, () => new SyncService());
  await service.setAccount('a');
  cleanups.push(async () => {
    await service.setAccount(null);
    for (const db of databases.values()) {
      await db.delete();
    }
    injector.destroy();
  });
  return { service, db: dbService.forUser('a'), dbService, today };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

describe('sync persistence', () => {
  it('cancels a repeat when the account signs out during its database read', async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    await db.entries.put(entry('source', 100));
    db.entries.hook('reading', (record) => {
      void service.setAccount(null);
      return record;
    });
    await expect(service.repeatEntry('source', '2026-10-20')).rejects.toThrow('account changed');
    expect(await db.entries.count()).toBe(1);
    expect(await db.pendingMutations.count()).toBe(0);
  });

  it('derives the current target from effective dates, including disable and delete', async () => {
    const { service, today } = await setup((_url, body) => of(response(body)));
    await service.saveTarget('2026-10-01', 1800);
    await service.saveTarget('2026-11-01', 2200);
    expect(service.preferences().kcalLimit).toBe(1800);
    today.set('2026-11-01');
    expect(service.preferences().kcalLimit).toBe(2200);
    await service.saveTarget('2026-11-05', null);
    today.set('2026-11-05');
    expect(service.preferences().kcalLimit).toBeNull();
    await service.deleteTarget(targetIdForDate('2026-11-05'));
    expect(service.preferences().kcalLimit).toBe(2200);
  });

  it('preserves a newer target in the database when only the period is edited', async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    await db.targets.put({
      id: targetIdForDate('2026-10-01'),
      effective_from: '2026-10-01',
      kcal_limit: 1900,
    });
    await service.savePreferences(
      { kcalLimit: null, cycleStartDate: '2026-10-01' },
      { updateKcalLimit: false, updateCycleStartDate: true },
    );
    expect(service.preferences()).toEqual({ kcalLimit: 1900, cycleStartDate: '2026-10-01' });
    await service.setAccount(null);
    expect(await db.pendingMutations.toArray()).toMatchObject([{ kind: 'period' }]);
  });

  it('repeats signed entries and copies a day with new IDs and target-day timestamps', async () => {
    const { service } = await setup((_url, body) => of(response(body)));
    await service.upsertEntry(entry('food', 300));
    await service.upsertEntry(entry('activity', -100));
    await service.repeatEntry('activity', '2026-10-20');
    await service.copyDay('2026-09-06', '2026-10-21');
    const repeated = service
      .entries()
      .filter((item) => toLocalDateKey(item.happened_at) === '2026-10-20');
    const copied = service
      .entries()
      .filter((item) => toLocalDateKey(item.happened_at) === '2026-10-21');
    expect(repeated.map((item) => item.kcal_delta)).toEqual([-100]);
    expect(copied.map((item) => item.kcal_delta).sort((a, b) => a - b)).toEqual([-100, 300]);
    expect(new Set(service.entries().map((item) => item.id)).size).toBe(5);
  });

  it('logs saved meal snapshots without requiring their original templates', async () => {
    const { service } = await setup((_url, body) => of(response(body)));
    const meal: KcalMeal = {
      id: crypto.randomUUID(),
      name: 'Breakfast',
      items: [
        { template_id: crypto.randomUUID(), name: 'Bread', kcal_delta: 150 },
        { template_id: crypto.randomUUID(), name: 'Milk', kcal_delta: 50 },
      ],
    };
    await service.upsertMeal(meal);
    await service.addMeal(meal.id, '2026-10-20');
    expect(service.templates()).toHaveLength(0);
    expect(
      service
        .entries()
        .map((item) => item.kcal_delta)
        .sort((a, b) => a - b),
    ).toEqual([50, 150]);
    expect(
      service.entries().every((item) => toLocalDateKey(item.happened_at) === '2026-10-20'),
    ).toBe(true);
  });

  it('rolls back an entire meal entry batch if one queued entry cannot be written', async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    const meal: KcalMeal = {
      id: crypto.randomUUID(),
      name: 'Breakfast',
      items: [
        { template_id: crypto.randomUUID(), name: 'Bread', kcal_delta: 150 },
        { template_id: crypto.randomUUID(), name: 'Milk', kcal_delta: 50 },
      ],
    };
    await service.upsertMeal(meal);
    await service.pull();
    let queued = 0;
    db.pendingMutations.hook('creating', () => {
      if (++queued === 2) {
        throw new Error('disk full');
      }
    });
    await expect(service.addMeal(meal.id, '2026-10-20')).rejects.toThrow('disk full');
    expect(service.entries()).toHaveLength(0);
    expect(await db.entries.count()).toBe(0);
    expect(await db.pendingMutations.count()).toBe(0);
  });

  it('requires an initial snapshot before starting a period, then archives the remote active period', async () => {
    let requests = 0;
    const { service, db } = await setup((_url, body) => {
      requests++;
      const result = response(body);
      result.data.pull_changes = [period('2026-10-01')];
      return of(result);
    });
    expect(service.preferencesLoaded()).toBe(true);
    await expect(service.startNewCycle('2026-10-20')).rejects.toThrow(
      'Sync this device once before starting a new period.',
    );
    expect(requests).toBe(0);
    expect(await db.profilePreferences.count()).toBe(0);
    expect(await db.periods.count()).toBe(0);
    expect(await db.pendingMutations.count()).toBe(0);
    expect(await db.syncState.count()).toBe(0);

    await service.pull();
    expect(service.preferences().cycleStartDate).toBe('2026-10-01');
    await service.startNewCycle('2026-10-20');
    expect(service.preferences().cycleStartDate).toBe('2026-10-20');
    expect(service.periods()).toEqual([
      { id: periodIdForDate('2026-10-01'), start_date: '2026-10-01', end_date: '2026-10-19' },
    ]);
    await service.setAccount(null);
    expect(await db.pendingMutations.count()).toBe(2);
  });

  it('archives a completed period and starts the next one in the same transaction', async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    await service.pull();
    await service.startNewCycle('2026-10-01');
    await service.pull();
    await service.startNewCycle('2026-10-20');
    expect(service.periods()).toEqual([
      { id: periodIdForDate('2026-10-01'), start_date: '2026-10-01', end_date: '2026-10-19' },
    ]);
    expect(service.preferences().cycleStartDate).toBe('2026-10-20');
    await service.setAccount(null);
    const pending = await db.pendingMutations.toArray();
    const archive = pending.find((item) => item.kind === 'archive');
    const active = pending.find((item) => item.kind === 'period');
    expect(archive).toBeDefined();
    expect(active).toBeDefined();
    expect(archive?.payload.client_updated_at).toBe(active?.payload.client_updated_at);
    await service.setAccount('a');
    await service.startNewCycle('2026-10-20');
    expect(service.periods()).toHaveLength(1);
    await expect(service.startNewCycle('2026-10-19')).rejects.toThrow('after');
    await expect(
      service.savePreferences(
        { kcalLimit: null, cycleStartDate: '2026-10-10' },
        { updateKcalLimit: false },
      ),
    ).rejects.toThrow('after all archived');
    expect(await db.periods.count()).toBe(1);
  });

  it('rolls back the archive and active start when queue persistence fails', async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    await service.pull();
    await service.startNewCycle('2026-10-01');
    await service.pull();
    db.pendingMutations.hook('creating', () => {
      throw new Error('disk full');
    });
    await expect(service.startNewCycle('2026-10-20')).rejects.toThrow('disk full');
    expect(service.preferences().cycleStartDate).toBe('2026-10-01');
    expect(await db.periods.count()).toBe(0);
  });

  it('imports all record types with fresh timestamps and no foreign server metadata', async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    const changes: KcalSyncChange[] = [
      { ...period('2026-10-20'), global_version: 999, server_updated_at: '2001-01-01T00:00:00Z' },
      {
        entity_table: 'kcal_targets',
        id: targetIdForDate('2026-10-01'),
        effective_from: '2026-10-01',
        kcal_limit: 2000,
        deleted: false,
        client_updated_at: '2001-01-01T00:00:00Z',
      },
      {
        entity_table: 'kcal_periods',
        id: periodIdForDate('2026-10-01'),
        start_date: '2026-10-01',
        end_date: '2026-10-19',
        deleted: false,
        client_updated_at: '2001-01-01T00:00:00Z',
      },
      {
        entity_table: 'kcal_meals',
        id: crypto.randomUUID(),
        name: 'Meal',
        items: [{ template_id: crypto.randomUUID(), name: 'Food', kcal_delta: 200 }],
        deleted: false,
        client_updated_at: '2001-01-01T00:00:00Z',
      },
    ];
    await service.applyChanges(changes);
    expect(service.targets()).toHaveLength(1);
    expect(service.periods()).toHaveLength(1);
    expect(service.meals()).toHaveLength(1);
    await service.setAccount(null);
    const pending = await db.pendingMutations.toArray();
    expect(pending).toHaveLength(4);
    for (const item of pending) {
      expect(item.payload.client_updated_at).not.toBe('2001-01-01T00:00:00Z');
      expect(item.payload).not.toHaveProperty('global_version');
      expect(item.payload).not.toHaveProperty('server_updated_at');
    }
  });

  it('rejects an invalid import or overlapping archives without saving any part of the batch', async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    const target: KcalSyncChange = {
      entity_table: 'kcal_targets',
      id: targetIdForDate('2026-10-01'),
      effective_from: '2026-10-01',
      kcal_limit: 2000,
      deleted: false,
      client_updated_at: '',
    };
    await expect(
      service.applyChanges([
        target,
        {
          ...entry('not-a-uuid'),
          entity_table: 'kcal_entries',
          deleted: false,
          client_updated_at: '',
        },
      ]),
    ).rejects.toThrow('record ID');
    const archive = {
      entity_table: 'kcal_periods' as const,
      id: crypto.randomUUID(),
      start_date: '2026-10-01',
      end_date: '2026-10-19',
      deleted: false,
      client_updated_at: '',
    };
    await expect(
      service.applyChanges([
        target,
        archive,
        { ...archive, id: crypto.randomUUID(), start_date: '2026-10-19', end_date: '2026-10-20' },
      ]),
    ).rejects.toThrow('overlap');
    expect(await db.targets.count()).toBe(0);
    expect(await db.periods.count()).toBe(0);
    expect(await db.pendingMutations.count()).toBe(0);
  });

  it("queues a new device's target without clearing an unknown server period", async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    await service.savePreferences({ kcalLimit: 2200, cycleStartDate: null });

    expect(service.preferences()).toEqual({ kcalLimit: 2200, cycleStartDate: null });
    await service.setAccount(null);
    expect(await db.pendingMutations.toArray()).toMatchObject([{ kind: 'target' }]);
  });

  it('preserves a newer cached period when saving only the daily target', async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    expect(service.preferences().cycleStartDate).toBeNull();
    await db.profilePreferences.put({
      id: 'profile',
      cycleStartDate: '2026-10-01',
    });

    await service.savePreferences(
      { kcalLimit: 2200, cycleStartDate: null },
      { updateCycleStartDate: false },
    );

    expect(service.preferences()).toEqual({ kcalLimit: 2200, cycleStartDate: '2026-10-01' });
    await service.setAccount(null);
    expect(await db.pendingMutations.toArray()).toMatchObject([{ kind: 'target' }]);
  });

  it.each(['2026-10-01', null])(
    'queues an explicit period edit even when the cached date is already %s',
    async (date) => {
      const { service, db } = await setup((_url, body) => of(response(body)));
      await db.profilePreferences.put({ id: 'profile', cycleStartDate: date });
      await service.savePreferences(
        { kcalLimit: 2200, cycleStartDate: date },
        { updateCycleStartDate: true, updateKcalLimit: false },
      );
      await service.setAccount(null);
      const pending = await db.pendingMutations.toArray();
      expect(pending).toHaveLength(1);
      expect(pending[0].payload).toMatchObject({
        entity_table: 'kcal_period_starts',
        cycle_start_date: date,
      });
    },
  );

  it('persists offline period edits across account reloads and keeps accounts isolated', async () => {
    const { service, db } = await setup(() =>
      throwError(() => new HttpErrorResponse({ status: 0 })),
    );
    const preferences = { kcalLimit: 2200, cycleStartDate: '2026-10-01' };
    await service.savePreferences(preferences);
    await service.pull();
    expect(await db.pendingMutations.toArray()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'period',
          payload: expect.objectContaining({
            entity_table: 'kcal_period_starts',
            id: PERIOD_START_ID,
            cycle_start_date: '2026-10-01',
            deleted: false,
          }),
        }),
      ]),
    );

    await service.setAccount(null);
    await service.setAccount('b');
    expect(service.preferences()).toEqual({ kcalLimit: null, cycleStartDate: null });
    expect(service.pendingCount()).toBe(0);
    await service.setAccount('a');
    expect(service.preferences()).toEqual(preferences);
    expect(service.preferencesLoaded()).toBe(true);
    expect(service.pendingCount()).toBe(2);
  });

  it('shares period changes, clears, and daily targets between devices', async () => {
    const server = new Map<string, KcalSyncChange>();
    let seq = 0;
    const sync = (_url: string, body: KcalSyncRequest) => {
      for (const change of body.changes) {
        server.set(`${change.entity_table}:${change.id}`, change);
        seq++;
      }
      const result = response(body, seq);
      result.data.pull_changes = [...server.values()];
      return of(result);
    };
    const first = await setup(sync);
    const second = await setup(sync);
    await first.service.savePreferences({ kcalLimit: 1800, cycleStartDate: '2026-10-01' });
    await first.service.pull();
    await second.service.savePreferences({ kcalLimit: 2200, cycleStartDate: null });
    await second.service.pull();
    expect(second.service.preferences()).toEqual({ kcalLimit: 2200, cycleStartDate: '2026-10-01' });

    await second.service.savePreferences({ kcalLimit: 2200, cycleStartDate: null });
    await second.service.pull();
    await first.service.pull();
    expect(first.service.preferences()).toEqual({ kcalLimit: 2200, cycleStartDate: null });
    expect(second.service.preferences()).toEqual({ kcalLimit: 2200, cycleStartDate: null });
  });

  it.each(['2026-10-02', null])(
    'preserves a newer period edit %s while an older upload is in flight',
    async (date) => {
      const result = new Subject<KcalSyncResponse>();
      const started = Promise.withResolvers<KcalSyncRequest>();
      const { service, db } = await setup((_url, body) => {
        started.resolve(body);
        return result;
      });
      await service.savePreferences({ kcalLimit: 2200, cycleStartDate: '2026-10-01' });
      const syncing = service.pull();
      const sent = await started.promise;
      await service.savePreferences({ kcalLimit: 2200, cycleStartDate: date });
      result.next(response(sent));
      result.complete();
      await syncing;

      expect(service.preferences()).toEqual({ kcalLimit: 2200, cycleStartDate: date });
      const pending = await db.pendingMutations.toArray();
      expect(pending).toHaveLength(1);
      expect(pending[0].payload).toMatchObject({ cycle_start_date: date });
      await service.setAccount(null);
    },
  );

  it.each(['2026-10-02', null])(
    'replays the queued period %s over a reset snapshot',
    async (date) => {
      const { service, db } = await setup((_url, body) => {
        const reset = response(body);
        reset.data.reset_required = true;
        reset.data.push_results = [];
        reset.data.pull_changes = [period('2026-09-01')];
        return of(reset);
      });
      await db.profilePreferences.put({
        id: 'profile',
        cycleStartDate: '2026-10-01',
      });
      await service.savePreferences({ kcalLimit: 2200, cycleStartDate: date });
      await service.pull();

      expect(service.preferences()).toEqual({ kcalLimit: 2200, cycleStartDate: date });
      expect(await db.pendingMutations.count()).toBe(2);
      await service.setAccount(null);
    },
  );

  it('clears an absent period and target on reset', async () => {
    const { service, db } = await setup((_url, body) => {
      const reset = response(body);
      reset.data.reset_required = true;
      return of(reset);
    });
    await db.profilePreferences.put({
      id: 'profile',
      cycleStartDate: '2026-10-01',
    });
    await service.pull();
    expect(service.preferences()).toEqual({ kcalLimit: null, cycleStartDate: null });
  });

  it('reconciles a rejected period edit and links its conflict notice to the profile', async () => {
    const { service, db } = await setup((_url, body) => {
      const result = response(body);
      result.data.push_results = [{ applied: false, record: period('2026-10-10') }];
      return of(result);
    });
    await service.savePreferences({ kcalLimit: 2200, cycleStartDate: '2026-10-01' });
    await service.pull();
    expect(service.preferences()).toEqual({ kcalLimit: 2200, cycleStartDate: '2026-10-10' });
    expect(await db.pendingMutations.count()).toBe(0);
    expect(service.syncNotice()?.details[0].routeCommands).toEqual(['/profile']);
  });

  it('reconciles a rejected archive group, including synthetic tombstones, then allows retry', async () => {
    const archive = (start: string, end: string): KcalSyncArchiveChange => ({
      entity_table: 'kcal_periods',
      id: periodIdForDate(start),
      start_date: start,
      end_date: end,
      deleted: false,
      client_updated_at: '2026-10-15T12:00:00Z',
    });
    const serverArchives = [
      archive('2026-10-01', '2026-10-09'),
      archive('2026-10-10', '2026-10-14'),
    ];
    let rejectGroup = true;
    const { service, db } = await setup((_url, body) => {
      const result = response(body);
      if (rejectGroup) {
        result.data.push_results = body.changes.map((change) => {
          if (change.entity_table === 'kcal_period_starts') {
            return { applied: false, record: period('2026-10-15') };
          }
          if (change.entity_table === 'kcal_periods') {
            return {
              applied: false,
              record: serverArchives.find((item) => item.id === change.id) ?? {
                ...change,
                deleted: true,
              },
            };
          }
          return { applied: true, record: change };
        });
        result.data.pull_changes = [...serverArchives, period('2026-10-15')];
      }
      return of(result);
    });
    const independentEntry = entry(crypto.randomUUID());
    await service.applyChanges([
      archive('2026-10-01', '2026-10-11'),
      archive('2026-10-12', '2026-10-19'),
      period('2026-10-20'),
      { ...independentEntry, entity_table: 'kcal_entries', deleted: false, client_updated_at: '' },
    ]);
    await service.pull();
    expect(service.preferences().cycleStartDate).toBe('2026-10-15');
    expect(service.periods()).toEqual(
      serverArchives.map(({ id, start_date, end_date }) => ({ id, start_date, end_date })),
    );
    expect(await db.periods.get(periodIdForDate('2026-10-12'))).toBeUndefined();
    expect(service.entries()).toEqual([independentEntry]);
    expect(await db.pendingMutations.count()).toBe(0);
    expect(service.syncError()).toBe('');
    expect(service.syncNotice()?.details.map((detail) => detail.routeCommands)).toContainEqual([
      '/trends',
    ]);

    rejectGroup = false;
    await service.startNewCycle('2026-10-20');
    await service.pull();
    expect(service.preferences().cycleStartDate).toBe('2026-10-20');
    expect(service.periods()).toContainEqual({
      id: periodIdForDate('2026-10-15'),
      start_date: '2026-10-15',
      end_date: '2026-10-19',
    });
    expect(await db.pendingMutations.count()).toBe(0);
  });

  it('rolls back both preferences when the period upload queue cannot be written', async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    await service.savePreferences({ kcalLimit: 1800, cycleStartDate: null });
    await service.pull();
    db.pendingMutations.hook('creating', () => {
      throw new Error('disk full');
    });
    await expect(
      service.savePreferences({ kcalLimit: 2200, cycleStartDate: '2026-10-01' }),
    ).rejects.toThrow('disk full');
    expect(service.preferences()).toEqual({ kcalLimit: 1800, cycleStartDate: null });
    expect(await db.targets.get(targetIdForDate('2026-10-22'))).toMatchObject({ kcal_limit: 1800 });
    expect(await db.pendingMutations.count()).toBe(0);
  });

  it.each(['2026-02-30', '2026-2-1', '2026-01-01T00:00:00Z', '0000-01-01', 'invalid'])(
    'rejects invalid period date %s before queuing it',
    async (date) => {
      const { service, db } = await setup((_url, body) => of(response(body)));
      await expect(
        service.savePreferences({ kcalLimit: 2200, cycleStartDate: date }),
      ).rejects.toThrow('valid period start date');
      expect(await db.profilePreferences.count()).toBe(0);
      expect(await db.pendingMutations.count()).toBe(0);
    },
  );

  it.each([false, true])(
    'ignores an older snapshot (reset: %s) already superseded by another tab',
    async (reset) => {
      const result = new Subject<KcalSyncResponse>();
      const started = Promise.withResolvers<KcalSyncRequest>();
      const { service, db } = await setup((_url, body) => {
        started.resolve(body);
        return result;
      });
      const syncing = service.pull();
      const sent = await started.promise;
      await db.entries.put(entry('one', 300));
      await db.syncState.put({ id: 'pull_snapshot', lastSeq: 10 });
      const older = response(sent, 9);
      older.data.reset_required = reset;
      older.data.pull_changes = [
        {
          entity_table: 'kcal_entries',
          ...entry('one', 100),
          deleted: false,
          client_updated_at: '2026-09-06T12:00:00Z',
        },
      ];
      result.next(older);
      result.complete();
      await syncing;
      expect(service.entries()).toEqual([entry('one', 300)]);
      expect((await db.syncState.get('pull_snapshot'))?.lastSeq).toBe(10);
      expect(service.syncNotice()).toBeNull();
    },
  );

  it('accepts a reset to an older server cursor when the local snapshot is unchanged', async () => {
    const requests: KcalSyncRequest[] = [];
    const { service, db } = await setup((_url, body) => {
      requests.push(body);
      const reset = response(body, 8);
      reset.data.reset_required = true;
      reset.data.pull_changes = [
        {
          entity_table: 'kcal_entries',
          ...entry('restored', 200),
          deleted: false,
          client_updated_at: '2026-09-06T12:00:00Z',
        },
      ];
      return of(reset);
    });
    await db.entries.put(entry('obsolete', 300));
    await db.syncState.put({ id: 'pull_snapshot', lastSeq: 10 });

    await service.pull();

    expect(requests[0].last_sync_seq).toBe(10);
    expect(service.entries()).toEqual([entry('restored', 200)]);
    expect((await db.syncState.get('pull_snapshot'))?.lastSeq).toBe(8);
    expect(service.syncNotice()?.title).toBe('Offline cache was reset');
  });

  it('rolls back the local entry if writing its upload queue fails', async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    db.pendingMutations.hook('creating', () => {
      throw new Error('disk full');
    });
    await expect(service.upsertEntry(entry('one'))).rejects.toThrow('disk full');
    expect(await db.entries.count()).toBe(0);
    expect(await db.pendingMutations.count()).toBe(0);
    expect(service.entries()).toEqual([]);
  });

  it('preserves a newer edit made while an older upload is in flight', async () => {
    const result = new Subject<KcalSyncResponse>();
    const started = Promise.withResolvers<KcalSyncRequest>();
    const { service, db } = await setup((_url, body) => {
      started.resolve(body);
      return result;
    });
    await service.upsertEntry(entry('one', 100));
    await service.upsertEntry(entry('two', 200));
    const syncing = service.pull();
    const sent = await started.promise;
    await service.upsertEntry(entry('one', 150));
    result.next(response(sent));
    result.complete();
    await syncing;
    const pending = await db.pendingMutations.toArray();
    expect(pending).toHaveLength(1);
    expect(pending[0].payload).toMatchObject({ id: 'one', kcal_delta: 150 });
    expect(service.entries()).toContainEqual(entry('one', 150));
    expect(service.entries()).toContainEqual(entry('two', 200));
    await service.setAccount(null);
  });

  it('commits acknowledgements, server changes, and cursor atomically', async () => {
    const { service, db } = await setup((_url, body) => of(response(body, 9)));
    await service.upsertEntry(entry('one'));
    db.syncState.hook('creating', () => {
      throw new Error('disk full');
    });
    await service.pull();
    expect(await db.pendingMutations.count()).toBe(1);
    expect(await db.syncState.get('pull_snapshot')).toBeUndefined();
    expect(service.syncError()).not.toBe('');
  });

  it('keeps account data and queues separate, including late sync responses', async () => {
    const result = new Subject<KcalSyncResponse>();
    const started = Promise.withResolvers<KcalSyncRequest>();
    const { service, db } = await setup((_url, body) => {
      started.resolve(body);
      return result;
    });
    await service.upsertEntry(entry('only-a'));
    const syncing = service.pull();
    const sent = await started.promise;
    expect(sent).toMatchObject({ user_id: 'a' });
    await service.setAccount(null);
    await service.setAccount('b');
    expect(service.entries()).toEqual([]);
    expect(service.pendingCount()).toBe(0);
    result.next(response(sent));
    result.complete();
    await syncing;
    expect(service.entries()).toEqual([]);
    expect(await db.pendingMutations.count()).toBe(1);
    await service.setAccount('a');
    expect(service.entries()).toEqual([entry('only-a')]);
    expect(service.pendingCount()).toBe(1);
  });

  it('automatically pushes preserved offline edits after a server reset', async () => {
    const completed = Promise.withResolvers<void>();
    let calls = 0;
    const { service, db } = await setup((_url, body) => {
      calls++;
      if (calls === 1) {
        return of({ data: { ...response(body, 8).data, reset_required: true, push_results: [] } });
      }
      completed.resolve();
      return of(response(body, 9));
    });
    await service.upsertEntry(entry('offline'));
    await service.pull();
    await completed.promise;
    await service.pull();
    expect(calls).toBe(2);
    expect(await db.pendingMutations.count()).toBe(0);
    expect(service.entries()).toEqual([entry('offline')]);
  });

  it('keeps failed uploads and exposes session expiry', async () => {
    const { service, db } = await setup(() =>
      throwError(() => new HttpErrorResponse({ status: 401 })),
    );
    await service.upsertEntry(entry('offline'));
    await service.pull();
    expect(await db.pendingMutations.count()).toBe(1);
    expect(service.syncError()).toContain('Sign in again');
    expect(service.syncing()).toBe(false);
  });

  it('rejects values the API cannot accept before they poison the queue', async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    for (const value of [0, 0.1, NaN, Infinity, 2147483648, -2147483649]) {
      await expect(service.upsertEntry(entry('invalid', value))).rejects.toThrow();
    }
    for (const amount of ['NaN', 'Infinity', '0.0001', '1000000000', '1e10', '0x10', '1_000']) {
      await expect(
        service.upsertTemplate({
          id: 'bad',
          kind: 'food',
          name: 'Rice',
          amount,
          unit: 'g',
          kcal_amount: 100,
        }),
      ).rejects.toThrow();
    }
    expect(await db.pendingMutations.count()).toBe(0);
  });

  it.each(['0.001', '999999999.999', '1e2', '0,25'])(
    'accepts supported template amount %s',
    async (amount) => {
      const { service, db } = await setup((_url, body) => of(response(body)));
      await service.upsertTemplate({
        id: 'valid',
        kind: 'food',
        name: 'Rice',
        amount,
        unit: 'g',
        kcal_amount: 100,
      });
      expect(await db.templates.count()).toBe(1);
    },
  );
});
