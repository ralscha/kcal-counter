import { AbstractControl } from '@angular/forms';

export type ApiValidationFieldErrors = Record<string, Record<string, unknown>>;

export interface ApiErrorPayload {
  code?: string;
  message?: string;
  fields?: ApiValidationFieldErrors;
}

export interface ApiErrorResponse {
  error?: ApiErrorPayload;
}

export function applyApiValidationErrors(form: AbstractControl, response: ApiErrorResponse): void {
  const error = response.error;
  if (!error || error.code !== 'validation_failed' || !error.fields) {
    return;
  }
  for (const [path, validators] of Object.entries(error.fields)) {
    const control = form.get(path);
    if (!control) {
      continue;
    }
    control.setErrors({ ...(control.errors ?? {}), ...validators });
    control.markAsTouched();
    control.markAsDirty();
  }
}

export function firstFieldError(errors: Record<string, unknown> | null | undefined): string | null {
  if (!errors) {
    return null;
  }
  if (errors['required']) {
    return 'Required';
  }
  if (errors['email']) {
    return 'Enter a valid email address';
  }
  if (errors['minlength']) {
    return `Minimum length is ${String((errors['minlength'] as Record<string, unknown>)?.['requiredLength'] ?? '')}`.trim();
  }
  if (errors['maxlength']) {
    return `Maximum length is ${String((errors['maxlength'] as Record<string, unknown>)?.['requiredLength'] ?? '')}`.trim();
  }
  if (errors['pattern']) {
    return 'Invalid format';
  }
  return null;
}
