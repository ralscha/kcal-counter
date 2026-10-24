import { Component, computed, effect, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { SyncService } from '../../core/services/sync.service';
import { LocalDateService } from '../../core/services/local-date.service';
import {
  KcalChartComponent,
  type ChartSeries,
} from '../../shared/components/kcal-chart/kcal-chart';
import { buildDailyStatistics, createPeriodSummarizer } from '../../shared/utils/kcal-statistics';
import {
  addDays,
  calendarDaysBetween,
  parseDateKey,
  toDateKey,
} from '../../shared/utils/local-date';

@Component({
  selector: 'app-trends',
  imports: [DecimalPipe, RouterLink, KcalChartComponent],
  templateUrl: './trends.html',
})
export class TrendsComponent {
  readonly #sync = inject(SyncService);
  readonly #clock = inject(LocalDateService);
  protected readonly days = signal(30);
  protected readonly selectedPeriod = signal<string | null>(null);
  protected readonly cursor = signal<number | null>(null);
  protected readonly activeStart = computed(() => this.#sync.preferences().cycleStartDate);
  protected readonly activeStarted = computed(() => {
    const start = this.activeStart();
    return start !== null && start <= this.#clock.today();
  });
  readonly #summarize = computed(() =>
    createPeriodSummarizer(this.#sync.entries(), this.#sync.targets()),
  );
  protected readonly periodRows = computed(() =>
    this.#sync
      .periods()
      .slice()
      .sort((a, b) => b.start_date.localeCompare(a.start_date))
      .map((period) => ({
        ...period,
        ...this.#summarize()(period.start_date, period.end_date),
      })),
  );
  protected readonly range = computed(() => {
    const period = this.#sync.periods().find((item) => item.id === this.selectedPeriod());
    if (period) {
      return { start: period.start_date, end: period.end_date, label: 'Archived period' };
    }
    const today = this.#clock.today();
    const active = this.activeStart();
    if (this.selectedPeriod() === 'active' && active && active <= today) {
      return { start: active, end: today, label: 'Current period' };
    }
    return {
      start: toDateKey(addDays(parseDateKey(today), 1 - this.days())),
      end: today,
      label: `Last ${this.days()} days`,
    };
  });
  protected readonly summary = computed(() =>
    this.#summarize()(this.range().start, this.range().end),
  );
  protected readonly clipped = computed(
    () => calendarDaysBetween(this.range().start, this.range().end) >= 366,
  );
  protected readonly rows = computed(() => {
    const { start, end } = this.range();
    const visibleStart = this.clipped() ? toDateKey(addDays(parseDateKey(end), -365)) : start;
    const rows = buildDailyStatistics(
      this.#sync.entries(),
      this.#sync.targets(),
      visibleStart,
      end,
    );
    if (visibleStart > start) {
      const prefix = this.#summarize()(start, toDateKey(addDays(parseDateKey(visibleStart), -1)));
      return rows.map((row) => ({
        ...row,
        cumulativeDifference:
          prefix.difference === null || row.cumulativeDifference === null
            ? null
            : prefix.difference + row.cumulativeDifference,
      }));
    }
    return rows;
  });
  protected readonly dates = computed(() => this.rows().map((row) => row.date));
  protected readonly selectedIndex = computed(() =>
    Math.min(this.cursor() ?? this.rows().length - 1, this.rows().length - 1),
  );
  protected readonly selectedDay = computed(() => this.rows()[this.selectedIndex()]);
  protected readonly dailySeries = computed<ChartSeries[]>(() => [
    {
      name: 'Daily net kcal',
      values: this.rows().map((row) => row.total),
      color: 'var(--color-primary)',
    },
    {
      name: 'Daily target',
      values: this.rows().map((row) => row.target),
      color: 'var(--color-secondary)',
      dashed: true,
    },
    {
      name: '7-day average',
      values: this.rows().map((row) => row.rollingAverage),
      color: 'var(--color-accent)',
    },
  ]);
  protected readonly cumulativeSeries = computed<ChartSeries[]>(() => [
    {
      name: 'Cumulative difference',
      values: this.rows().map((row) => row.cumulativeDifference),
      color: 'var(--color-primary)',
    },
  ]);

  constructor() {
    effect(() => {
      const selected = this.selectedPeriod();
      if (
        selected &&
        (selected === 'active'
          ? !this.activeStarted()
          : !this.#sync.periods().some((period) => period.id === selected))
      ) {
        this.selectedPeriod.set(null);
        this.cursor.set(null);
      }
    });
  }

  protected selectDays(days: number): void {
    this.days.set(days);
    this.selectedPeriod.set(null);
    this.cursor.set(null);
  }
  protected viewPeriod(id: string): void {
    this.selectedPeriod.set(id);
    this.cursor.set(null);
  }
  protected selectDay(event: Event): void {
    this.cursor.set(Number((event.target as HTMLInputElement).value));
  }
}
