import { describe, expect, it } from "vitest";
import type { DirectRankRow } from "./rank";
import { createDirectRankXlsx } from "./xlsx-export";

describe("createDirectRankXlsx", () => {
  it("creates a valid XLSX container with typed ranking data", async () => {
    const row: DirectRankRow = {groupId:"g1",groupName:"Grandma Mugs",keyword:"grandma mug",asin:"B0TEST0002",snapshotDay:"2026-09-22",scanDepth:190,organicRank:43,sponsoredRank:null,pageNumber:1,positionOnPage:43,status:"ranked",title:"Grandma Mug",imageUrl:"https://images.example/mug.jpg",priceText:"$19.99",priceCents:1999,currency:"USD"};
    const blob = createDirectRankXlsx([row]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const decoded = new TextDecoder().decode(bytes);
    expect([...bytes.slice(0,4)]).toEqual([0x50,0x4b,0x03,0x04]);
    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(decoded).toContain("xl/worksheets/sheet1.xml");
    expect(decoded).toContain("snapshot_day");
    expect(decoded).toContain("B0TEST0002");
    expect(decoded).toContain("https://www.amazon.com/dp/B0TEST0002");
    expect(decoded).toContain('<c r="B2"><v>190</v></c>');
    expect(decoded).toContain('<c r="L2"><v>43</v></c>');
  });
});
