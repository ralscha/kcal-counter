import { Injectable } from '@angular/core';

const PREFIX = 'kcal_';

@Injectable({ providedIn: 'root' })
export class StorageService {
  get<T>(key: string): T | null {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  set<T>(key: string, value: T): void {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  }

  remove(key: string): void {
    localStorage.removeItem(PREFIX + key);
  }
}
