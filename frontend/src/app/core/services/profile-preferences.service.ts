import { Service, effect, inject, signal } from '@angular/core';
import { DbService } from './db.service';
import { AuthService } from './auth.service';

export interface ProfilePreferences {
  kcalLimit: number | null;
  cycleStartDate: string | null;
}

const PROFILE_PREFERENCES_ID = 'profile';
const DEFAULT_PROFILE_PREFERENCES: ProfilePreferences = {
  kcalLimit: null,
  cycleStartDate: null,
};

@Service()
export class ProfilePreferencesService {
  readonly #db = inject(DbService);
  readonly #auth = inject(AuthService);
  readonly #preferences = signal<ProfilePreferences>(DEFAULT_PROFILE_PREFERENCES);
  readonly #loaded = signal(false);

  readonly preferences = this.#preferences.asReadonly();
  readonly loaded = this.#loaded.asReadonly();

  constructor() {
    effect(() => {
      this.#auth.currentUser();
      void this.load().catch(() => undefined);
    });
  }

  async load(): Promise<void> {
    const userId = this.#auth.currentUser()?.user_id;
    this.#loaded.set(false);
    this.#preferences.set(DEFAULT_PROFILE_PREFERENCES);
    try {
      const saved = userId
        ? await this.#db.forUser(userId).profilePreferences.get(PROFILE_PREFERENCES_ID)
        : null;
      if (saved && this.#auth.currentUser()?.user_id === userId) {
        this.#preferences.set(
          this.#normalize({
            kcalLimit: saved.kcalLimit,
            cycleStartDate: saved.cycleStartDate,
          }),
        );
      }
    } finally {
      if (this.#auth.currentUser()?.user_id === userId) {
        this.#loaded.set(true);
      }
    }
  }

  async save(preferences: ProfilePreferences): Promise<void> {
    const next = this.#normalize(preferences);
    const userId = this.#auth.currentUser()?.user_id;
    if (!userId) {
      throw new Error('Sign in before saving preferences.');
    }
    await this.#db.forUser(userId).profilePreferences.put({
      id: PROFILE_PREFERENCES_ID,
      kcalLimit: next.kcalLimit,
      cycleStartDate: next.cycleStartDate,
    });
    if (this.#auth.currentUser()?.user_id === userId) {
      this.#preferences.set(next);
      this.#loaded.set(true);
    }
  }

  #normalize(preferences: ProfilePreferences): ProfilePreferences {
    return {
      kcalLimit:
        preferences.kcalLimit == null || !Number.isFinite(preferences.kcalLimit)
          ? null
          : Math.max(1, Math.round(preferences.kcalLimit)),
      cycleStartDate: preferences.cycleStartDate || null,
    };
  }
}
