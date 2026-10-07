import React, { useMemo } from 'react';
import type { RankSnapshot } from '../types';
import { amazonDpUrl } from '../utils/amazon';
import { formatPagePos } from '../utils/pagePos';

export interface TimelineTarget {
  asin: string;
  keyword: string;
}

interface Props {
  target: TimelineTarget;
  rows: RankSnapshot[];
  onClose: () => void;
}

interface TimelinePoint {
  day: string;
  organic_rank: number | null;
  page_number: number | null;
  position_on_page: number | null;
  status: string;
  price_cents: number | null;
}

/** True only for real plotted ranks — never invent. */
function isPlottable(p: TimelinePoint): boolean {
  return (
    p.organic_rank != null &&
    Number.isFinite(p.organic_rank) &&
    p.status !== 'not_found'
  );
}

function RankTimelineChart({
  points,
}: {
  points: TimelinePoint[];
}): React.ReactElement {
  const W = 520;
  const H = 220;
  const pad = { top: 16, right: 16, bottom: 36, left: 40 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const plotted = points.filter(isPlottable);
  const ranks = plotted.map((p) => p.organic_rank as number);
  const minRank = ranks.length ? Math.min(...ranks, 1) : 1;
  const maxRank = ranks.length ? Math.max(...ranks, 1) : 10;
  // Invert Y: rank 1 at top
  const yMin = Math.max(1, minRank);
  const yMax = Math.max(yMin + 1, maxRank);

  const n = Math.max(points.length, 1);
  const xAt = (i: number) =>
    pad.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (rank: number) =>
    pad.top + ((rank - yMin) / (yMax - yMin)) * innerH;

  // Build polyline segments; gaps at null / not_found
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (isPlottable(p)) {
      current.push(`${xAt(i).toFixed(1)},${yAt(p.organic_rank!).toFixed(1)}`);
    } else if (current.length) {
      segments.push(current.join(' '));
      current = [];
    }
  });
  if (current.length) segments.push(current.join(' '));

  const yTicks = Array.from(
    new Set([yMin, Math.round((yMin + yMax) / 2), yMax])
  ).sort((a, b) => a - b);

  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  return (
    <svg
      className="timeline-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Organic rank over time"
    >
      {/* grid + axes */}
      {yTicks.map((t) => (
        <g key={t}>
          <line
            x1={pad.left}
            x2={W - pad.right}
            y1={yAt(t)}
            y2={yAt(t)}
            className="timeline-grid"
          />
          <text
            x={pad.left - 8}
            y={yAt(t) + 4}
            textAnchor="end"
            className="timeline-axis-label"
          >
            #{t}
          </text>
        </g>
      ))}
      <line
        x1={pad.left}
        x2={pad.left}
        y1={pad.top}
        y2={H - pad.bottom}
        className="timeline-axis"
      />
      <line
        x1={pad.left}
        x2={W - pad.right}
        y1={H - pad.bottom}
        y2={H - pad.bottom}
        className="timeline-axis"
      />

      {segments.map((pts, i) => (
        <polyline
          key={i}
          fill="none"
          points={pts}
          className="timeline-line"
        />
      ))}

      {points.map((p, i) => {
        if (!isPlottable(p)) return null;
        return (
          <circle
            key={p.day}
            cx={xAt(i)}
            cy={yAt(p.organic_rank!)}
            r={4}
            className="timeline-dot"
          >
            <title>
              {p.day}: rank {p.organic_rank}
            </title>
          </circle>
        );
      })}

      {points.map((p, i) => {
        if (i % labelEvery !== 0 && i !== points.length - 1) return null;
        return (
          <text
            key={`lbl-${p.day}`}
            x={xAt(i)}
            y={H - 10}
            textAnchor="middle"
            className="timeline-axis-label"
          >
            {p.day.slice(5)}
          </text>
        );
      })}

      {!plotted.length && (
        <text
          x={W / 2}
          y={H / 2}
          textAnchor="middle"
          className="timeline-empty"
        >
          No ranked points in range
        </text>
      )}
    </svg>
  );
}

export function KeywordTimeline({
  target,
  rows,
  onClose,
}: Props): React.ReactElement {
  const points = useMemo((): TimelinePoint[] => {
    return rows
      .filter((r) => r.asin === target.asin && r.keyword === target.keyword)
      .sort((a, b) => a.snapshot_day.localeCompare(b.snapshot_day))
      .map((r) => ({
        day: r.snapshot_day,
        organic_rank: r.organic_rank,
        page_number: r.page_number,
        position_on_page: r.position_on_page,
        status: r.status,
        price_cents: r.price_cents,
      }));
  }, [rows, target.asin, target.keyword]);

  // Deduplicate by day (keep last)
  const byDay = useMemo(() => {
    const m = new Map<string, TimelinePoint>();
    for (const p of points) m.set(p.day, p);
    return Array.from(m.values()).sort((a, b) => a.day.localeCompare(b.day));
  }, [points]);

  return (
    <div
      className="timeline-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <aside
        className="timeline-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Rank timeline for ${target.keyword}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="timeline-panel-header">
          <div>
            <div className="timeline-panel-title">{target.keyword}</div>
            <div className="timeline-panel-sub">
              <a
                href={amazonDpUrl(target.asin)}
                target="_blank"
                rel="noreferrer"
              >
                {target.asin}
              </a>
              <span className="muted"> · rank over time</span>
            </div>
          </div>
          <button
            type="button"
            className="timeline-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <RankTimelineChart points={byDay} />

        <div className="timeline-table-wrap">
          <table className="timeline-table">
            <thead>
              <tr>
                <th>day</th>
                <th>rank</th>
                <th>position_on_page</th>
                <th>status</th>
                <th>price_cents</th>
              </tr>
            </thead>
            <tbody>
              {byDay.map((p) => (
                <tr key={p.day}>
                  <td>{p.day}</td>
                  <td>
                    {isPlottable(p) ? p.organic_rank : '—'}
                  </td>
                  <td>
                    {formatPagePos(p.page_number, p.position_on_page) ?? '—'}
                  </td>
                  <td>{p.status || '—'}</td>
                  <td>{p.price_cents == null ? '—' : p.price_cents}</td>
                </tr>
              ))}
              {!byDay.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    No snapshot rows for this ASIN × keyword
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </aside>
    </div>
  );
}
