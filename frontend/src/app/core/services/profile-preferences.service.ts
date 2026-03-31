import { Injectable, inject, signal } from '@angular/core';
import { DbService } from './db.service';

export interface ProfilePreferences {
  kcalLimit: number | null;
  cycleStartDate: string | null;
}

const PROFILE_PREFERENCES_ID = 'profile';
const DEFAULT_PROFILE_PREFERENCES: ProfilePreferences = {
  kcalLimit: null,
  cycleStartDate: null,
};

@Injectable({ providedIn: 'root' })
export class ProfilePreferencesService {
  readonly #db = inject(DbService);
  readonly #preferences = signal<ProfilePreferences>(DEFAULT_PROFILE_PREFERENCES);
  readonly #loaded = signal(false);

  readonly preferences = this.#preferences.asReadonly();
  readonly loaded = this.#loaded.asReadonly();

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const saved = await this.#db.profilePreferences.get(PROFILE_PREFERENCES_ID);
      if (saved) {
        this.#preferences.set({
          kcalLimit: saved.kcalLimit,
          cycleStartDate: saved.cycleStartDate,
        });
      }
    } finally {
      this.#loaded.set(true);
    }
  }

  async save(preferences: ProfilePreferences): Promise<void> {
    const next = this.#normalize(preferences);
    this.#preferences.set(next);
    await this.#db.profilePreferences.put({
      id: PROFILE_PREFERENCES_ID,
      kcalLimit: next.kcalLimit,
      cycleStartDate: next.cycleStartDate,
    });
    this.#loaded.set(true);
  }

  #normalize(preferences: ProfilePreferences): ProfilePreferences {
    return {
      kcalLimit:
        preferences.kcalLimit == null || Number.isNaN(preferences.kcalLimit)
          ? null
          : Math.max(1, Math.round(preferences.kcalLimit)),
      cycleStartDate: preferences.cycleStartDate || null,
    };
  }
}
