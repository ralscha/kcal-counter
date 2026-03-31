import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { KcalEntry } from '../../core/models/kcal.model';
import { SyncService } from '../../core/services/sync.service';
import { generateUuid } from '../../shared/utils/uuid';
import {
  kcalExpressionValidator,
  parseArithmeticExpression,
} from '../../shared/utils/arithmetic-expression';
import { HistoryDayDetailsComponent } from './components/history-day-details';
import { HistoryDayListComponent } from './components/history-day-list';
import { HistoryDeleteModalComponent } from './components/history-delete-modal';
import { HistoryWeekNavComponent } from './components/history-week-nav';
import { HistoryDay } from './history.models';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const result = startOfDay(date);
  result.setDate(result.getDate() + days);
  return result;
}

function startOfIsoWeek(date: Date): Date {
  const result = startOfDay(date);
  const day = result.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  return result;
}

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function toLocalDateKey(iso: string): string {
  return toDateKey(new Date(iso));
}

function formatDateLabel(date: Date): string {
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatWeekdayLabel(date: Date): string {
  return date.toLocaleDateString([], { weekday: 'short' });
}

function getIsoWeekInfo(date: Date): { week: number; year: number } {
  const target = startOfDay(date);
  const dayNumber = (target.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNumber + 3);

  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstThursdayDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstThursdayDay + 3);

  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / 604800000);
  return { week, year: target.getFullYear() };
}

function buildEntryTimestamp(
  dateKey: string,
  existingEntries: KcalEntry[],
  todayKey: string,
): string {
  if (dateKey === todayKey) {
    return new Date().toISOString();
  }

  const date = parseDateKey(dateKey);
  date.setHours(12, 0, 0, 0);
  date.setMinutes(date.getMinutes() + Math.min(existingEntries.length, 719));
  return date.toISOString();
}

@Component({
  selector: 'app-history',
  imports: [
    ReactiveFormsModule,
    HistoryWeekNavComponent,
    HistoryDayListComponent,
    HistoryDayDetailsComponent,
    HistoryDeleteModalComponent,
  ],
  templateUrl: './history.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryComponent {
  readonly #destroyRef = inject(DestroyRef);
  readonly #fb = inject(FormBuilder);
  readonly #route = inject(ActivatedRoute);
  readonly #router = inject(Router);
  readonly #sync = inject(SyncService);

  readonly #currentWeekStart = startOfIsoWeek(new Date());
  readonly #todayKey = toDateKey(new Date());

  protected selectedWeekStart = signal(this.#currentWeekStart);
  protected selectedDay = signal<string | null>(null);
  protected addingDay = signal<string | null>(null);
  protected editingEntry = signal<KcalEntry | null>(null);
  protected pendingDeleteEntry = signal<KcalEntry | null>(null);
  protected saveLoading = signal(false);
  protected saveError = signal('');
  readonly #reviewEntryId = signal<string | null>(null);
  readonly #handledReviewEntryId = signal<string | null>(null);

  protected form = this.#fb.group({
    kcal_delta: this.#fb.control<number | string | null>(0, {
      validators: [Validators.required, kcalExpressionValidator],
    }),
  });

  protected readonly weekLabel = computed(() => {
    const info = getIsoWeekInfo(this.selectedWeekStart());
    return `W${info.week}/${info.year}`;
  });

  protected readonly canGoForward = computed(
    () => toDateKey(this.selectedWeekStart()) !== toDateKey(this.#currentWeekStart),
  );

  protected readonly formDay = computed(() => {
    const editing = this.editingEntry();
    return editing ? toLocalDateKey(editing.happened_at) : this.addingDay();
  });

  protected readonly selectedDayDetails = computed(
    () => this.days().find((day) => day.dateKey === this.selectedDay()) ?? null,
  );

  protected readonly days = computed<HistoryDay[]>(() => {
    const start = this.selectedWeekStart();
    const isCurrentWeek = toDateKey(start) === toDateKey(this.#currentWeekStart);
    const lastDay = isCurrentWeek ? startOfDay(new Date()) : addDays(start, 6);
    const entries = this.#sync.entries();
    const days: HistoryDay[] = [];

    for (let cursor = startOfDay(start); cursor <= lastDay; cursor = addDays(cursor, 1)) {
      const dateKey = toDateKey(cursor);
      const dayEntries = entries
        .filter((entry) => toLocalDateKey(entry.happened_at) === dateKey)
        .sort((left, right) => right.happened_at.localeCompare(left.happened_at));

      days.push({
        dateKey,
        weekdayLabel: formatWeekdayLabel(cursor),
        dateLabel: formatDateLabel(cursor),
        total: dayEntries.reduce((sum, entry) => sum + entry.kcal_delta, 0),
        entries: dayEntries,
      });
    }

    return days;
  });

  constructor() {
    this.#route.queryParamMap.pipe(takeUntilDestroyed(this.#destroyRef)).subscribe((params) => {
      this.#reviewEntryId.set(params.get('review_entry'));
    });

    effect(() => {
      const reviewEntryId = this.#reviewEntryId();
      if (!reviewEntryId || this.#handledReviewEntryId() === reviewEntryId) {
        return;
      }

      const entry = this.#sync.entries().find((item) => item.id === reviewEntryId);
      if (!entry) {
        return;
      }

      this.#handledReviewEntryId.set(reviewEntryId);
      const dateKey = toLocalDateKey(entry.happened_at);
      this.selectedWeekStart.set(startOfIsoWeek(new Date(entry.happened_at)));
      this.pendingDeleteEntry.set(null);
      this.openEdit(dateKey, entry);
      void this.#router.navigate([], {
        relativeTo: this.#route,
        queryParams: { review_entry: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    });
  }

  protected previousWeek(): void {
    this.selectedWeekStart.update((current) => addDays(current, -7));
    this.resetDetails();
  }

  protected nextWeek(): void {
    if (!this.canGoForward()) {
      return;
    }

    this.selectedWeekStart.update((current) => addDays(current, 7));
    this.resetDetails();
  }

  protected openDay(dateKey: string): void {
    this.selectedDay.set(dateKey);
    this.cancelForm();
  }

  protected backToDays(): void {
    this.selectedDay.set(null);
    this.cancelForm();
  }

  protected openAdd(dateKey: string): void {
    this.selectedDay.set(dateKey);
    this.editingEntry.set(null);
    this.addingDay.set(dateKey);
    this.form.reset({ kcal_delta: 0 });
    this.saveError.set('');
  }

  protected openEdit(dateKey: string, entry: KcalEntry): void {
    this.selectedDay.set(dateKey);
    this.addingDay.set(null);
    this.editingEntry.set(entry);
    this.form.reset({ kcal_delta: entry.kcal_delta });
    this.saveError.set('');
  }

  protected cancelForm(): void {
    this.addingDay.set(null);
    this.editingEntry.set(null);
    this.saveError.set('');
  }

  protected requestDelete(entry: KcalEntry): void {
    this.pendingDeleteEntry.set(entry);
  }

  protected cancelDelete(): void {
    this.pendingDeleteEntry.set(null);
  }

  protected async saveEntry(dateKey: string): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.saveLoading.set(true);
    this.saveError.set('');

    try {
      const { kcal_delta } = this.form.getRawValue();
      const parsedKcal = parseArithmeticExpression(kcal_delta);
      if (parsedKcal == null) {
        this.form.get('kcal_delta')?.markAsTouched();
        return;
      }

      this.form.patchValue({ kcal_delta: parsedKcal });
      const editing = this.editingEntry();
      const entry: KcalEntry = {
        id: editing?.id ?? generateUuid(),
        kcal_delta: parsedKcal,
        happened_at:
          editing?.happened_at ??
          buildEntryTimestamp(dateKey, this.entriesForDate(dateKey), this.#todayKey),
      };

      this.#sync.upsertEntry(entry);
      this.cancelForm();
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        const body = error.error as { error?: { message?: string } };
        this.saveError.set(body?.error?.message ?? 'Failed to save entry.');
      } else {
        this.saveError.set('Failed to save entry.');
      }
    } finally {
      this.saveLoading.set(false);
    }
  }

  protected confirmDelete(): void {
    const entry = this.pendingDeleteEntry();
    if (!entry) {
      return;
    }

    this.#sync.deleteEntry(entry.id);
    if (this.editingEntry()?.id === entry.id) {
      this.cancelForm();
    }
    this.pendingDeleteEntry.set(null);
  }

  private entriesForDate(dateKey: string): KcalEntry[] {
    return this.#sync.entries().filter((entry) => toLocalDateKey(entry.happened_at) === dateKey);
  }

  private resetDetails(): void {
    this.selectedDay.set(null);
    this.cancelForm();
    this.cancelDelete();
  }
}
