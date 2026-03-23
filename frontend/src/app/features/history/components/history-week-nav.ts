import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

@Component({
  selector: 'app-history-week-nav',
  standalone: true,
  templateUrl: './history-week-nav.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryWeekNavComponent {
  readonly weekLabel = input.required<string>();
  readonly canGoForward = input(false);

  readonly previousWeek = output<void>();
  readonly nextWeek = output<void>();
}
