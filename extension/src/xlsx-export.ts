import { positionLabel, type DirectRankRow } from "./rank";

const encoder = new TextEncoder();

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function columnName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function cellXml(value: string | number | null | undefined, row: number, column: number, header = false) {
  const reference = `${columnName(column)}${row}`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"${header?' s="1"':""}><v>${value}</v></c>`;
  const text = escapeXml(String(value ?? ""));
  return `<c r="${reference}" t="inlineStr"${header?' s="1"':""}><is><t xml:space="preserve">${text}</t></is></c>`;
}

function uint16(value: number) {
  return new Uint8Array([value & 255, (value >>> 8) & 255]);
}

function uint32(value: number) {
  return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
}

function concat(parts: Uint8Array[]) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<{ name: string; content: string }>) {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.content);
    const checksum = crc32(data);
    const local = concat([uint32(0x04034b50),uint16(20),uint16(0x0800),uint16(0),uint16(0),uint16(0),uint32(checksum),uint32(data.length),uint32(data.length),uint16(name.length),uint16(0),name,data]);
    localParts.push(local);
    centralParts.push(concat([uint32(0x02014b50),uint16(20),uint16(20),uint16(0x0800),uint16(0),uint16(0),uint16(0),uint32(checksum),uint32(data.length),uint32(data.length),uint16(name.length),uint16(0),uint16(0),uint16(0),uint16(0),uint32(0),uint32(offset),name]));
    offset += local.length;
  }
  const central = concat(centralParts);
  const end = concat([uint32(0x06054b50),uint16(0),uint16(0),uint16(entries.length),uint16(entries.length),uint32(central.length),uint32(offset),uint16(0)]);
  return concat([...localParts, central, end]);
}

const headers = ["snapshot_day","scan_depth","group","keyword","asin","amazon_url","title","image_url","price","price_cents","currency","organic_rank","sponsored_rank","page","position","position_label","sponsored_above","status","note","owner"];

export function createDirectRankXlsx(rows: DirectRankRow[]) {
  const values: Array<Array<string | number | null | undefined>> = [headers, ...rows.map((row) => [
    row.snapshotDay,row.scanDepth,row.groupName,row.keyword,row.asin,`https://www.amazon.com/dp/${row.asin}`,row.title,row.imageUrl,row.priceText,row.priceCents,row.currency,row.organicRank,row.sponsoredRank,row.pageNumber,row.positionOnPage,positionLabel(row),row.sponsoredAbove,row.status,row.note,row.ownerName || row.ownerId || ""
  ])];
  const sheetRows = values.map((row, rowIndex) => `<row r="${rowIndex+1}">${row.map((value,columnIndex)=>cellXml(value,rowIndex+1,columnIndex,rowIndex===0)).join("")}</row>`).join("");
  const lastCell = `${columnName(headers.length-1)}${Math.max(1,values.length)}`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastCell}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="14" customWidth="1"/><col min="2" max="2" width="11" customWidth="1"/><col min="3" max="5" width="20" customWidth="1"/><col min="6" max="8" width="34" customWidth="1"/><col min="9" max="${headers.length}" width="16" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${columnName(headers.length-1)}${Math.max(1,values.length)}"/></worksheet>`;
  const entries = [
    {name:"[Content_Types].xml",content:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`},
    {name:"_rels/.rels",content:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
    {name:"xl/workbook.xml",content:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Rankings" sheetId="1" r:id="rId1"/></sheets></workbook>`},
    {name:"xl/_rels/workbook.xml.rels",content:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
    {name:"xl/styles.xml",content:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2868ED"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`},
    {name:"xl/worksheets/sheet1.xml",content:sheet}
  ];
  return new Blob([zip(entries)], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}
