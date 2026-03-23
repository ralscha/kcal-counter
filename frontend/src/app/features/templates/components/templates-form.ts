import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { KcalTemplateItem, KcalTemplateKind } from '../../../core/models/kcal.model';

@Component({
  selector: 'app-templates-form',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './templates-form.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesFormComponent {
  readonly activeKind = input.required<KcalTemplateKind>();
  readonly editingItem = input<KcalTemplateItem | null>(null);
  readonly form = input.required<FormGroup>();
  readonly formError = input('');
  readonly formLoading = input(false);

  readonly cancelRequested = output<void>();
  readonly saveRequested = output<void>();
}
