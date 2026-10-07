// @vitest-environment happy-dom
/**
 * Fixtures for the two layouts Amazon alternates between (v0.3.2 regression: v0.3.1 reported
 * Sponsored↑ 1 / Featured↑ 1 on every keyword of the 48-tile layout; stored trace
 * "1:YCYN:O 2:9QP2:O 3:CLYD:O 4:YCYN:F(sspa-link) 5:0003:S(label-class) … 12:0004:O").
 */
import { describe, expect, it } from "vitest";
import { accumulatePage, newRankState, scanSerpPage } from "./serp";

const TARGET = "B0TEST0004";
const GRID = "sg-col-4-of-24 sg-col-4-of-12 s-result-item s-asin sg-col-4-of-16 sg-col s-widget-spacing-small sg-col-4-of-20";
const WIDE = "sg-col-20-of-24 sg-col-16-of-20 sg-col-12-of-16 sg-col-0-of-12";
const org = (n: number) => `B0ORG${String(n).padStart(5, "0")}`;
const adA = (n: number) => `B0ADS${String(n).padStart(5, "0")}`;

const organic = (id: string) => `<div class="${GRID}" data-component-type="s-search-result" data-asin="${id}" data-index="1"><h2><span>${id}</span></h2><img class="s-image" src="https://m.media-amazon.com/images/I/${id}.jpg"><span class="a-price"><span class="a-offscreen">$15.99</span></span></div>`;
const sponsoredTile = (id: string) => `<div class="${GRID} AdHolder" data-component-type="s-search-result" data-asin="${id}"><a class="puis-label-popover"><span class="puis-sponsored-label-text">Sponsored</span></a><a href="/sspa/click?ie=UTF8&url=%2Fdp%2F${id}">p</a><h2><span>Ad ${id}</span></h2></div>`;
const featuredTile = (id: string) => `<div class="${GRID} AdHolder" data-component-type="s-search-result" data-asin="${id}"><span class="a-color-secondary">Featured from Amazon brands</span><a href="/sspa/click?ie=UTF8&url=%2Fdp%2F${id}">p</a><h2><span>Amazon brand ${id}</span></h2></div>`;

/** Top "Sponsored" brand banner (headline/video brand ad, e.g. EDSG tie patches): a full-row result item WITH s-search-result + data-asin + s-asin — v0.3.1 treated any s-search-result as grid. */
const topBrandBanner = `<div class="${WIDE} s-result-item s-asin sg-col AdHolder" data-component-type="s-search-result" data-asin="B0TEST0003"><span class="puis-sponsored-label-text">Sponsored</span><div class="sbv-video"><video></video></div><a href="/sspa/click?brand">EDSG</a></div>`;
/** Same banner without a video element (headline ad image + logo): only the column width tells it apart. */
const headlineBanner = `<div class="${WIDE} s-result-item s-asin sg-col AdHolder" data-component-type="s-search-result" data-asin="B0TEST0003"><span class="puis-sponsored-label-text">Sponsored</span><a href="/sspa/click?brand">EDSG tie patches</a></div>`;
/** Brand video single-product widget: a non-result row wrapping one s-search-result (only an /sspa/ link) — v0.3.1 took nested slots. */
const videoSingleProduct = `<div class="sg-col-20-of-24 s-matching-dir" data-cel-widget="MAIN-VIDEO_SINGLE_PRODUCT-4"><div data-component-type="s-search-result" data-asin="${org(1)}" class="s-asin"><a href="/sspa/click?video">watch</a></div></div>`;
const resultsHeader = `<div class="s-result-item s-widget s-flex-full-width" data-asin=""><h2>Results</h2></div>`;
/** "Featured from Amazon brands" multi-product row (horizontal widget, no a-carousel class) — not grid slots. */
const featuredRow = `<div class="s-result-item ${WIDE} sg-col AdHolder" data-asin=""><span>Featured from Amazon brands</span><div class="_brands-row">${[1, 2, 3, 4].map((n) => `<div data-asin="${adA(900 + n)}"><a href="/sspa/click?row${n}">x</a></div>`).join("")}</div></div>`;

function rank(page: string[]) {
  document.body.innerHTML = `<div class="s-main-slot s-result-list s-search-results sg-row">${page.join("")}</div><a class="s-pagination-next" href="#">Next</a>`;
  const scan = scanSerpPage();
  if (scan.kind !== "ok") throw new Error(scan.kind);
  const state = newRankState();
  accumulatePage(state, scan.items, 1, new Set([TARGET]), { maxOrganic: 100, includeSponsored: false });
  return { scan, hit: state.matches.find((match) => match.asin === TARGET && !match.sponsored)!, trace: state.traces[TARGET] };
}

describe("48-tile layout: top brand banner + organic grid", () => {
  it("reports Sponsored↑ 0 / Featured↑ 0 and keeps organic #12 (v0.3.1: 1/1)", () => {
    const page = [topBrandBanner, resultsHeader, organic(org(1)), organic(org(2)), organic(org(3)), videoSingleProduct, `<div class="s-result-item s-widget" data-asin=""></div>`, headlineBanner, `<div class="s-result-item s-widget" data-asin=""></div>`];
    for (let n = 4; n <= 11; n += 1) page.push(organic(org(n)));
    page.push(organic(TARGET));
    for (let n = 12; n <= 47; n += 1) page.push(organic(org(n)));
    const { scan, hit, trace } = rank(page);
    expect(hit).toMatchObject({ rank: 12, positionOnPage: 12, sponsoredAbove: 0, featuredAbove: 0 });
    expect(scan.layout).toMatchObject({ tiles: 48, organic: 48, sponsored: 0, featured: 0, adNoAsin: 0 });
    expect(trace).not.toMatch(/:S\(|:F\(/);
    // the skipped ads are listed with the reason, for live re-test diagnostics
    expect(scan.layout.adSkipped).toContain("0003:S(label-class+AdHolder+sspa-link)/");
    expect(scan.layout.adSkipped).toContain("/nested");
    expect(scan.layout.gridColumns).toBe("sg-col-4-of-12 sg-col-4-of-16 sg-col-4-of-20 sg-col-4-of-24");
  });
});

describe("60-tile layout: Sponsored and Featured grid tiles", () => {
  it("counts 8 Sponsored + 4 Featured grid tiles above organic #17; banner and Featured row count nowhere", () => {
    // pattern before the hit (S = sponsored tile, F = featured tile, O = organic), modelled on the v0.3.0 '...from daughter' trace
    const before = "FFFFOOOOOOSOOOOSSSSOOOOSSSOO".split(""); // 16 organic, 8 S, 4 F
    const page = [topBrandBanner, resultsHeader];
    let o = 0, a = 0;
    before.forEach((kind, index) => {
      if (index === 12) page.push(featuredRow);
      page.push(kind === "S" ? sponsoredTile(adA(++a)) : kind === "F" ? featuredTile(adA(++a)) : organic(org(++o)));
    });
    page.push(organic(TARGET));
    let extraAds = 0;
    while (o < 47) {
      if (o % 10 === 5 && extraAds < o / 10) { extraAds += 1; page.push(sponsoredTile(adA(++a))); }
      else page.push(organic(org(++o)));
    }
    const { scan, hit } = rank(page);
    expect(hit).toMatchObject({ rank: 17, positionOnPage: 17, sponsoredAbove: 8, featuredAbove: 4 });
    expect(scan.layout.organic).toBe(48);
    expect(scan.layout.featured).toBe(4);
    expect(scan.layout.tiles).toBe(48 + a);
    expect(scan.layout.adSkipped?.split(" ").length).toBe(2); // top banner + Featured row
  });

  it("a single grid tile labelled 'Featured from Amazon brands' is Featured, not organic", () => {
    const { hit, scan } = rank([featuredTile(adA(1)), organic(org(1)), organic(TARGET)]);
    expect(scan.items[0]).toMatchObject({ kind: "featured", sponsored: true });
    expect(hit).toMatchObject({ rank: 2, sponsoredAbove: 0, featuredAbove: 1 });
  });
});
