import { HttpErrorResponse } from '@angular/common/http';
import { ToastService } from '../../core/services/toast.service';

export interface ToastErrorOptions {
  fallback: string;
  title: string;
  notAllowedMessage?: string;
}

export function toastErrorMessage(
  toastService: ToastService,
  error: unknown,
  options: ToastErrorOptions,
): string {
  const message = extractErrorMessage(error, options);
  toastService.error(message, { title: options.title });
  return message;
}

function extractErrorMessage(error: unknown, options: ToastErrorOptions): string {
  if (error instanceof HttpErrorResponse) {
    return (
      (error.error as { error?: { message?: string } })?.error?.message ??
      error.message ??
      options.fallback
    );
  }

  if (
    options.notAllowedMessage &&
    error instanceof DOMException &&
    error.name === 'NotAllowedError'
  ) {
    return options.notAllowedMessage;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return options.fallback;
}
