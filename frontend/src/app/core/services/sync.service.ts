import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, Service, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import {
  KcalEntry,
  KcalSyncChange,
  KcalSyncResponse,
  KcalTemplateItem,
  PERIOD_START_ID,
  targetIdForDate,
  periodIdForDate,
  type KcalTarget,
  type KcalPeriod,
  type KcalMeal,
} from '../models/kcal.model';
import type { ProfilePreferences, ProfileSaveOptions } from '../models/user.model';
import { StorageService } from './storage.service';
import { AccountDb, DbService } from './db.service';
import { generateUuid } from '../../shared/utils/uuid';
import { targetForDate } from '../../shared/utils/kcal-statistics';
import {
  addDays,
  entriesForDay,
  isDateKey,
  parseDateKey,
  toDateKey,
} from '../../shared/utils/local-date';
import { LocalDateService } from './local-date.service';
import { MAX_ARCHIVED_PERIODS, prepareSyncChange } from './sync-validation.util';
import {
  buildBatchSyncRequest,
  buildQueuedMutationIndex,
  dedupeQueuedMutations,
  normalizeEntry,
  normalizeSyncChange,
  normalizeTemplateAmount,
  normalizeTemplateKcalAmount,
  queuedMutationKey,
  syncMutationKind,
  selectSyncBatch,
  SyncBatchError,
  type QueuedSyncMutation,
} from './sync-push.util';
import { resolvePullSinceSeq } from './sync-pull.util';

const SNAPSHOT_ID = 'pull_snapshot';
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const PROFILE_ID = 'profile';

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
  readonly #clock = inject(LocalDateService);
  readonly #deviceId = this.#initDeviceId();

  readonly templates = signal<KcalTemplateItem[]>([]);
  readonly entries = signal<KcalEntry[]>([]);
  readonly targets = signal<KcalTarget[]>([]);
  readonly periods = signal<KcalPeriod[]>([]);
  readonly meals = signal<KcalMeal[]>([]);
  readonly #cycleStartDate = signal<string | null>(null);
  readonly #preferencesLoaded = signal(false);
  readonly preferences = computed<ProfilePreferences>(() => ({
    kcalLimit: targetForDate(this.targets(), this.#clock.today()),
    cycleStartDate: this.#cycleStartDate(),
  }));
  readonly preferencesLoaded = this.#preferencesLoaded.asReadonly();
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
    this.targets.set([]);
    this.periods.set([]);
    this.meals.set([]);
    this.#cycleStartDate.set(null);
    this.#preferencesLoaded.set(this.#account === null);
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
    const [templates, entries, pending, snapshot, preferences, targets, periods, meals] =
      await db.transaction('r', this.#tables(db), () =>
        Promise.all([
          db.templates.toArray(),
          db.entries.toArray(),
          db.pendingMutations.toArray(),
          db.syncState.get(SNAPSHOT_ID),
          db.profilePreferences.get(PROFILE_ID),
          db.targets.toArray(),
          db.periods.toArray(),
          db.meals.toArray(),
        ]),
      );
    if (this.#account !== account) {
      return;
    }
    this.templates.set(templates);
    this.entries.set(entries);
    this.targets.set(targets);
    this.periods.set(periods);
    this.meals.set(meals);
    this.#cycleStartDate.set(preferences?.cycleStartDate ?? null);
    this.#preferencesLoaded.set(true);
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
      } else if (change.entity_table === 'kcal_period_starts') {
        await db.profilePreferences.put({
          id: PROFILE_ID,
          cycleStartDate: change.cycle_start_date,
        });
      } else if (change.entity_table === 'kcal_targets') {
        if (change.deleted) {
          await db.targets.delete(change.id);
        } else {
          const { id, effective_from, kcal_limit } = change;
          await db.targets.put({ id, effective_from, kcal_limit });
        }
      } else if (change.entity_table === 'kcal_periods') {
        if (change.deleted) {
          await db.periods.delete(change.id);
        } else {
          const { id, start_date, end_date } = change;
          await db.periods.put({ id, start_date, end_date });
        }
      } else if (change.entity_table === 'kcal_meals') {
        if (change.deleted) {
          await db.meals.delete(change.id);
        } else {
          const { id, name, items } = change;
          await db.meals.put({ id, name, items });
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
      const { pending, seq, snapshotSeq } = await db.transaction(
        'rw',
        this.#tables(db),
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
          return {
            pending: includePending ? selectSyncBatch(this.#deviceId, seq, userId, pending) : [],
            seq,
            snapshotSeq: snapshot?.lastSeq ?? 0,
          };
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
      const applied = await db.transaction('rw', this.#tables(db), async () => {
        if (!data.reset_required) {
          await db.pendingMutations.bulkDelete(
            pending.flatMap((mutation) => (mutation.id === undefined ? [] : [mutation.id])),
          );
        }
        const currentSnapshot = await db.syncState.get(SNAPSHOT_ID);
        const currentSeq = currentSnapshot?.lastSeq ?? 0;
        // Resets can move the cursor backwards after a server restore, but must
        // not replace a newer snapshot another tab committed while we waited.
        if (
          currentSeq > data.last_sync_seq &&
          (!data.reset_required || currentSeq !== snapshotSeq)
        ) {
          return false;
        }
        if (data.reset_required) {
          await db.templates.clear();
          await db.entries.clear();
          await db.targets.clear();
          await db.periods.clear();
          await db.meals.clear();
          await db.profilePreferences.clear();
          await this.#writeChanges(db, data.pull_changes);
          const queued = await this.#loadPending(db);
          await this.#writeChanges(
            db,
            queued.map((mutation) => mutation.payload),
          );
        } else {
          const queued = buildQueuedMutationIndex(await this.#loadPending(db));
          const changes = [
            ...data.push_results.map((result) => result.record),
            ...data.pull_changes,
          ];
          await this.#writeChanges(
            db,
            changes.filter(
              (change) => !queued.has(queuedMutationKey(syncMutationKind(change), change.id)),
            ),
          );
        }
        await db.syncState.put({
          id: SNAPSHOT_ID,
          lastSeq: data.last_sync_seq,
          lastSyncedAt: new Date().toISOString(),
        });
        return true;
      });
      await this.#hydrate(account);
      if (this.#account !== account) {
        return;
      }
      this.#retryDelayMs = 0;
      if (applied && data.reset_required) {
        this.syncNotice.set({
          title: 'Offline cache was reset',
          message:
            data.reset_reason ??
            'The server supplied a fresh snapshot. Your queued changes were kept.',
          details: [],
          tone: 'warning',
        });
      } else if (applied) {
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
      if (error instanceof SyncBatchError) {
        this.syncError.set(error.message);
      } else if (status === 401 || status === 403) {
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
      message: 'Some queued edits conflicted with the current server data.',
      details: discarded.map(({ record }): SyncNoticeDetail => {
        const mutation = pending.get(queuedMutationKey(syncMutationKind(record), record.id));
        if (!mutation) {
          return {
            message: `Change ${record.id} was skipped because the server already had a newer version.`,
            reviewLabel: null,
            routeCommands: null,
            queryParams: null,
          };
        }
        const change = mutation.payload;
        if (
          change.entity_table === 'kcal_targets' ||
          change.entity_table === 'kcal_periods' ||
          change.entity_table === 'kcal_meals'
        ) {
          const label =
            change.entity_table === 'kcal_targets'
              ? 'Calorie target'
              : change.entity_table === 'kcal_periods'
                ? 'Archived period'
                : 'Saved meal';
          return {
            message:
              change.entity_table === 'kcal_periods'
                ? `${label}: skipped because the server has newer or conflicting period history.`
                : `${label}: skipped because the server already had a newer version.`,
            reviewLabel: `Review ${label.toLowerCase()}`,
            routeCommands: [
              change.entity_table === 'kcal_meals'
                ? '/meals'
                : change.entity_table === 'kcal_periods'
                  ? '/trends'
                  : '/profile',
            ],
            queryParams: null,
          };
        }
        if (change.entity_table === 'kcal_period_starts') {
          return {
            message: `Period start ${change.cycle_start_date ?? 'cleared'}: skipped because the server has newer or conflicting period history.`,
            reviewLabel: 'Review period start',
            routeCommands: ['/profile'],
            queryParams: null,
          };
        }
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

  #tables(db: AccountDb) {
    return [
      db.templates,
      db.entries,
      db.targets,
      db.periods,
      db.meals,
      db.pendingMutations,
      db.profilePreferences,
      db.syncState,
    ];
  }

  async #validatePeriods(db: AccountDb, changes: KcalSyncChange[]): Promise<void> {
    if (
      !changes.some(
        (change) =>
          change.entity_table === 'kcal_periods' || change.entity_table === 'kcal_period_starts',
      )
    ) {
      return;
    }
    const periods = new Map((await db.periods.toArray()).map((period) => [period.id, period]));
    let activeStart = (await db.profilePreferences.get(PROFILE_ID))?.cycleStartDate ?? null;
    for (const change of changes) {
      if (change.entity_table === 'kcal_period_starts') {
        activeStart = change.cycle_start_date;
      } else if (change.entity_table === 'kcal_periods') {
        if (change.deleted) {
          periods.delete(change.id);
        } else {
          periods.set(change.id, change);
        }
      }
    }
    const sorted = [...periods.values()].sort((a, b) => a.start_date.localeCompare(b.start_date));
    if (sorted.length > MAX_ARCHIVED_PERIODS) {
      throw new Error('Keep at most 1000 archived periods.');
    }
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i].start_date <= sorted[i - 1].end_date) {
        throw new Error('Archived periods cannot overlap.');
      }
      if (activeStart !== null && sorted[i].end_date >= activeStart) {
        throw new Error('The active period must start after all archived periods.');
      }
    }
  }

  async #commit(
    build: (db: AccountDb) => KcalSyncChange[] | Promise<KcalSyncChange[]>,
    strictIds = false,
  ): Promise<void> {
    const account = this.#account;
    if (!account) {
      throw new Error('Sign in before saving changes.');
    }
    const { db } = account;
    await db.transaction('rw', this.#tables(db), async () => {
      const changes = await build(db);
      if (this.#account !== account) {
        throw new Error('The account changed before saving.');
      }
      if (!changes.length) {
        return;
      }
      for (const mutation of await db.pendingMutations.toArray()) {
        const timestamp = Date.parse(mutation.payload.client_updated_at);
        if (Number.isFinite(timestamp)) {
          this.#lastTimestamp = Math.max(this.#lastTimestamp, timestamp);
        }
      }
      const timestamp = this.#timestamp();
      const prepared = changes.map((change) => prepareSyncChange(change, timestamp, strictIds));
      await this.#validatePeriods(db, prepared);
      if (this.#account !== account) {
        throw new Error('The account changed before saving.');
      }
      await this.#writeChanges(db, prepared);
      await db.pendingMutations.bulkAdd(
        prepared.map((payload) => ({ kind: syncMutationKind(payload), payload })),
      );
      await this.#loadPending(db);
      if (this.#account !== account) {
        throw new Error('The account changed before saving.');
      }
    });
    await this.#hydrate(account);
    if (this.#account === account) {
      this.#requestSync(0);
    }
  }

  async #persist(change: KcalSyncChange): Promise<void> {
    await this.#commit(() => [change]);
  }

  async applyChanges(changes: KcalSyncChange[]): Promise<void> {
    if (!Array.isArray(changes)) {
      throw new Error('Invalid changes.');
    }
    await this.#commit(() => changes, true);
  }

  async savePreferences(
    preferences: ProfilePreferences,
    {
      updateCycleStartDate,
      updateKcalLimit,
      targetEffectiveFrom = this.#clock.today(),
    }: ProfileSaveOptions = {},
  ): Promise<void> {
    if (
      updateCycleStartDate !== false &&
      preferences.cycleStartDate !== null &&
      !isDateKey(preferences.cycleStartDate)
    ) {
      throw new Error('Enter a valid period start date.');
    }
    await this.#commit(async (db) => {
      const current = await db.profilePreferences.get(PROFILE_ID);
      const cycleStartDate =
        updateCycleStartDate !== false
          ? preferences.cycleStartDate
          : (current?.cycleStartDate ?? null);
      const changes: KcalSyncChange[] = [];
      if (updateCycleStartDate === true || (current?.cycleStartDate ?? null) !== cycleStartDate) {
        changes.push({
          entity_table: 'kcal_period_starts',
          id: PERIOD_START_ID,
          cycle_start_date: cycleStartDate,
          deleted: false,
          client_updated_at: '',
        });
      }
      const existingLimit = targetForDate(await db.targets.toArray(), targetEffectiveFrom);
      if (
        updateKcalLimit === true ||
        (updateKcalLimit !== false && existingLimit !== preferences.kcalLimit)
      ) {
        changes.push({
          entity_table: 'kcal_targets',
          id: targetIdForDate(targetEffectiveFrom),
          effective_from: targetEffectiveFrom,
          kcal_limit: preferences.kcalLimit,
          deleted: false,
          client_updated_at: '',
        });
      }
      return changes;
    });
  }

  async saveTarget(effectiveDate: string, kcalLimit: number | null): Promise<void> {
    await this.#commit(() => [
      {
        entity_table: 'kcal_targets',
        id: targetIdForDate(effectiveDate),
        effective_from: effectiveDate,
        kcal_limit: kcalLimit,
        deleted: false,
        client_updated_at: '',
      },
    ]);
  }

  async deleteTarget(id: string): Promise<void> {
    await this.#commit(async (db) => {
      const target = await db.targets.get(id);
      return target
        ? [{ ...target, entity_table: 'kcal_targets', deleted: true, client_updated_at: '' }]
        : [];
    });
  }

  async startNewCycle(date = this.#clock.today()): Promise<void> {
    if (!isDateKey(date)) {
      throw new Error('Enter a valid period start date.');
    }
    await this.#commit(async (db) => {
      if (!(await db.syncState.get(SNAPSHOT_ID))) {
        throw new Error('Sync this device once before starting a new period.');
      }
      const current = (await db.profilePreferences.get(PROFILE_ID))?.cycleStartDate;
      if (current === date) {
        return [];
      }
      if (current && date < current) {
        throw new Error('A new period must start after the current period.');
      }
      const changes: KcalSyncChange[] = [];
      if (current) {
        changes.push({
          entity_table: 'kcal_periods',
          id: periodIdForDate(current),
          start_date: current,
          end_date: toDateKey(addDays(parseDateKey(date), -1)),
          deleted: false,
          client_updated_at: '',
        });
      }
      changes.push({
        entity_table: 'kcal_period_starts',
        id: PERIOD_START_ID,
        cycle_start_date: date,
        deleted: false,
        client_updated_at: '',
      });
      return changes;
    });
  }

  async upsertMeal(meal: KcalMeal): Promise<void> {
    await this.#commit(() => [
      { ...meal, entity_table: 'kcal_meals', deleted: false, client_updated_at: '' },
    ]);
  }

  async deleteMeal(id: string): Promise<void> {
    await this.#commit(async (db) => {
      const meal = await db.meals.get(id);
      return meal
        ? [{ ...meal, entity_table: 'kcal_meals', deleted: true, client_updated_at: '' }]
        : [];
    });
  }

  #entryTimestamp(date: string, source?: string): string {
    if (!isDateKey(date)) {
      throw new Error('Enter a valid entry date.');
    }
    if (!source && date === this.#clock.today()) {
      return new Date().toISOString();
    }
    const timestamp = parseDateKey(date);
    const previous = source ? new Date(source) : null;
    timestamp.setHours(
      previous?.getHours() ?? 12,
      previous?.getMinutes() ?? 0,
      previous?.getSeconds() ?? 0,
      previous?.getMilliseconds() ?? 0,
    );
    return timestamp.toISOString();
  }

  async repeatEntry(entryId: string, date = this.#clock.today()): Promise<void> {
    await this.#commit(async (db) => {
      const entry = await db.entries.get(entryId);
      if (!entry) {
        throw new Error('The entry no longer exists.');
      }
      return [
        {
          entity_table: 'kcal_entries',
          id: generateUuid(),
          kcal_delta: entry.kcal_delta,
          happened_at: this.#entryTimestamp(date),
          deleted: false,
          client_updated_at: '',
        },
      ];
    });
  }

  async copyDay(sourceDate: string, targetDate: string): Promise<void> {
    if (!isDateKey(sourceDate) || !isDateKey(targetDate)) {
      throw new Error('Enter valid source and target dates.');
    }
    await this.#commit(async (db) =>
      entriesForDay(await db.entries.toArray(), sourceDate).map((entry): KcalSyncChange => ({
        entity_table: 'kcal_entries',
        id: generateUuid(),
        kcal_delta: entry.kcal_delta,
        happened_at: this.#entryTimestamp(targetDate, entry.happened_at),
        deleted: false,
        client_updated_at: '',
      })),
    );
  }

  async addMeal(mealId: string, date: string): Promise<void> {
    await this.#commit(async (db) => {
      const meal = await db.meals.get(mealId);
      if (!meal) {
        throw new Error('The saved meal no longer exists.');
      }
      return meal.items.map((item): KcalSyncChange => ({
        entity_table: 'kcal_entries',
        id: generateUuid(),
        kcal_delta: item.kcal_delta,
        happened_at: this.#entryTimestamp(date),
        deleted: false,
        client_updated_at: '',
      }));
    });
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
      !/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized.amount) ||
      Number(normalized.amount) < 0.001 ||
      Number(normalized.amount) > 999999999.999 ||
      !Number.isInteger(normalized.kcal_amount) ||
      normalized.kcal_amount <= 0 ||
      normalized.kcal_amount > 2147483647
    ) {
      throw new Error(
        'Enter a name, unit, amount between 0.001 and 999999999.999, and valid calories.',
      );
    }
    await this.#persist({
      entity_table: 'kcal_template_items',
      ...normalized,
      deleted: false,
      client_updated_at: this.#timestamp(),
    });
  }

  async deleteTemplate(id: string): Promise<void> {
    const item = this.templates().find((template) => template.id === id);
    if (item) {
      await this.#persist({
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
    await this.#persist({
      entity_table: 'kcal_entries',
      ...normalized,
      deleted: false,
      client_updated_at: this.#timestamp(),
    });
  }

  async deleteEntry(id: string): Promise<void> {
    const entry = this.entries().find((current) => current.id === id);
    if (entry) {
      await this.#persist({
        entity_table: 'kcal_entries',
        ...entry,
        deleted: true,
        client_updated_at: this.#timestamp(),
      });
    }
  }
}
