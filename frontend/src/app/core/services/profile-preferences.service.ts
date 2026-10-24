import { Service, inject } from '@angular/core';
import type { ProfilePreferences, ProfileSaveOptions } from '../models/user.model';
import { SyncService } from './sync.service';

export type { ProfilePreferences, ProfileSaveOptions } from '../models/user.model';

@Service()
export class ProfilePreferencesService {
  readonly #sync = inject(SyncService);

  readonly preferences = this.#sync.preferences;
  readonly loaded = this.#sync.preferencesLoaded;

  async save(preferences: ProfilePreferences, options: ProfileSaveOptions = {}): Promise<void> {
    await this.#sync.savePreferences(
      {
        kcalLimit:
          preferences.kcalLimit == null || !Number.isFinite(preferences.kcalLimit)
            ? null
            : Math.max(1, Math.round(preferences.kcalLimit)),
        cycleStartDate: preferences.cycleStartDate || null,
      },
      options,
    );
  }
}
