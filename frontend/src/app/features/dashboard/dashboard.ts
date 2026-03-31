import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { SyncService } from '../../core/services/sync.service';
import { KcalEntry, KcalTemplateItem, KcalTemplateKind } from '../../core/models/kcal.model';
import { ProfilePreferencesService } from '../../core/services/profile-preferences.service';
import { generateUuid } from '../../shared/utils/uuid';
import {
  kcalExpressionValidator,
  parseArithmeticExpression,
} from '../../shared/utils/arithmetic-expression';
import { DashboardEntryFormModalComponent } from './components/dashboard-entry-form-modal';
import { DashboardSummaryComponent } from './components/dashboard-summary';
import { DashboardTemplatePickerModalComponent } from './components/dashboard-template-picker-modal';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDateToday(): string {
  return toDateKey(new Date());
}

function formatDisplayDate(dateKey: string): string {
  return parseDateKey(dateKey).toLocaleDateString([], {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
  });
}

function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() + days);
  return result;
}

function toLocalDateKey(iso: string): string {
  return toDateKey(new Date(iso));
}

function localTimeDefault(): string {
  const now = new Date();
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function localTimeFromIso(iso: string): string {
  const local = new Date(iso);
  return `${pad(local.getHours())}:${pad(local.getMinutes())}`;
}

function toIsoFromLocalDateAndTime(dateKey: string, time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  const date = parseDateKey(dateKey);
  date.setHours(hours || 0, minutes || 0, 0, 0);
  return date.toISOString();
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    DashboardSummaryComponent,
    DashboardTemplatePickerModalComponent,
    DashboardEntryFormModalComponent,
  ],
  templateUrl: './dashboard.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent {
  readonly #document = inject(DOCUMENT);
  readonly #destroyRef = inject(DestroyRef);
  readonly #fb = inject(FormBuilder);
  readonly #sync = inject(SyncService);
  readonly #preferences = inject(ProfilePreferencesService);

  protected selectedDate = signal(localDateToday());
  protected showAddForm = signal(false);
  protected showTemplatePicker = signal(false);
  protected addLoading = signal(false);
  protected addError = signal('');
  protected editingEntry = signal<KcalEntry | null>(null);
  protected addTemplateKind = signal<KcalTemplateKind | null>(null);
  protected selectedAddTemplate = signal<KcalTemplateItem | null>(null);
  protected templateSearchQuery = signal('');
  protected templateAmountInput = signal('');

  protected form = this.#fb.group({
    kcal_delta: this.#fb.control<number | string | null>(null, {
      validators: [Validators.required, kcalExpressionValidator],
    }),
    happened_at: this.#fb.nonNullable.control(localTimeDefault(), Validators.required),
  });

  protected readonly dateRange = computed(() => {
    const d = this.selectedDate();
    const from = new Date(d + 'T00:00:00').toISOString();
    const to = new Date(d + 'T23:59:59.999').toISOString();
    return { from, to };
  });

  protected readonly dayEntries = computed(() => {
    const { from, to } = this.dateRange();
    return this.#sync
      .entries()
      .filter((e) => e.happened_at >= from && e.happened_at <= to)
      .sort((a, b) => b.happened_at.localeCompare(a.happened_at));
  });

  protected readonly totalKcal = computed(() =>
    this.dayEntries().reduce((sum, e) => sum + e.kcal_delta, 0),
  );

  protected readonly recentEntries = computed(() => this.dayEntries().slice(0, 3));

  protected readonly addableTemplates = computed(() => {
    const kind = this.addTemplateKind();
    if (!kind) {
      return [];
    }

    return this.#sync.templates().filter((template) => template.kind === kind);
  });

  protected readonly filteredTemplates = computed(() => {
    const query = this.templateSearchQuery().trim().toLowerCase();
    if (!query) {
      return this.addableTemplates();
    }

    return this.addableTemplates().filter((template) => {
      const haystack = [template.name, template.amount, template.unit, String(template.kcal_amount)]
        .join(' ')
        .toLowerCase();

      return haystack.includes(query);
    });
  });

  protected readonly hasSelectedTemplate = computed(() => this.selectedAddTemplate() !== null);

  protected readonly dailyLimit = computed(() => this.#preferences.preferences().kcalLimit);

  protected readonly selectedDateLabel = computed(() => formatDisplayDate(this.selectedDate()));

  protected readonly cycleStartDateLabel = computed(() => {
    const cycleStartDate = this.#preferences.preferences().cycleStartDate;
    return cycleStartDate ? formatDisplayDate(cycleStartDate) : null;
  });

  protected readonly dailyLimitDifference = computed(() => {
    const limit = this.dailyLimit();
    if (limit == null) {
      return null;
    }

    return this.totalKcal() - limit;
  });

  protected readonly cycleDifference = computed(() => {
    const limit = this.dailyLimit();
    const cycleStartDate = this.#preferences.preferences().cycleStartDate;
    const selectedDate = this.selectedDate();

    if (limit == null || !cycleStartDate || cycleStartDate > selectedDate) {
      return null;
    }

    const totalsByDate = new Map<string, number>();
    for (const entry of this.#sync.entries()) {
      const dateKey = toLocalDateKey(entry.happened_at);
      if (dateKey < cycleStartDate || dateKey > selectedDate) {
        continue;
      }

      totalsByDate.set(dateKey, (totalsByDate.get(dateKey) ?? 0) + entry.kcal_delta);
    }

    let runningDifference = 0;
    for (
      let cursor = parseDateKey(cycleStartDate);
      toDateKey(cursor) <= selectedDate;
      cursor = addDays(cursor, 1)
    ) {
      const dateKey = toDateKey(cursor);
      runningDifference += (totalsByDate.get(dateKey) ?? 0) - limit;
    }

    return runningDifference;
  });

  protected readonly hasCycleStarted = computed(() => {
    const cycleStartDate = this.#preferences.preferences().cycleStartDate;
    return !!cycleStartDate && cycleStartDate <= this.selectedDate();
  });

  constructor() {
    this.#registerActivityListeners();
  }

  protected openAdd(kind: KcalTemplateKind): void {
    this.editingEntry.set(null);
    this.addTemplateKind.set(kind);
    this.templateSearchQuery.set('');
    this.openAddFormWithTemplate(null);
  }

  protected openEdit(entry: KcalEntry): void {
    this.editingEntry.set(entry);
    this.addTemplateKind.set(null);
    this.selectedAddTemplate.set(null);
    this.templateSearchQuery.set('');
    this.templateAmountInput.set('');
    this.form.reset({
      kcal_delta: entry.kcal_delta,
      happened_at: localTimeFromIso(entry.happened_at),
    });
    this.addError.set('');
    this.showTemplatePicker.set(false);
    this.showAddForm.set(true);
  }

  protected openManualEntry(): void {
    this.openAddFormWithTemplate(null);
  }

  protected chooseTemplate(template: KcalTemplateItem): void {
    this.openAddFormWithTemplate(template);
  }

  protected onTemplateSearchInput(event: Event): void {
    this.templateSearchQuery.set((event.target as HTMLInputElement).value);
  }

  protected onTemplateAmountInput(value: string): void {
    this.templateAmountInput.set(value);

    const template = this.selectedAddTemplate();
    const enteredAmount = this.parseAmount(value);
    if (!template || enteredAmount == null) {
      return;
    }

    const templateAmount = this.parseAmount(template.amount);
    if (templateAmount == null || templateAmount === 0) {
      return;
    }

    const calculatedKcal = Math.round((template.kcal_amount / templateAmount) * enteredAmount);
    this.form.patchValue({
      kcal_delta: template.kind === 'food' ? calculatedKcal : -calculatedKcal,
    });
  }

  protected backToTemplatePicker(): void {
    if (this.editingEntry() || !this.addTemplateKind()) {
      return;
    }

    this.addError.set('');
    this.showAddForm.set(false);
    this.showTemplatePicker.set(true);
  }

  protected backToAddForm(): void {
    if (this.editingEntry()) {
      return;
    }

    this.addError.set('');
    this.showTemplatePicker.set(false);
    this.showAddForm.set(true);
  }

  protected cancelAdd(): void {
    this.showAddForm.set(false);
    this.showTemplatePicker.set(false);
    this.editingEntry.set(null);
    this.addTemplateKind.set(null);
    this.selectedAddTemplate.set(null);
    this.templateSearchQuery.set('');
    this.templateAmountInput.set('');
    this.addError.set('');
  }

  protected async saveEntry(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.addLoading.set(true);
    this.addError.set('');
    try {
      const { kcal_delta, happened_at } = this.form.getRawValue();
      const parsedKcal = parseArithmeticExpression(kcal_delta);
      if (parsedKcal == null) {
        this.form.get('kcal_delta')?.markAsTouched();
        return;
      }

      this.form.patchValue({ kcal_delta: parsedKcal });

      const editing = this.editingEntry();
      const dateKey = editing ? toLocalDateKey(editing.happened_at) : localDateToday();
      const entry: KcalEntry = {
        id: editing?.id ?? generateUuid(),
        kcal_delta: parsedKcal,
        happened_at: toIsoFromLocalDateAndTime(dateKey, happened_at),
      };
      this.#sync.upsertEntry(entry);
      this.showAddForm.set(false);
      this.showTemplatePicker.set(false);
      this.editingEntry.set(null);
      this.addTemplateKind.set(null);
      this.selectedAddTemplate.set(null);
      this.templateSearchQuery.set('');
      this.templateAmountInput.set('');
    } catch (e) {
      if (e instanceof HttpErrorResponse) {
        const body = e.error as { error?: { message?: string } };
        this.addError.set(body?.error?.message ?? 'Failed to save entry.');
      } else {
        this.addError.set('Failed to save entry.');
      }
    } finally {
      this.addLoading.set(false);
    }
  }

  protected templateName(tmpl: KcalTemplateItem): string {
    return `${tmpl.name} — ${tmpl.kcal_amount} kcal / ${tmpl.amount} ${tmpl.unit}`;
  }

  protected templatePickerTitle(): string {
    return this.addTemplateKind() === 'activity'
      ? 'Choose activity template'
      : 'Choose food template';
  }

  protected addDialogTitle(): string {
    if (this.editingEntry()) {
      return 'Edit entry';
    }

    return this.addTemplateKind() === 'activity' ? 'Add activity' : 'Add food';
  }

  protected selectedTemplateLabel(): string {
    const template = this.selectedAddTemplate();
    return template ? this.templateName(template) : 'Manual entry';
  }

  protected templateAmountLabel(): string {
    const template = this.selectedAddTemplate();
    return template ? `Amount (${template.unit})` : 'Amount';
  }

  protected templateAmountPlaceholder(): string {
    const template = this.selectedAddTemplate();
    return template ? `${template.amount}` : '';
  }

  private openAddFormWithTemplate(template: KcalTemplateItem | null): void {
    this.selectedAddTemplate.set(template);
    this.templateAmountInput.set('');
    this.form.reset({
      kcal_delta: template
        ? template.kind === 'food'
          ? template.kcal_amount
          : -template.kcal_amount
        : null,
      happened_at: localTimeDefault(),
    });
    this.addError.set('');
    this.showTemplatePicker.set(false);
    this.showAddForm.set(true);
  }

  private parseAmount(value: string): number | null {
    const normalized = value.trim().replace(',', '.');
    if (!normalized) {
      return null;
    }

    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      return null;
    }

    return parsed;
  }

  #registerActivityListeners(): void {
    if (typeof window === 'undefined') {
      return;
    }

    this.#document.addEventListener('visibilitychange', this.#handleVisibilityChange);
    window.addEventListener('pageshow', this.#handleAppBecameActive);

    this.#destroyRef.onDestroy(() => {
      this.#document.removeEventListener('visibilitychange', this.#handleVisibilityChange);
      window.removeEventListener('pageshow', this.#handleAppBecameActive);
    });
  }

  readonly #handleVisibilityChange = (): void => {
    if (this.#document.visibilityState !== 'visible') {
      return;
    }

    this.#syncSelectedDateToToday();
  };

  readonly #handleAppBecameActive = (): void => {
    this.#syncSelectedDateToToday();
  };

  #syncSelectedDateToToday(): void {
    const today = localDateToday();
    if (this.selectedDate() === today) {
      return;
    }

    this.selectedDate.set(today);
  }
}
