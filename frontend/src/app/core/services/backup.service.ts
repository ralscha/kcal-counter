import { inject, Service } from '@angular/core';
import { AuthService } from './auth.service';
import { SyncService } from './sync.service';
import { toDateKey } from '../../shared/utils/local-date';
import {
  backupChanges,
  exportCsv,
  parseBackup,
  serializeBackup,
  validatePeriodLayout,
  type BackupData,
  type BackupDocument,
  type CsvExport,
} from './backup.util';

export interface BackupCount {
  label: string;
  total: number;
  added: number;
  replaced: number;
}

export interface BackupPreview {
  document: BackupDocument;
  counts: BackupCount[];
}

@Service()
export class BackupService {
  readonly #sync = inject(SyncService);
  readonly #auth = inject(AuthService);
  readonly #previewAccounts = new WeakMap<BackupPreview, string>();
  readonly ready = this.#sync.preferencesLoaded;

  #snapshot(): BackupData {
    if (!this.ready() || !this.#auth.currentUser()) {
      throw new Error('Sign in and wait for your saved data to load.');
    }
    return {
      entries: this.#sync.entries(),
      templates: this.#sync.templates(),
      targets: this.#sync.targets(),
      periods: this.#sync.periods(),
      meals: this.#sync.meals(),
      active_period_start: this.#sync.preferences().cycleStartDate,
    };
  }

  exportJson(): string {
    return serializeBackup(this.#snapshot());
  }

  previewImport(source: string): BackupPreview {
    const current = this.#snapshot();
    const document = parseBackup(source);
    const periods = new Map(current.periods.map((period) => [period.id, period]));
    for (const period of document.data.periods) {
      periods.set(period.id, period);
    }
    validatePeriodLayout([...periods.values()], document.data.active_period_start);
    const collections = [
      ['Entries', 'entries'],
      ['Templates', 'templates'],
      ['Dated targets', 'targets'],
      ['Archived periods', 'periods'],
      ['Saved meals', 'meals'],
    ] as const;
    const preview: BackupPreview = {
      document,
      counts: collections.map(([label, key]) => {
        const existing = new Set(current[key].map((row) => row.id));
        const rows = document.data[key];
        const replaced = rows.filter((row) => existing.has(row.id)).length;
        return { label, total: rows.length, added: rows.length - replaced, replaced };
      }),
    };
    this.#previewAccounts.set(preview, this.#auth.currentUser()!.user_id);
    return preview;
  }

  async importBackup(preview: BackupPreview): Promise<void> {
    const account = this.#previewAccounts.get(preview);
    if (!account || account !== this.#auth.currentUser()?.user_id || !this.ready()) {
      throw new Error('Your account changed. Select the backup again before importing.');
    }
    // Validate again at the mutation boundary, then commit every collection in one transaction.
    const verified = parseBackup(JSON.stringify(preview.document));
    await this.#sync.applyChanges(backupChanges(verified));
    this.#previewAccounts.delete(preview);
  }

  download(kind: 'json' | CsvExport): void {
    const content = kind === 'json' ? this.exportJson() : exportCsv(this.#snapshot(), kind);
    const extension = kind === 'json' ? 'json' : 'csv';
    const blob = new Blob([content], {
      type: kind === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kcal-${kind === 'json' ? 'backup' : kind}-${toDateKey(new Date())}.${extension}`;
    document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
  }
}
