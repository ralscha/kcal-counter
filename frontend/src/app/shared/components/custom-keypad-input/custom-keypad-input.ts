import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  forwardRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

type InputConstraint = 'none' | 'integer' | 'decimal' | 'expression';

export const INTEGER_KEYPAD_ROWS = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
  ['0', '00'],
] as const satisfies readonly (readonly string[])[];

export const DECIMAL_KEYPAD_ROWS = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
  ['0', '.'],
] as const satisfies readonly (readonly string[])[];

export const EXPRESSION_KEYPAD_ROWS = [
  ['7', '8', '9', '/'],
  ['4', '5', '6', '*'],
  ['1', '2', '3', '-'],
  ['0', '.', '+'],
] as const satisfies readonly (readonly string[])[];

@Component({
  selector: 'app-custom-keypad-input',
  standalone: true,
  templateUrl: './custom-keypad-input.html',
  styleUrl: './custom-keypad-input.css',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => CustomKeypadInputComponent),
      multi: true,
    },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    '(focusout)': 'handleHostFocusOut()',
  },
})
export class CustomKeypadInputComponent implements ControlValueAccessor {
  readonly inputId = input.required<string>();
  readonly placeholder = input('');
  readonly describedBy = input<string | null>(null);
  readonly invalid = input(false);
  readonly inputClass = input('input input-sm w-full');
  readonly valueInput = input<string | number | null | undefined>(undefined);
  readonly inputConstraint = input<InputConstraint>('none');
  readonly type = input('text');
  readonly autocomplete = input('off');
  readonly ariaLabel = input<string | null>(null);
  readonly keypadRows = input<readonly (readonly string[])[]>(EXPRESSION_KEYPAD_ROWS);

  readonly valueInputChange = output<string>();

  protected readonly value = signal('');
  protected readonly keypadOpen = signal(false);
  protected readonly isDisabled = signal(false);

  readonly #host = inject(ElementRef<HTMLElement>);

  #inputElement: HTMLInputElement | null = null;
  #onChange: (value: string | null) => void = () => undefined;
  #onTouched: () => void = () => undefined;
  #backspaceDelayId: ReturnType<typeof setTimeout> | null = null;
  #backspaceIntervalId: ReturnType<typeof setInterval> | null = null;
  #suppressBackspaceClick = false;

  constructor() {
    effect(() => {
      const externalValue = this.valueInput();
      if (externalValue === undefined) {
        return;
      }

      const normalized = externalValue == null ? '' : this.sanitizeValue(String(externalValue));
      if (normalized !== this.value()) {
        this.value.set(normalized);
      }
    });
  }

  writeValue(value: string | number | null | undefined): void {
    this.value.set(value == null ? '' : this.sanitizeValue(String(value)));
  }

  registerOnChange(fn: (value: string | null) => void): void {
    this.#onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.#onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.isDisabled.set(isDisabled);
    if (isDisabled) {
      this.keypadOpen.set(false);
    }
  }

  protected registerInput(element: HTMLInputElement): void {
    this.#inputElement = element;
  }

  protected openKeypad(): void {
    if (this.isDisabled()) {
      return;
    }

    this.keypadOpen.set(true);
  }

  protected handleInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const rawValue = input.value;
    const caret = input.selectionStart ?? rawValue.length;
    const sanitizedValue = this.sanitizeValue(rawValue);

    this.syncValue(sanitizedValue);

    if (sanitizedValue !== rawValue) {
      const nextCaret = this.sanitizeValue(rawValue.slice(0, caret)).length;
      this.focusInput(nextCaret);
    }
  }

  protected handleEnter(event: Event): void {
    event.preventDefault();
    this.closeKeypad();
  }

  protected insertText(fragment: string): void {
    if (this.isDisabled()) {
      return;
    }

    const input = this.#inputElement;
    const currentValue = this.value();
    const start = input?.selectionStart ?? currentValue.length;
    const end = input?.selectionEnd ?? currentValue.length;
    const nextValue = this.sanitizeValue(
      `${currentValue.slice(0, start)}${fragment}${currentValue.slice(end)}`,
    );
    const nextCaret = this.sanitizeValue(`${currentValue.slice(0, start)}${fragment}`).length;

    this.syncValue(nextValue);
    this.focusInput(nextCaret);
  }

  protected backspace(): void {
    if (this.isDisabled()) {
      return;
    }

    const input = this.#inputElement;
    const currentValue = this.value();
    const start = input?.selectionStart ?? currentValue.length;
    const end = input?.selectionEnd ?? currentValue.length;
    if (start === 0 && end === 0) {
      return;
    }

    const deleteStart = start === end ? start - 1 : start;
    const nextValue = `${currentValue.slice(0, Math.max(0, deleteStart))}${currentValue.slice(end)}`;

    this.syncValue(nextValue);
    this.focusInput(Math.max(0, deleteStart));
  }

  protected handleBackspaceClick(): void {
    if (this.#suppressBackspaceClick) {
      this.#suppressBackspaceClick = false;
      return;
    }

    this.backspace();
  }

  protected startBackspaceRepeat(event: PointerEvent): void {
    if (this.isDisabled()) {
      return;
    }

    event.preventDefault();
    this.stopBackspaceRepeat();

    this.#backspaceDelayId = setTimeout(() => {
      this.#suppressBackspaceClick = true;
      this.backspace();
      this.#backspaceIntervalId = setInterval(() => this.backspace(), 80);
    }, 350);
  }

  protected stopBackspaceRepeat(): void {
    if (this.#backspaceDelayId != null) {
      clearTimeout(this.#backspaceDelayId);
      this.#backspaceDelayId = null;
    }

    if (this.#backspaceIntervalId != null) {
      clearInterval(this.#backspaceIntervalId);
      this.#backspaceIntervalId = null;
    }
  }

  protected clear(): void {
    if (this.isDisabled()) {
      return;
    }

    this.syncValue('');
    this.focusInput(0);
  }

  protected closeKeypad(): void {
    this.stopBackspaceRepeat();
    this.keypadOpen.set(false);
    this.#onTouched();
    this.#inputElement?.blur();
  }

  protected handleHostFocusOut(): void {
    queueMicrotask(() => {
      if (this.#host.nativeElement.contains(document.activeElement)) {
        return;
      }

      this.stopBackspaceRepeat();
      this.keypadOpen.set(false);
      this.#onTouched();
    });
  }

  private syncValue(value: string): void {
    this.value.set(value);
    this.#onChange(value === '' ? null : value);
    this.valueInputChange.emit(value);
  }

  private focusInput(caret: number = this.value().length): void {
    const input = this.#inputElement;
    if (!input) {
      return;
    }

    input.focus();
    input.setSelectionRange(caret, caret);
  }

  private sanitizeValue(value: string): string {
    switch (this.inputConstraint()) {
      case 'integer':
        return this.sanitizeIntegerValue(value);
      case 'decimal':
        return this.sanitizeDecimalValue(value);
      case 'expression':
        return this.sanitizeExpressionValue(value);
      default:
        return value;
    }
  }

  private sanitizeIntegerValue(value: string): string {
    const digitsOnly = value.replace(/\D+/g, '');
    return digitsOnly.replace(/^0+(?=\d)/, '');
  }

  private sanitizeDecimalValue(value: string): string {
    let integerPart = '';
    let fractionPart = '';
    let hasDecimalSeparator = false;

    for (const char of value.replaceAll(',', '.')) {
      if (char >= '0' && char <= '9') {
        if (hasDecimalSeparator) {
          fractionPart += char;
        } else {
          integerPart += char;
        }
        continue;
      }

      if (char === '.' && !hasDecimalSeparator) {
        hasDecimalSeparator = true;
      }
    }

    const normalizedIntegerPart =
      integerPart.replace(/^0+(?=\d)/, '') || (hasDecimalSeparator ? '0' : integerPart);

    if (!hasDecimalSeparator) {
      return normalizedIntegerPart;
    }

    return `${normalizedIntegerPart || '0'}.${fractionPart}`;
  }

  private sanitizeExpressionValue(value: string): string {
    let sanitized = '';
    let currentNumberHasDot = false;
    let expectingNumber = true;
    let unarySignAllowed = true;

    for (const char of value.replaceAll(',', '.')) {
      if (char === ' ') {
        continue;
      }

      if (char >= '0' && char <= '9') {
        sanitized += char;
        expectingNumber = false;
        unarySignAllowed = false;
        continue;
      }

      if (char === '.') {
        if (currentNumberHasDot) {
          continue;
        }

        if (expectingNumber) {
          sanitized += '0.';
          currentNumberHasDot = true;
          expectingNumber = false;
          unarySignAllowed = false;
          continue;
        }

        sanitized += '.';
        currentNumberHasDot = true;
        continue;
      }

      if (char === '+' || char === '-') {
        if (expectingNumber) {
          if (unarySignAllowed) {
            sanitized += char;
            unarySignAllowed = false;
          }
          continue;
        }

        sanitized += char;
        expectingNumber = true;
        unarySignAllowed = true;
        currentNumberHasDot = false;
        continue;
      }

      if ((char === '*' || char === '/') && !expectingNumber) {
        sanitized += char;
        expectingNumber = true;
        unarySignAllowed = true;
        currentNumberHasDot = false;
      }
    }

    return sanitized;
  }
}
