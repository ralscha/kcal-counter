import { describe, expect, it } from 'bun:test';

import { normalizeDashboardEntryKcal } from './dashboard-kcal';

describe('normalizeDashboardEntryKcal', () => {
  it('forces activity entries negative even when entered as positive', () => {
    expect(normalizeDashboardEntryKcal('activity', false, 250)).toBe(-250);
    expect(normalizeDashboardEntryKcal('activity', false, -250)).toBe(-250);
  });

  it('forces food entries positive', () => {
    expect(normalizeDashboardEntryKcal('food', false, 320)).toBe(320);
    expect(normalizeDashboardEntryKcal('food', false, -320)).toBe(320);
  });

  it('preserves sign while editing existing entries', () => {
    expect(normalizeDashboardEntryKcal('activity', true, 180)).toBe(180);
    expect(normalizeDashboardEntryKcal('food', true, -180)).toBe(-180);
  });
});
