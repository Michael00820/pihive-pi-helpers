import { describe, expect, it } from "vitest";
import { fromUnits, fromUnitsNumber, toUnits, UNITS_PER_PI } from "../src/money.js";

describe("money helpers (units of 1e-7 Pi)", () => {
  it("converts Pi strings to integer units exactly", () => {
    expect(toUnits("1")).toBe(UNITS_PER_PI);
    expect(toUnits("1.2345")).toBe(12_345_000n);
    expect(toUnits("0.0000001")).toBe(1n);
    expect(toUnits("51.5000000")).toBe(515_000_000n);
    expect(toUnits(" 0.05 ")).toBe(500_000n);
  });

  it("accepts plain JS numbers without float drift", () => {
    expect(toUnits(0.1)).toBe(1_000_000n);
    expect(toUnits(0.3)).toBe(3_000_000n);
    expect(toUnits(10)).toBe(100_000_000n);
    expect(toUnits(0)).toBe(0n);
  });

  it("rejects invalid, negative or over-precise amounts", () => {
    for (const bad of ["", "-1", "1.23456789", "1e3", "abc", "1.", ".5"]) {
      expect(() => toUnits(bad)).toThrow(RangeError);
    }
    expect(() => toUnits(-1)).toThrow(RangeError);
    expect(() => toUnits(Number.NaN)).toThrow(RangeError);
    expect(() => toUnits(0.123456789)).toThrow(RangeError);
  });

  it("formats units back to 7-decimal strings", () => {
    expect(fromUnits(12_345_000n)).toBe("1.2345000");
    expect(fromUnits(1n)).toBe("0.0000001");
    expect(fromUnits(0n)).toBe("0.0000000");
    expect(fromUnits(-5n)).toBe("-0.0000005");
    expect(fromUnitsNumber(515_000_000n)).toBe(51.5);
  });

  it("round-trips", () => {
    for (const s of ["0.0000001", "1.0000000", "123456.7654321", "0.0500000"]) {
      expect(fromUnits(toUnits(s))).toBe(s);
    }
  });
});
