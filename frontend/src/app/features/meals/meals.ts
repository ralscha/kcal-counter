import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators, type ValidatorFn } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { KcalMeal, KcalMealItem } from '../../core/models/kcal.model';
import { SyncService } from '../../core/services/sync.service';
import { LocalDateService } from '../../core/services/local-date.service';
import { ToastService } from '../../core/services/toast.service';
import { generateUuid } from '../../shared/utils/uuid';

const mealNameLength: ValidatorFn = (control) =>
  Array.from(String(control.value ?? '').trim()).length <= 200 ? null : { maxlength: true };

@Component({
  selector: 'app-meals',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './meals.html',
})
export class MealsComponent {
  readonly #sync = inject(SyncService);
  readonly #clock = inject(LocalDateService);
  readonly #toast = inject(ToastService);
  readonly #fb = inject(FormBuilder);
  protected readonly meals = computed(() =>
    this.#sync
      .meals()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  protected readonly templates = computed(() =>
    this.#sync
      .templates()
      .filter((item) => item.kind === 'food')
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  protected readonly form = this.#fb.nonNullable.group({
    name: ['', [Validators.required, mealNameLength]],
    templateId: [''],
    servings: ['1'],
  });
  protected readonly items = signal<KcalMealItem[]>([]);
  protected readonly editingId = signal<string | null>(null);
  protected readonly showForm = signal(false);
  protected readonly pendingDelete = signal<KcalMeal | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly total = computed(() =>
    this.items().reduce((sum, item) => sum + item.kcal_delta, 0),
  );

  protected open(meal?: KcalMeal): void {
    this.editingId.set(meal?.id ?? null);
    this.items.set(meal?.items.map((item) => ({ ...item })) ?? []);
    this.form.reset({ name: meal?.name ?? '', templateId: '', servings: '1' });
    this.error.set('');
    this.showForm.set(true);
  }
  protected addItem(): void {
    const { templateId, servings } = this.form.getRawValue();
    const template = this.templates().find((item) => item.id === templateId);
    const amount = Number(servings);
    const kcal = Math.round((template?.kcal_amount ?? 0) * amount);
    if (
      !template ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !Number.isSafeInteger(kcal) ||
      kcal < 1 ||
      kcal > 2147483647
    ) {
      this.error.set('Choose a food template and a portion count that gives at least 1 kcal.');
      return;
    }
    if (this.items().length >= 100) {
      this.error.set('A meal can contain at most 100 items.');
      return;
    }
    this.items.update((items) => [
      ...items,
      {
        template_id: template.id,
        name: Array.from(`${template.name} (${amount} × ${template.amount} ${template.unit})`)
          .slice(0, 200)
          .join(''),
        kcal_delta: kcal,
      },
    ]);
    this.error.set('');
  }
  protected removeItem(index: number): void {
    this.items.update((items) => items.filter((_, i) => i !== index));
  }
  protected async save(): Promise<void> {
    if (this.busy()) {
      return;
    }
    if (this.form.invalid || !this.form.controls.name.value.trim() || !this.items().length) {
      this.form.markAllAsTouched();
      this.error.set('Enter a meal name of at most 200 characters and add at least one food.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.#sync.upsertMeal({
        id: this.editingId() ?? generateUuid(),
        name: this.form.controls.name.value.trim(),
        items: this.items(),
      });
      this.showForm.set(false);
      this.#toast.success('Meal saved.');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save meal.');
    } finally {
      this.busy.set(false);
    }
  }
  protected async log(meal: KcalMeal): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      await this.#sync.addMeal(meal.id, this.#clock.today());
      this.#toast.success(`${meal.name} added to today.`);
    } catch (error) {
      this.#toast.error(error instanceof Error ? error.message : 'Could not add meal.');
    } finally {
      this.busy.set(false);
    }
  }
  protected async deleteMeal(): Promise<void> {
    const meal = this.pendingDelete();
    if (!meal || this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      await this.#sync.deleteMeal(meal.id);
      this.pendingDelete.set(null);
    } catch (error) {
      this.#toast.error(error instanceof Error ? error.message : 'Could not delete meal.');
    } finally {
      this.busy.set(false);
    }
  }
  protected mealTotal(meal: KcalMeal): number {
    return meal.items.reduce((sum, item) => sum + item.kcal_delta, 0);
  }
}
