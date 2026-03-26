import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import {
  KcalEntry,
  KcalSyncChange,
  KcalSyncResponse,
  KcalTemplateItem,
} from '../models/kcal.model';
import { StorageService } from './storage.service';
import { DbService } from './db.service';
import { generateUuid } from '../../shared/utils/uuid';
import {
  buildBatchSyncRequest,
  buildQueuedMutationIndex,
  dedupeQueuedMutations,
  normalizeEntry,
  normalizeSyncChange,
  queuedMutationKey,
  type QueuedSyncMutation,
} from './sync-push.util';
import { resolvePullSinceSeq } from './sync-pull.util';

const DEVICE_ID_KEY = 'device_id';
const LAST_SYNC_SEQ_KEY = 'last_sync_seq';
const SYNC_SNAPSHOT_RECORD_ID = 'pull_snapshot';
const SYNC_RETRY_BASE_MS = 1_000;
const SYNC_RETRY_MAX_MS = 30_000;

function normalizeTemplateItem(item: KcalTemplateItem): KcalTemplateItem {
  return {
    ...item,
    amount: String(item.amount).trim(),
  };
}

function compareClientUpdatedAt(left: string, right: string): number {
  return left.trim().localeCompare(right.trim());
}

interface SyncNotice {
  title: string;
  message: string;
  details: SyncNoticeDetail[];
  tone: 'info' | 'warning';
}

interface SyncNoticeDetail {
  message: string;
  reviewLabel: string | null;
  routeCommands: string[] | null;
  queryParams: Record<string, string> | null;
}

@Injectable({ providedIn: 'root' })
export class SyncService {
  readonly #http = inject(HttpClient);
  readonly #storage = inject(StorageService);
  readonly #db = inject(DbService);

  readonly #deviceId = this.#initDeviceId();

  readonly templates = signal<KcalTemplateItem[]>([]);
  readonly entries = signal<KcalEntry[]>([]);
  readonly syncNotice = signal<SyncNotice | null>(null);

  #isSyncing = false;
  #syncPendingRequested = false;
  #syncRetryDelayMs = 0;
  #syncRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.#requestSyncPending(0));
    }
  }

  #initDeviceId(): string {
    let id = this.#storage.get<string>(DEVICE_ID_KEY);
    if (!id) {
      id = generateUuid();
      this.#storage.set(DEVICE_ID_KEY, id);
    }
    return id;
  }

  #timestamp(): string {
    return new Date().toISOString();
  }

  #lastSyncSeq(): number {
    return this.#storage.get<number>(LAST_SYNC_SEQ_KEY) ?? 0;
  }

  #saveLastSyncSeq(seq: number): void {
    this.#storage.set(LAST_SYNC_SEQ_KEY, seq);
  }

  async #hydrateFromDb(): Promise<{
    templateCount: number;
    entryCount: number;
    pendingMutationCount: number;
    hasSnapshot: boolean;
  }> {
    const [templates, entries, pendingMutationCount, snapshot] = await Promise.all([
      this.#db.templates.toArray(),
      this.#db.entries.toArray(),
      this.#db.pendingMutations.count(),
      this.#db.syncState.get(SYNC_SNAPSHOT_RECORD_ID),
    ]);
    this.templates.set(templates);
    this.entries.set(entries);
    return {
      templateCount: templates.length,
      entryCount: entries.length,
      pendingMutationCount,
      hasSnapshot: snapshot !== undefined,
    };
  }

  async pull(options: { syncPending?: boolean } = {}): Promise<void> {
    const { syncPending = true } = options;
    if (syncPending) {
      await this.#syncPending(true, true);
      return;
    }

    await this.#syncPending(true, false);
  }

  dismissSyncNotice(): void {
    this.syncNotice.set(null);
  }

  #requestSyncPending(delayMs: number): void {
    this.#syncPendingRequested = true;
    if (this.#syncRetryTimer !== null) {
      clearTimeout(this.#syncRetryTimer);
    }
    this.#syncRetryTimer = setTimeout(() => {
      this.#syncRetryTimer = null;
      void this.#syncPending(true, true);
    }, delayMs);
  }

  #nextRetryDelay(): number {
    return this.#syncRetryDelayMs === 0
      ? SYNC_RETRY_BASE_MS
      : Math.min(this.#syncRetryDelayMs * 2, SYNC_RETRY_MAX_MS);
  }

  async #replacePendingMutations(mutations: QueuedSyncMutation[]): Promise<void> {
    await this.#db.pendingMutations.clear();
    if (mutations.length) {
      await this.#db.pendingMutations.bulkAdd(
        mutations.map(({ kind, payload }) => ({ kind, payload })),
      );
    }
  }

  async #loadPendingMutations(): Promise<QueuedSyncMutation[]> {
    const pending = await this.#db.pendingMutations.toArray();
    const deduped = dedupeQueuedMutations(pending);
    if (deduped.length !== pending.length) {
      await this.#replacePendingMutations(deduped);
      return this.#db.pendingMutations.toArray();
    }
    return deduped;
  }

  async #queuePendingMutation(mutation: QueuedSyncMutation): Promise<void> {
    await this.#db.transaction('rw', this.#db.pendingMutations, async () => {
      const pending = await this.#db.pendingMutations.toArray();
      const deduped = dedupeQueuedMutations([...pending, mutation]);
      await this.#replacePendingMutations(deduped);
    });
  }

  async #postSyncRequest(pending: QueuedSyncMutation[]): Promise<KcalSyncResponse> {
    const localState = await this.#hydrateFromDb();
    const lastSyncSeq = this.#lastSyncSeq();
    const syncSeq = resolvePullSinceSeq({ ...localState, lastSeq: lastSyncSeq });
    if (syncSeq !== lastSyncSeq) {
      this.#saveLastSyncSeq(syncSeq);
    }

    return firstValueFrom(
      this.#http.post<KcalSyncResponse>(
        '/api/v1/kcal/sync',
        buildBatchSyncRequest(this.#deviceId, syncSeq, pending),
        { withCredentials: true },
      ),
    );
  }

  async #applyServerChanges(
    changes: KcalSyncChange[],
    pendingByEntity: Map<string, QueuedSyncMutation>,
  ): Promise<void> {
    const templates = new Map(this.templates().map((item) => [item.id, item]));
    const entries = new Map(this.entries().map((item) => [item.id, item]));

    const templatesToPut: KcalTemplateItem[] = [];
    const templateIdsToDelete: string[] = [];
    const entriesToPut: KcalEntry[] = [];
    const entryIdsToDelete: string[] = [];

    for (const rawChange of changes) {
      const change = normalizeSyncChange(rawChange);
      const pending = pendingByEntity.get(
        queuedMutationKey(
          change.entity_table === 'kcal_template_items' ? 'template' : 'entry',
          change.id,
        ),
      );
      if (
        pending &&
        compareClientUpdatedAt(pending.payload.client_updated_at, change.client_updated_at) >= 0
      ) {
        continue;
      }

      if (change.entity_table === 'kcal_template_items') {
        if (change.deleted) {
          templates.delete(change.id);
          templateIdsToDelete.push(change.id);
        } else {
          const item = normalizeTemplateItem({
            id: change.id,
            kind: change.kind,
            name: change.name,
            amount: change.amount,
            unit: change.unit,
            kcal_amount: change.kcal_amount,
          });
          templates.set(change.id, item);
          templatesToPut.push(item);
        }
      } else if (change.deleted) {
        entries.delete(change.id);
        entryIdsToDelete.push(change.id);
      } else {
        const item: KcalEntry = {
          id: change.id,
          kcal_delta: change.kcal_delta,
          happened_at: change.happened_at,
        };
        entries.set(change.id, item);
        entriesToPut.push(item);
      }
    }

    this.templates.set([...templates.values()]);
    this.entries.set([...entries.values()]);

    await Promise.all([
      templatesToPut.length ? this.#db.templates.bulkPut(templatesToPut) : Promise.resolve(),
      templateIdsToDelete.length
        ? this.#db.templates.bulkDelete(templateIdsToDelete)
        : Promise.resolve(),
      entriesToPut.length ? this.#db.entries.bulkPut(entriesToPut) : Promise.resolve(),
      entryIdsToDelete.length ? this.#db.entries.bulkDelete(entryIdsToDelete) : Promise.resolve(),
    ]);
  }

  async #replaceLocalState(changes: KcalSyncChange[]): Promise<void> {
    const templates = changes
      .filter(
        (change): change is Extract<KcalSyncChange, { entity_table: 'kcal_template_items' }> =>
          change.entity_table === 'kcal_template_items' && !change.deleted,
      )
      .map((change) =>
        normalizeTemplateItem({
          id: change.id,
          kind: change.kind,
          name: change.name,
          amount: change.amount,
          unit: change.unit,
          kcal_amount: change.kcal_amount,
        }),
      );
    const entries = changes
      .filter(
        (change): change is Extract<KcalSyncChange, { entity_table: 'kcal_entries' }> =>
          change.entity_table === 'kcal_entries' && !change.deleted,
      )
      .map((change) => ({
        id: change.id,
        kcal_delta: change.kcal_delta,
        happened_at: change.happened_at,
      }));

    await this.#db.templates.clear();
    await this.#db.entries.clear();
    await this.#db.pendingMutations.clear();
    if (templates.length) {
      await this.#db.templates.bulkPut(templates);
    }
    if (entries.length) {
      await this.#db.entries.bulkPut(entries);
    }

    this.templates.set(templates);
    this.entries.set(entries);
  }

  #describeQueuedMutation(mutation: QueuedSyncMutation): string {
    if (mutation.payload.entity_table === 'kcal_template_items') {
      return mutation.payload.deleted
        ? `Deleted ${mutation.payload.kind} template "${mutation.payload.name}"`
        : `${mutation.payload.kind} template "${mutation.payload.name}"`;
    }

    return mutation.payload.deleted
      ? `Deleted entry from ${mutation.payload.happened_at}`
      : `Entry ${mutation.payload.kcal_delta} kcal from ${mutation.payload.happened_at}`;
  }

  #buildReviewTarget(mutation: QueuedSyncMutation): {
    reviewLabel: string | null;
    routeCommands: string[] | null;
    queryParams: Record<string, string> | null;
  } {
    if (mutation.payload.entity_table === 'kcal_template_items') {
      return {
        reviewLabel: 'Review template',
        routeCommands:
          mutation.payload.kind === 'activity' ? ['/templates', 'activity'] : ['/templates'],
        queryParams: { review_template: mutation.payload.id },
      };
    }

    return {
      reviewLabel: 'Review entry',
      routeCommands: ['/history'],
      queryParams: { review_entry: mutation.payload.id },
    };
  }

  #handleDiscardedChanges(
    pushResults: KcalSyncResponse['data']['push_results'],
    pendingByEntity: Map<string, QueuedSyncMutation>,
  ): void {
    const discarded = pushResults.filter((result) => !result.applied);
    if (!discarded.length) {
      return;
    }

    this.syncNotice.set({
      title: 'Some offline changes were skipped',
      message: 'The server already had newer versions of some queued edits.',
      details: discarded.map((result) => {
        const mutation = pendingByEntity.get(
          queuedMutationKey(
            result.record.entity_table === 'kcal_template_items' ? 'template' : 'entry',
            result.record.id,
          ),
        );
        if (!mutation) {
          return {
            message: `Change ${result.record.id} was skipped because the server already had a newer version.`,
            reviewLabel: null,
            routeCommands: null,
            queryParams: null,
          };
        }

        return {
          message: `${this.#describeQueuedMutation(mutation)}: skipped because the server already had a newer version.`,
          ...this.#buildReviewTarget(mutation),
        };
      }),
      tone: 'info',
    });
  }

  async #syncPending(allowEmptySync: boolean, includePendingMutations = true): Promise<void> {
    if (this.#isSyncing) {
      this.#syncPendingRequested = true;
      return;
    }

    this.#isSyncing = true;
    this.#syncPendingRequested = false;
    try {
      const pending = includePendingMutations ? await this.#loadPendingMutations() : [];
      if (!pending.length && !allowEmptySync) {
        this.#syncRetryDelayMs = 0;
        return;
      }

      const response = await this.#postSyncRequest(pending);
      if (response.data.reset_required) {
        await this.#replaceLocalState(response.data.pull_changes);
        this.#saveLastSyncSeq(response.data.last_sync_seq);
        await this.#db.syncState.put({ id: SYNC_SNAPSHOT_RECORD_ID });
        this.#syncRetryDelayMs = 0;
        this.syncNotice.set({
          title: 'Offline cache was reset',
          message:
            response.data.reset_reason ??
            'The server no longer retained enough sync history to merge local state safely.',
          details: [],
          tone: 'warning',
        });
        return;
      }

      const sentPendingByEntity = buildQueuedMutationIndex(pending);
      const sentIds = pending.flatMap((mutation) =>
        mutation.id === undefined ? [] : [mutation.id],
      );
      if (sentIds.length) {
        await this.#db.pendingMutations.bulkDelete(sentIds);
      }

      const pendingByEntity = buildQueuedMutationIndex(await this.#loadPendingMutations());
      await this.#applyServerChanges(
        response.data.push_results.map((result) => result.record),
        pendingByEntity,
      );
      await this.#applyServerChanges(response.data.pull_changes, pendingByEntity);
      this.#saveLastSyncSeq(response.data.last_sync_seq);
      await this.#db.syncState.put({ id: SYNC_SNAPSHOT_RECORD_ID });
      this.#syncRetryDelayMs = 0;
      this.#handleDiscardedChanges(response.data.push_results, sentPendingByEntity);
    } catch {
      if ((await this.#db.pendingMutations.count()) > 0 || allowEmptySync) {
        this.#syncRetryDelayMs = this.#nextRetryDelay();
        this.#requestSyncPending(this.#syncRetryDelayMs);
      }
    } finally {
      this.#isSyncing = false;
      if (this.#syncPendingRequested && this.#syncRetryDelayMs === 0) {
        this.#requestSyncPending(0);
      }
    }
  }

  async #persistAndPush(kind: 'template' | 'entry', change: KcalSyncChange): Promise<void> {
    const normalizedChange = normalizeSyncChange(change);

    if (normalizedChange.entity_table === 'kcal_template_items') {
      if (normalizedChange.deleted) {
        await this.#db.templates.delete(normalizedChange.id);
      } else {
        await this.#db.templates.put(
          normalizeTemplateItem({
            id: normalizedChange.id,
            kind: normalizedChange.kind,
            name: normalizedChange.name,
            amount: normalizedChange.amount,
            unit: normalizedChange.unit,
            kcal_amount: normalizedChange.kcal_amount,
          }),
        );
      }
    } else if (normalizedChange.deleted) {
      await this.#db.entries.delete(normalizedChange.id);
    } else {
      await this.#db.entries.put({
        id: normalizedChange.id,
        kcal_delta: normalizedChange.kcal_delta,
        happened_at: normalizedChange.happened_at,
      });
    }

    await this.#queuePendingMutation({ kind, payload: normalizedChange });
    await this.#syncPending(false, true);
  }

  upsertTemplate(item: KcalTemplateItem): void {
    const updatedAt = this.#timestamp();
    const normalizedItem = normalizeTemplateItem(item);
    this.templates.update((list) => {
      const idx = list.findIndex((template) => template.id === normalizedItem.id);
      if (idx >= 0) {
        const updated = [...list];
        updated[idx] = normalizedItem;
        return updated;
      }
      return [...list, normalizedItem];
    });
    void this.#persistAndPush('template', {
      entity_table: 'kcal_template_items',
      ...normalizedItem,
      deleted: false,
      client_updated_at: updatedAt,
    });
  }

  deleteTemplate(id: string): void {
    const updatedAt = this.#timestamp();
    const item = this.templates().find((template) => template.id === id);
    if (!item) {
      return;
    }
    this.templates.update((list) => list.filter((template) => template.id !== id));
    void this.#persistAndPush('template', {
      entity_table: 'kcal_template_items',
      ...item,
      deleted: true,
      client_updated_at: updatedAt,
    });
  }

  upsertEntry(entry: KcalEntry): void {
    const updatedAt = this.#timestamp();
    const normalizedEntry = normalizeEntry(entry);
    this.entries.update((list) => {
      const idx = list.findIndex((current) => current.id === normalizedEntry.id);
      if (idx >= 0) {
        const updated = [...list];
        updated[idx] = normalizedEntry;
        return updated;
      }
      return [...list, normalizedEntry];
    });
    void this.#persistAndPush('entry', {
      entity_table: 'kcal_entries',
      ...normalizedEntry,
      deleted: false,
      client_updated_at: updatedAt,
    });
  }

  deleteEntry(id: string): void {
    const updatedAt = this.#timestamp();
    const entry = this.entries().find((current) => current.id === id);
    if (!entry) {
      return;
    }
    this.entries.update((list) => list.filter((current) => current.id !== id));
    void this.#persistAndPush('entry', {
      entity_table: 'kcal_entries',
      ...entry,
      deleted: true,
      client_updated_at: updatedAt,
    });
  }
}
