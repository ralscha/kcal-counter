import { Component, input, output } from '@angular/core';
import { KcalEntry } from '../../../core/models/kcal.model';

@Component({
  selector: 'app-history-entry-list',
  standalone: true,
  templateUrl: './history-entry-list.html',
})
export class HistoryEntryListComponent {
  readonly entries = input.required<KcalEntry[]>();
  readonly repeatLoading = input(false);

  readonly openEdit = output<KcalEntry>();
  readonly requestDelete = output<KcalEntry>();
  readonly repeatEntry = output<KcalEntry>();

  protected formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
