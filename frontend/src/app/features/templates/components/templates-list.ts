import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { KcalTemplateItem, KcalTemplateKind } from '../../../core/models/kcal.model';

@Component({
  selector: 'app-templates-list',
  standalone: true,
  templateUrl: './templates-list.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesListComponent {
  readonly items = input.required<KcalTemplateItem[]>();
  readonly activeKind = input.required<KcalTemplateKind>();

  readonly openEdit = output<KcalTemplateItem>();
  readonly requestDelete = output<KcalTemplateItem>();
  readonly openAdd = output<void>();
}
