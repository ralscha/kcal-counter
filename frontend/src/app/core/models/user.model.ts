export interface SessionPrincipal {
  user_id: string;
  roles: string[];
}

export interface ProfilePreferences {
  kcalLimit: number | null;
  cycleStartDate: string | null;
}

export interface ProfileSaveOptions {
  updateCycleStartDate?: boolean;
  updateKcalLimit?: boolean;
  targetEffectiveFrom?: string;
}
