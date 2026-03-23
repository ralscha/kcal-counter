import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-dashboard-summary',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './dashboard-summary.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardSummaryComponent {
  readonly selectedDateLabel = input.required<string>();
  readonly dailyLimitDifference = input<number | null>(null);
  readonly cycleDifference = input<number | null>(null);
  readonly cycleStartDateLabel = input<string | null>(null);
  readonly totalKcal = input.required<number>();

  readonly addActivity = output<void>();
  readonly addFood = output<void>();

  protected formatSignedKcal(value: number): string {
    return `${value > 0 ? '+' : ''}${value}`;
  }
}
