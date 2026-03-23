import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormGroup } from '@angular/forms';
import { KcalEntry } from '../../../core/models/kcal.model';
import { HistoryDay } from '../history.models';
import { HistoryEntryFormComponent } from './history-entry-form';
import { HistoryEntryListComponent } from './history-entry-list';

@Component({
  selector: 'app-history-day-details',
  standalone: true,
  imports: [HistoryEntryFormComponent, HistoryEntryListComponent],
  templateUrl: './history-day-details.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryDayDetailsComponent {
  readonly day = input.required<HistoryDay>();
  readonly formDay = input<string | null>(null);
  readonly form = input.required<FormGroup>();
  readonly saveLoading = input(false);
  readonly saveError = input('');
  readonly editing = input(false);

  readonly back = output<void>();
  readonly openAdd = output<string>();
  readonly openEdit = output<KcalEntry>();
  readonly cancelForm = output<void>();
  readonly saveEntry = output<string>();
  readonly requestDelete = output<KcalEntry>();
}
