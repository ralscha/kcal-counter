import { Service } from '@angular/core';
import Dexie, { type Table } from 'dexie';
import { KcalTemplateItem, KcalEntry, KcalSyncChange } from '../models/kcal.model';

export interface PendingMutation {
  id?: number;
  kind: 'template' | 'entry';
  payload: KcalSyncChange;
}

export interface ProfilePreferenceRecord {
  id: string;
  kcalLimit: number | null;
  cycleStartDate: string | null;
}

export interface SyncStateRecord {
  id: string;
  lastSeq?: number;
  lastSyncedAt?: string;
}

export interface LegacyDeviceData {
  templates: KcalTemplateItem[];
  entries: KcalEntry[];
  pendingMutations: PendingMutation[];
  preferences: ProfilePreferenceRecord | undefined;
}

export class AccountDb extends Dexie {
  templates!: Table<KcalTemplateItem, string>;
  entries!: Table<KcalEntry, string>;
  pendingMutations!: Table<PendingMutation, number>;
  profilePreferences!: Table<ProfilePreferenceRecord, string>;
  syncState!: Table<SyncStateRecord, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      templates: 'id, kind, name',
      entries: 'id, happened_at',
      pendingMutations: '++id, kind',
      profilePreferences: 'id',
    });
    this.version(2).stores({
      templates: 'id, kind, name',
      entries: 'id, happened_at',
      pendingMutations: '++id, kind',
      profilePreferences: 'id',
      syncState: 'id',
    });
  }
}

@Service()
export class DbService {
  readonly #accounts = new Map<string, AccountDb>();

  forUser(userId: string): AccountDb {
    let database = this.#accounts.get(userId);
    if (!database) {
      database = new AccountDb(`kcal-counter:user:${userId}`);
      this.#accounts.set(userId, database);
    }
    return database;
  }

  async previousDeviceData(): Promise<LegacyDeviceData | null> {
    if (!(await Dexie.exists('kcal-counter'))) {
      return null;
    }
    const db = new AccountDb('kcal-counter');
    try {
      if (await db.syncState.get('account_recovery_complete')) {
        return null;
      }
      const [templates, entries, pendingMutations, preferences] = await Promise.all([
        db.templates.toArray(),
        db.entries.toArray(),
        db.pendingMutations.toArray(),
        db.profilePreferences.get('profile'),
      ]);
      return pendingMutations.length || preferences
        ? { templates, entries, pendingMutations, preferences }
        : null;
    } finally {
      db.close();
    }
  }

  async markPreviousDataRecovered(): Promise<void> {
    const db = new AccountDb('kcal-counter');
    try {
      await db.syncState.put({ id: 'account_recovery_complete' });
    } finally {
      db.close();
    }
  }
}
