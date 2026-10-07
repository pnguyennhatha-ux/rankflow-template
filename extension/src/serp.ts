/**
 * Amazon search-results page parsing.
 *
 * `scanSerpPage` is injected with chrome.scripting.executeScript, so it must stay fully self-contained
 * (no imports, no references to module scope). `accumulatePage` is the pure rank counter used by the
 * background worker and the unit tests.
 */
import type { DirectSerpMatch } from "./rank";

export type TileKind = "organic" | "sponsored" | "featured";

export type SerpTile = {
  asin: string;
  /** Not organic: sponsored (explicit "Sponsored" label) or featured (ad slot without the label, e.g. "Featured from Amazon brands"). */
  sponsored: boolean;
  kind: TileKind;
  /** Why the tile was classified as an ad ("" = organic), e.g. "label-class+AdHolder". */
  signal: string;
  /** data-component-type of the tile (diagnostic). */
  component: string;
  title: string | null;
  imageUrl: string | null;
  priceText: string | null;
  priceCents: number | null;
  currency: string | null;
};

export type SerpLayout = {
  /** Grid tiles accepted (organic + ad). */
  tiles: number;
  mainSlot: boolean;
  organic?: number;
  sponsored?: number;
  featured?: number;
  /** Grid ad slots counted without a readable ASIN (placeholder/wrapper). */
  adNoAsin?: number;
  /** Full-width rows / widgets skipped (banners, carousels, video, "Results" header). */
  skipped?: number;
  /** Compact map of every main-slot child in order (diagnostic, first page only is stored). */
  map?: string;
  /** Column classes of the organic grid cells (ads must match to count as grid tiles). */
  gridColumns?: string;
  /** Ad elements that are NOT grid tiles and why: "YCYN:F(sspa-link)/nested 0003:S(label-class)/cols=…". */
  adSkipped?: string;
};

export type SerpScan =
  | { kind: "ok"; items: SerpTile[]; hasNext: boolean; layout: SerpLayout }
  | { kind: "blocked"; message: string }
  | { kind: "parser_error"; message: string };

/**
 * Tile rule (documented in README):
 *  - A tile is a GRID slot of the result list: a `.s-result-item` that is a direct child of a `.s-main-slot`,
 *    or any `[data-component-type=s-search-result]` inside it, that is not a full-width row
 *    (`s-flex-full-width`, `s-widget` without grid columns) and not inside a carousel.
 *  - The ASIN is the slot's data-asin, else the first inner [data-asin], else the first /dp/ link.
 *  - Ad tiles: "sponsored" when the slot carries an explicit Sponsored label (label classes,
 *    aria-label, sp-sponsored-result, a leaf "Sponsored" text); "featured" when it is an ad slot without
 *    that label (AdHolder / /sspa/ link / "Featured from Amazon brands"). Both are excluded from organic.
 *  - Ad grid tiles must additionally be a direct child of .s-main-slot, occupy the same grid columns
 *    (sg-col-N-of-M) as the page's organic tiles, show at most one product and contain no video/carousel.
 *    Everything else with an ad signal (top brand banner, video/headline brand ads, multi-product
 *    "Featured from Amazon brands" rows, ads nested in widgets) is skipped and counted nowhere.
 *  - sponsoredAbove = sponsored grid tiles before the organic hit on the same page; featuredAbove likewise.
 */
export function scanSerpPage(): SerpScan {
  const doc = document;
  const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const bodyText = doc.body ? ((doc.body as HTMLElement).innerText ?? doc.body.textContent ?? "") : "";
  const blocked = Boolean(doc.querySelector("#captchacharacters, form[action*='validateCaptcha']")) || /enter the characters you see below|sorry, we just need to make sure you're not a robot/i.test(bodyText);
  if (blocked) return { kind: "blocked", message: "Amazon yêu cầu CAPTCHA hoặc xác minh robot." };

  const ASIN = /^[A-Z0-9]{10}$/;
  const mains = Array.from(doc.querySelectorAll<HTMLElement>(".s-main-slot"));
  const inCarousel = (node: Element) => Boolean(node.closest(".a-carousel, .a-carousel-container, [data-component-type='s-shopping-adviser'], [data-component-type='s-searchgrid-carousel']"));
  const isFullWidth = (node: HTMLElement) => {
    const cls = node.classList;
    if (cls.contains("s-flex-full-width") || cls.contains("s-full-width")) return true;
    const grid = cls.contains("s-asin") || Array.from(cls).some((name) => /^sg-col-\d+-of-\d+$/.test(name) && !/^sg-col-(20-of-24|16-of-16|12-of-12|24-of-24)$/.test(name)) || node.dataset.componentType === "s-search-result";
    return !grid && (cls.contains("s-widget") || Boolean(node.querySelector(".a-carousel, video")));
  };
  const asinOf = (node: HTMLElement): string => {
    const own = (node.dataset.asin ?? "").trim().toUpperCase();
    if (ASIN.test(own)) return own;
    for (const inner of Array.from(node.querySelectorAll<HTMLElement>("[data-asin]"))) {
      const value = (inner.dataset.asin ?? "").trim().toUpperCase();
      if (ASIN.test(value)) return value;
    }
    const href = node.querySelector<HTMLAnchorElement>("a[href*='/dp/']")?.getAttribute("href") ?? "";
    const match = decodeURIComponent(href).match(/\/dp\/([A-Z0-9]{10})/i);
    return match ? match[1]!.toUpperCase() : "";
  };
  const labelSignal = (node: HTMLElement): string => {
    if (node.querySelector("[data-component-type='sp-sponsored-result']")) return "sp-sponsored-result";
    if (node.querySelector(".puis-sponsored-label-text, .s-sponsored-label-text, .puis-sponsored-label-info-icon, .s-sponsored-label-info-icon")) return "label-class";
    if (node.querySelector("[aria-label^='Sponsored' i], [aria-label*='sponsored ad' i], [aria-label*='Sponsored information' i]")) return "aria-label";
    const leaf = Array.from(node.querySelectorAll<HTMLElement>("span, a, div")).some((el) => el.childElementCount === 0 && /^sponsored$/i.test(clean(el.textContent)));
    return leaf ? "label-text" : "";
  };
  const adSignal = (node: HTMLElement): string => {
    const signals: string[] = [];
    if (node.classList.contains("AdHolder")) signals.push("AdHolder");
    if (node.querySelector("a[href*='/sspa/click'], a[href*='%2Fsspa%2Fclick']")) signals.push("sspa-link");
    if (/featured from (amazon|our) brands/i.test(clean(node.textContent))) signals.push("featured-text");
    return signals.join("+");
  };

  // candidate slots in document order. `direct` = the slot IS a child of .s-main-slot (a grid cell);
  // nested slots live inside some other row/widget and can never be ad grid tiles.
  const candidates: Array<{ node: HTMLElement; at: number; direct: boolean }> = [];
  const seen = new Set<Element>();
  const mapParts: string[] = [];
  let skipped = 0;
  for (const main of mains) {
    for (const child of Array.from(main.children) as HTMLElement[]) {
      const isResultItem = child.classList.contains("s-result-item") || child.dataset.componentType === "s-search-result";
      const slots = isResultItem ? [child] : Array.from(child.querySelectorAll<HTMLElement>("[data-component-type='s-search-result']"));
      if (!slots.length) { if (child.classList.contains("s-result-item") || child.dataset.asin !== undefined) { skipped += 1; mapParts.push("W"); } continue; }
      for (const slot of slots) {
        if (seen.has(slot)) continue;
        seen.add(slot);
        if (inCarousel(slot) || isFullWidth(slot)) { skipped += 1; mapParts.push(slot.classList.contains("AdHolder") || adSignal(slot) || labelSignal(slot) ? "W$" : "W"); continue; }
        candidates.push({ node: slot, at: mapParts.push("?") - 1, direct: isResultItem });
      }
    }
  }
  if (!mains.length) {
    for (const node of Array.from(doc.querySelectorAll<HTMLElement>("[data-component-type='s-search-result']"))) if (!inCarousel(node)) candidates.push({ node, at: mapParts.push("?") - 1, direct: true });
  }

  // Grid geometry: the column classes (sg-col-N-of-M) shared by the page's organic grid tiles. An ad is a
  // grid tile only if it occupies a cell of that same grid; brand banners, video/headline ads and
  // "Featured from Amazon brands" rows span other widths (or sit inside another widget).
  const columns = (node: HTMLElement) => Array.from(node.classList).filter((name) => /^sg-col-\d+-of-\d+$/.test(name)).sort().join(" ");
  const innerAsins = (node: HTMLElement) => new Set(Array.from(node.querySelectorAll<HTMLElement>("[data-asin]")).map((el) => (el.dataset.asin ?? "").trim().toUpperCase()).filter((value) => ASIN.test(value)));
  const tally = new Map<string, number>();
  for (const { node, direct } of candidates) {
    if (!direct || !ASIN.test((node.dataset.asin ?? "").trim().toUpperCase()) || labelSignal(node) || adSignal(node)) continue;
    const key = columns(node);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const gridColumns = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const adGridReason = (node: HTMLElement, direct: boolean, ownAsin: string): string => {
    if (!direct) return "nested";
    if (node.classList.contains("s-widget") || node.classList.contains("s-flex-full-width")) return "widget";
    if (node.querySelector("video, .a-carousel, [class*='carousel']")) return "video/carousel";
    const others = innerAsins(node);
    if (ownAsin) others.delete(ownAsin);
    if (others.size > 1) return `products=${others.size}`;
    const sameColumns = gridColumns !== "" && columns(node) === gridColumns;
    // without its own data-asin, an ad cell only counts when it provably sits in the organic grid columns
    if (!ownAsin && !sameColumns) return `no-asin cols=${columns(node) || "none"}`;
    if (gridColumns && !sameColumns) return `cols=${columns(node) || "none"}`;
    return "";
  };

  // run-length encode tokens: "O O O O S" → "O×4 S" (spaces only around runs)
  const compressMap = (tokens: string[]) => {
    const out: string[] = [];
    for (let i = 0; i < tokens.length;) {
      let j = i;
      while (j < tokens.length && tokens[j] === tokens[i]) j += 1;
      out.push(j - i >= 3 ? ` ${tokens[i]}×${j - i} ` : tokens.slice(i, j).join(""));
      i = j;
    }
    return out.join("").replace(/\s+/g, " ").trim();
  };
  const items: SerpTile[] = [];
  const adSkipped: string[] = [];
  let adNoAsin = 0;
  for (const { node, at, direct } of candidates) {
    const asin = asinOf(node);
    const label = labelSignal(node);
    const ad = adSignal(node);
    const kind: TileKind = label ? "sponsored" : ad ? "featured" : "organic";
    const signal = [label, ad].filter(Boolean).join("+");
    if (kind !== "organic") {
      const ownAsin = (node.dataset.asin ?? "").trim().toUpperCase();
      const reason = adGridReason(node, direct, ASIN.test(ownAsin) ? ownAsin : "");
      if (reason) {
        // not a grid position: counted nowhere (not organic, not sponsored/featured above)
        skipped += 1;
        mapParts[at] = "W$";
        if (adSkipped.length < 12) adSkipped.push(`${asin ? asin.slice(-4) : "?"}:${kind === "sponsored" ? "S" : "F"}(${signal})/${reason}`);
        continue;
      }
      if (!asin) {
        // an ad grid cell whose product is not readable (yet) still occupies a position above organic tiles
        adNoAsin += 1;
        mapParts[at] = kind === "sponsored" ? "s?" : "f?";
        items.push({ asin: "", sponsored: true, kind, signal, component: node.dataset.componentType ?? "", title: null, imageUrl: null, priceText: null, priceCents: null, currency: null });
        continue;
      }
    } else if (!asin) { skipped += 1; mapParts[at] = "W"; continue; }
    const title = clean(node.querySelector<HTMLElement>("h2 span, h2")?.textContent) || null;
    const image = node.querySelector<HTMLImageElement>("img.s-image") ?? node.querySelector<HTMLImageElement>("img");
    let imageUrl: string | null = image?.currentSrc || image?.getAttribute("src") || null;
    if (!imageUrl || imageUrl.startsWith("data:") || /grey-pixel|transparent-pixel/.test(imageUrl)) {
      const srcset = image?.getAttribute("srcset") ?? image?.getAttribute("data-srcset") ?? "";
      imageUrl = srcset.split(",")[0]?.trim().split(/\s+/)[0] || image?.getAttribute("data-src") || null;
    }
    if (imageUrl && !/^https:\/\//.test(imageUrl)) imageUrl = imageUrl.startsWith("//") ? `https:${imageUrl}` : null;
    const priceText = clean(node.querySelector<HTMLElement>(".a-price:not(.a-text-price) .a-offscreen, .a-price .a-offscreen")?.textContent) || null;
    const numericPrice = priceText?.match(/[\d,]+(?:\.\d{1,2})?/u)?.[0];
    const priceCents = numericPrice ? Math.round(Number(numericPrice.replaceAll(",", "")) * 100) : null;
    mapParts[at] = kind === "sponsored" ? "S" : kind === "featured" ? "F" : "O";
    items.push({
      asin, sponsored: kind !== "organic", kind, signal,
      component: node.dataset.componentType ?? "", title, imageUrl, priceText,
      priceCents: priceCents !== null && Number.isFinite(priceCents) ? priceCents : null,
      currency: priceText?.includes("$") ? "USD" : null
    });
  }
  const layout: SerpLayout = {
    tiles: items.length, mainSlot: mains.length > 0,
    organic: items.filter((item) => item.kind === "organic").length,
    sponsored: items.filter((item) => item.kind === "sponsored").length,
    featured: items.filter((item) => item.kind === "featured").length,
    adNoAsin, skipped, map: compressMap(mapParts), gridColumns, adSkipped: adSkipped.join(" ")
  };
  if (!items.length) {
    if (/no results for|did not match any products/i.test(bodyText)) return { kind: "ok", items: [], hasNext: false, layout };
    return { kind: "parser_error", message: "Không nhận diện được danh sách kết quả Amazon. Giao diện trang có thể đã thay đổi." };
  }
  const next = doc.querySelector<HTMLElement>("a.s-pagination-next");
  const hasNext = Boolean(next && !next.classList.contains("s-pagination-disabled") && next.getAttribute("aria-disabled") !== "true");
  return { kind: "ok", items, hasNext, layout };
}

/**
 * Settle probe (injected): Amazon may inject ad tiles after the load event. Returns a signature of the
 * result grid (slot count + ad count + ad slots without ASIN); the caller re-probes until it is stable.
 */
export function serpSignature(): string {
  const slots = Array.from(document.querySelectorAll<HTMLElement>(".s-main-slot > .s-result-item, .s-main-slot [data-component-type='s-search-result']"));
  const ads = slots.filter((node) => node.classList.contains("AdHolder") || node.querySelector(".puis-sponsored-label-text, .s-sponsored-label-text, [data-component-type='sp-sponsored-result'], a[href*='/sspa/click']")).length;
  const pending = slots.filter((node) => node.classList.contains("AdHolder") && !/^[A-Z0-9]{10}$/i.test(node.dataset.asin ?? "") && !node.querySelector("[data-asin]:not([data-asin=''])")).length;
  return `${slots.length}:${ads}:${pending}`;
}

export type RankState = { organicScanned: number; sponsoredScanned: number; matches: DirectSerpMatch[]; traces: Record<string, string> };

export function newRankState(): RankState {
  return { organicScanned: 0, sponsoredScanned: 0, matches: [], traces: {} };
}

/** Compact tile trace for diagnostics: "1:9F3K:S(label-class+AdHolder) 2:8P4T:O 3:?:F(AdHolder) ...". */
export function traceTiles(items: SerpTile[], upTo: number): string {
  return items.slice(0, upTo + 1).map((item, index) => {
    const tag = item.kind === "organic" || (!item.kind && !item.sponsored) ? "O" : `${item.kind === "featured" ? "F" : "S"}(${item.signal})`;
    return `${index + 1}:${item.asin ? item.asin.slice(-4) : "?"}:${tag}${item.component && item.component !== "s-search-result" ? `[${item.component}]` : ""}`;
  }).join(" ");
}

/** Parse a stored trace back into tiles (used by tests and offline diagnostics). Old traces have no S/F split: "S(...)" is sponsored. */
export function parseTrace(trace: string): SerpTile[] {
  const body = trace.includes(" · ") ? trace.slice(trace.indexOf(" · ") + 3) : trace;
  return body.trim().split(/\s+/).map((part) => {
    const match = part.match(/^\d+:([^:]+):(O|S|F)(?:\(([^)]*)\))?/);
    if (!match) throw new Error(`bad trace part: ${part}`);
    const kind: TileKind = match[2] === "O" ? "organic" : match[2] === "F" ? "featured" : "sponsored";
    return { asin: match[1] === "?" ? "" : match[1]!, sponsored: kind !== "organic", kind, signal: match[3] ?? "", component: "s-search-result", title: null, imageUrl: null, priceText: null, priceCents: null, currency: null };
  });
}

/**
 * Count one page. Organic rank is cumulative across pages and excludes ad tiles (sponsored + featured);
 * positionOnPage counts organic tiles on that page only (block UI "#pos Ppage"). sponsoredAbove counts
 * sponsored grid tiles before the hit on the same page, featuredAbove the unlabeled ad slots.
 */
export function accumulatePage(state: RankState, items: SerpTile[], pageNumber: number, targets: Set<string>, options: { maxOrganic: number; includeSponsored: boolean }) {
  let organicOnPage = 0;
  let sponsoredOnPage = 0;
  let featuredOnPage = 0;
  items.forEach((item, index) => {
    if (item.sponsored) {
      if (item.kind === "featured") featuredOnPage += 1; else sponsoredOnPage += 1;
      state.sponsoredScanned += 1;
      if (item.asin && options.includeSponsored && targets.has(item.asin) && !state.matches.some((match) => match.asin === item.asin && match.sponsored)) {
        state.matches.push({ asin: item.asin, sponsored: true, rank: state.sponsoredScanned, pageNumber, positionOnPage: sponsoredOnPage + featuredOnPage, title: item.title, imageUrl: item.imageUrl, priceText: item.priceText, priceCents: item.priceCents, currency: item.currency });
      }
      return;
    }
    if (state.organicScanned >= options.maxOrganic) return;
    state.organicScanned += 1;
    organicOnPage += 1;
    if (targets.has(item.asin) && !state.matches.some((match) => match.asin === item.asin && !match.sponsored)) {
      state.matches.push({ asin: item.asin, sponsored: false, rank: state.organicScanned, pageNumber, positionOnPage: organicOnPage, sponsoredAbove: sponsoredOnPage, featuredAbove: featuredOnPage, title: item.title, imageUrl: item.imageUrl, priceText: item.priceText, priceCents: item.priceCents, currency: item.currency });
      state.traces[item.asin] = `P${pageNumber} tiles=${items.length} · ${traceTiles(items, index)}`;
    }
  });
}
