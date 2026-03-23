import { Injectable } from '@angular/core';
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
}

@Injectable({ providedIn: 'root' })
export class DbService extends Dexie {
  templates!: Table<KcalTemplateItem, string>;
  entries!: Table<KcalEntry, string>;
  pendingMutations!: Table<PendingMutation, number>;
  profilePreferences!: Table<ProfilePreferenceRecord, string>;
  syncState!: Table<SyncStateRecord, string>;

  constructor() {
    super('kcal-counter');
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
