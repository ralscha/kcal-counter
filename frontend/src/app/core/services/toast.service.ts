import { Injectable, signal } from '@angular/core';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface ToastOptions {
  kind?: ToastKind;
  durationMs?: number;
  title?: string;
}

export interface ToastMessage {
  id: number;
  message: string;
  kind: ToastKind;
  title: string | null;
}

const DEFAULT_DURATION_MS = 3500;

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly #messages = signal<ToastMessage[]>([]);
  readonly #timeouts = new Map<number, number>();
  #nextId = 1;

  readonly messages = this.#messages.asReadonly();

  show(message: string, options: ToastOptions = {}): number {
    const id = this.#nextId++;
    const toast: ToastMessage = {
      id,
      message,
      kind: options.kind ?? 'info',
      title: options.title ?? null,
    };

    this.#messages.update((messages) => [...messages, toast]);

    const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
    if (durationMs > 0) {
      const timeoutId = window.setTimeout(() => {
        this.dismiss(id);
      }, durationMs);
      this.#timeouts.set(id, timeoutId);
    }

    return id;
  }

  success(message: string, options: Omit<ToastOptions, 'kind'> = {}): number {
    return this.show(message, { ...options, kind: 'success' });
  }

  error(message: string, options: Omit<ToastOptions, 'kind'> = {}): number {
    return this.show(message, { ...options, kind: 'error' });
  }

  info(message: string, options: Omit<ToastOptions, 'kind'> = {}): number {
    return this.show(message, { ...options, kind: 'info' });
  }

  warning(message: string, options: Omit<ToastOptions, 'kind'> = {}): number {
    return this.show(message, { ...options, kind: 'warning' });
  }

  dismiss(id: number): void {
    const timeoutId = this.#timeouts.get(id);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      this.#timeouts.delete(id);
    }

    this.#messages.update((messages) => messages.filter((message) => message.id !== id));
  }
}
