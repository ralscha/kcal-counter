import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import {
  CustomKeypadInputComponent,
  DECIMAL_KEYPAD_ROWS,
  EXPRESSION_KEYPAD_ROWS,
} from '../../../shared/components/custom-keypad-input/custom-keypad-input';

@Component({
  selector: 'app-dashboard-entry-form-modal',
  standalone: true,
  imports: [ReactiveFormsModule, CustomKeypadInputComponent],
  templateUrl: './dashboard-entry-form-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardEntryFormModalComponent {
  protected readonly decimalKeypadRows = DECIMAL_KEYPAD_ROWS;
  protected readonly expressionKeypadRows = EXPRESSION_KEYPAD_ROWS;

  readonly title = input.required<string>();
  readonly form = input.required<FormGroup>();
  readonly error = input('');
  readonly editing = input(false);
  readonly hasSelectedTemplate = input(false);
  readonly templateAmountInput = input('');
  readonly templateAmountLabel = input('Amount');
  readonly templateAmountPlaceholder = input('');
  readonly selectedTemplateLabel = input('Manual entry');
  readonly loading = input(false);

  readonly backRequested = output<void>();
  readonly cancelRequested = output<void>();
  readonly saveRequested = output<void>();
  readonly templateAmountChanged = output<string>();

  protected submit(): void {
    this.saveRequested.emit();
  }
}
