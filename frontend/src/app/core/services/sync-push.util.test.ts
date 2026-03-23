/// <reference types="bun-types" />

import { describe, expect, it } from 'bun:test';

import { buildBatchSyncRequest, dedupeQueuedMutations } from './sync-push.util';

describe('sync-push.util', () => {
  it('builds a batched sync request from queued changes', () => {
    const request = buildBatchSyncRequest('device-1', 7, [
      {
        kind: 'template',
        payload: {
          entity_table: 'kcal_template_items',
          id: 'template-1',
          kind: 'food',
          name: 'rice',
          amount: ' 100 ',
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
});
