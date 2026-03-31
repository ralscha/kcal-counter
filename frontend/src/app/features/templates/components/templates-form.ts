import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { KcalTemplateItem, KcalTemplateKind } from '../../../core/models/kcal.model';
import {
  CustomKeypadInputComponent,
  DECIMAL_KEYPAD_ROWS,
  INTEGER_KEYPAD_ROWS,
} from '../../../shared/components/custom-keypad-input/custom-keypad-input';

@Component({
  selector: 'app-templates-form',
  standalone: true,
  imports: [ReactiveFormsModule, CustomKeypadInputComponent],
  templateUrl: './templates-form.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesFormComponent {
  protected readonly decimalKeypadRows = DECIMAL_KEYPAD_ROWS;
  protected readonly integerKeypadRows = INTEGER_KEYPAD_ROWS;

  readonly activeKind = input.required<KcalTemplateKind>();
  readonly editingItem = input<KcalTemplateItem | null>(null);
  readonly form = input.required<FormGroup>();
  readonly formError = input('');
  readonly formLoading = input(false);

  readonly cancelRequested = output<void>();
  readonly saveRequested = output<void>();
}
