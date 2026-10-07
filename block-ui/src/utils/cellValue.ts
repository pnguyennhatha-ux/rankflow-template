/**
 * Normalize Bitable open-cell values to primitives.
 * Never invents organic_rank — null/missing stays null.
 */

function segmentText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  if (Array.isArray(v)) {
    const parts = v
      .map((seg) => {
        if (seg == null) return '';
        if (typeof seg === 'string' || typeof seg === 'number') return String(seg);
        if (typeof seg === 'object' && 'text' in (seg as object)) {
          return String((seg as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean);
    return parts.length ? parts.join('') : null;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.name === 'string') return o.name;
  }
  return null;
}

export interface CellUser {
  id: string;
  name: string | null;
}

/** Lark user (人员) cell → first person {id, name}; anything else → null. */
export function asUser(v: unknown): CellUser | null {
  const first = Array.isArray(v) ? v.find((x) => x && typeof x === 'object') : v;
  if (!first || typeof first !== 'object') return null;
  const o = first as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id) return null;
  const name = [o.name, o.enName, o.en_name].find((x) => typeof x === 'string' && x.trim()) as string | undefined;
  return { id, name: name?.trim() ?? null };
}

export function userLabel(u: { id: string; name?: string | null } | null | undefined): string {
  if (!u?.id) return '';
  return u.name?.trim() || u.id;
}

export function asString(v: unknown): string {
  return segmentText(v)?.trim() ?? '';
}

export function asImageUrl(v: unknown): string | null {
  const value = asString(v);
  const markdownUrl = value.match(/^\[[^\]]+\]\((https?:\/\/[^)]+)\)$/i)?.[1];
  const url = markdownUrl ?? value;
  return /^https?:\/\//i.test(url) ? url : null;
}

export function asNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  // Select / formula wrappers sometimes nest value
  if (typeof v === 'object' && v !== null && 'value' in v) {
    return asNumber((v as { value: unknown }).value);
  }
  const t = segmentText(v);
  if (t == null || t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Date field may be ms timestamp or YYYY-MM-DD text. */
export function asDay(v: unknown): string {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
  }
  const s = asString(v);
  // Accept YYYY-MM-DD or ISO prefix
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}
