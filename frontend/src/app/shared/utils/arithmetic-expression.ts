import { AbstractControl, type ValidationErrors, type ValidatorFn } from '@angular/forms';

export function parseArithmeticExpression(
  value: number | string | null | undefined,
): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const normalized = value?.trim().replaceAll(',', '.');
  if (!normalized) {
    return null;
  }

  let index = 0;

  const skipWhitespace = (): void => {
    while (normalized[index] === ' ') {
      index += 1;
    }
  };

  const parseNumber = (): number | null => {
    skipWhitespace();

    let hasDigit = false;
    let hasDecimalSeparator = false;
    const start = index;

    while (index < normalized.length) {
      const char = normalized[index];
      if (char >= '0' && char <= '9') {
        hasDigit = true;
        index += 1;
        continue;
      }

      if (char === '.') {
        if (hasDecimalSeparator) {
          return null;
        }

        hasDecimalSeparator = true;
        index += 1;
        continue;
      }

      break;
    }

    if (!hasDigit) {
      return null;
    }

    const parsed = Number(normalized.slice(start, index));
    return Number.isFinite(parsed) ? parsed : null;
  };

  const parseFactor = (): number | null => {
    skipWhitespace();

    const operator = normalized[index];
    if (operator === '+' || operator === '-') {
      index += 1;
      const factor = parseFactor();
      if (factor == null) {
        return null;
      }

      return operator === '-' ? -factor : factor;
    }

    return parseNumber();
  };

  const parseTerm = (): number | null => {
    let result = parseFactor();
    if (result == null) {
      return null;
    }

    while (true) {
      skipWhitespace();
      const operator = normalized[index];
      if (operator !== '*' && operator !== '/') {
        return result;
      }

      index += 1;
      const rightSide = parseFactor();
      if (rightSide == null) {
        return null;
      }

      if (operator === '*') {
        result *= rightSide;
        continue;
      }

      if (rightSide === 0) {
        return null;
      }

      result /= rightSide;
    }
  };

  const parseExpression = (): number | null => {
    let result = parseTerm();
    if (result == null) {
      return null;
    }

    while (true) {
      skipWhitespace();
      const operator = normalized[index];
      if (operator !== '+' && operator !== '-') {
        return result;
      }

      index += 1;
      const rightSide = parseTerm();
      if (rightSide == null) {
        return null;
      }

      result = operator === '+' ? result + rightSide : result - rightSide;
    }
  };

  const parsed = parseExpression();
  skipWhitespace();

  if (parsed == null || index !== normalized.length || !Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

export function createArithmeticExpressionValidator(
  errorKey = 'arithmeticExpression',
): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    if (value == null || value === '') {
      return null;
    }

    return parseArithmeticExpression(value) == null ? { [errorKey]: true } : null;
  };
}

export const kcalExpressionValidator = createArithmeticExpressionValidator('kcalExpression');
