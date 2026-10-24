import { targetIdForDate } from '../models/kcal.model';
import type { BackupData } from './backup.util';

export function backupFixture(): BackupData {
  return {
    entries: [
      {
        id: '10000000-0000-0000-0000-000000000001',
        kcal_delta: 150,
        happened_at: new Date(2026, 0, 1, 12).toISOString(),
      },
      {
        id: '10000000-0000-0000-0000-000000000002',
        kcal_delta: -50,
        happened_at: new Date(2026, 0, 3, 12).toISOString(),
      },
    ],
    templates: [
      {
        id: '20000000-0000-0000-0000-000000000001',
        kind: 'food',
        name: 'Rice, cooked',
        amount: '100',
        unit: 'g',
        kcal_amount: 150,
      },
    ],
    targets: [
      { id: targetIdForDate('2026-01-01'), effective_from: '2026-01-01', kcal_limit: 2000 },
      { id: targetIdForDate('2026-01-03'), effective_from: '2026-01-03', kcal_limit: null },
    ],
    periods: [
      {
        id: '30000000-0000-0000-0000-000000000001',
        start_date: '2026-01-01',
        end_date: '2026-01-02',
      },
    ],
    active_period_start: '2026-01-03',
    meals: [
      {
        id: '40000000-0000-0000-0000-000000000001',
        name: 'Lunch',
        items: [
          {
            template_id: '20000000-0000-0000-0000-000000000001',
            name: 'Rice, cooked',
            kcal_delta: 150,
          },
        ],
      },
    ],
  };
}
