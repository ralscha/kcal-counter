import { Injectable, signal, effect, inject } from '@angular/core';
import { StorageService } from './storage.service';

export type Theme = 'light' | 'dark';
const THEME_KEY = 'theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly #storage = inject(StorageService);
  readonly #theme = signal<Theme>('light');
  readonly theme = this.#theme.asReadonly();

  constructor() {
    const saved = this.#storage.get<Theme>(THEME_KEY) ?? 'light';
    this.#theme.set(saved);
    this.#applyTheme(saved);
    effect(() => {
      this.#applyTheme(this.#theme());
      this.#storage.set(THEME_KEY, this.#theme());
    });
  }

  toggle(): void {
    this.#theme.update((t) => (t === 'light' ? 'dark' : 'light'));
  }

  #applyTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
  }
}
