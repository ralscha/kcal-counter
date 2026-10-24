import { PERIOD_START_ID, targetIdForDate, type KcalSyncChange } from '../models/kcal.model';
import { isDateKey } from '../../shared/utils/local-date';
import {
  normalizeKcalDelta,
  normalizeTemplateAmount,
  normalizeTemplateKcalAmount,
} from './sync-push.util';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INT = 2147483647;
export const MAX_ARCHIVED_PERIODS = 1000;
export const MAX_SYNC_CHANGE_BYTES = 128 * 1024;

function validUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    UUID.test(value) &&
    value !== '00000000-0000-0000-0000-000000000000'
  );
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function text(value: unknown, name: string, maxLength = Infinity): string {
  check(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      Array.from(value.trim()).length <= maxLength,
    `Enter a valid ${name}.`,
  );
  return value.trim();
}

function date(value: unknown): asserts value is string {
  check(typeof value === 'string' && isDateKey(value), 'Enter a valid calendar date.');
}

// Construct data fields explicitly: imported server versions and timestamps are never trusted.
function prepareChangeData(
  change: KcalSyncChange,
  timestamp: string,
  strictIds = true,
): KcalSyncChange {
  check(change !== null && typeof change === 'object', 'Invalid change.');
  check(
    typeof change.id === 'string' && (strictIds ? validUuid(change.id) : change.id.length > 0),
    'Enter a valid record ID.',
  );
  check(typeof change.deleted === 'boolean', 'Invalid deleted flag.');
  const base = { id: change.id, deleted: change.deleted, client_updated_at: timestamp };
  switch (change.entity_table) {
    case 'kcal_template_items': {
      check(change.kind === 'food' || change.kind === 'activity', 'Enter a valid template kind.');
      const amount = normalizeTemplateAmount(change.amount);
      const calories = normalizeTemplateKcalAmount(change.kcal_amount);
      check(
        /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(amount) &&
          Number(amount) >= 0.001 &&
          Number(amount) <= 999999999.999,
        'Enter an amount between 0.001 and 999999999.999.',
      );
      check(
        Number.isInteger(calories) && calories > 0 && calories <= MAX_INT,
        'Enter valid template calories.',
      );
      return {
        ...base,
        entity_table: change.entity_table,
        kind: change.kind,
        name: text(change.name, 'template name'),
        unit: text(change.unit, 'unit'),
        amount,
        kcal_amount: calories,
      };
    }
    case 'kcal_entries': {
      const calories = normalizeKcalDelta(change.kcal_delta);
      check(
        Number.isInteger(calories) &&
          calories !== 0 &&
          calories >= -2147483648 &&
          calories <= MAX_INT,
        'Enter nonzero calories within the supported range.',
      );
      check(
        typeof change.happened_at === 'string' &&
          /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
            change.happened_at,
          ) &&
          isDateKey(change.happened_at.slice(0, 10)) &&
          Number.isFinite(Date.parse(change.happened_at)),
        'Enter a valid entry timestamp.',
      );
      return {
        ...base,
        entity_table: change.entity_table,
        kcal_delta: calories,
        happened_at: change.happened_at,
      };
    }
    case 'kcal_period_starts':
      check(
        change.id === PERIOD_START_ID && change.deleted === false,
        'Invalid active period record.',
      );
      if (change.cycle_start_date !== null) {
        date(change.cycle_start_date);
      }
      return {
        ...base,
        id: PERIOD_START_ID,
        deleted: false,
        entity_table: change.entity_table,
        cycle_start_date: change.cycle_start_date,
      };
    case 'kcal_targets':
      date(change.effective_from);
      check(
        change.id === targetIdForDate(change.effective_from),
        'Target ID must match its effective date.',
      );
      check(
        change.kcal_limit === null ||
          (Number.isInteger(change.kcal_limit) &&
            change.kcal_limit > 0 &&
            change.kcal_limit <= MAX_INT),
        'Enter a positive whole-number target within the supported range.',
      );
      return {
        ...base,
        entity_table: change.entity_table,
        effective_from: change.effective_from,
        kcal_limit: change.kcal_limit,
      };
    case 'kcal_periods':
      date(change.start_date);
      date(change.end_date);
      check(change.end_date >= change.start_date, 'A period must end on or after its start date.');
      return {
        ...base,
        entity_table: change.entity_table,
        start_date: change.start_date,
        end_date: change.end_date,
      };
    case 'kcal_meals': {
      check(
        Array.isArray(change.items) && change.items.length >= 1 && change.items.length <= 100,
        'A saved meal must have between 1 and 100 items.',
      );
      const items = change.items.map((item) => {
        check(
          item !== null && typeof item === 'object' && validUuid(item.template_id),
          'Enter a valid meal template ID.',
        );
        check(
          Number.isInteger(item.kcal_delta) && item.kcal_delta > 0 && item.kcal_delta <= MAX_INT,
          'Enter positive whole-number meal calories.',
        );
        return {
          template_id: item.template_id,
          name: text(item.name, 'meal item name', 200),
          kcal_delta: item.kcal_delta,
        };
      });
      return {
        ...base,
        entity_table: change.entity_table,
        name: text(change.name, 'meal name', 200),
        items,
      };
    }
    default:
      throw new Error('Unsupported record type.');
  }
}

export function prepareSyncChange(
  change: KcalSyncChange,
  timestamp: string,
  strictIds = true,
): KcalSyncChange {
  const prepared = prepareChangeData(change, timestamp, strictIds);
  check(
    new TextEncoder().encode(JSON.stringify(prepared)).length <= MAX_SYNC_CHANGE_BYTES,
    'A single record is too large to sync (maximum 128 KiB).',
  );
  return prepared;
}
