import { KcalEntry, KcalSyncChange, KcalSyncRequest } from '../models/kcal.model';

export type PendingMutationKind = 'template' | 'entry' | 'period' | 'target' | 'archive' | 'meal';

export interface QueuedSyncMutation {
  id?: number;
  kind: PendingMutationKind;
  payload: KcalSyncChange;
}

export const MAX_SYNC_REQUEST_BYTES = 900 * 1024;

export class SyncBatchError extends Error {}

export function selectSyncBatch(
  deviceId: string,
  lastSyncSeq: number,
  userId: string,
  mutations: QueuedSyncMutation[],
): QueuedSyncMutation[] {
  const pending = dedupeQueuedMutations(mutations);
  const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
  const envelopeBytes = bytes({
    ...buildBatchSyncRequest(deviceId, lastSyncSeq, []),
    user_id: userId,
  });
  const periods = pending.filter((item) => item.kind === 'period' || item.kind === 'archive');
  const independent = pending.filter((item) => item.kind !== 'period' && item.kind !== 'archive');
  const batch: QueuedSyncMutation[] = [];
  let size = envelopeBytes;
  for (const mutation of periods) {
    size += bytes(mutation.payload) + (batch.length > 0 ? 1 : 0);
    if (size > MAX_SYNC_REQUEST_BYTES) {
      throw new SyncBatchError(
        'Too many unsynced period changes to upload together. Export a backup and reduce the pending period changes before retrying.',
      );
    }
    batch.push(mutation);
  }
  for (const mutation of independent) {
    if (batch.length >= Math.max(200, periods.length)) {
      break;
    }
    const nextSize = size + bytes(mutation.payload) + (batch.length > 0 ? 1 : 0);
    if (nextSize > MAX_SYNC_REQUEST_BYTES) {
      if (!batch.length) {
        throw new SyncBatchError(
          'A saved record is too large to upload. Shorten its text or remove it, then retry.',
        );
      }
      break;
    }
    batch.push(mutation);
    size = nextSize;
  }
  return batch;
}

export function syncMutationKind(change: KcalSyncChange): PendingMutationKind {
  switch (change.entity_table) {
    case 'kcal_template_items':
      return 'template';
    case 'kcal_entries':
      return 'entry';
    case 'kcal_period_starts':
      return 'period';
    case 'kcal_targets':
      return 'target';
    case 'kcal_periods':
      return 'archive';
    case 'kcal_meals':
      return 'meal';
  }
}

export function normalizeKcalDelta(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }

  const rounded = value < 0 ? -Math.round(Math.abs(value)) : Math.round(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function normalizeEntry(entry: KcalEntry): KcalEntry {
  return {
    ...entry,
    kcal_delta: normalizeKcalDelta(entry.kcal_delta),
  };
}

export function normalizeTemplateAmount(value: string | number): string {
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) {
    return '';
  }

  if (!/^\d*(\.\d*)?$/.test(normalized) || !/\d/.test(normalized)) {
    return normalized;
  }

  const [rawIntegerPart, rawFractionPart = ''] = normalized.split('.');
  const integerPart = rawIntegerPart.replace(/^0+(?=\d)/, '') || '0';
  const fractionPart = rawFractionPart.replace(/0+$/, '');

  return fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
}

export function normalizeTemplateKcalAmount(value: number | string): number {
  const normalized =
    typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));

  if (!Number.isFinite(normalized)) {
    return normalized;
  }

  return normalizeKcalDelta(normalized);
}

export function normalizeSyncChange(change: KcalSyncChange): KcalSyncChange {
  if (change.entity_table === 'kcal_template_items') {
    return {
      ...change,
      amount: normalizeTemplateAmount(change.amount),
      kcal_amount: normalizeTemplateKcalAmount(change.kcal_amount),
    };
  }

  return change.entity_table === 'kcal_entries'
    ? { ...change, kcal_delta: normalizeKcalDelta(change.kcal_delta) }
    : change;
}

function normalizeQueuedMutation(mutation: QueuedSyncMutation): QueuedSyncMutation {
  return {
    ...mutation,
    payload: normalizeSyncChange(mutation.payload),
  };
}

export function compareClientUpdatedAt(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

export function queuedMutationKey(kind: PendingMutationKind, entityId: string): string {
  return `${kind}:${entityId}`;
}

export function dedupeQueuedMutations(mutations: QueuedSyncMutation[]): QueuedSyncMutation[] {
  const deduped = new Map<string, QueuedSyncMutation>();

  for (const rawMutation of mutations) {
    const mutation = normalizeQueuedMutation(rawMutation);
    const key = queuedMutationKey(mutation.kind, mutation.payload.id);
    const current = deduped.get(key);
    if (!current) {
      deduped.set(key, mutation);
      continue;
    }

    const cmp = compareClientUpdatedAt(
      mutation.payload.client_updated_at,
      current.payload.client_updated_at,
    );
    if (cmp > 0 || (cmp === 0 && (mutation.id ?? 0) >= (current.id ?? 0))) {
      deduped.set(key, mutation);
    }
  }

  return [...deduped.values()].sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
}

export function buildQueuedMutationIndex(
  mutations: QueuedSyncMutation[],
): Map<string, QueuedSyncMutation> {
  return new Map(
    dedupeQueuedMutations(mutations).map((mutation) => [
      queuedMutationKey(mutation.kind, mutation.payload.id),
      mutation,
    ]),
  );
}

export function buildBatchSyncRequest(
  deviceId: string,
  lastSyncSeq: number,
  mutations: QueuedSyncMutation[],
): KcalSyncRequest {
  return {
    device_id: deviceId,
    last_sync_seq: lastSyncSeq,
    changes: dedupeQueuedMutations(mutations).map((mutation) => mutation.payload),
  };
}
