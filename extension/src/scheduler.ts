/**
 * Crawl scheduling: a fixed number of keyword slots (2 by default) pull keywords from one queue, and
 * each slot owns ONE Amazon tab that is reused for every keyword/page it crawls. Spacing between page
 * loads is not done here: every navigation still goes through the shared NavGate, so the two slots are
 * staggered (never two loads at the same instant) and a CAPTCHA backoff pauses both.
 */

export type TabApi = {
  create(url: string): Promise<number>;
  update(tabId: number, url: string): Promise<void>;
  remove(tabId: number): Promise<void>;
  exists(tabId: number): Promise<boolean>;
};

export class TabPool {
  private readonly tabs = new Map<number, number>();
  created = 0;
  reused = 0;
  constructor(private readonly api: TabApi, private readonly onChange: (tabIds: number[]) => void = () => undefined) {}

  /** Navigate the slot's tab to `url`, creating the tab on first use (or if the user closed it). */
  async open(slot: number, url: string): Promise<number> {
    const existing = this.tabs.get(slot);
    if (existing !== undefined && await this.api.exists(existing)) {
      await this.api.update(existing, url);
      this.reused += 1;
      return existing;
    }
    const tabId = await this.api.create(url);
    this.tabs.set(slot, tabId);
    this.created += 1;
    this.onChange(this.ids());
    return tabId;
  }

  ids(): number[] {
    return [...this.tabs.values()];
  }

  async closeAll(): Promise<void> {
    const ids = this.ids();
    this.tabs.clear();
    await Promise.all(ids.map((id) => this.api.remove(id).catch(() => undefined)));
    this.onChange([]);
  }
}

/**
 * Run `work` over `items` with `concurrency` slots (slot ids 0..n-1). Items are handed out in order; a
 * slot takes the next item when it finishes one. Stops handing out items once `shouldStop()` is true.
 * Rejects with the first error after all slots have settled. Results keep the input order.
 */
export async function runSlots<T, R>(items: T[], concurrency: number, work: (item: T, slot: number, index: number) => Promise<R>, shouldStop: () => boolean = () => false): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  const slots = Array.from({ length: width }, async (_unused, slot) => {
    while (!shouldStop()) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]!, slot, index);
    }
  });
  const settled = await Promise.allSettled(slots);
  const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

/** The subset of the chrome API used for crawl tabs (injectable for tests). */
export type ChromeLike = {
  windows: {
    create(data: { url: string; focused: boolean; state?: "minimized"; type: "normal" }): Promise<{ id?: number; tabs?: Array<{ id?: number }> } | undefined>;
    get(windowId: number): Promise<{ id?: number; focused: boolean }>;
    getLastFocused(): Promise<{ id?: number; focused: boolean }>;
    update(windowId: number, data: { focused: boolean }): Promise<unknown>;
  };
  tabs: {
    create(data: { windowId?: number; url: string; active: boolean }): Promise<{ id?: number }>;
    update(tabId: number, data: { url: string }): Promise<unknown>;
    remove(tabId: number): Promise<unknown>;
    get(tabId: number): Promise<unknown>;
  };
};

/**
 * Crawl tabs never live in the user's windows: the first slot tab opens a separate, unfocused,
 * minimized window; the second slot tab is added to it with active:false. Navigation never passes
 * `active`, and nothing ever focuses the crawl window. Pages there are hidden exactly like ordinary
 * background tabs (how v0.3.x already crawled slot 2 and set the ZIP). Closing both tabs closes it.
 */
export function createCrawlWindowTabs(chromeApi: ChromeLike): { api: TabApi; reset(): void; windowId(): number | undefined } {
  let crawlWindowId: number | undefined;
  const openWindow = async (url: string): Promise<number> => {
    const before = await chromeApi.windows.getLastFocused().catch(() => undefined);
    let created: { id?: number; tabs?: Array<{ id?: number }> } | undefined;
    try {
      created = await chromeApi.windows.create({ url, focused: false, state: "minimized", type: "normal" });
    } catch {
      created = await chromeApi.windows.create({ url, focused: false, type: "normal" }); // minimized refused
    }
    crawlWindowId = created?.id;
    // some window managers still raise/focus a new window: give focus back to where the user was
    if (created?.id !== undefined && before?.focused && before.id !== undefined && before.id !== created.id) {
      const now = await chromeApi.windows.get(created.id).catch(() => undefined);
      if (now?.focused) await chromeApi.windows.update(before.id, { focused: true }).catch(() => undefined);
    }
    const tabId = created?.tabs?.[0]?.id;
    if (tabId === undefined) throw new Error("Không thể mở cửa sổ crawl Amazon.");
    return tabId;
  };
  const api: TabApi = {
    async create(url) {
      const alive = crawlWindowId !== undefined && await chromeApi.windows.get(crawlWindowId).then(() => true, () => false);
      if (!alive) return openWindow(url);
      const tab = await chromeApi.tabs.create({ windowId: crawlWindowId, url, active: false });
      if (tab.id === undefined) throw new Error("Không thể mở tab Amazon.");
      return tab.id;
    },
    async update(tabId, url) { await chromeApi.tabs.update(tabId, { url }); },
    async remove(tabId) { await chromeApi.tabs.remove(tabId); },
    async exists(tabId) { return chromeApi.tabs.get(tabId).then(() => true, () => false); }
  };
  return { api, reset: () => { crawlWindowId = undefined; }, windowId: () => crawlWindowId };
}
