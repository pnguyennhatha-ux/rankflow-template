import React, { useMemo, useState } from 'react';
import type { CellDetail, FilterState, RankSnapshot } from '../types';
import {
  applyFilters,
  buildPivot,
  cellKey,
  type PivotCell,
} from '../utils/pivot';
import { rankStyle } from '../utils/rankColor';
import { amazonDpUrl } from '../utils/amazon';
import { formatPagePos } from '../utils/pagePos';
import {
  KeywordTimeline,
  type TimelineTarget,
} from './KeywordTimeline';

interface Props {
  rows: RankSnapshot[];
  filters: FilterState;
  onCellClick: (detail: CellDetail) => void;
  /** Jump to "Bộ key" page and scroll to the group holding this ASIN. */
  onEditAsin?: (asin: string) => void;
}

export function HeatmapGrid({
  rows,
  filters,
  onCellClick,
  onEditAsin,
}: Props): React.ReactElement {
  const pivot = buildPivot(rows, filters);
  const filteredRows = useMemo(
    () => applyFilters(rows, filters),
    [rows, filters]
  );
  const [timeline, setTimeline] = useState<TimelineTarget | null>(null);

  if (!pivot.asinGroups.length || !pivot.days.length) {
    return (
      <div className="empty">
        Không có dữ liệu khớp filter (không invent rank).
      </div>
    );
  }

  const handleCell = (
    asin: string,
    keyword: string,
    day: string,
    cell: PivotCell | undefined
  ) => {
    onCellClick({
      keyword,
      snapshot_day: day,
      asin: cell?.asin ?? asin,
      organic_rank: cell?.organic_rank ?? null,
      page_number: cell?.page_number ?? null,
      position_on_page: cell?.position_on_page ?? null,
      status: cell?.status ?? '—',
      price_cents: cell?.price_cents ?? null,
      image_url: cell?.image_url ?? null,
      run_id: cell?.run_id ?? '',
    });
  };

  const dayColSpan = pivot.days.length;

  return (
    <>
      <div className="grid-wrap">
        <table className="heatmap">
          <thead>
            <tr>
              <th className="sticky-col">keyword</th>
              {pivot.days.map((d) => (
                <th key={d}>{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pivot.asinGroups.map((group) => (
              <React.Fragment key={group.asin}>
                <tr className="asin-group-header">
                  <td className="sticky-col asin-group-cell" colSpan={1}>
                    <div className="asin-group-row">
                      {group.image_url ? (
                        <img
                          className="kw-thumb"
                          src={group.image_url}
                          alt=""
                        />
                      ) : (
                        <div
                          className="kw-thumb placeholder"
                          aria-hidden="true"
                        />
                      )}
                      <div className="asin-group-meta">
                        <a
                          className="asin-group-link"
                          href={amazonDpUrl(group.asin)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {group.asin}
                        </a>
                        {onEditAsin && (
                          <button
                            type="button"
                            className="asin-edit-btn"
                            title="Sửa trong Bộ key"
                            onClick={() => onEditAsin(group.asin)}
                          >
                            ✎ Bộ key
                          </button>
                        )}
                        {group.groups.length > 0 && (
                          <span className="asin-group-name" title="Nhóm (watchlist_item.group)">
                            {group.groups.join(' · ')}
                          </span>
                        )}
                        {group.owners.length > 0 && (
                          <span className="asin-owner-name" title="Owner (snapshot.owner / watchlist_item.owner)">
                            👤 {group.owners.join(' · ')}
                          </span>
                        )}
                        <span className="asin-group-count">
                          {group.keywords.length} KW
                        </span>
                      </div>
                    </div>
                  </td>
                  <td
                    className="asin-group-spacer"
                    colSpan={dayColSpan}
                    aria-hidden="true"
                  />
                </tr>
                {group.keywords.map((kw) => (
                  <tr key={`${group.asin}||${kw}`}>
                    <td className="sticky-col kw">
                      <div className="kw-row kw-row-only">
                        <div className="kw-meta">
                          <button
                            type="button"
                            className="kw-text kw-text-btn"
                            title={`Open rank timeline · ${group.asin}`}
                            onClick={() =>
                              setTimeline({ asin: group.asin, keyword: kw })
                            }
                          >
                            {kw}
                          </button>
                          {group.keywordOwners[kw] && group.owners.length > 1 && (
                            <span className="kw-owner" title="Owner">
                              👤 {group.keywordOwners[kw]}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    {pivot.days.map((day) => {
                      const cell = pivot.cells.get(
                        cellKey(group.asin, kw, day)
                      );
                      const style = rankStyle(
                        cell?.organic_rank ?? null,
                        cell?.status ?? 'not_found'
                      );
                      const display =
                        cell?.organic_rank == null
                          ? '—'
                          : String(cell.organic_rank);
                      const pagePosition = formatPagePos(
                        cell?.page_number ?? null,
                        cell?.position_on_page ?? null
                      );
                      return (
                        <td key={day} className="cell-td">
                          <button
                            type="button"
                            className="rank-cell"
                            style={{
                              background: style.background,
                              color: style.color,
                            }}
                            title={`${kw} · ${day}`}
                            onClick={() =>
                              handleCell(group.asin, kw, day, cell)
                            }
                          >
                            <span>{display}</span>
                            {pagePosition && (
                              <span className="rank-cell-subtitle">
                                {pagePosition}
                              </span>
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {timeline && (
        <KeywordTimeline
          target={timeline}
          rows={filteredRows}
          onClose={() => setTimeline(null)}
        />
      )}
    </>
  );
}
