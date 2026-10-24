import { Injector, runInInjectionContext, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { SyncService } from '../../../core/services/sync.service';
import { LocalDateService } from '../../../core/services/local-date.service';
import { ToastService } from '../../../core/services/toast.service';
import { QuickLoggingComponent } from './quick-logging';

class TestQuickLogging extends QuickLoggingComponent {
  readonly repeatToday = (id: string) => this.repeat(id);
  readonly copy = () => this.copyYesterday();
  readonly loading = this.busy;
  readonly confirmation = this.confirmCopy;
}

describe('quick logging actions', () => {
  it('prevents another repeated entry while a local write is pending and recovers after failure', async () => {
    let rejectWrite!: (error: Error) => void;
    const repeatEntry = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectWrite = reject;
        }),
    );
    const error = vi.fn();
    const injector = Injector.create({
      providers: [
        { provide: SyncService, useValue: { repeatEntry, meals: signal([]) } },
        { provide: LocalDateService, useValue: { today: signal('2026-10-22') } },
        { provide: ToastService, useValue: { success: vi.fn(), error } },
      ],
    });
    try {
      const component = runInInjectionContext(injector, () => new TestQuickLogging());
      const pending = component.repeatToday('entry');
      await component.repeatToday('entry');
      expect(repeatEntry).toHaveBeenCalledExactlyOnceWith('entry', '2026-10-22');
      rejectWrite(new Error('Storage is full.'));
      await pending;
      expect(error).toHaveBeenCalledWith('Storage is full.');
      expect(component.loading()).toBe(false);
    } finally {
      injector.destroy();
    }
  });

  it('copies the previous local calendar day and closes the preview only after success', async () => {
    const copyDay = vi.fn(async () => undefined);
    const injector = Injector.create({
      providers: [
        { provide: SyncService, useValue: { copyDay, meals: signal([]) } },
        { provide: LocalDateService, useValue: { today: signal('2026-03-30') } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    try {
      const component = runInInjectionContext(injector, () => new TestQuickLogging());
      component.confirmation.set(true);
      await component.copy();
      expect(copyDay).toHaveBeenCalledExactlyOnceWith('2026-03-29', '2026-03-30');
      expect(component.confirmation()).toBe(false);
    } finally {
      injector.destroy();
    }
  });
});
