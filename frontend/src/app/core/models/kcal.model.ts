export type KcalTemplateKind = 'food' | 'activity';

export interface KcalTemplateItem {
  id: string;
  kind: KcalTemplateKind;
  name: string;
  amount: string;
  unit: string;
  kcal_amount: number;
}

export interface KcalEntry {
  id: string;
  kcal_delta: number;
  happened_at: string;
}

export interface KcalTarget {
  id: string;
  effective_from: string;
  kcal_limit: number | null;
}

export function targetIdForDate(date: string): string {
  return `00000000-0000-0000-0002-0000${date.replaceAll('-', '')}`;
}

export function periodIdForDate(date: string): string {
  return `00000000-0000-0000-0003-0000${date.replaceAll('-', '')}`;
}

export interface KcalPeriod {
  id: string;
  start_date: string;
  end_date: string;
}

export interface KcalMealItem {
  template_id: string;
  name: string;
  kcal_delta: number;
}

export interface KcalMeal {
  id: string;
  name: string;
  items: KcalMealItem[];
}

interface SyncMetadata {
  deleted: boolean;
  client_updated_at: string;
  global_version?: number;
  server_updated_at?: string;
}

export interface KcalSyncTargetChange extends KcalTarget, SyncMetadata {
  entity_table: 'kcal_targets';
}

export interface KcalSyncArchiveChange extends KcalPeriod, SyncMetadata {
  entity_table: 'kcal_periods';
}

export interface KcalSyncMealChange extends KcalMeal, SyncMetadata {
  entity_table: 'kcal_meals';
}

export interface KcalSyncTemplateChange extends KcalTemplateItem {
  entity_table: 'kcal_template_items';
  deleted: boolean;
  client_updated_at: string;
  global_version?: number;
  server_updated_at?: string;
}

export interface KcalSyncEntryChange extends KcalEntry {
  entity_table: 'kcal_entries';
  deleted: boolean;
  client_updated_at: string;
  global_version?: number;
  server_updated_at?: string;
}

export const PERIOD_START_ID = '00000000-0000-0000-0000-000000000001';

export interface KcalSyncPeriodChange {
  entity_table: 'kcal_period_starts';
  id: typeof PERIOD_START_ID;
  cycle_start_date: string | null;
  deleted: false;
  client_updated_at: string;
  global_version?: number;
  server_updated_at?: string;
}

export type KcalSyncChange =
  | KcalSyncTemplateChange
  | KcalSyncEntryChange
  | KcalSyncPeriodChange
  | KcalSyncTargetChange
  | KcalSyncArchiveChange
  | KcalSyncMealChange;

export interface KcalSyncRequest {
  device_id: string;
  last_sync_seq: number;
  changes: KcalSyncChange[];
}

export interface KcalSyncPushResult {
  applied: boolean;
  record: KcalSyncChange;
}

export interface KcalSyncResponse {
  data: {
    reset_required: boolean;
    reset_reason?: string;
    last_sync_seq: number;
    min_valid_seq: number;
    push_results: KcalSyncPushResult[];
    pull_changes: KcalSyncChange[];
  };
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    fields?: Record<string, unknown>;
  };
}
