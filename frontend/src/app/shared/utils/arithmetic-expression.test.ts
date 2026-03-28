import { describe, expect, it } from 'bun:test';

import {
  createArithmeticExpressionValidator,
  parseArithmeticExpression,
} from './arithmetic-expression';

describe('parseArithmeticExpression', () => {
  it('respects operator precedence', () => {
    expect(parseArithmeticExpression('3*50+25')).toBe(175);
  });

  it('supports decimals, commas, and unary signs', () => {
    expect(parseArithmeticExpression('-1,5 + 4 / 2')).toBe(0.5);
  });

  it('rejects invalid expressions', () => {
    expect(parseArithmeticExpression('2..5')).toBeNull();
    expect(parseArithmeticExpression('12/0')).toBeNull();
    expect(parseArithmeticExpression('3+')).toBeNull();
  });
});

describe('createArithmeticExpressionValidator', () => {
  it('returns the configured error key for invalid input', () => {
    const validator = createArithmeticExpressionValidator('kcalExpression');

    expect(validator({ value: '1+*2' } as never)).toEqual({ kcalExpression: true });
    expect(validator({ value: '1+2' } as never)).toBeNull();
  });
});
