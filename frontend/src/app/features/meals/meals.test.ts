import { Injector, runInInjectionContext, signal } from '@angular/core';
import { FormBuilder } from '@angular/forms';
import { describe, expect, it, vi } from 'vitest';
import { SyncService } from '../../core/services/sync.service';
import { LocalDateService } from '../../core/services/local-date.service';
import { ToastService } from '../../core/services/toast.service';
import { MealsComponent } from './meals';
import type { KcalMeal } from '../../core/models/kcal.model';

class TestMeals extends MealsComponent {
  readonly mealForm = this.form;
  readonly addFood = () => this.addItem();
  readonly saveMeal = () => this.save();
  readonly mealItems = this.items;
  readonly formError = this.error;
  readonly editMeal = (meal: KcalMeal) => this.open(meal);
}

describe('meal composition', () => {
  it('edits a valid imported Unicode name and truncates snapshots at character boundaries', async () => {
    const template = {
      id: '00000000-0000-0000-0000-000000000010',
      name: 'a'.repeat(199) + '🍎',
      kind: 'food',
      amount: '100',
      unit: 'g',
      kcal_amount: 380,
    };
    const upsertMeal = vi.fn(async () => undefined);
    const injector = Injector.create({
      providers: [
        FormBuilder,
        {
          provide: SyncService,
          useValue: { templates: signal([template]), meals: signal([]), upsertMeal },
        },
        { provide: LocalDateService, useValue: { today: signal('2026-10-22') } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    try {
      const component = runInInjectionContext(injector, () => new TestMeals());
      const meal: KcalMeal = {
        id: '00000000-0000-0000-0000-000000000011',
        name: '🍎'.repeat(200),
        items: [{ template_id: template.id, name: 'Oats', kcal_delta: 380 }],
      };
      component.editMeal(meal);
      component.mealForm.controls.templateId.setValue(template.id);
      component.addFood();
      expect(component.mealItems()[1].name).toBe(template.name);
      await component.saveMeal();
      expect(upsertMeal).toHaveBeenCalledWith(
        expect.objectContaining({ id: meal.id, name: meal.name }),
      );
    } finally {
      injector.destroy();
    }
  });

  it('saves portion-scaled snapshots that survive source template changes', async () => {
    const templates = signal([
      {
        id: '00000000-0000-0000-0000-000000000010',
        name: 'Oats',
        kind: 'food',
        amount: '100',
        unit: 'g',
        kcal_amount: 380,
      },
    ]);
    const upsertMeal = vi.fn(async () => undefined);
    const injector = Injector.create({
      providers: [
        FormBuilder,
        { provide: SyncService, useValue: { templates, meals: signal([]), upsertMeal } },
        { provide: LocalDateService, useValue: { today: signal('2026-10-22') } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    try {
      const component = runInInjectionContext(injector, () => new TestMeals());
      component.mealForm.setValue({
        name: 'Breakfast',
        templateId: templates()[0].id,
        servings: '0.5',
      });
      component.addFood();
      templates.update((items) => items.map((item) => ({ ...item, kcal_amount: 400 })));
      await component.saveMeal();
      expect(upsertMeal).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Breakfast',
          items: [{ template_id: templates()[0].id, name: 'Oats (0.5 × 100 g)', kcal_delta: 190 }],
        }),
      );
      component.mealForm.controls.servings.setValue('-1');
      component.addFood();
      expect(component.mealItems()).toHaveLength(1);
      expect(component.formError()).not.toBe('');
    } finally {
      injector.destroy();
    }
  });
});
