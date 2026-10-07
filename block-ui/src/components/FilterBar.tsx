import React, { useEffect, useMemo, useState } from 'react';
import type { FilterState } from '../types';
import { LEGEND } from '../utils/rankColor';
import { amazonDpUrl } from '../utils/amazon';
import { DateRangePicker } from './DateRangePicker';

interface Props {
  allAsins: string[];
  asinImages: Map<string, string>;
  filters: FilterState;
  onChange: (next: FilterState) => void;
  mode: 'bitable' | 'unavailable';
  rowCount: number;
  minDay: string;
  maxDay: string;
  /** Distinct owners in the snapshot rows (snapshot.owner / watchlist_item.owner). */
  owners?: Array<{ id: string; label: string }>;
}

interface ContainsDraft {
  asinContains: string;
  keywordContains: string;
  groupContains: string;
}

export function FilterBar({
  allAsins,
  asinImages,
  filters,
  onChange,
  mode,
  rowCount,
  minDay,
  maxDay,
  owners = [],
}: Props): React.ReactElement {
  const [draft, setDraft] = useState<ContainsDraft>({
    asinContains: filters.asinContains,
    keywordContains: filters.keywordContains,
    groupContains: filters.groupContains,
  });


  // Sync draft when parent clears / updates contains filters externally
  useEffect(() => {
    setDraft({
      asinContains: filters.asinContains,
      keywordContains: filters.keywordContains,
      groupContains: filters.groupContains,
    });
  }, [
    filters.asinContains,
    filters.keywordContains,
    filters.groupContains,
  ]);

  const applyContains = () => {
    onChange({
      ...filters,
      asinContains: draft.asinContains,
      keywordContains: draft.keywordContains,
      groupContains: draft.groupContains,
    });
  };

  const clearContains = () => {
    const empty: ContainsDraft = {
      asinContains: '',
      keywordContains: '',
      groupContains: '',
    };
    setDraft(empty);
    onChange({
      ...filters,
      ...empty,
      asins: [],
      ownerId: '',
    });
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyContains();
    }
  };

  // Chip list visibility uses applied asinContains (or all if empty)
  const visibleAsins = useMemo(() => {
    const q = filters.asinContains.trim().toLowerCase();
    if (!q) return allAsins;
    return allAsins.filter((a) => a.toLowerCase().includes(q));
  }, [allAsins, filters.asinContains]);

  const toggleAsin = (asin: string) => {
    const set = new Set(filters.asins);
    if (set.has(asin)) set.delete(asin);
    else set.add(asin);
    onChange({ ...filters, asins: Array.from(set).sort() });
  };

  return (
    <div className="filter-bar">
      <div className="filter-search-row">
        <input
          type="search"
          className="filter-input"
          placeholder="ASIN contains…"
          value={draft.asinContains}
          onChange={(e) =>
            setDraft((d) => ({ ...d, asinContains: e.target.value }))
          }
          onKeyDown={onSearchKeyDown}
          aria-label="ASIN contains"
        />
        <input
          type="search"
          className="filter-input"
          placeholder="Keyword contains…"
          value={draft.keywordContains}
          onChange={(e) =>
            setDraft((d) => ({ ...d, keywordContains: e.target.value }))
          }
          onKeyDown={onSearchKeyDown}
          aria-label="Keyword contains"
        />
        <input
          type="search"
          className="filter-input"
          placeholder="Group / watchlist contains…"
          value={draft.groupContains}
          onChange={(e) =>
            setDraft((d) => ({ ...d, groupContains: e.target.value }))
          }
          onKeyDown={onSearchKeyDown}
          aria-label="Group / watchlist contains"
        />
        {owners.length > 0 && (
          <select
            className="filter-input filter-owner"
            value={filters.ownerId}
            onChange={(e) => onChange({ ...filters, ownerId: e.target.value })}
            aria-label="Owner"
            title="Owner (cột owner)"
          >
            <option value="">Owner: tất cả</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                Owner: {o.label}
              </option>
            ))}
            <option value="-">Owner: (trống)</option>
          </select>
        )}
        <button
          type="button"
          className="btn-primary"
          onClick={applyContains}
        >
          Lọc
        </button>
        <span className="muted filter-enter-hint">Enter</span>
        <button type="button" className="btn-clear" onClick={clearContains}>
          Xóa
        </button>
      </div>

      <div className="filter-row">
        <label className="filter-label">ASIN</label>
        <div className="asin-chips">
          <button
            type="button"
            className={`chip ${filters.asins.length === 0 ? 'active' : ''}`}
            onClick={() => onChange({ ...filters, asins: [] })}
          >
            Tất cả
          </button>
          {visibleAsins.map((a) => (
            <button
              key={a}
              type="button"
              className={`chip ${filters.asins.includes(a) ? 'active' : ''}`}
              onClick={() => toggleAsin(a)}
            >
              {asinImages.get(a) ? (
                <img className="chip-thumb" src={asinImages.get(a)} alt="" />
              ) : (
                <div className="chip-thumb placeholder" aria-hidden="true" />
              )}
              <a
                href={amazonDpUrl(a)}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                {a}
              </a>
            </button>
          ))}
          {visibleAsins.length === 0 && (
            <span className="muted">No ASIN match</span>
          )}
        </div>
      </div>

      <div className="filter-row filter-row-compact">
        <label className="filter-label">Date range</label>
        <DateRangePicker
          from={filters.dateFrom}
          to={filters.dateTo}
          minDay={minDay}
          maxDay={maxDay}
          onApply={({ from, to }) => onChange({ ...filters, dateFrom: from, dateTo: to })}
        />
        {(minDay || maxDay) && (
          <span className="muted date-bounds" title="Data snapshot_day bounds">
            data {minDay || '?'} → {maxDay || '?'}
          </span>
        )}

        <label className="toggle">
          <input
            type="checkbox"
            checked={filters.onlyRankedKw}
            onChange={(e) =>
              onChange({ ...filters, onlyRankedKw: e.target.checked })
            }
          />
          <span>chỉ KW có rank</span>
        </label>

        <span className="muted meta">
          {rowCount} snapshot rows · source:{' '}
          <strong className={mode === 'unavailable' ? 'demo-tag' : ''}>
            {mode === 'unavailable' ? 'không kết nối' : 'bitable snapshot'}
          </strong>
        </span>
      </div>

      <div className="legend">
        {LEGEND.map((l) => (
          <span key={l.text} className="legend-item">
            <span
              className="legend-swatch"
              style={{ background: l.swatch }}
            />
            {l.text}
          </span>
        ))}
      </div>
    </div>
  );
}
