import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';

@Component({
  selector: 'app-dashboard-entry-form-modal',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './dashboard-entry-form-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardEntryFormModalComponent {
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
  readonly templateAmountChanged = output<Event>();

  protected submit(): void {
    this.saveRequested.emit();
  }
}
