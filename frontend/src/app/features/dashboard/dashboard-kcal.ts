import { KcalTemplateKind } from '../../core/models/kcal.model';

export function normalizeDashboardEntryKcal(
  kind: KcalTemplateKind | null,
  isEditing: boolean,
  kcalDelta: number,
): number {
  if (isEditing || kind == null) {
    return kcalDelta;
  }

  if (kind === 'activity') {
    return -Math.abs(kcalDelta);
  }

  return Math.abs(kcalDelta);
}
