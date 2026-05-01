/// <reference types="bun-types" />

import '@angular/compiler';
import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it } from 'bun:test';
import { of } from 'rxjs';

import type { KcalEntry, KcalSyncResponse } from '../models/kcal.model';
import { DbService, type PendingMutation, type SyncStateRecord } from './db.service';
import { StorageService } from './storage.service';
import { SyncService } from './sync.service';

class FakeTable<T extends object, TKey> {
  readonly #rows = new Map<TKey, T>();
  readonly #getKey: (value: T) => TKey;
  readonly #setKey?: (value: T, key: TKey) => void;
  readonly #nextKey?: () => TKey;

  constructor(options: {
    getKey: (value: T) => TKey;
    setKey?: (value: T, key: TKey) => void;
    nextKey?: () => TKey;
  }) {
    this.#getKey = options.getKey;
    this.#setKey = options.setKey;
    this.#nextKey = options.nextKey;
  }

  seed(values: T[]): void {
    for (const value of values) {
      const key = this.#getKey(value);
      this.#rows.set(key, structuredClone(value));
    }
  }

  async toArray(): Promise<T[]> {
    return [...this.#rows.values()].map((value) => structuredClone(value));
  }

  async count(): Promise<number> {
    return this.#rows.size;
  }

  async get(key: TKey): Promise<T | undefined> {
    const value = this.#rows.get(key);
    return value ? structuredClone(value) : undefined;
  }

  async put(value: T): Promise<TKey> {
    let key = this.#getKey(value);
    if ((key === undefined || key === null) && this.#nextKey && this.#setKey) {
      key = this.#nextKey();
      this.#setKey(value, key);
    }
    this.#rows.set(key, structuredClone(value));
    return key;
  }

  async bulkPut(values: T[]): Promise<void> {
    for (const value of values) {
      await this.put(value);
    }
  }

  async bulkAdd(values: T[]): Promise<void> {
    for (const value of values) {
      await this.put(value);
    }
  }

  async delete(key: TKey): Promise<void> {
    this.#rows.delete(key);
  }

  async bulkDelete(keys: TKey[]): Promise<void> {
    for (const key of keys) {
      this.#rows.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

class FakeDbService {
  readonly templates = new FakeTable({
    getKey: (value: { id: string }) => value.id,
  });

  readonly entries = new FakeTable({
    getKey: (value: { id: string }) => value.id,
  });

  readonly pendingMutations = new FakeTable<PendingMutation, number>({
    getKey: (value) => value.id as number,
    setKey: (value, key) => {
      value.id = key;
    },
    nextKey: (() => {
      let nextId = 1;
      return () => nextId++;
    })(),
  });

  readonly profilePreferences = new FakeTable({
    getKey: (value: { id: string }) => value.id,
  });

  readonly syncState = new FakeTable<SyncStateRecord, string>({
    getKey: (value) => value.id,
  });

  async transaction(_mode: string, ...args: unknown[]): Promise<void> {
    const callback = args[args.length - 1] as () => Promise<void>;
    await callback();
  }
}

class FakeStorageService {
  readonly #values = new Map<string, unknown>();

  get<T>(key: string): T | null {
    return (this.#values.get(key) as T | undefined) ?? null;
  }

  set<T>(key: string, value: T): void {
    this.#values.set(key, value);
  }

  remove(key: string): void {
    this.#values.delete(key);
  }
}

interface HttpCall {
  url: string;
  body?: unknown;
  options?: unknown;
}

function createService(options: {
  http: Pick<HttpClient, 'post'>;
  storage: StorageService;
  db: DbService;
}): SyncService {
  const document = {
    visibilityState: 'visible',
    addEventListener: () => undefined,
  };
  const injector = Injector.create({
    providers: [
      { provide: DOCUMENT, useValue: document },
      { provide: HttpClient, useValue: options.http },
      { provide: StorageService, useValue: options.storage },
      { provide: DbService, useValue: options.db },
    ],
  });

  return runInInjectionContext(injector, () => new SyncService());
}

describe('SyncService', () => {
  it('keeps a newer queued local mutation when sync returns an older server change', async () => {
    const db = new FakeDbService();
    const storage = new FakeStorageService();
    const postCalls: HttpCall[] = [];
    const localEntry: KcalEntry = {
      id: 'entry-1',
      kcal_delta: 250,
      happened_at: '2026-03-23T12:00:00Z',
    };

    db.entries.seed([localEntry]);
    await db.pendingMutations.bulkAdd([
      {
        kind: 'entry',
        payload: {
          entity_table: 'kcal_entries',
          ...localEntry,
          deleted: false,
          client_updated_at: '2026-03-23T12:02:00Z',
        },
      },
    ]);
    await db.syncState.put({ id: 'pull_snapshot' });
    storage.set('device_id', 'device-123');
    storage.set('last_sync_seq', 5);

    const http = {
      post: (url: string, body: unknown, options: unknown) => {
        postCalls.push({ url, body, options });
        return of({
          data: {
            reset_required: false,
            last_sync_seq: 6,
            min_valid_seq: 0,
            push_results: [],
            pull_changes: [
              {
                entity_table: 'kcal_entries',
                id: 'entry-1',
                kcal_delta: 100,
                happened_at: '2026-03-23T12:00:00Z',
                deleted: false,
                client_updated_at: '2026-03-23T12:01:00Z',
                global_version: 6,
                server_updated_at: '2026-03-23T12:03:00Z',
              },
            ],
          },
        } satisfies KcalSyncResponse);
      },
    };

    const service = createService({
      http: http as unknown as Pick<HttpClient, 'post'>,
      storage: storage as unknown as StorageService,
      db: db as unknown as DbService,
    });
    await service.pull({ syncPending: false });

    expect(service.entries()).toEqual([localEntry]);
    expect(await db.entries.toArray()).toEqual([localEntry]);
    expect(storage.get<number>('last_sync_seq')).toBe(6);
    expect(postCalls).toHaveLength(1);
    expect((postCalls[0]?.body as { last_sync_seq: number }).last_sync_seq).toBe(5);
    expect((postCalls[0]?.body as { changes: unknown[] }).changes).toEqual([]);
  });

  it('keeps queued local mutations when a stale sync requires reset', async () => {
    const db = new FakeDbService();
    const storage = new FakeStorageService();
    const localEntry: KcalEntry = {
      id: 'entry-reset-local',
      kcal_delta: 250,
      happened_at: '2026-03-23T12:00:00Z',
    };

    db.entries.seed([localEntry]);
    await db.pendingMutations.bulkAdd([
      {
        kind: 'entry',
        payload: {
          entity_table: 'kcal_entries',
          ...localEntry,
          deleted: false,
          client_updated_at: '2026-03-23T12:02:00Z',
        },
      },
    ]);
    await db.syncState.put({ id: 'pull_snapshot' });
    storage.set('device_id', 'device-reset');
    storage.set('last_sync_seq', 5);

    const http = {
      post: () =>
        of({
          data: {
            reset_required: true,
            reset_reason: 'client cursor is older than the retained tombstone history',
            last_sync_seq: 10,
            min_valid_seq: 8,
            push_results: [],
            pull_changes: [
              {
                entity_table: 'kcal_entries',
                id: 'entry-server',
                kcal_delta: 100,
                happened_at: '2026-03-23T08:00:00Z',
                deleted: false,
                client_updated_at: '2026-03-23T08:01:00Z',
                global_version: 10,
                server_updated_at: '2026-03-23T08:01:01Z',
              },
            ],
          },
        } satisfies KcalSyncResponse),
    };

    const service = createService({
      http: http as unknown as Pick<HttpClient, 'post'>,
      storage: storage as unknown as StorageService,
      db: db as unknown as DbService,
    });
    await service.pull();

    expect(await db.pendingMutations.count()).toBe(1);
    expect(service.entries()).toContainEqual(localEntry);
    expect(service.entries()).toContainEqual({
      id: 'entry-server',
      kcal_delta: 100,
      happened_at: '2026-03-23T08:00:00Z',
    });
    expect(storage.get<number>('last_sync_seq')).toBe(10);
  });

  it('flushes the deduplicated offline queue in a single sync request', async () => {
    const db = new FakeDbService();
    const storage = new FakeStorageService();
    const postCalls: HttpCall[] = [];

    await db.pendingMutations.bulkAdd([
      {
        kind: 'entry',
        payload: {
          entity_table: 'kcal_entries',
          id: 'entry-1',
          kcal_delta: 100,
          happened_at: '2026-03-23T10:00:00Z',
          deleted: false,
          client_updated_at: '2026-03-23T10:01:00Z',
        },
      },
      {
        kind: 'entry',
        payload: {
          entity_table: 'kcal_entries',
          id: 'entry-1',
          kcal_delta: 150,
          happened_at: '2026-03-23T10:00:00Z',
          deleted: false,
          client_updated_at: '2026-03-23T10:02:00Z',
        },
      },
      {
        kind: 'template',
        payload: {
          entity_table: 'kcal_template_items',
          id: 'template-1',
          kind: 'food',
          name: 'rice',
          amount: '100',
          unit: 'g',
          kcal_amount: 130,
          deleted: false,
          client_updated_at: '2026-03-23T10:03:00Z',
        },
      },
    ]);
    storage.set('device_id', 'device-456');

    const http = {
      post: (url: string, body: unknown, options: unknown) => {
        postCalls.push({ url, body, options });
        return of({
          data: {
            reset_required: false,
            last_sync_seq: 3,
            min_valid_seq: 0,
            push_results: [
              {
                applied: true,
                record: {
                  entity_table: 'kcal_entries',
                  id: 'entry-1',
                  kcal_delta: 150,
                  happened_at: '2026-03-23T10:00:00Z',
                  deleted: false,
                  client_updated_at: '2026-03-23T10:02:00Z',
                  global_version: 2,
                  server_updated_at: '2026-03-23T10:04:00Z',
                },
              },
              {
                applied: true,
                record: {
                  entity_table: 'kcal_template_items',
                  id: 'template-1',
                  kind: 'food',
                  name: 'rice',
                  amount: '100',
                  unit: 'g',
                  kcal_amount: 130,
                  deleted: false,
                  client_updated_at: '2026-03-23T10:03:00Z',
                  global_version: 3,
                  server_updated_at: '2026-03-23T10:04:00Z',
                },
              },
            ],
            pull_changes: [],
          },
        } satisfies KcalSyncResponse);
      },
    };

    const service = createService({
      http: http as unknown as Pick<HttpClient, 'post'>,
      storage: storage as unknown as StorageService,
      db: db as unknown as DbService,
    });
    await service.pull();

    expect(postCalls).toHaveLength(1);
    const request = postCalls[0]?.body as {
      device_id: string;
      last_sync_seq: number;
      changes: { id: string; kcal_delta?: number; amount?: string }[];
    };
    expect(request.device_id).toBe('device-456');
    expect(request.last_sync_seq).toBe(0);
    expect(request.changes).toHaveLength(2);
    expect(request.changes[0]).toMatchObject({ id: 'entry-1', kcal_delta: 150 });
    expect(request.changes[1]).toMatchObject({ id: 'template-1', amount: '100' });
    expect(await db.pendingMutations.count()).toBe(0);
  });

  it('rounds fractional queued entry calories before posting sync payloads', async () => {
    const db = new FakeDbService();
    const storage = new FakeStorageService();
    const postCalls: HttpCall[] = [];

    await db.pendingMutations.bulkAdd([
      {
        kind: 'entry',
        payload: {
          entity_table: 'kcal_entries',
          id: 'entry-fractional',
          kcal_delta: 97.5,
          happened_at: '2026-03-26T04:27:00Z',
          deleted: false,
          client_updated_at: '2026-03-26T04:28:36.905Z',
        },
      },
    ]);
    storage.set('device_id', 'device-fractional');

    const http = {
      post: (url: string, body: unknown, options: unknown) => {
        postCalls.push({ url, body, options });
        return of({
          data: {
            reset_required: false,
            last_sync_seq: 1,
            min_valid_seq: 0,
            push_results: [
              {
                applied: true,
                record: {
                  entity_table: 'kcal_entries',
                  id: 'entry-fractional',
                  kcal_delta: 98,
                  happened_at: '2026-03-26T04:27:00Z',
                  deleted: false,
                  client_updated_at: '2026-03-26T04:28:36.905Z',
                  global_version: 1,
                  server_updated_at: '2026-03-26T04:28:37.000Z',
                },
              },
            ],
            pull_changes: [],
          },
        } satisfies KcalSyncResponse);
      },
    };

    const service = createService({
      http: http as unknown as Pick<HttpClient, 'post'>,
      storage: storage as unknown as StorageService,
      db: db as unknown as DbService,
    });

    await service.pull();

    expect(postCalls).toHaveLength(1);
    const request = postCalls[0]?.body as {
      changes: { id: string; kcal_delta?: number }[];
    };
    expect(request.changes).toHaveLength(1);
    expect(request.changes[0]).toMatchObject({ id: 'entry-fractional', kcal_delta: 98 });
  });

  it('writes template kcal_amount as a number when local input passes a string', async () => {
    const db = new FakeDbService();
    const storage = new FakeStorageService();

    storage.set('device_id', 'device-template-kcal');

    const http = {
      post: () =>
        of({
          data: {
            reset_required: false,
            last_sync_seq: 1,
            min_valid_seq: 0,
            push_results: [
              {
                applied: true,
                record: {
                  entity_table: 'kcal_template_items',
                  id: 'template-string-kcal',
                  kind: 'food',
                  name: 'banana',
                  amount: '1',
                  unit: 'piece',
                  kcal_amount: 90,
                  deleted: false,
                  client_updated_at: '2026-03-29T08:00:00Z',
                  global_version: 1,
                  server_updated_at: '2026-03-29T08:00:01Z',
                },
              },
            ],
            pull_changes: [],
          },
        } satisfies KcalSyncResponse),
    };

    const service = createService({
      http: http as unknown as Pick<HttpClient, 'post'>,
      storage: storage as unknown as StorageService,
      db: db as unknown as DbService,
    });

    service.upsertTemplate({
      id: 'template-string-kcal',
      kind: 'food',
      name: 'banana',
      amount: '1',
      unit: 'piece',
      kcal_amount: '90' as unknown as number,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const storedTemplates = await db.templates.toArray();
    expect(storedTemplates).toHaveLength(1);
    expect(storedTemplates[0]).toMatchObject({
      id: 'template-string-kcal',
      kcal_amount: 90,
    });
    expect(typeof (storedTemplates[0] as unknown as { kcal_amount: unknown }).kcal_amount).toBe(
      'number',
    );
  });

  it('builds a notice for discarded offline changes', async () => {
    const db = new FakeDbService();
    const storage = new FakeStorageService();

    await db.pendingMutations.bulkAdd([
      {
        kind: 'entry',
        payload: {
          entity_table: 'kcal_entries',
          id: 'entry-9',
          kcal_delta: 80,
          happened_at: '2026-03-24T07:30:00Z',
          deleted: false,
          client_updated_at: '2026-03-24T07:31:00Z',
        },
      },
    ]);
    storage.set('device_id', 'device-789');

    const http = {
      post: () =>
        of({
          data: {
            reset_required: false,
            last_sync_seq: 9,
            min_valid_seq: 0,
            push_results: [
              {
                applied: false,
                record: {
                  entity_table: 'kcal_entries',
                  id: 'entry-9',
                  kcal_delta: 120,
                  happened_at: '2026-03-24T07:30:00Z',
                  deleted: false,
                  client_updated_at: '2026-03-24T07:35:00Z',
                  global_version: 9,
                  server_updated_at: '2026-03-24T07:35:01Z',
                },
              },
            ],
            pull_changes: [],
          },
        } satisfies KcalSyncResponse),
    };

    const service = createService({
      http: http as unknown as Pick<HttpClient, 'post'>,
      storage: storage as unknown as StorageService,
      db: db as unknown as DbService,
    });

    await service.pull();

    expect(service.syncNotice()).toEqual({
      title: 'Some offline changes were skipped',
      message: 'The server already had newer versions of some queued edits.',
      details: [
        {
          message:
            'Entry 80 kcal from 2026-03-24T07:30:00Z: skipped because the server already had a newer version.',
          reviewLabel: 'Review entry',
          routeCommands: ['/history'],
          queryParams: { review_entry: 'entry-9' },
        },
      ],
      tone: 'info',
    });
  });
});
