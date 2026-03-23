import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  ProfilePreferencesService,
  type ProfilePreferences,
} from '../../core/services/profile-preferences.service';
import { ToastService } from '../../core/services/toast.service';
import { ThemeToggleComponent } from '../../shared/components/theme-toggle/theme-toggle';

type SaveState = 'idle' | 'saving';

function localDateToday(): string {
  const today = new Date();
  const offset = today.getTimezoneOffset();
  return new Date(today.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

@Component({
  selector: 'app-profile-page',
  imports: [ReactiveFormsModule, ThemeToggleComponent],
  templateUrl: './profile.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfilePageComponent {
  protected readonly preferencesService = inject(ProfilePreferencesService);
  readonly #toastService = inject(ToastService);

  readonly #destroyRef = inject(DestroyRef);
  readonly #fb = inject(FormBuilder);

  protected readonly saveState = signal<SaveState>('idle');
  protected readonly form = this.#fb.nonNullable.group({
    kcalLimit: ['', [Validators.min(1)]],
    cycleStartDate: [''],
  });

  constructor() {
    effect(() => {
      if (!this.preferencesService.loaded()) {
        return;
      }

      const preferences = this.preferencesService.preferences();
      this.form.reset(
        {
          kcalLimit: preferences.kcalLimit?.toString() ?? '',
          cycleStartDate: preferences.cycleStartDate ?? '',
        },
        { emitEvent: false },
      );
    });

    this.form.valueChanges.pipe(takeUntilDestroyed(this.#destroyRef)).subscribe(() => {
      if (this.saveState() !== 'idle') {
        this.saveState.set('idle');
      }
    });
  }

  protected async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.saveState.set('saving');

    try {
      await this.preferencesService.save(this.#getFormPreferences());
      this.saveState.set('idle');
      this.#toastService.success('Profile saved.', { title: 'Preferences updated' });
    } catch {
      this.saveState.set('idle');
      this.#toastService.error('Could not save preferences.', { title: 'Save failed' });
    }
  }

  protected async startNewCycle(): Promise<void> {
    this.form.controls.cycleStartDate.setValue(localDateToday());
    await this.save();
  }

  #getFormPreferences(): ProfilePreferences {
    const { kcalLimit, cycleStartDate } = this.form.getRawValue();

    return {
      kcalLimit: kcalLimit === '' ? null : Number(kcalLimit),
      cycleStartDate: cycleStartDate || null,
    };
  }
}
