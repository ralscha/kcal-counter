import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SyncService } from '../../../core/services/sync.service';
import { LocalDateService } from '../../../core/services/local-date.service';
import { ToastService } from '../../../core/services/toast.service';
import {
  addDays,
  entriesForDay,
  parseDateKey,
  toDateKey,
  toLocalDateKey,
} from '../../../shared/utils/local-date';

@Component({
  selector: 'app-quick-logging',
  imports: [RouterLink],
  templateUrl: './quick-logging.html',
})
export class QuickLoggingComponent {
  readonly #sync = inject(SyncService);
  readonly #clock = inject(LocalDateService);
  readonly #toast = inject(ToastService);
  protected readonly busy = signal(false);
  protected readonly confirmCopy = signal(false);
  protected readonly yesterday = computed(() =>
    toDateKey(addDays(parseDateKey(this.#clock.today()), -1)),
  );
  protected readonly yesterdayEntries = computed(() =>
    entriesForDay(this.#sync.entries(), this.yesterday()),
  );
  protected readonly yesterdayTotal = computed(() =>
    this.yesterdayEntries().reduce((sum, entry) => sum + entry.kcal_delta, 0),
  );
  protected readonly meals = this.#sync.meals;
  protected readonly recent = computed(() =>
    this.#sync
      .entries()
      .filter((entry) => toLocalDateKey(entry.happened_at) <= this.#clock.today())
      .slice()
      .sort((a, b) => Date.parse(b.happened_at) - Date.parse(a.happened_at))
      .slice(0, 5),
  );
  protected readonly dateLabel = toLocalDateKey;

  protected async repeat(id: string): Promise<void> {
    await this.run(() => this.#sync.repeatEntry(id, this.#clock.today()), 'Entry repeated today.');
  }
  protected async addMeal(id: string): Promise<void> {
    await this.run(() => this.#sync.addMeal(id, this.#clock.today()), 'Meal added to today.');
  }
  protected async copyYesterday(): Promise<void> {
    await this.run(async () => {
      await this.#sync.copyDay(this.yesterday(), this.#clock.today());
      this.confirmCopy.set(false);
    }, 'Yesterday’s entries copied to today.');
  }
  private async run(action: () => Promise<void>, message: string): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      await action();
      this.#toast.success(message);
    } catch (error) {
      this.#toast.error(error instanceof Error ? error.message : 'Could not add entries.');
    } finally {
      this.busy.set(false);
    }
  }
}
