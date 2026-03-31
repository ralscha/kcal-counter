import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { KcalTemplateItem } from '../../../core/models/kcal.model';

@Component({
  selector: 'app-dashboard-template-picker-modal',
  standalone: true,
  templateUrl: './dashboard-template-picker-modal.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardTemplatePickerModalComponent {
  readonly title = input.required<string>();
  readonly searchQuery = input('');
  readonly templates = input.required<KcalTemplateItem[]>();

  readonly backRequested = output<void>();
  readonly cancelRequested = output<void>();
  readonly manualEntryRequested = output<void>();
  readonly templateSelected = output<KcalTemplateItem>();
  readonly searchQueryChanged = output<Event>();
}
