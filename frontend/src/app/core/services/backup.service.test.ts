import Dexie from 'dexie';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { afterEach, describe, expect, it } from 'vitest';
import { throwError } from 'rxjs';
import { AccountDb, DbService } from './db.service';
import { AuthService } from './auth.service';
import { StorageService } from './storage.service';
import { SyncService } from './sync.service';
import { BackupService } from './backup.service';
import { serializeBackup } from './backup.util';
import { backupFixture } from './backup.test-data';
import { LocalDateService } from './local-date.service';

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
const cleanups: (() => Promise<void>)[] = [];

async function setup() {
  const db = new AccountDb(`backup-test-${crypto.randomUUID()}`);
  const user = signal({ user_id: 'a' });
  const injector = Injector.create({
    providers: [
      { provide: LocalDateService, useValue: { today: signal('2026-10-22') } },
      {
        provide: DOCUMENT,
        useValue: { visibilityState: 'visible', addEventListener: () => undefined },
      },
      {
        provide: HttpClient,
        useValue: { post: () => throwError(() => new HttpErrorResponse({ status: 401 })) },
      },
      { provide: DbService, useValue: { forUser: () => db } },
      {
        provide: StorageService,
        useValue: { get: () => '50000000-0000-0000-0000-000000000001', set: () => undefined },
      },
    ],
  });
  const sync = runInInjectionContext(injector, () => new SyncService());
  await sync.setAccount('a');
  const backupInjector = Injector.create({
    providers: [
      { provide: SyncService, useValue: sync },
      { provide: AuthService, useValue: { currentUser: user } },
    ],
  });
  const backup = runInInjectionContext(backupInjector, () => new BackupService());
  cleanups.push(async () => {
    await sync.setAccount(null);
    backupInjector.destroy();
    injector.destroy();
    await db.delete();
  });
  return { backup, sync, db, user };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

describe('backup import persistence', () => {
  it('previews without mutation, then merges all collections and exports queued offline data', async () => {
    const { backup, db, sync } = await setup();
    const data = backupFixture();
    const preview = backup.previewImport(serializeBackup(data));
    expect(preview.counts[0]).toMatchObject({ total: 2, added: 2, replaced: 0 });
    expect(await db.pendingMutations.count()).toBe(0);
    expect(await db.entries.count()).toBe(0);

    await backup.importBackup(preview);

    expect(JSON.parse(backup.exportJson()).data).toEqual(data);
    expect(sync.preferences().cycleStartDate).toBe(data.active_period_start);
    const pending = await db.pendingMutations.toArray();
    expect(pending).toHaveLength(8);
    expect(
      pending.every((row) => row.payload.client_updated_at !== '1970-01-01T00:00:00.000Z'),
    ).toBe(true);

    const repeated = backup.previewImport(serializeBackup(data));
    expect(repeated.counts[0]).toMatchObject({ added: 0, replaced: 2 });
    await backup.importBackup(repeated);
    expect(await db.entries.count()).toBe(2);
    expect(await db.templates.count()).toBe(1);
    expect(await db.pendingMutations.count()).toBe(8);
  });

  it('rejects an invalid record before any data or pending edit is changed', async () => {
    const { backup, db } = await setup();
    const document = JSON.parse(serializeBackup(backupFixture()));
    document.data.meals[0].items[0].kcal_delta = 0;
    expect(() => backup.previewImport(JSON.stringify(document))).toThrow();
    expect(await db.pendingMutations.count()).toBe(0);
    expect(await db.entries.count()).toBe(0);
  });

  it('rolls back the entire multi-collection import if its sync queue cannot be written', async () => {
    const { backup, db, sync } = await setup();
    const preview = backup.previewImport(serializeBackup(backupFixture()));
    db.pendingMutations.hook('creating', () => {
      throw new Error('disk full');
    });
    await expect(backup.importBackup(preview)).rejects.toThrow('disk full');
    for (const table of db.tables) {
      expect(await table.count(), table.name).toBe(0);
    }
    expect(sync.entries()).toEqual([]);
    expect(sync.preferences().cycleStartDate).toBeNull();
  });

  it('rejects a preview if the signed-in account changes before confirmation', async () => {
    const { backup, db, user } = await setup();
    const preview = backup.previewImport(serializeBackup(backupFixture()));
    user.set({ user_id: 'b' });
    await expect(backup.importBackup(preview)).rejects.toThrow('account changed');
    expect(await db.pendingMutations.count()).toBe(0);
  });

  it('keeps records omitted from a merge and explicitly restores a cleared active period', async () => {
    const { backup, db, sync } = await setup();
    const data = backupFixture();
    await backup.importBackup(backup.previewImport(serializeBackup(data)));
    data.entries = [];
    data.templates = [];
    data.meals = [];
    data.active_period_start = null;
    await backup.importBackup(backup.previewImport(serializeBackup(data)));
    expect(await db.entries.count()).toBe(2);
    expect(await db.templates.count()).toBe(1);
    expect(await db.meals.count()).toBe(1);
    expect(sync.preferences().cycleStartDate).toBeNull();
  });
});
