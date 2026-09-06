import Dexie from 'dexie';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, describe, expect, it } from 'vitest';
import { of, Subject, throwError } from 'rxjs';
import type { KcalEntry, KcalSyncRequest, KcalSyncResponse } from '../models/kcal.model';
import { AccountDb, DbService } from './db.service';
import { StorageService } from './storage.service';
import { SyncService } from './sync.service';

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

async function setup(post: (url: string, body: KcalSyncRequest) => unknown) {
  const databases = new Map<string, AccountDb>();
  const values = new Map<string, unknown>();
  const dbService = {
    markPreviousDataRecovered: async () => undefined,
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
  return { service, db: dbService.forUser('a'), dbService };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

describe('sync persistence', () => {
  it('recovers earlier device edits without replacing current edits or preferences', async () => {
    const { service, db } = await setup((_url, body) => of(response(body)));
    await service.upsertEntry(entry('current', 250));
    await db.profilePreferences.put({ id: 'profile', kcalLimit: 2200, cycleStartDate: null });
    const changes = ['current', 'recovered'].map((id) => ({
      kind: 'entry' as const,
      payload: {
        entity_table: 'kcal_entries' as const,
        ...entry(id, 100),
        deleted: false,
        client_updated_at: '2026-01-01T00:00:00Z',
      },
    }));
    await service.recoverPreviousData({
      templates: [],
      entries: [],
      pendingMutations: changes,
      preferences: { id: 'profile', kcalLimit: 1800, cycleStartDate: null },
    });
    expect(service.entries()).toContainEqual(entry('current', 250));
    expect(service.entries()).toContainEqual(entry('recovered', 100));
    expect((await db.profilePreferences.get('profile'))?.kcalLimit).toBe(2200);
    expect(changes).toHaveLength(2);
  });

  it('ignores a response older than a snapshot already committed by another tab', async () => {
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
    await expect(
      service.upsertTemplate({
        id: 'bad',
        kind: 'food',
        name: 'Rice',
        amount: 'NaN',
        unit: 'g',
        kcal_amount: 100,
      }),
    ).rejects.toThrow();
    expect(await db.pendingMutations.count()).toBe(0);
  });
});
