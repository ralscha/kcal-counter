import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { KcalTemplateKind } from '../../../core/models/kcal.model';

@Component({
  selector: 'app-templates-kind-tabs',
  standalone: true,
  templateUrl: './templates-kind-tabs.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesKindTabsComponent {
  readonly activeKind = input.required<KcalTemplateKind>();
  readonly selectKind = output<KcalTemplateKind>();
}
