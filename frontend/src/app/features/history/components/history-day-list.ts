import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { HistoryDay } from '../history.models';

@Component({
  selector: 'app-history-day-list',
  standalone: true,
  templateUrl: './history-day-list.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryDayListComponent {
  readonly days = input.required<HistoryDay[]>();
  readonly openDay = output<string>();
}
