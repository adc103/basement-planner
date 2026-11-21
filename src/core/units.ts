/**
 * Length units. The plan stores every length in inches (floating point).
 * Rendering converts to meters at the edge.
 */

export const INCH_M = 0.0254;

export const inToM = (inches: number): number => inches * INCH_M;
export const mToIn = (meters: number): number => meters / INCH_M;

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Format inches as feet-inches with a reduced fraction, e.g. 124.5 -> 10' 4 1/2".
 * `precision` is the fraction denominator (default 1/16").
 */
export function formatLength(inches: number, precision = 16): string {
  const neg = inches < 0;
  let ticks = Math.round(Math.abs(inches) * precision);
  const perFoot = 12 * precision;
  const feet = Math.floor(ticks / perFoot);
  ticks -= feet * perFoot;
  const whole = Math.floor(ticks / precision);
  const frac = ticks - whole * precision;
  let fracStr = '';
  if (frac > 0) {
    const g = gcd(frac, precision);
    fracStr = `${frac / g}/${precision / g}`;
  }
  const inchPart = whole > 0 && fracStr ? `${whole} ${fracStr}` : whole > 0 ? `${whole}` : fracStr || '0';
  const sign = neg ? '-' : '';
  if (feet === 0) return `${sign}${inchPart}"`;
  return `${sign}${feet}' ${inchPart}"`;
}

/**
 * Parse a typed length into inches. Accepts:
 *   10'            -> 120
 *   10' 4"         -> 124
 *   10'4           -> 124 (number after feet mark is inches)
 *   10' 4 1/2"     -> 124.5
 *   4 1/2"  / 4.5  -> 4.5  (a bare number is inches)
 *   10.5'          -> 126
 *   3/4            -> 0.75
 * Returns null when the text can't be read.
 */
export function parseLength(text: string): number | null {
  const s = text
    .trim()
    .replace(/[’′]/g, "'")
    .replace(/[”″]|''/g, '"')
    .replace(/\s+/g, ' ');
  if (!s) return null;

  let feet = 0;
  let rest = s;
  const feetIdx = s.indexOf("'");
  if (feetIdx >= 0) {
    const feetStr = s.slice(0, feetIdx).trim();
    const f = parseNumber(feetStr);
    if (f === null) return null;
    feet = f;
    rest = s.slice(feetIdx + 1);
    if (rest.includes("'")) return null;
  }
  rest = rest.replace(/"/g, '').replace(/^\s*-\s*/, '').trim();
  let inches = 0;
  if (rest) {
    const v = parseNumber(rest);
    if (v === null) return null;
    inches = v;
  }
  const total = feet * 12 + inches;
  return Number.isFinite(total) ? total : null;
}

/** "4", "4.5", "1/2", "4 1/2" -> number */
function parseNumber(str: string): number | null {
  const s = str.trim();
  if (!s) return null;
  let m = /^\d+(?:\.\d+)?$/.exec(s) ?? /^\.\d+$/.exec(s);
  if (m) return parseFloat(s);
  m = /^(?:(\d+)\s+)?(\d+)\/(\d+)$/.exec(s);
  if (!m) return null;
  const den = parseInt(m[3], 10);
  if (den === 0) return null;
  return (m[1] !== undefined ? parseInt(m[1], 10) : 0) + parseInt(m[2], 10) / den;
}
