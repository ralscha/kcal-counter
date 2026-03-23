import { KcalEntry } from '../../core/models/kcal.model';

export interface HistoryDay {
  dateKey: string;
  weekdayLabel: string;
  dateLabel: string;
  total: number;
  entries: KcalEntry[];
}
