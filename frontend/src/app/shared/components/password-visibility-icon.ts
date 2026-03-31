import { ChangeDetectionStrategy, Component, signal, input } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

@Component({
  selector: 'app-password-visibility-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (passwordVisible()) {
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
        />
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M1 1l22 22" />
      </svg>
    } @else {
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
        />
        <circle cx="12" cy="12" r="3" stroke-width="2" />
      </svg>
    }
  `,
})
export class PasswordVisibilityIconComponent {
  readonly passwordVisible = input.required<boolean>();
}

@Component({
  selector: 'app-password-field',
  standalone: true,
  imports: [ReactiveFormsModule, PasswordVisibilityIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="input w-full min-h-12 pr-1" [class.input-error]="invalid()">
      <input
        [id]="id()"
        [type]="visible() ? 'text' : 'password'"
        [formControl]="control()"
        class="grow"
        [placeholder]="placeholder()"
        [autocomplete]="autocomplete()"
      />
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-circle shrink-0"
        [attr.aria-label]="visible() ? 'Hide ' + visibilityLabel() : 'Show ' + visibilityLabel()"
        [attr.aria-pressed]="visible()"
        (click)="toggleVisibility()"
      >
        <app-password-visibility-icon [passwordVisible]="visible()" />
      </button>
    </label>
  `,
})
export class PasswordFieldComponent {
  readonly control = input.required<FormControl<string>>();
  readonly id = input.required<string>();
  readonly placeholder = input('');
  readonly autocomplete = input('current-password');
  readonly invalid = input(false);
  readonly visibilityLabel = input('password');

  protected readonly visible = signal(false);

  protected toggleVisibility(): void {
    this.visible.update((value) => !value);
  }
}
