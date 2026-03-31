import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { KcalTemplateItem } from '../../../core/models/kcal.model';

@Component({
  selector: 'app-templates-delete-modal',
  standalone: true,
  templateUrl: './templates-delete-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesDeleteModalComponent {
  readonly item = input.required<KcalTemplateItem>();

  readonly cancelRequested = output<void>();
  readonly confirmRequested = output<void>();
}
