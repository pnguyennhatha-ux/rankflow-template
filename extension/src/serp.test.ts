// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { accumulatePage, newRankState, scanSerpPage, type SerpTile } from "./serp";
import { positionLabel } from "./rank";

const asin = (n: number) => `B0TEST${String(n).padStart(4, "0")}`;

type Kind = "organic" | "adholder" | "sspa" | "label" | "sp-result" | "plain-organic";
function tile(n: number, kind: Kind) {
  const attrs = kind === "plain-organic" ? `class="s-result-item" data-asin="${asin(n)}"` : `class="s-result-item${kind === "adholder" ? " AdHolder" : ""}" data-component-type="s-search-result" data-asin="${asin(n)}"`;
  const extra = kind === "sspa" ? `<a href="/sspa/click?ie=UTF8&spc=x">x</a>` : kind === "label" ? `<span class="puis-sponsored-label-text">Sponsored</span>` : kind === "sp-result" ? `<div data-component-type="sp-sponsored-result"></div>` : "";
  return `<div ${attrs}><h2><span>Product ${n}</span></h2>${extra}<span class="a-price"><span class="a-offscreen">$1${n}.99</span></span></div>`;
}

function page(kinds: Kind[], extras = "") {
  document.body.innerHTML = `<div class="s-main-slot">${kinds.map((kind, index) => tile(index + 1, kind)).join("")}${extras}</div><a class="s-pagination-next" href="#">Next</a>`;
}

describe("scanSerpPage (60-tile layout)", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("classifies every sponsored signal and keeps organic tiles without s-search-result", () => {
    const kinds: Kind[] = [];
    for (let i = 0; i < 60; i += 1) kinds.push(i < 4 ? "adholder" : i < 7 ? "sspa" : i < 9 ? "label" : i === 9 ? "sp-result" : i === 12 ? "plain-organic" : "organic");
    page(kinds, `<div class="s-result-item" data-asin=""><div class="a-carousel"><div data-component-type="s-search-result" data-asin="${asin(999)}"></div></div></div>`);
    const scan = scanSerpPage();
    expect(scan.kind).toBe("ok");
    if (scan.kind !== "ok") return;
    expect(scan.layout.tiles).toBe(60); // carousel product excluded, plain organic included
    expect(scan.items.filter((item) => item.sponsored)).toHaveLength(10);
    expect(new Set(scan.items.filter((item) => item.sponsored).map((item) => item.signal))).toEqual(new Set(["AdHolder", "sspa-link", "label-class", "sp-sponsored-result"]));
    expect(scan.items[12]).toMatchObject({ asin: asin(13), sponsored: false });
    expect(scan.items[0]).toMatchObject({ priceText: "$11.99", priceCents: 1199, currency: "USD" });
    expect(scan.hasNext).toBe(true);
  });

  it("detects a bare 'Sponsored' text label and CAPTCHA pages", () => {
    document.body.innerHTML = `<div class="s-main-slot"><div data-component-type="s-search-result" data-asin="${asin(1)}"><div><span>Sponsored</span></div></div><div data-component-type="s-search-result" data-asin="${asin(2)}"><span>Sponsored products are great</span></div></div>`;
    const scan = scanSerpPage();
    expect(scan.kind === "ok" && scan.items.map((item) => item.sponsored)).toEqual([true, false]);
    document.body.innerHTML = `<form action="/errors/validateCaptcha"></form>`;
    expect(scanSerpPage().kind).toBe("blocked");
  });
});

describe("accumulatePage", () => {
  const items = (pattern: string): SerpTile[] => pattern.split("").map((ch, index) => ({ asin: asin(index + 1), sponsored: ch === "S", kind: ch === "S" ? "sponsored" as const : "organic" as const, signal: ch === "S" ? "AdHolder" : "", component: "s-search-result", title: null, imageUrl: null, priceText: null, priceCents: null, currency: null }));

  it("counts organic rank excluding sponsored, with per-page position and sponsoredAbove", () => {
    const state = newRankState();
    const page1 = items("SSSOOSOOO"); // target = tile 8 → organic #4, 4 sponsored above
    accumulatePage(state, page1, 1, new Set([asin(8)]), { maxOrganic: 100, includeSponsored: true });
    expect(state.matches[0]).toMatchObject({ asin: asin(8), rank: 4, pageNumber: 1, positionOnPage: 4, sponsoredAbove: 4 });
    expect(positionLabel({ pageNumber: 1, positionOnPage: 5 })).toBe("#5 P1");
    expect(state.traces[asin(8)]).toContain("tiles=9");
    const page2 = items("OSOO");
    accumulatePage(state, page2, 2, new Set([asin(4)]), { maxOrganic: 100, includeSponsored: false });
    expect(state.matches[1]).toMatchObject({ rank: 8, positionOnPage: 3, sponsoredAbove: 1 });
  });

  it("stops counting at maxOrganic and records sponsored ranks only when enabled", () => {
    const state = newRankState();
    accumulatePage(state, items("SOOO"), 1, new Set([asin(1), asin(4)]), { maxOrganic: 2, includeSponsored: true });
    expect(state.organicScanned).toBe(2);
    expect(state.matches.map((match) => match.sponsored)).toEqual([true]);
  });
});
