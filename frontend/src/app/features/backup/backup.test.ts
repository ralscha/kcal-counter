import { Injector, runInInjectionContext, signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupService, type BackupPreview } from '../../core/services/backup.service';
import { ToastService } from '../../core/services/toast.service';
import { BackupPageComponent } from './backup';
import { backupFixture } from '../../core/services/backup.test-data';
import { parseBackup, serializeBackup } from '../../core/services/backup.util';

class TestBackup extends BackupPageComponent {
  readonly select = (event: Event) => this.selectFile(event);
  readonly cancel = () => this.cancelImport();
  readonly confirm = () => this.confirmImport();
  readonly currentPreview = this.preview;
  readonly isImporting = this.importing;
  readonly importError = this.error;
}

const injectors: Injector[] = [];

function setup() {
  const preview: BackupPreview = {
    counts: [],
    document: parseBackup(serializeBackup(backupFixture())),
  };
  const service = {
    ready: signal(true),
    previewImport: vi.fn(() => preview),
    importBackup: vi.fn<(preview: BackupPreview) => Promise<void>>(async () => undefined),
  };
  const toast = { success: vi.fn() };
  const injector = Injector.create({
    providers: [
      { provide: BackupService, useValue: service },
      { provide: ToastService, useValue: toast },
    ],
  });
  injectors.push(injector);
  const component = runInInjectionContext(injector, () => new TestBackup());
  return { component, service, preview, toast };
}

function selectedFile(text: () => Promise<string>, size = 100): Event {
  return {
    target: { files: [{ text, size, name: 'backup.json' }], value: 'backup.json' },
  } as unknown as Event;
}

afterEach(() => {
  for (const injector of injectors.splice(0)) {
    (injector as Injector & { destroy: () => void }).destroy();
  }
});

describe('backup import confirmation', () => {
  it('never mutates data on file selection or cancellation', async () => {
    const { component, service } = setup();
    await component.select(selectedFile(async () => '{}'));
    expect(component.currentPreview()).not.toBeNull();
    expect(service.importBackup).not.toHaveBeenCalled();
    component.cancel();
    await component.confirm();
    expect(component.currentPreview()).toBeNull();
    expect(service.importBackup).not.toHaveBeenCalled();
  });

  it('ignores a file read that finishes after cancellation', async () => {
    const { component, service } = setup();
    const reading = Promise.withResolvers<string>();
    const selected = component.select(selectedFile(() => reading.promise));
    component.cancel();
    reading.resolve('{}');
    await selected;
    expect(component.currentPreview()).toBeNull();
    expect(service.previewImport).not.toHaveBeenCalled();
  });

  it('requires confirmation and prevents duplicate imports while one is in flight', async () => {
    const { component, service, preview } = setup();
    const saving = Promise.withResolvers<void>();
    service.importBackup.mockImplementation(() => saving.promise);
    await component.select(selectedFile(async () => '{}'));
    const importTask = component.confirm();
    await component.confirm();
    expect(service.importBackup).toHaveBeenCalledExactlyOnceWith(preview);
    expect(component.isImporting()).toBe(true);
    saving.resolve();
    await importTask;
    expect(component.currentPreview()).toBeNull();
    expect(component.isImporting()).toBe(false);
  });

  it('rejects oversized files before reading their contents', async () => {
    const { component, service } = setup();
    const read = vi.fn(async () => '{}');
    await component.select(selectedFile(read, 10 * 1024 * 1024 + 1));
    expect(read).not.toHaveBeenCalled();
    expect(component.importError()).toContain('10 MB');
    expect(service.importBackup).not.toHaveBeenCalled();
  });
});
