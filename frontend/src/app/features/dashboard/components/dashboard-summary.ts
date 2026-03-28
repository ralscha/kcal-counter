import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { KcalEntry } from '../../../core/models/kcal.model';

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
  readonly recentEntries = input<KcalEntry[]>([]);
  readonly totalKcal = input.required<number>();

  readonly addActivity = output<void>();
  readonly addFood = output<void>();

  protected formatSignedKcal(value: number): string {
    return `${value > 0 ? '+' : ''}${value}`;
  }

  protected formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
