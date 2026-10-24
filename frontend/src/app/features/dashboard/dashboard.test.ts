import { Injector, runInInjectionContext, signal } from '@angular/core';
import { FormBuilder } from '@angular/forms';
import { describe, expect, it, vi } from 'vitest';
import { LocalDateService } from '../../core/services/local-date.service';
import { ProfilePreferencesService } from '../../core/services/profile-preferences.service';
import { SyncService } from '../../core/services/sync.service';
import { DashboardComponent } from './dashboard';

class TestDashboard extends DashboardComponent {
  readonly save = () => this.saveEntry();
  readonly open = () => this.openAdd('food');
  readonly entryForm = this.form;
  readonly isOpen = this.showAddForm;
  readonly isSaving = this.addLoading;
}

describe('dashboard saves', () => {
  it('saves only once when submitted again before the local write finishes', async () => {
    let finishWrite!: () => void;
    const upsertEntry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const injector = Injector.create({
      providers: [
        FormBuilder,
        { provide: LocalDateService, useValue: { today: signal('2026-10-22') } },
        { provide: ProfilePreferencesService, useValue: {} },
        { provide: SyncService, useValue: { upsertEntry } },
      ],
    });
    try {
      const dashboard = runInInjectionContext(injector, () => new TestDashboard());
      dashboard.open();
      dashboard.entryForm.setValue({ kcal_delta: 250, happened_at: '12:00' });

      const firstSave = dashboard.save();
      await dashboard.save();

      expect(upsertEntry).toHaveBeenCalledTimes(1);
      expect(dashboard.isSaving()).toBe(true);
      expect(dashboard.isOpen()).toBe(true);

      finishWrite();
      await firstSave;
      expect(dashboard.isSaving()).toBe(false);
      expect(dashboard.isOpen()).toBe(false);
    } finally {
      injector.destroy();
    }
  });
});
