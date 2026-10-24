import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  ProfilePreferencesService,
  type ProfilePreferences,
} from '../../core/services/profile-preferences.service';
import {
  CustomKeypadInputComponent,
  INTEGER_KEYPAD_ROWS,
} from '../../shared/components/custom-keypad-input/custom-keypad-input';
import { ToastService } from '../../core/services/toast.service';
import { ThemeToggleComponent } from '../../shared/components/theme-toggle/theme-toggle';
import { isDateKey } from '../../shared/utils/local-date';
import { targetForDate } from '../../shared/utils/kcal-statistics';
import { SyncService } from '../../core/services/sync.service';
import { LocalDateService } from '../../core/services/local-date.service';
import type { KcalTarget } from '../../core/models/kcal.model';

type SaveState = 'idle' | 'saving';

@Component({
  selector: 'app-profile-page',
  imports: [ReactiveFormsModule, ThemeToggleComponent, CustomKeypadInputComponent, RouterLink],
  templateUrl: './profile.html',
})
export class ProfilePageComponent {
  protected readonly integerKeypadRows = INTEGER_KEYPAD_ROWS;
  protected readonly preferencesService = inject(ProfilePreferencesService);
  readonly #toastService = inject(ToastService);
  readonly #fb = inject(FormBuilder);
  readonly #sync = inject(SyncService);
  protected readonly today = inject(LocalDateService).today;
  protected readonly periodReady = computed(() => this.#sync.lastSyncedAt() !== null);
  protected readonly targets = computed(() =>
    this.#sync
      .targets()
      .slice()
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from)),
  );
  protected readonly pendingDeleteTarget = signal<KcalTarget | null>(null);
  protected readonly error = signal('');

  protected readonly saveState = signal<SaveState>('idle');
  protected readonly form = this.#fb.nonNullable.group({
    kcalLimit: this.#fb.control<string | null>('', [
      Validators.min(1),
      Validators.max(2147483647),
      Validators.pattern(/^\d*$/),
    ]),
    targetEffectiveFrom: [this.today(), Validators.required],
    cycleStartDate: [''],
  });

  constructor() {
    effect(() => {
      if (!this.preferencesService.loaded()) {
        return;
      }

      const preferences = this.preferencesService.preferences();
      const targets = this.#sync.targets();
      const { kcalLimit, cycleStartDate } = this.form.controls;
      if (!kcalLimit.dirty) {
        kcalLimit.setValue(
          targetForDate(targets, this.form.controls.targetEffectiveFrom.value)?.toString() ?? '',
          { emitEvent: false },
        );
      }
      if (!cycleStartDate.dirty) {
        cycleStartDate.setValue(preferences.cycleStartDate ?? '', { emitEvent: false });
      }
    });
  }

  protected async save(): Promise<void> {
    if (this.saveState() === 'saving') {
      return;
    }
    if (this.form.invalid || !isDateKey(this.form.controls.targetEffectiveFrom.value)) {
      this.form.markAllAsTouched();
      this.error.set(
        'Enter a valid target date and a positive whole-number target, or leave the target blank.',
      );
      return;
    }

    this.saveState.set('saving');
    this.error.set('');
    const submitted = this.form.getRawValue();

    try {
      await this.preferencesService.save(this.#getFormPreferences(), {
        updateCycleStartDate: this.form.controls.cycleStartDate.dirty,
        updateKcalLimit:
          this.form.controls.kcalLimit.dirty || this.form.controls.targetEffectiveFrom.dirty,
        targetEffectiveFrom: submitted.targetEffectiveFrom,
      });
      for (const key of ['kcalLimit', 'cycleStartDate', 'targetEffectiveFrom'] as const) {
        if (this.form.controls[key].value === submitted[key]) {
          this.form.controls[key].markAsPristine();
        }
      }
      this.#toastService.success('Profile saved.', { title: 'Preferences updated' });
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save preferences.');
    } finally {
      this.saveState.set('idle');
    }
  }

  protected async startNewCycle(): Promise<void> {
    if (this.saveState() === 'saving') {
      return;
    }
    this.saveState.set('saving');
    this.error.set('');
    const submittedDate = this.form.controls.cycleStartDate.value;
    try {
      await this.#sync.startNewCycle(this.today());
      if (this.form.controls.cycleStartDate.value === submittedDate) {
        this.form.controls.cycleStartDate.setValue(this.today());
        this.form.controls.cycleStartDate.markAsPristine();
      }
      this.#toastService.success('Current period starts today.');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not start period.');
    } finally {
      this.saveState.set('idle');
    }
  }

  protected refreshTarget(): void {
    if (!this.form.controls.kcalLimit.dirty) {
      this.form.controls.kcalLimit.setValue(
        targetForDate(
          this.#sync.targets(),
          this.form.controls.targetEffectiveFrom.value,
        )?.toString() ?? '',
      );
    }
  }

  protected editTarget(target: KcalTarget): void {
    this.form.controls.targetEffectiveFrom.setValue(target.effective_from);
    this.form.controls.kcalLimit.setValue(target.kcal_limit?.toString() ?? '');
    this.form.controls.targetEffectiveFrom.markAsDirty();
    this.form.controls.kcalLimit.markAsDirty();
  }

  protected async deleteTarget(): Promise<void> {
    const target = this.pendingDeleteTarget();
    if (!target || this.saveState() === 'saving') {
      return;
    }
    this.saveState.set('saving');
    this.error.set('');
    try {
      await this.#sync.deleteTarget(target.id);
      this.pendingDeleteTarget.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not remove target.');
    } finally {
      this.saveState.set('idle');
    }
  }

  #getFormPreferences(): ProfilePreferences {
    const { kcalLimit, cycleStartDate } = this.form.getRawValue();

    return {
      kcalLimit: kcalLimit == null || kcalLimit === '' ? null : Number(kcalLimit),
      cycleStartDate: this.form.controls.cycleStartDate.dirty
        ? cycleStartDate || null
        : this.preferencesService.preferences().cycleStartDate,
    };
  }
}
