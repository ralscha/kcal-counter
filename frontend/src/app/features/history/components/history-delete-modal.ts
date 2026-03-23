import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { KcalEntry } from '../../../core/models/kcal.model';

@Component({
  selector: 'app-history-delete-modal',
  standalone: true,
  templateUrl: './history-delete-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryDeleteModalComponent {
  readonly entry = input.required<KcalEntry>();
  readonly dateLabel = input('');

  readonly cancelRequested = output<void>();
  readonly confirmRequested = output<void>();

  protected formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
