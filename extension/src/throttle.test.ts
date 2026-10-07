import { describe, expect, it } from "vitest";
import { DEFAULT_THROTTLE, captchaBackoff, normalizeThrottle, randomDelay } from "./throttle";

describe("throttle", () => {
  it("normalizes backend hints and keeps defaults for junk", () => {
    expect(normalizeThrottle(undefined)).toEqual(DEFAULT_THROTTLE);
    expect(normalizeThrottle({ pageDelayMs: [5000, 1000], keywordDelayMs: [-5, 999999] as [number, number], captchaBackoffMs: 10 ** 9 })).toEqual({ pageDelayMs: [1000, 5000], keywordDelayMs: [0, 120000], captchaBackoffMs: 900000 });
    expect(normalizeThrottle({ pageDelayMs: ["x", 1] as unknown as [number, number] }).pageDelayMs).toEqual(DEFAULT_THROTTLE.pageDelayMs);
  });
  it("draws delays inside the range", () => {
    expect(randomDelay([1000, 3000], () => 0)).toBe(1000);
    expect(randomDelay([1000, 3000], () => 0.5)).toBe(2000);
    expect(randomDelay([1000, 3000], () => 0.999999)).toBe(3000);
  });
  it("doubles CAPTCHA backoff per consecutive block with a cap", () => {
    expect(captchaBackoff(90000, 1)).toBe(90000);
    expect(captchaBackoff(90000, 2)).toBe(180000);
    expect(captchaBackoff(90000, 10)).toBe(900000);
  });
});
