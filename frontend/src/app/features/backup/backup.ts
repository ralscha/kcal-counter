import { Component, inject, signal } from '@angular/core';
import { BackupService, type BackupPreview } from '../../core/services/backup.service';
import { MAX_BACKUP_BYTES, type CsvExport } from '../../core/services/backup.util';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-backup-page',
  templateUrl: './backup.html',
})
export class BackupPageComponent {
  readonly #backup = inject(BackupService);
  readonly #toast = inject(ToastService);
  protected readonly ready = this.#backup.ready;
  protected readonly preview = signal<BackupPreview | null>(null);
  protected readonly fileName = signal('');
  protected readonly reading = signal(false);
  protected readonly importing = signal(false);
  protected readonly error = signal('');
  #selection = 0;

  protected download(kind: 'json' | CsvExport): void {
    this.error.set('');
    try {
      this.#backup.download(kind);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not export your data.');
    }
  }

  protected async selectFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.importing()) {
      return;
    }
    const selection = ++this.#selection;
    this.preview.set(null);
    this.error.set('');
    this.fileName.set(file.name);
    this.reading.set(true);
    try {
      if (file.size > MAX_BACKUP_BYTES) {
        throw new Error('Choose a JSON backup smaller than 10 MB.');
      }
      const source = await file.text();
      if (selection === this.#selection) {
        this.preview.set(this.#backup.previewImport(source));
      }
    } catch (error) {
      if (selection === this.#selection) {
        this.error.set(error instanceof Error ? error.message : 'Could not read the backup.');
      }
    } finally {
      if (selection === this.#selection) {
        this.reading.set(false);
      }
    }
  }

  protected cancelImport(): void {
    if (this.importing()) {
      return;
    }
    this.#selection++;
    this.preview.set(null);
    this.fileName.set('');
    this.reading.set(false);
    this.error.set('');
  }

  protected async confirmImport(): Promise<void> {
    const preview = this.preview();
    if (!preview || this.importing() || this.reading()) {
      return;
    }
    this.importing.set(true);
    this.error.set('');
    try {
      await this.#backup.importBackup(preview);
      this.preview.set(null);
      this.fileName.set('');
      this.#toast.success('Backup merged. Changes are saved locally and will sync when online.');
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'Import failed. Your data was not changed.',
      );
    } finally {
      this.importing.set(false);
    }
  }
}
