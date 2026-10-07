// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { accumulatePage, newRankState, parseTrace, scanSerpPage } from "./serp";

const TARGET = "B0TEST0004";
const GRID = "sg-col-4-of-24 sg-col-4-of-12 s-result-item s-asin sg-col-4-of-16 sg-col s-widget-spacing-small sg-col-4-of-20";
const asin = (n: number) => `B0ORG${String(n).padStart(5, "0")}`;
const ad = (n: number) => `B0ADS${String(n).padStart(5, "0")}`;

const organic = (id: string) => `<div class="${GRID}" data-component-type="s-search-result" data-asin="${id}"><h2><span>${id}</span></h2><img class="s-image" src="data:image/gif;base64,R0lGOD" srcset="https://m.media-amazon.com/images/I/${id}._AC_UL320_.jpg 1x, https://m.media-amazon.com/images/I/${id}._AC_UL640_.jpg 2x"><span class="a-price"><span class="a-offscreen">$15.99</span></span></div>`;
/** Sponsored tile rendered as an outer grid slot WITHOUT data-asin; the ASIN only lives on an inner element. */
const wrappedSponsored = (id: string) => `<div class="${GRID} AdHolder" data-asin=""><div data-component-type="sp-sponsored-result" data-asin="${id}"><a href="/sspa/click?ie=UTF8&url=%2Fdp%2F${id}">x</a><span class="a-color-secondary">Sponsored</span></div></div>`;
const labelledSponsored = (id: string) => `<div class="${GRID} AdHolder" data-component-type="s-search-result" data-asin="${id}"><span class="puis-sponsored-label-text">Sponsored</span></div>`;
const featured = (id: string) => `<div class="${GRID} AdHolder" data-component-type="s-search-result" data-asin="${id}"><span>Featured from Amazon brands</span><a href="/sspa/click?x">x</a></div>`;
const placeholderAd = () => `<div class="${GRID} AdHolder" data-asin=""><span class="puis-sponsored-label-text">Sponsored</span></div>`;
const banner = `<div class="s-result-item s-widget s-widget-spacing-large AdHolder s-flex-full-width" data-asin=""><div data-component-type="s-search-result" data-asin="${ad(900)}"><span class="puis-sponsored-label-text">Sponsored</span></div></div>`;
const carousel = `<div class="s-result-item s-widget s-flex-full-width" data-asin=""><div class="a-carousel"><div data-component-type="s-search-result" data-asin="${ad(901)}"><span>Sponsored</span></div></div></div>`;
const video = `<div class="s-result-item s-widget AdHolder" data-asin=""><video></video><a href="/sspa/click?y">v</a></div>`;
const header = `<div class="s-result-item s-widget s-flex-full-width" data-asin=""><h2>Results</h2></div>`;

function render(tiles: string[]) {
  document.body.innerHTML = `<div class="s-main-slot s-result-list">${tiles.join("")}</div><a class="s-pagination-next" href="#">Next</a>`;
  const scan = scanSerpPage();
  if (scan.kind !== "ok") throw new Error(scan.kind);
  return scan;
}

function rankOf(tiles: string[]) {
  const scan = render(tiles);
  const state = newRankState();
  accumulatePage(state, scan.items, 1, new Set([TARGET]), { maxOrganic: 100, includeSponsored: false });
  return { scan, hit: state.matches.find((match) => match.asin === TARGET && !match.sponsored), trace: state.traces[TARGET] };
}

describe("sponsored-above (60-tile layout)", () => {
  it("'father of the bride gifts': counts 7 wrapped sponsored tiles above organic #10 (v0.3 saw 0)", () => {
    // v0.3 trace for this keyword: 48 tiles, 10 organic up to the hit, no ads at all → the ad tiles were not candidates.
    const page: string[] = [header];
    const before = ["S", "S", "S", "O", "O", "S", "O", "O", "O", "S", "S", "O", "O", "S", "O", "O", "T"]; // 7 ads + 9 organic + hit
    let o = 0, a = 0;
    for (const kind of before) page.push(kind === "S" ? wrappedSponsored(ad(++a)) : kind === "T" ? organic(TARGET) : organic(asin(++o)));
    while (o < 47) page.push(o % 9 === 4 && a < 12 ? wrappedSponsored(ad(++a)) : organic(asin(++o)));
    while (a < 12) page.push(wrappedSponsored(ad(++a)));
    const { scan, hit, trace } = rankOf(page);
    expect(scan.layout).toMatchObject({ tiles: 60, organic: 48, sponsored: 12, featured: 0 });
    expect(hit).toMatchObject({ rank: 10, positionOnPage: 10, sponsoredAbove: 7, featuredAbove: 0 });
    expect(trace).toContain("1:0001:S(sp-sponsored-result+AdHolder+sspa-link)");
    expect(scan.layout.map?.startsWith("W S×3 OOS")).toBe(true);
  });

  it("re-counts the stored v0.3 trace for '...from daughter' (12 ad tiles above organic #17)", () => {
    const stored = "P1 tiles=60 · 1:1T3M:S(AdHolder) 2:YCYN:S(AdHolder) 3:3B8R:S(AdHolder) 4:8HGV:S(AdHolder) 5:YCYN:O 6:SQZG:O 7:Y6W6:O 8:9QP2:O 9:7JWY:O 10:RMDX:O 11:G2VM:S(AdHolder) 12:F7P9:O 13:CLYD:O 14:WDKQ:O 15:YRV3:O 16:84VX:S(AdHolder) 17:C8PL:S(AdHolder) 18:SYPL:S(AdHolder) 19:ZJTL:S(AdHolder) 20:G2VM:O 21:MDVJ:O 22:LZ9J:O 23:3B8R:O 24:F5N7:S(AdHolder) 25:VKGV:S(AdHolder) 26:Y477:S(AdHolder) 27:YHPG:O 28:HCBF:O 29:0004:O";
    const items = parseTrace(stored);
    const state = newRankState();
    accumulatePage(state, items, 1, new Set(["0004"]), { maxOrganic: 100, includeSponsored: false });
    // organic #17 matched Amazon; v0.3 only knew "AdHolder", so labelled and unlabelled ad slots were lumped together
    expect(state.matches[0]).toMatchObject({ rank: 17, positionOnPage: 17, sponsoredAbove: 12, featuredAbove: 0 });
  });

  it("splits 'Featured from Amazon brands' (unlabelled ad slots) from Sponsored; both stay out of organic", () => {
    const page = [featured(ad(1)), featured(ad(2)), featured(ad(3)), featured(ad(4)), organic(asin(1)), organic(asin(2)), labelledSponsored(ad(5)), organic(asin(3)), labelledSponsored(ad(6)), organic(TARGET)];
    const { hit, scan } = rankOf(page);
    expect(scan.layout).toMatchObject({ organic: 4, sponsored: 2, featured: 4 });
    expect(hit).toMatchObject({ rank: 4, sponsoredAbove: 2, featuredAbove: 4 });
  });

  it("counts a grid ad slot without readable ASIN; skips banners, carousels, video and headers", () => {
    const page = [header, banner, placeholderAd(), organic(asin(1)), carousel, video, labelledSponsored(ad(1)), organic(TARGET)];
    const { hit, scan } = rankOf(page);
    expect(scan.layout).toMatchObject({ tiles: 4, organic: 2, sponsored: 2, adNoAsin: 1, skipped: 4 });
    expect(hit).toMatchObject({ rank: 2, sponsoredAbove: 2 });
    expect(scan.layout.map).toBe("WW$s?OW$W$SO"); // carousel/video/banner with ad signals are marked W$ and counted nowhere
  });

  it("captures the real image URL when src is a lazy placeholder, and the price", () => {
    const { scan } = rankOf([organic(TARGET)]);
    expect(scan.items[0]).toMatchObject({ imageUrl: `https://m.media-amazon.com/images/I/${TARGET}._AC_UL320_.jpg`, priceText: "$15.99", priceCents: 1599 });
  });
});
