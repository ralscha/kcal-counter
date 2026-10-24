// @vitest-environment jsdom
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ProfilePreferencesService,
  type ProfilePreferences,
} from '../../core/services/profile-preferences.service';
import { ToastService } from '../../core/services/toast.service';
import { SyncService } from '../../core/services/sync.service';
import { LocalDateService } from '../../core/services/local-date.service';
import { targetIdForDate } from '../../core/models/kcal.model';
import { ProfilePageComponent } from './profile';

class TestProfile extends ProfilePageComponent {
  readonly preferenceForm = this.form;
  readonly savePreferences = () => this.save();
  readonly startCycle = () => this.startNewCycle();
}

function setup(initial: ProfilePreferences = { kcalLimit: null, cycleStartDate: null }) {
  const preferences = signal(initial);
  const save = vi.fn(async (next: ProfilePreferences) => {
    preferences.set(next);
  });
  const startNewCycle = vi.fn(async (date: string) =>
    preferences.update((value) => ({ ...value, cycleStartDate: date })),
  );
  const targets = signal(
    initial.kcalLimit === null
      ? []
      : [
          {
            id: targetIdForDate('2026-10-01'),
            effective_from: '2026-10-01',
            kcal_limit: initial.kcalLimit,
          },
        ],
  );
  TestBed.configureTestingModule({
    providers: [
      FormBuilder,
      { provide: LocalDateService, useValue: { today: signal('2026-10-22') } },
      {
        provide: SyncService,
        useValue: {
          targets,
          startNewCycle,
          deleteTarget: vi.fn(),
          lastSyncedAt: signal('2026-10-22T12:00:00Z'),
        },
      },
      {
        provide: ProfilePreferencesService,
        useValue: { loaded: signal(true), preferences, save },
      },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
    ],
  });
  const profile = TestBed.runInInjectionContext(() => new TestProfile());
  TestBed.tick();
  return { profile, preferences, save, startNewCycle };
}

describe('profile preferences', () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });
  afterAll(() => TestBed.resetTestEnvironment());

  it.each(['', null])('removes the daily limit when the keypad clears it to %s', async (empty) => {
    const { profile, save } = setup();
    profile.preferenceForm.controls.kcalLimit.setValue('2200');
    profile.preferenceForm.controls.kcalLimit.setValue(empty);
    profile.preferenceForm.controls.kcalLimit.markAsDirty();

    await profile.savePreferences();

    expect(save).toHaveBeenCalledExactlyOnceWith(
      { kcalLimit: null, cycleStartDate: null },
      { updateCycleStartDate: false, updateKcalLimit: true, targetEffectiveFrom: '2026-10-22' },
    );
  });

  it('starts a cycle on today’s local calendar date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 22, 0, 30));
    const { profile, save, startNewCycle } = setup({
      kcalLimit: 2200,
      cycleStartDate: '2026-10-01',
    });

    await profile.startCycle();

    expect(startNewCycle).toHaveBeenCalledExactlyOnceWith('2026-10-22');
    expect(save).not.toHaveBeenCalled();
  });

  it('saves an explicitly cleared cycle date', async () => {
    const { profile, save } = setup({ kcalLimit: 2200, cycleStartDate: '2026-10-01' });
    profile.preferenceForm.controls.cycleStartDate.setValue('');
    profile.preferenceForm.controls.cycleStartDate.markAsDirty();

    await profile.savePreferences();

    expect(save).toHaveBeenCalledExactlyOnceWith(
      { kcalLimit: 2200, cycleStartDate: null },
      { updateCycleStartDate: true, updateKcalLimit: false, targetEffectiveFrom: '2026-10-22' },
    );
  });

  it('preserves unsaved cycle edits when a remote update arrives', () => {
    const { profile, preferences } = setup({ kcalLimit: 2200, cycleStartDate: '2026-10-01' });
    profile.preferenceForm.controls.cycleStartDate.setValue('2026-10-20');
    profile.preferenceForm.controls.cycleStartDate.markAsDirty();

    preferences.set({ kcalLimit: 2200, cycleStartDate: '2026-10-15' });
    TestBed.tick();

    expect(profile.preferenceForm.controls.cycleStartDate.value).toBe('2026-10-20');
  });

  it('keeps the latest synced period when only the calorie target is edited', async () => {
    const { profile, preferences, save } = setup();
    profile.preferenceForm.controls.kcalLimit.setValue('2200');
    profile.preferenceForm.controls.kcalLimit.markAsDirty();
    preferences.set({ kcalLimit: null, cycleStartDate: '2026-10-15' });

    // Save before the form effect renders the freshly downloaded date.
    await profile.savePreferences();

    expect(save).toHaveBeenCalledExactlyOnceWith(
      { kcalLimit: 2200, cycleStartDate: '2026-10-15' },
      { updateCycleStartDate: false, updateKcalLimit: true, targetEffectiveFrom: '2026-10-22' },
    );
  });

  it('saves a target on its selected effective date', async () => {
    const { profile, save } = setup({ kcalLimit: 2200, cycleStartDate: null });
    profile.preferenceForm.controls.targetEffectiveFrom.setValue('2026-11-01');
    profile.preferenceForm.controls.targetEffectiveFrom.markAsDirty();
    profile.preferenceForm.controls.kcalLimit.setValue('2300');
    profile.preferenceForm.controls.kcalLimit.markAsDirty();
    await profile.savePreferences();
    expect(save).toHaveBeenCalledExactlyOnceWith(
      { kcalLimit: 2300, cycleStartDate: null },
      { updateCycleStartDate: false, updateKcalLimit: true, targetEffectiveFrom: '2026-11-01' },
    );
  });

  it('does not save unsaved target edits when starting a new period', async () => {
    const { profile, save, startNewCycle } = setup({
      kcalLimit: 2200,
      cycleStartDate: '2026-10-01',
    });
    profile.preferenceForm.controls.kcalLimit.setValue('2400');
    profile.preferenceForm.controls.kcalLimit.markAsDirty();
    await profile.startCycle();
    expect(startNewCycle).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(profile.preferenceForm.controls.kcalLimit.value).toBe('2400');
    expect(profile.preferenceForm.controls.kcalLimit.dirty).toBe(true);
  });

  it('preserves a newer period-date draft while starting a period', async () => {
    const { profile, startNewCycle } = setup({ kcalLimit: 2200, cycleStartDate: '2026-10-01' });
    let finish!: () => void;
    startNewCycle.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = profile.startCycle();
    profile.preferenceForm.controls.cycleStartDate.setValue('2026-10-25');
    profile.preferenceForm.controls.cycleStartDate.markAsDirty();
    finish();
    await pending;
    expect(profile.preferenceForm.controls.cycleStartDate.value).toBe('2026-10-25');
    expect(profile.preferenceForm.controls.cycleStartDate.dirty).toBe(true);
  });
});
