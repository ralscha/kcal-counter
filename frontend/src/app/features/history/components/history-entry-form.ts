import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ReactiveFormsModule, FormGroup } from '@angular/forms';
import { CustomKeypadInputComponent } from '../../../shared/components/custom-keypad-input/custom-keypad-input';

@Component({
  selector: 'app-history-entry-form',
  standalone: true,
  imports: [ReactiveFormsModule, CustomKeypadInputComponent],
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
