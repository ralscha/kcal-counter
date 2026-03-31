import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { KcalEntry } from '../../../core/models/kcal.model';

@Component({
  selector: 'app-history-entry-list',
  standalone: true,
  templateUrl: './history-entry-list.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryEntryListComponent {
  readonly entries = input.required<KcalEntry[]>();

  readonly openEdit = output<KcalEntry>();
  readonly requestDelete = output<KcalEntry>();

  protected formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
