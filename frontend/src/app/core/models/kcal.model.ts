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

export type KcalSyncChange = KcalSyncTemplateChange | KcalSyncEntryChange;

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
