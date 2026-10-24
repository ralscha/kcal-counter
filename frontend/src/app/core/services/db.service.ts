import { Service } from '@angular/core';
import Dexie, { type Table } from 'dexie';
import {
  KcalTemplateItem,
  KcalEntry,
  KcalTarget,
  KcalPeriod,
  KcalMeal,
} from '../models/kcal.model';
import type { QueuedSyncMutation } from './sync-push.util';

export type PendingMutation = QueuedSyncMutation;

export interface ProfilePreferenceRecord {
  id: string;
  cycleStartDate: string | null;
}

export interface SyncStateRecord {
  id: string;
  lastSeq?: number;
  lastSyncedAt?: string;
}

export class AccountDb extends Dexie {
  templates!: Table<KcalTemplateItem, string>;
  entries!: Table<KcalEntry, string>;
  targets!: Table<KcalTarget, string>;
  periods!: Table<KcalPeriod, string>;
  meals!: Table<KcalMeal, string>;
  pendingMutations!: Table<PendingMutation, number>;
  profilePreferences!: Table<ProfilePreferenceRecord, string>;
  syncState!: Table<SyncStateRecord, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      templates: 'id, kind, name',
      entries: 'id, happened_at',
      targets: 'id, effective_from',
      periods: 'id, start_date, end_date',
      meals: 'id, name',
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
}
