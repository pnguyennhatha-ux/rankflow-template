import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CellDetailToast } from './components/CellDetailToast';
import { FilterBar } from './components/FilterBar';
import { HeatmapGrid } from './components/HeatmapGrid';
import { KeySetPage } from './components/KeySetPage';
import { RunStatusLine } from './components/RunStatusLine';
import { BASE_URL, BLOCK_TYPE_ID, SNAPSHOT_TABLE_ID } from './config';
import { loadSnapshots, showDetailToast } from './data/loadSnapshots';
import { loadRunStatus, type RunStatus } from './data/runStatus';
import { createRunRequest, isActive, loadLatestRequest, type RunRequest } from './data/runRequest';
import type { CellDetail, FilterState, LoadResult, ThemeMode } from './types';
import { nextDateRange, ownerOptions } from './utils/pivot';
import './styles/app.css';

const THEME_KEY = 'rank-track-theme';

type Page = 'heatmap' | 'keyset';

const initialFilters: FilterState = {
  asins: [],
  dateFrom: '',
  dateTo: '',
  onlyRankedKw: false,
  asinContains: '',
  keywordContains: '',
  groupContains: '',
  ownerId: '',
};

function readStoredTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // ignore
  }
  return 'dark';
}

function dayBounds(rows: { snapshot_day: string }[]): {
  minDay: string;
  maxDay: string;
} {
  let minDay = '';
  let maxDay = '';
  for (const r of rows) {
    const d = r.snapshot_day;
    if (!d) continue;
    if (!minDay || d < minDay) minDay = d;
    if (!maxDay || d > maxDay) maxDay = d;
  }
  return { minDay, maxDay };
}

export default function App(): React.ReactElement {
  const [data, setData] = useState<LoadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [detail, setDetail] = useState<CellDetail | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(readStoredTheme);
  // '#keyset' opens the Bộ key page directly (handy for local demo/screenshots)
  const initialPage: Page =
    typeof window !== 'undefined' && window.location.hash === '#keyset' ? 'keyset' : 'heatmap';
  const [page, setPage] = useState<Page>(initialPage);
  const [keysetMounted, setKeysetMounted] = useState(initialPage === 'keyset');
  const [focus, setFocus] = useState<{ asin: string; nonce: number } | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [runStatusLoading, setRunStatusLoading] = useState(true);

  const [runRequest, setRunRequest] = useState<RunRequest | null>(null);
  const [runNowBusy, setRunNowBusy] = useState(false);
  const [runNowError, setRunNowError] = useState<string | null>(null);

  const reloadRunStatus = useCallback(() => {
    setRunStatusLoading(true);
    const st = loadRunStatus()
      .then((s) => {
        setRunStatus(s);
        return s;
      })
      .catch(() => {
        setRunStatus(null);
        return null;
      });
    st.then((s) =>
      s && s.mode === 'bitable'
        ? loadLatestRequest()
            .then(setRunRequest)
            .catch(() => undefined) // run_request table optional
        : setRunRequest(null)
    ).finally(() => setRunStatusLoading(false));
  }, []);

  useEffect(() => {
    reloadRunStatus();
  }, [reloadRunStatus]);

  // While a request is pending/running: refresh the status line every 30 s.
  const requestActive = isActive(runRequest);
  useEffect(() => {
    if (!requestActive) return undefined;
    const t = window.setInterval(reloadRunStatus, 30_000);
    return () => window.clearInterval(t);
  }, [requestActive, reloadRunStatus]);

  const onRunNow = useCallback(async () => {
    setRunNowBusy(true);
    setRunNowError(null);
    try {
      await createRunRequest();
      reloadRunStatus();
    } catch (e) {
      setRunNowError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunNowBusy(false);
    }
  }, [reloadRunStatus]);

  const openKeySet = useCallback((asin?: string) => {
    setKeysetMounted(true);
    setPage('keyset');
    if (asin) setFocus({ asin, nonce: Date.now() });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  // Bounds of the previous load: a range that still ends on the old last day follows new days after a reload.
  const lastBounds = useRef<{ minDay: string; maxDay: string }>({ minDay: '', maxDay: '' });
  const reload = useCallback(() => {
    setLoading(true);
    loadSnapshots()
      .then((result) => {
        setData(result);
        const { minDay, maxDay } = dayBounds(result.rows);
        const prev = lastBounds.current;
        if (minDay && maxDay) {
          lastBounds.current = { minDay, maxDay };
          setFilters((f) => nextDateRange(f, prev, { minDay, maxDay }));
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // A request just finished (active → done/failed) → reload the heatmap once to show the new snapshots.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !requestActive) reload();
    wasActive.current = requestActive;
  }, [requestActive, reload]);

  const owners = useMemo(() => ownerOptions(data?.rows ?? []), [data]);
  const allAsins = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.rows.map((r) => r.asin))).sort();
  }, [data]);

  const { minDay, maxDay } = useMemo(
    () => dayBounds(data?.rows ?? []),
    [data],
  );

  const asinImages = useMemo(() => {
    const images = new Map<string, string>();
    for (const row of data?.rows ?? []) {
      if (row.image_url && !images.has(row.asin)) {
        images.set(row.asin, row.image_url);
      }
    }
    return images;
  }, [data]);

  const onCellClick = useCallback(async (d: CellDetail) => {
    setDetail(d);
    try {
      await showDetailToast(d);
    } catch {
      // local toast already showing via setDetail
    }
  }, []);

  const toggleTheme = () =>
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return (
    <div className="app" data-theme={theme}>
      <header className="header">
        <div className="header-left">
          <div className="title-row">
            <h1>Rank Track</h1>
            <nav className="tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={page === 'heatmap'}
                className={page === 'heatmap' ? 'tab active' : 'tab'}
                onClick={() => setPage('heatmap')}
              >
                Heatmap
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={page === 'keyset'}
                className={page === 'keyset' ? 'tab active' : 'tab'}
                onClick={() => openKeySet()}
              >
                Bộ key
              </button>
            </nav>
          </div>
          <p className="sub">
            Table View Extension · snapshot{' '}
            <code>{SNAPSHOT_TABLE_ID}</code> · BlockTypeID{' '}
            <code>{BLOCK_TYPE_ID}</code>
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            title="Toggle light / dark"
          >
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
          <a href={BASE_URL} target="_blank" rel="noreferrer">
            Open Base
          </a>
          {page === 'heatmap' && (
            <button
              type="button"
              onClick={() => {
                reload();
                reloadRunStatus();
              }}
              disabled={loading}
            >
              Refresh
            </button>
          )}
        </div>
      </header>

      <RunStatusLine
        status={runStatus}
        loading={runStatusLoading}
        onRefresh={reloadRunStatus}
        request={runRequest}
        onRunNow={onRunNow}
        runNowBusy={runNowBusy}
        runNowError={runNowError}
      />

      <div className="page" hidden={page !== 'heatmap'}>
      {data?.mode === 'unavailable' && (
        <div className="demo-banner" role="alert">
          <strong>KHÔNG CÓ DỮ LIỆU LIVE</strong> — {data.error}{' '}
          <a href={BASE_URL} target="_blank" rel="noreferrer">Mở Base đúng</a>
        </div>
      )}

      {loading && <div className="loading">Loading snapshot…</div>}

      {!loading && data?.mode === 'bitable' && (
        <>
          <FilterBar
            allAsins={allAsins}
            asinImages={asinImages}
            filters={filters}
            onChange={setFilters}
            mode={data.mode}
            rowCount={data.rows.length}
            minDay={minDay}
            maxDay={maxDay}
            owners={owners}
          />
          <HeatmapGrid
            rows={data.rows}
            filters={filters}
            onCellClick={onCellClick}
            onEditAsin={openKeySet}
          />
        </>
      )}
      </div>

      {keysetMounted && (
        <div className="page" hidden={page !== 'keyset'}>
          <KeySetPage focus={focus} active={page === 'keyset'} onSaved={reloadRunStatus} request={runRequest} onRunNow={onRunNow} runNowBusy={runNowBusy} runNowError={runNowError} bitableMode={runStatus?.mode === 'bitable'} />
        </div>
      )}

      <CellDetailToast detail={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
