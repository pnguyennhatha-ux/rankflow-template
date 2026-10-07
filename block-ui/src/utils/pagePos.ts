import { asString } from './cellValue';

/** Display format: "#7 P2" (position on page + page). Never invent values. */
export function formatPagePos(
  page_number: number | null | undefined,
  position_on_page: number | null | undefined
): string | null {
  if (
    page_number == null ||
    position_on_page == null ||
    !Number.isFinite(page_number) ||
    !Number.isFinite(position_on_page)
  ) {
    return null;
  }
  return `#${position_on_page} P${page_number}`;
}

/** Parse Base Text "#7 P2" (incl. Bitable segment arrays) or legacy numbers. */
export function parsePagePos(raw: unknown): {
  page_number: number | null;
  position_on_page: number | null;
  label: string | null;
} {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { page_number: null, position_on_page: raw, label: null };
  }
  const text = asString(raw);
  if (text) {
    const m = text.match(/^#\s*(\d+)\s*P\s*(\d+)$/i);
    if (m) {
      const position_on_page = Number(m[1]);
      const page_number = Number(m[2]);
      return {
        page_number,
        position_on_page,
        label: formatPagePos(page_number, position_on_page),
      };
    }
  }
  return { page_number: null, position_on_page: null, label: null };
}
