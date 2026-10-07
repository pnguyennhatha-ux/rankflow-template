import { describe, expect, it } from "vitest";
import { TabPool, runSlots, type TabApi } from "./scheduler";
import { NavGate, type Throttle } from "./throttle";

/** Deterministic virtual time: sleeps resolve in time order; the driver advances the clock. */
class VirtualClock {
  t = 0;
  private timers: Array<{ at: number; seq: number; resolve: () => void }> = [];
  private seq = 0;
  now = () => this.t;
  sleep = (ms: number) => new Promise<void>((resolve) => { this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, resolve }); });
  async run<T>(main: Promise<T>): Promise<T> {
    let done = false;
    void main.finally(() => { done = true; }).catch(() => undefined);
    for (let guard = 0; guard < 100_000; guard += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (done) return main;
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift();
      if (!next) throw new Error("deadlock: nothing scheduled");
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
    throw new Error("runaway");
  }
}

function seeded(seed: number) {
  return () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
}

const throttle: Throttle = { pageDelayMs: [1_500, 4_000], keywordDelayMs: [2_000, 6_000], captchaBackoffMs: 90_000 };

function fakeTabs() {
  let nextId = 100;
  const open = new Set<number>();
  const calls: string[] = [];
  const api: TabApi = {
    async create(url) { const id = nextId++; open.add(id); calls.push(`create ${id} ${url}`); return id; },
    async update(id, url) { calls.push(`update ${id} ${url}`); },
    async remove(id) { open.delete(id); calls.push(`remove ${id}`); },
    async exists(id) { return open.has(id); }
  };
  return { api, open, calls };
}

describe("2-slot crawl scheduling", () => {
  it("runs 2 slots on 2 reused tabs, staggered by the shared gate, ZIP once, CAPTCHA pauses both", async () => {
    const clock = new VirtualClock();
    const random = seeded(7);
    const gate = new NavGate(throttle, clock.now, random);
    const tabs = fakeTabs();
    const pool = new TabPool(tabs.api);
    const loads: Array<{ slot: number; start: number; end: number; url: string }> = [];
    let pauseUntil = 0;
    const keywords = ["k1", "k2", "k3", "k4", "k5", "k6"];
    const pagesFor: Record<string, number> = { k1: 1, k2: 2, k3: 1, k4: 1, k5: 3, k6: 1 };

    const navigate = async (kind: "keyword" | "page", slot: number, url: string) => {
      while (clock.now() < pauseUntil) await clock.sleep(pauseUntil - clock.now());
      await clock.sleep(gate.reserve(kind, slot));
      const start = clock.now();
      await pool.open(slot, url);
      await clock.sleep(3_000 + Math.round(random() * 2_000)); // page load + settle + scan (~3–5 s on Amazon)
      gate.settle(slot);
      loads.push({ slot, start, end: clock.now(), url });
    };

    const main = (async () => {
      await navigate("keyword", 0, "https://www.amazon.com/"); // ZIP once, slot 0's tab
      const out = await runSlots(keywords, 2, async (keyword, slot) => {
        for (let page = 1; page <= pagesFor[keyword]!; page += 1) {
          await navigate(page === 1 ? "keyword" : "page", slot, `/s?k=${keyword}&page=${page}`);
          if (keyword === "k3" && page === 1 && pauseUntil === 0) { // CAPTCHA seen by one slot
            pauseUntil = clock.now() + 90_000;
            gate.delayUntil(pauseUntil);
          }
        }
        return `${keyword}@${slot}`;
      });
      await pool.closeAll();
      return out;
    })();
    const result = await clock.run(main);

    // every keyword done, both slots used
    expect(result).toHaveLength(6);
    expect(new Set(result.map((item) => item!.split("@")[1]))).toEqual(new Set(["0", "1"]));
    // exactly 2 tabs ever created, reused for all other navigations, closed at the end
    expect(pool.created).toBe(2);
    expect(tabs.calls.filter((call) => call.startsWith("create"))).toHaveLength(2);
    expect(tabs.calls.filter((call) => call.startsWith("create"))[0]).toContain("amazon.com/"); // ZIP tab = slot 0 tab, reused
    expect(pool.reused).toBe(loads.length - 2);
    expect(tabs.open.size).toBe(0);
    // staggered: no two navigations start at the same instant; every gap ≥ the minimum page delay
    const starts = gate.log.map((entry) => entry.at);
    expect(new Set(starts).size).toBe(starts.length);
    for (const entry of gate.log.slice(1)) expect(entry.gapMs).toBeGreaterThanOrEqual(throttle.pageDelayMs[0]);
    // real parallelism: some loads of the two slots overlap in time
    const overlap = loads.some((a) => loads.some((b) => a.slot !== b.slot && a.start < b.end && b.start < a.end));
    expect(overlap).toBe(true);
    // CAPTCHA pause applies to both slots: nothing starts inside the pause window
    const captchaAt = loads.find((load) => load.url.includes("k=k3"))!.end;
    const inPause = gate.log.filter((entry) => entry.at > captchaAt && entry.at < captchaAt + 90_000);
    expect(inPause).toHaveLength(0);
    expect(new Set(gate.log.filter((entry) => entry.at >= captchaAt + 90_000).map((entry) => entry.slot))).toEqual(new Set([0, 1]));
    // load time is recorded per navigation
    expect(gate.log.every((entry) => typeof entry.loadMs === "number")).toBe(true);
  });

  it("caps the width at the number of keywords and recreates a tab the user closed", async () => {
    const tabs = fakeTabs();
    const pool = new TabPool(tabs.api);
    const first = await pool.open(0, "a");
    tabs.open.delete(first); // user closed it
    const second = await pool.open(0, "b");
    expect(second).not.toBe(first);
    expect(pool.created).toBe(2);
    const slots = new Set<number>();
    await runSlots(["only"], 2, async (_item, slot) => { slots.add(slot); });
    expect([...slots]).toEqual([0]);
  });

  it("stops handing out keywords once stopped and rethrows the first failure", async () => {
    let stopped = false;
    const seen: string[] = [];
    await expect(runSlots(["a", "b", "c", "d"], 2, async (item) => {
      seen.push(item);
      if (item === "b") { stopped = true; throw new Error("boom"); }
    }, () => stopped)).rejects.toThrow("boom");
    expect(seen).toEqual(["a", "b"]);
  });
});
