/**
 * Pi amounts are stored as bigint "units" of 10^-7 Pi (Pi has 7 decimal places).
 * 1 Pi = 10_000_000 u. Never use JS floating point for sums; convert only at the edges.
 */

export const PI_DECIMALS = 7;
export const UNITS_PER_PI = 10_000_000n;

const PI_AMOUNT_RE = /^(\d+)(?:\.(\d{1,7}))?$/;

/** "1.2345" -> 12345000n. Rejects negatives, exponents, and more than 7 decimals. */
export function toUnits(amount: string | number): bigint {
  const str = typeof amount === "number" ? numberToPlainString(amount) : amount.trim();
  const m = PI_AMOUNT_RE.exec(str);
  if (!m?.[1]) throw new RangeError(`Invalid Pi amount: ${JSON.stringify(amount)}`);
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(PI_DECIMALS, "0"));
  return whole * UNITS_PER_PI + frac;
}

/** 12345000n -> "1.2345000" (always 7 decimals, the format Pi's API uses). */
export function fromUnits(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / UNITS_PER_PI;
  const frac = (abs % UNITS_PER_PI).toString().padStart(PI_DECIMALS, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Only for handing an amount to an SDK that insists on a JS number (e.g. Pi.createPayment). */
export function fromUnitsNumber(units: bigint): number {
  return Number(fromUnits(units));
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`Invalid Pi amount: ${n}`);
  // toFixed(7) avoids exponent notation; this rounds to 7 dp, so a number input with more
  // precision than Pi supports is rejected below rather than silently rounded.
  const fixed = n.toFixed(PI_DECIMALS);
  if (Number(fixed) !== n) throw new RangeError(`Pi amount has more than ${PI_DECIMALS} decimals: ${n}`);
  return fixed.replace(/\.?0+$/, "") || "0";
}
