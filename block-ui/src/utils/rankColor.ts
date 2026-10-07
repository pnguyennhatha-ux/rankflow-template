/**
 * Heatmap colors (bot spec):
 * #1–10 dark green · 11–50 green · 51–190 yellow · ngoài/null gray · unverified_* light red
 * Display only — never invents ranks.
 */

export interface RankStyle {
  background: string;
  color: string;
  label: string;
}

const GRAY: RankStyle = {
  background: '#E8E8E8',
  color: '#666666',
  label: '—',
};

const LIGHT_RED: RankStyle = {
  background: '#FECACA',
  color: '#7F1D1D',
  label: '?',
};

const DARK_GREEN: RankStyle = {
  background: '#14532D',
  color: '#FFFFFF',
  label: '',
};

const GREEN: RankStyle = {
  background: '#4ADE80',
  color: '#14532D',
  label: '',
};

const YELLOW: RankStyle = {
  background: '#FDE047',
  color: '#713F12',
  label: '',
};

export function rankStyle(
  organic_rank: number | null,
  status: string
): RankStyle {
  const st = (status || '').toLowerCase();
  if (st.startsWith('unverified')) {
    return {
      ...LIGHT_RED,
      label: organic_rank != null ? String(organic_rank) : 'uv',
    };
  }

  if (
    organic_rank == null ||
    st === 'not_found' ||
    !Number.isFinite(organic_rank)
  ) {
    return GRAY;
  }

  const r = organic_rank;
  if (r >= 1 && r <= 10) {
    return { ...DARK_GREEN, label: String(r) };
  }
  if (r >= 11 && r <= 50) {
    return { ...GREEN, label: String(r) };
  }
  if (r >= 51 && r <= 190) {
    return { ...YELLOW, label: String(r) };
  }
  // ngoài Top N (rank > 190) → gray
  return { ...GRAY, label: String(r) };
}

export const LEGEND: { swatch: string; text: string }[] = [
  { swatch: DARK_GREEN.background, text: '#1–10' },
  { swatch: GREEN.background, text: '#11–50' },
  { swatch: YELLOW.background, text: '#51–190' },
  { swatch: GRAY.background, text: 'ngoài / null / not_found' },
  { swatch: LIGHT_RED.background, text: 'unverified_*' },
];
