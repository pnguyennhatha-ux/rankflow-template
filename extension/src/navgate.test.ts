import { describe, expect, it } from "vitest";
import { NavGate, type Throttle } from "./throttle";

const throttle: Throttle = { pageDelayMs: [1_000, 3_000], keywordDelayMs: [2_000, 6_000], captchaBackoffMs: 90_000 };

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

describe("NavGate", () => {
  it("lets the first navigation go immediately and spaces later ones by the upcoming kind", () => {
    const c = clock();
    const gate = new NavGate(throttle, c.now, () => 0.5);
    expect(gate.reserve("keyword")).toBe(0);
    gate.settle();
    expect(gate.reserve("page")).toBe(2_000); // page range midpoint
    c.t += 2_000; gate.settle();
    expect(gate.reserve("keyword")).toBe(4_000); // keyword range midpoint
  });

  it("counts the gap from when the page finished loading, not when it started", () => {
    const c = clock();
    const gate = new NavGate(throttle, c.now, () => 0);
    gate.reserve("keyword");
    c.t += 5_000; // slow page load (longer than any gap)
    gate.settle();
    expect(gate.reserve("keyword")).toBe(2_000); // still waits the full minimum gap after load
  });

  it("serialises concurrent slots so navigations are never closer than one gap", () => {
    const c = clock();
    const gate = new NavGate(throttle, c.now, () => 0);
    expect(gate.reserve("keyword")).toBe(0);
    expect(gate.reserve("keyword")).toBe(2_000);
    expect(gate.reserve("keyword")).toBe(4_000);
    const gaps = gate.log.slice(1).map((entry) => entry.gapMs);
    expect(gaps.every((gap) => gap >= 2_000)).toBe(true);
  });

  it("honours delayUntil (CAPTCHA backoff) for every slot", () => {
    const c = clock();
    const gate = new NavGate(throttle, c.now, () => 0);
    gate.reserve("keyword");
    gate.delayUntil(c.t + 90_000);
    expect(gate.reserve("page")).toBe(90_000);
  });
});
