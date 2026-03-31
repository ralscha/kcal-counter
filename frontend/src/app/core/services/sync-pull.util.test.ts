/// <reference types="bun-types" />

import { describe, expect, it } from 'bun:test';
import { resolvePullSinceSeq } from './sync-pull.util';

describe('sync-pull.util', () => {
  it('keeps the stored cursor when local sync state exists', () => {
    expect(
      resolvePullSinceSeq({
        lastSeq: 42,
        templateCount: 1,
        entryCount: 0,
        pendingMutationCount: 0,
        hasSnapshot: false,
      }),
    ).toBe(42);
  });

  it('forces a full pull when indexeddb was wiped but the cursor remains', () => {
    expect(
      resolvePullSinceSeq({
        lastSeq: 42,
        templateCount: 0,
        entryCount: 0,
        pendingMutationCount: 0,
        hasSnapshot: false,
      }),
    ).toBe(0);
  });

  it('keeps the stored cursor for a legitimate empty snapshot', () => {
    expect(
      resolvePullSinceSeq({
        lastSeq: 42,
        templateCount: 0,
        entryCount: 0,
        pendingMutationCount: 0,
        hasSnapshot: true,
      }),
    ).toBe(42);
  });

  it('allows a clean empty state with no stored cursor', () => {
    expect(
      resolvePullSinceSeq({
        lastSeq: 0,
        templateCount: 0,
        entryCount: 0,
        pendingMutationCount: 0,
        hasSnapshot: false,
      }),
    ).toBe(0);
  });
});
