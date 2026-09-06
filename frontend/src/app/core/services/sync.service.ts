import { DOCUMENT } from '@angular/common';
import { DestroyRef, Service, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import {
  KcalEntry,
  KcalSyncChange,
  KcalSyncResponse,
  KcalTemplateItem,
} from '../models/kcal.model';
import { StorageService } from './storage.service';
import { AccountDb, DbService, type LegacyDeviceData } from './db.service';
import { generateUuid } from '../../shared/utils/uuid';
import {
  buildBatchSyncRequest,
  buildQueuedMutationIndex,
  dedupeQueuedMutations,
  normalizeEntry,
  normalizeSyncChange,
  normalizeTemplateAmount,
  normalizeTemplateKcalAmount,
  queuedMutationKey,
  type QueuedSyncMutation,
} from './sync-push.util';
import { resolvePullSinceSeq } from './sync-pull.util';

const SNAPSHOT_ID = 'pull_snapshot';
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

interface SyncAccount {
  userId: string;
  db: AccountDb;
}

interface SyncNoticeDetail {
  message: string;
  reviewLabel: string | null;
  routeCommands: string[] | null;
  queryParams: Record<string, string> | null;
}

interface SyncNotice {
  title: string;
  message: string;
  details: SyncNoticeDetail[];
  tone: 'info' | 'warning';
}

@Service()
export class SyncService {
  readonly #document = inject(DOCUMENT);
  readonly #http = inject(HttpClient);
  readonly #storage = inject(StorageService);
  readonly #databases = inject(DbService);
  readonly #deviceId = this.#initDeviceId();

  readonly templates = signal<KcalTemplateItem[]>([]);
  readonly entries = signal<KcalEntry[]>([]);
  readonly syncNotice = signal<SyncNotice | null>(null);
  readonly syncing = signal(false);
  readonly pendingCount = signal(0);
  readonly syncError = signal('');
  readonly lastSyncedAt = signal<string | null>(null);

  #account: SyncAccount | null = null;
  #task: { account: SyncAccount; promise: Promise<void> } | null = null;
  #retryDelayMs = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastTimestamp = 0;

  constructor() {
    const onActive = (): void => {
      if (this.#document.visibilityState === 'visible') {
        this.#requestSync(0);
      }
    };
    const onOnline = (): void => this.#requestSync(0);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline);
      window.addEventListener('pageshow', onActive);
      this.#document.addEventListener('visibilitychange', onActive);
      inject(DestroyRef).onDestroy(() => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('pageshow', onActive);
        this.#document.removeEventListener('visibilitychange', onActive);
        this.#cancelTimer();
        this.#account = null;
      });
    }
  }

  async setAccount(userId: string | null): Promise<void> {
    if (this.#account?.userId === userId) {
      return;
    }
    this.#cancelTimer();
    this.#account = userId ? { userId, db: this.#databases.forUser(userId) } : null;
    this.templates.set([]);
    this.entries.set([]);
    this.pendingCount.set(0);
    this.syncing.set(false);
    this.syncError.set('');
    this.syncNotice.set(null);
    this.lastSyncedAt.set(null);
    this.#retryDelayMs = 0;
    if (this.#account) {
      await this.#hydrate(this.#account);
    }
  }

  #initDeviceId(): string {
    let id = this.#storage.get<string>('device_id');
    if (!id) {
      id = generateUuid();
      this.#storage.set('device_id', id);
    }
    return id;
  }

  #timestamp(): string {
    this.#lastTimestamp = Math.max(Date.now(), this.#lastTimestamp + 1);
    return new Date(this.#lastTimestamp).toISOString();
  }

  async #hydrate(account: SyncAccount): Promise<void> {
    const { db } = account;
    const [templates, entries, pending, snapshot] = await db.transaction(
      'r',
      [db.templates, db.entries, db.pendingMutations, db.syncState],
      () =>
        Promise.all([
          db.templates.toArray(),
          db.entries.toArray(),
          db.pendingMutations.toArray(),
          db.syncState.get(SNAPSHOT_ID),
        ]),
    );
    if (this.#account !== account) {
      return;
    }
    this.templates.set(templates);
    this.entries.set(entries);
    this.pendingCount.set(dedupeQueuedMutations(pending).length);
    this.lastSyncedAt.set(snapshot?.lastSyncedAt ?? null);
  }

  async pull(options: { syncPending?: boolean } = {}): Promise<void> {
    const account = this.#account;
    if (!account) {
      return;
    }
    if (this.#task?.account === account) {
      return this.#task.promise;
    }
    this.#cancelTimer();
    const task = { account, promise: this.#runSync(account, options.syncPending ?? true) };
    this.#task = task;
    try {
      await task.promise;
    } finally {
      if (this.#task === task) {
        this.#task = null;
      }
    }
  }

  dismissSyncNotice(): void {
    this.syncNotice.set(null);
  }

  #cancelTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #requestSync(delayMs: number): void {
    if (!this.#account) {
      return;
    }
    this.#cancelTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.pull();
    }, delayMs);
  }

  // Retain queue IDs: acknowledgements must only remove the exact edits sent.
  async #loadPending(db: AccountDb): Promise<QueuedSyncMutation[]> {
    const pending = await db.pendingMutations.toArray();
    const deduped = dedupeQueuedMutations(pending);
    const retainedIds = new Set(deduped.map((mutation) => mutation.id));
    const obsoleteIds = pending.flatMap((mutation) =>
      mutation.id !== undefined && !retainedIds.has(mutation.id) ? [mutation.id] : [],
    );
    if (obsoleteIds.length) {
      await db.pendingMutations.bulkDelete(obsoleteIds);
    }
    return deduped;
  }

  async #writeChanges(db: AccountDb, changes: KcalSyncChange[]): Promise<void> {
    for (const rawChange of changes) {
      const change = normalizeSyncChange(rawChange);
      if (change.entity_table === 'kcal_template_items') {
        if (change.deleted) {
          await db.templates.delete(change.id);
        } else {
          const { id, kind, name, amount, unit, kcal_amount } = change;
          await db.templates.put({ id, kind, name, amount, unit, kcal_amount });
        }
      } else if (change.deleted) {
        await db.entries.delete(change.id);
      } else {
        const { id, kcal_delta, happened_at } = change;
        await db.entries.put({ id, kcal_delta, happened_at });
      }
    }
  }

  async #runSync(account: SyncAccount, includePending: boolean): Promise<void> {
    const { db, userId } = account;
    this.syncing.set(true);
    this.syncError.set('');
    try {
      const { pending, seq } = await db.transaction(
        'rw',
        [db.templates, db.entries, db.pendingMutations, db.syncState],
        async () => {
          const pending = await this.#loadPending(db);
          const snapshot = await db.syncState.get(SNAPSHOT_ID);
          const seq = resolvePullSinceSeq({
            lastSeq: snapshot?.lastSeq ?? 0,
            hasSnapshot: snapshot !== undefined,
            templateCount: await db.templates.count(),
            entryCount: await db.entries.count(),
            pendingMutationCount: pending.length,
          });
          return { pending: includePending ? pending.slice(0, 200) : [], seq };
        },
      );
      if (this.#account !== account) {
        return;
      }
      const response = await firstValueFrom(
        this.#http.post<KcalSyncResponse>(
          '/api/v1/kcal/sync',
          { ...buildBatchSyncRequest(this.#deviceId, seq, pending), user_id: userId },
          { withCredentials: true, timeout: 15_000 },
        ),
      );
      if (this.#account !== account) {
        return;
      }
      const data = response.data;
      await db.transaction(
        'rw',
        [db.templates, db.entries, db.pendingMutations, db.syncState],
        async () => {
          if (data.reset_required) {
            await db.templates.clear();
            await db.entries.clear();
            await this.#writeChanges(db, data.pull_changes);
            const queued = await this.#loadPending(db);
            await this.#writeChanges(
              db,
              queued.map((mutation) => mutation.payload),
            );
          } else {
            await db.pendingMutations.bulkDelete(
              pending.flatMap((mutation) => (mutation.id === undefined ? [] : [mutation.id])),
            );
            const currentSnapshot = await db.syncState.get(SNAPSHOT_ID);
            // Another tab may already have committed a more recent response.
            if ((currentSnapshot?.lastSeq ?? 0) > data.last_sync_seq) {
              return;
            }
            const queued = buildQueuedMutationIndex(await this.#loadPending(db));
            const changes = [
              ...data.push_results.map((result) => result.record),
              ...data.pull_changes,
            ];
            await this.#writeChanges(
              db,
              changes.filter(
                (change) =>
                  !queued.has(
                    queuedMutationKey(
                      change.entity_table === 'kcal_template_items' ? 'template' : 'entry',
                      change.id,
                    ),
                  ),
              ),
            );
          }
          await db.syncState.put({
            id: SNAPSHOT_ID,
            lastSeq: data.last_sync_seq,
            lastSyncedAt: new Date().toISOString(),
          });
        },
      );
      await this.#hydrate(account);
      if (this.#account !== account) {
        return;
      }
      this.#retryDelayMs = 0;
      if (data.reset_required) {
        this.syncNotice.set({
          title: 'Offline cache was reset',
          message:
            data.reset_reason ??
            'The server supplied a fresh snapshot. Your queued changes were kept.',
          details: [],
          tone: 'warning',
        });
      } else {
        this.#handleDiscardedChanges(data.push_results, buildQueuedMutationIndex(pending));
      }
      if (includePending && this.pendingCount() > 0) {
        this.#requestSync(0);
      }
    } catch (error) {
      if (this.#account !== account) {
        return;
      }
      const status = error instanceof HttpErrorResponse ? error.status : 0;
      if (status === 401 || status === 403) {
        this.syncError.set('Sign in again to sync this account. Your local changes are saved.');
      } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        this.syncError.set(
          'The server could not accept these changes. Review your entries and templates, then retry.',
        );
      } else {
        this.syncError.set(
          'Could not sync. Your changes are saved on this device; retrying automatically.',
        );
        this.#retryDelayMs = Math.min(
          this.#retryDelayMs ? this.#retryDelayMs * 2 : RETRY_BASE_MS,
          RETRY_MAX_MS,
        );
        this.#requestSync(this.#retryDelayMs);
      }
    } finally {
      if (this.#account === account) {
        this.syncing.set(false);
      }
    }
  }

  #handleDiscardedChanges(
    results: KcalSyncResponse['data']['push_results'],
    pending: Map<string, QueuedSyncMutation>,
  ): void {
    const discarded = results.filter((result) => !result.applied);
    if (!discarded.length) {
      return;
    }
    this.syncNotice.set({
      title: 'Some offline changes were skipped',
      message: 'The server already had newer versions of some queued edits.',
      details: discarded.map(({ record }): SyncNoticeDetail => {
        const mutation = pending.get(
          queuedMutationKey(
            record.entity_table === 'kcal_template_items' ? 'template' : 'entry',
            record.id,
          ),
        );
        if (!mutation) {
          return {
            message: `Change ${record.id} was skipped because the server already had a newer version.`,
            reviewLabel: null,
            routeCommands: null,
            queryParams: null,
          };
        }
        const change = mutation.payload;
        const template = change.entity_table === 'kcal_template_items';
        const description = template
          ? `${change.deleted ? 'Deleted ' : ''}${change.kind} template "${change.name}"`
          : change.deleted
            ? `Deleted entry from ${change.happened_at}`
            : `Entry ${change.kcal_delta} kcal from ${change.happened_at}`;
        return {
          message: `${description}: skipped because the server already had a newer version.`,
          reviewLabel: template ? 'Review template' : 'Review entry',
          routeCommands: template
            ? change.kind === 'activity'
              ? ['/templates', 'activity']
              : ['/templates']
            : ['/history'],
          queryParams: template ? { review_template: change.id } : { review_entry: change.id },
        };
      }),
      tone: 'info',
    });
  }

  async #persist(kind: 'template' | 'entry', change: KcalSyncChange): Promise<void> {
    const account = this.#account;
    if (!account) {
      throw new Error('Sign in before saving changes.');
    }
    const { db } = account;
    await db.transaction('rw', [db.templates, db.entries, db.pendingMutations], async () => {
      await this.#writeChanges(db, [change]);
      await db.pendingMutations.bulkAdd([{ kind, payload: change }]);
      await this.#loadPending(db);
    });
    await this.#hydrate(account);
    if (this.#account === account) {
      this.#requestSync(0);
    }
  }

  async recoverPreviousData(data: LegacyDeviceData): Promise<void> {
    const account = this.#account;
    if (!account) {
      throw new Error('Sign in before recovering data.');
    }
    const { db } = account;
    await db.transaction(
      'rw',
      [db.templates, db.entries, db.pendingMutations, db.profilePreferences],
      async () => {
        const existing = buildQueuedMutationIndex(await this.#loadPending(db));
        const recovered = dedupeQueuedMutations(data.pendingMutations).filter(
          (mutation) => !existing.has(queuedMutationKey(mutation.kind, mutation.payload.id)),
        );
        await this.#writeChanges(
          db,
          recovered.map((mutation) => mutation.payload),
        );
        await db.pendingMutations.bulkAdd(
          recovered.map(({ kind, payload }) => ({ kind, payload })),
        );
        if (data.preferences && !(await db.profilePreferences.get('profile'))) {
          await db.profilePreferences.put(data.preferences);
        }
      },
    );
    await this.#databases.markPreviousDataRecovered();
    await this.#hydrate(account);
    if (this.#account === account) {
      this.#requestSync(0);
    }
  }

  async upsertTemplate(item: KcalTemplateItem): Promise<void> {
    const normalized = {
      ...item,
      name: item.name.trim(),
      unit: item.unit.trim(),
      amount: normalizeTemplateAmount(item.amount),
      kcal_amount: normalizeTemplateKcalAmount(item.kcal_amount),
    };
    if (
      !normalized.name ||
      !normalized.unit ||
      !Number.isFinite(Number(normalized.amount)) ||
      Number(normalized.amount) <= 0 ||
      !Number.isInteger(normalized.kcal_amount) ||
      normalized.kcal_amount <= 0 ||
      normalized.kcal_amount > 2147483647
    ) {
      throw new Error('Enter a name, unit, positive amount, and valid calories.');
    }
    await this.#persist('template', {
      entity_table: 'kcal_template_items',
      ...normalized,
      deleted: false,
      client_updated_at: this.#timestamp(),
    });
  }

  async deleteTemplate(id: string): Promise<void> {
    const item = this.templates().find((template) => template.id === id);
    if (item) {
      await this.#persist('template', {
        entity_table: 'kcal_template_items',
        ...item,
        deleted: true,
        client_updated_at: this.#timestamp(),
      });
    }
  }

  async upsertEntry(entry: KcalEntry): Promise<void> {
    const normalized = normalizeEntry(entry);
    if (
      !Number.isInteger(normalized.kcal_delta) ||
      normalized.kcal_delta === 0 ||
      normalized.kcal_delta < -2147483648 ||
      normalized.kcal_delta > 2147483647 ||
      !Number.isFinite(Date.parse(normalized.happened_at))
    ) {
      throw new Error('Enter nonzero calories within the supported range and a valid date.');
    }
    await this.#persist('entry', {
      entity_table: 'kcal_entries',
      ...normalized,
      deleted: false,
      client_updated_at: this.#timestamp(),
    });
  }

  async deleteEntry(id: string): Promise<void> {
    const entry = this.entries().find((current) => current.id === id);
    if (entry) {
      await this.#persist('entry', {
        entity_table: 'kcal_entries',
        ...entry,
        deleted: true,
        client_updated_at: this.#timestamp(),
      });
    }
  }
}
