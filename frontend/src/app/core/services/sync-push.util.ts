import { KcalEntry, KcalSyncChange, KcalSyncRequest } from '../models/kcal.model';

export type PendingMutationKind = 'template' | 'entry';

export interface QueuedSyncMutation {
  id?: number;
  kind: PendingMutationKind;
  payload: KcalSyncChange;
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

export function normalizeSyncChange(change: KcalSyncChange): KcalSyncChange {
  if (change.entity_table === 'kcal_template_items') {
    return {
      ...change,
      amount: normalizeTemplateAmount(change.amount),
    };
  }

  return {
    ...change,
    kcal_delta: normalizeKcalDelta(change.kcal_delta),
  };
}

function normalizeQueuedMutation(mutation: QueuedSyncMutation): QueuedSyncMutation {
  return {
    ...mutation,
    payload: normalizeSyncChange(mutation.payload),
  };
}

function compareClientUpdatedAt(left: string, right: string): number {
  return left.trim().localeCompare(right.trim());
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
