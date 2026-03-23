import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ReactiveFormsModule, FormGroup } from '@angular/forms';

@Component({
  selector: 'app-history-entry-form',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './history-entry-form.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryEntryFormComponent {
  readonly dateKey = input.required<string>();
  readonly form = input.required<FormGroup>();
  readonly saveLoading = input(false);
  readonly saveError = input('');
  readonly editing = input(false);

  readonly cancelRequested = output<void>();
  readonly saveRequested = output<string>();

  protected submit(): void {
    this.saveRequested.emit(this.dateKey());
  }
}
