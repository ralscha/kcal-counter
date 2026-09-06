import { DOCUMENT } from '@angular/common';
import { DestroyRef, Service, inject, signal } from '@angular/core';
import { toDateKey } from '../../shared/utils/local-date';

@Service()
export class LocalDateService {
  readonly #today = signal(toDateKey(new Date()));
  readonly today = this.#today.asReadonly();

  constructor() {
    const document = inject(DOCUMENT);
    const refresh = (): void => this.#today.set(toDateKey(new Date()));
    const timer = setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    });
  }
}
