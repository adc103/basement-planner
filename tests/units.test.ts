import { describe, expect, it } from 'vitest';
import { formatLength, inToM, mToIn, parseLength } from '../src/core/units';

describe('parseLength', () => {
  it.each([
    ["10'", 120],
    ["10' 0\"", 120],
    ["10' 4\"", 124],
    ["10'4", 124],
    ["10'4\"", 124],
    ["10' 4 1/2\"", 124.5],
    ["10'-4 1/2\"", 124.5],
    ['4 1/2"', 4.5],
    ['4 1/2', 4.5],
    ['4.5', 4.5],
    ['124', 124],
    ["10.5'", 126],
    ['3/4', 0.75],
    ['.5', 0.5],
    ["0' 3/8\"", 0.375],
  ])('%s -> %d', (text, expected) => {
    expect(parseLength(text)).toBeCloseTo(expected, 6);
  });

  it.each(['', 'abc', "10' 4' ", '1/0', "'", '4/', '41/2x'])('rejects %s', (text) => {
    expect(parseLength(text)).toBeNull();
  });
});

describe('formatLength', () => {
  it.each([
    [0, '0"'],
    [4, '4"'],
    [12, "1' 0\""],
    [124, "10' 4\""],
    [124.5, "10' 4 1/2\""],
    [0.5, '1/2"'],
    [96.0625, "8' 1/16\""],
    [11.999, "1' 0\""],
  ])('%d -> %s', (inches, expected) => {
    expect(formatLength(inches)).toBe(expected);
  });

  it('round-trips through parseLength', () => {
    for (const x of [0.25, 7.125, 36, 95.5, 143.875, 400]) {
      expect(parseLength(formatLength(x))).toBeCloseTo(x, 6);
    }
  });
});

describe('meters', () => {
  it('converts both ways', () => {
    expect(inToM(1)).toBeCloseTo(0.0254);
    expect(mToIn(3.048)).toBeCloseTo(120);
  });
});
