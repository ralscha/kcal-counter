import { describe, expect, it } from 'vitest';

import {
  compareClientUpdatedAt,
  buildBatchSyncRequest,
  dedupeQueuedMutations,
  normalizeTemplateAmount,
  normalizeTemplateKcalAmount,
  selectSyncBatch,
  MAX_SYNC_REQUEST_BYTES,
  type QueuedSyncMutation,
} from './sync-push.util';
import { PERIOD_START_ID } from '../models/kcal.model';
import { prepareSyncChange } from './sync-validation.util';

describe('sync-push.util', () => {
  it('keeps more than 200 archive changes and the active period in one request', () => {
    const archives: QueuedSyncMutation[] = Array.from({ length: 250 }, (_, i) => ({
      id: i + 1,
      kind: 'archive',
      payload: {
        entity_table: 'kcal_periods',
        id: crypto.randomUUID(),
        start_date: '2026-01-01',
        end_date: '2026-01-02',
        deleted: false,
        client_updated_at: '2026-10-22T12:00:00Z',
      },
    }));
    archives.push({
      id: 251,
      kind: 'period',
      payload: {
        entity_table: 'kcal_period_starts',
        id: PERIOD_START_ID,
        cycle_start_date: '2026-10-22',
        deleted: false,
        client_updated_at: '2026-10-22T12:00:00Z',
      },
    });
    const batch = selectSyncBatch('device', 0, 'account', archives);
    expect(batch).toHaveLength(251);
    expect(batch.at(-1)?.kind).toBe('period');
  });

  it('bounds large Unicode meal batches by serialized UTF-8 request bytes', () => {
    const meals: QueuedSyncMutation[] = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      kind: 'meal',
      payload: prepareSyncChange(
        {
          entity_table: 'kcal_meals',
          id: crypto.randomUUID(),
          name: '🍎'.repeat(200),
          items: Array.from({ length: 100 }, () => ({
            template_id: crypto.randomUUID(),
            name: '🍎'.repeat(200),
            kcal_delta: 100,
          })),
          deleted: false,
          client_updated_at: '',
        },
        '2026-10-22T12:00:00Z',
      ),
    }));
    const batch = selectSyncBatch('device', 10, 'account', meals);
    const bytes = new TextEncoder().encode(
      JSON.stringify({ ...buildBatchSyncRequest('device', 10, batch), user_id: 'account' }),
    ).length;
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThan(meals.length);
    expect(bytes).toBeLessThanOrEqual(MAX_SYNC_REQUEST_BYTES);
  });

  it('rejects an individual record that could not be uploaded', () => {
    expect(() =>
      prepareSyncChange(
        {
          entity_table: 'kcal_template_items',
          id: crypto.randomUUID(),
          kind: 'food',
          name: '🍎'.repeat(40000),
          amount: '1',
          unit: 'g',
          kcal_amount: 100,
          deleted: false,
          client_updated_at: '',
        },
        '2026-10-22T12:00:00Z',
      ),
    ).toThrow('128 KiB');
  });

  it('compares instants across offsets and fractional timestamp formats', () => {
    expect(compareClientUpdatedAt('2026-09-06T12:00:00Z', '2026-09-06T12:00:00.001Z')).toBeLessThan(
      0,
    );
    expect(
      compareClientUpdatedAt('2026-09-06T14:00:00+02:00', '2026-09-06T12:01:00Z'),
    ).toBeLessThan(0);
    expect(compareClientUpdatedAt('2026-09-06T12:00:00Z', '2026-09-06T12:00:00.000Z')).toBe(0);
  });
  it('builds a batched sync request from queued changes', () => {
    const request = buildBatchSyncRequest('device-1', 7, [
      {
        kind: 'template',
        payload: {
          entity_table: 'kcal_template_items',
          id: 'template-1',
          kind: 'food',
          name: 'rice',
          amount: ' 0100.000 ',
          unit: 'g',
          kcal_amount: 130,
          deleted: false,
          client_updated_at: '2026-03-23T12:00:00Z',
        },
      },
      {
        kind: 'entry',
        payload: {
          entity_table: 'kcal_entries',
          id: 'entry-1',
          kcal_delta: 260,
          happened_at: '2026-03-23T11:58:00Z',
          deleted: false,
          client_updated_at: '2026-03-23T12:01:00Z',
        },
      },
    ]);

    expect(request).toEqual({
      device_id: 'device-1',
      last_sync_seq: 7,
      changes: [
        {
          entity_table: 'kcal_template_items',
          id: 'template-1',
          kind: 'food',
          name: 'rice',
          amount: '100',
          unit: 'g',
          kcal_amount: 130,
          deleted: false,
          client_updated_at: '2026-03-23T12:00:00Z',
        },
        {
          entity_table: 'kcal_entries',
          id: 'entry-1',
          kcal_delta: 260,
          happened_at: '2026-03-23T11:58:00Z',
          deleted: false,
          client_updated_at: '2026-03-23T12:01:00Z',
        },
      ],
    });
  });

  it('deduplicates queued mutations per entity and keeps the newest timestamp', () => {
    const deduped = dedupeQueuedMutations([
      {
        id: 1,
        kind: 'entry',
        payload: {
          entity_table: 'kcal_entries',
          id: 'entry-1',
          kcal_delta: 100,
          happened_at: '2026-03-23T11:58:00Z',
          deleted: false,
          client_updated_at: '2026-03-23T12:00:00Z',
        },
      },
      {
        id: 2,
        kind: 'entry',
        payload: {
          entity_table: 'kcal_entries',
          id: 'entry-1',
          kcal_delta: 150,
          happened_at: '2026-03-23T11:58:00Z',
          deleted: false,
          client_updated_at: '2026-03-23T12:01:00Z',
        },
      },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.payload).toMatchObject({ kcal_delta: 150 });
  });

  it('normalizes template amount strings without forcing trailing zeros', () => {
    expect(normalizeTemplateAmount('10')).toBe('10');
    expect(normalizeTemplateAmount('10.500')).toBe('10.5');
    expect(normalizeTemplateAmount('0010.000')).toBe('10');
  });

  it('normalizes template kcal strings into numbers', () => {
    expect(normalizeTemplateKcalAmount('90')).toBe(90);
    expect(normalizeTemplateKcalAmount('097.5')).toBe(98);
    expect(normalizeTemplateKcalAmount(130)).toBe(130);
  });
});
