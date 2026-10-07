import React, { useEffect, useState } from 'react';
import { formatIct, type RunStatus } from '../data/runStatus';
import { isActive, type RunRequest } from '../data/runRequest';
import { daysLabelVi, formatNextRun, formatNextRunFull, nextRun, TIME_RE } from '../utils/schedule';

interface Props {
  status: RunStatus | null;
  loading: boolean;
  onRefresh: () => void;
  /** v0.2.4 'Chạy ngay' */
  request: RunRequest | null;
  onRunNow: () => void;
  runNowBusy: boolean;
  runNowError: string | null;
}

const REQ_LABEL: Record<string, string> = {
  pending: 'đang chờ',
  claimed: 'đang chờ',
  running: 'đang chạy',
  done: 'xong',
  failed: 'lỗi',
  cancelled: 'đã hủy',
};

function RequestChip({ r }: { r: RunRequest }): React.ReactElement {
  const label = REQ_LABEL[r.status] ?? r.status;
  const when =
    r.status === 'running' ? r.startedAt ?? r.requestedAt : r.finishedAt ?? r.startedAt ?? r.requestedAt;
  const cls =
    r.status === 'failed' ? 'rq-failed' : r.status === 'done' ? 'rq-done' : isActive(r) ? 'rq-active' : 'rq-muted';
  const extra = r.status === 'done' && r.resultStatus ? ` · ${r.resultStatus}` : '';
  const title = [r.requestId, r.runId && `run ${r.runId}`, r.note].filter(Boolean).join(' · ');
  return (
    <span className={`rq-chip ${cls}`} title={title}>
      Yêu cầu: <b>{label}</b>
      {extra} · {formatIct(when)}
      {r.runId ? <span className="rq-run"> · {r.runId}</span> : null}
    </span>
  );
}

const STATUS_LABEL: Record<string, string> = {
  success: 'success',
  ok: 'success',
  running: 'đang chạy',
  partial: 'partial',
  failed: 'failed',
  pending: 'pending',
};

const n = (v: number | null) => (v == null ? '—' : String(v));

/** 'Lần tới' from structured schedule_* fields (fallback: schedule_note text). */
function NextRun({ status, now }: { status: RunStatus; now: number }): React.ReactElement {
  const s = status.schedule;
  if (!s) {
    return (
      <span title="Chưa có schedule_enabled / schedule_days / schedule_time">
        Lần tới: <b>{status.scheduleNote || '—'}</b>
      </span>
    );
  }
  const rule = `${daysLabelVi(s.days)} ${s.time || '—'} ICT`;
  if (!s.enabled) {
    return (
      <span title={`Lịch đang tắt (${rule}) — chỉ chạy khi bấm Chạy ngay`}>
        Lần tới: <b className="rs-muted">tắt lịch</b>
      </span>
    );
  }
  const next = nextRun(s, now);
  const invalid = !TIME_RE.test(s.time) || !s.days.length;
  return (
    <span title={next ? `${formatNextRunFull(next)} · lịch ${rule}` : `Lịch không hợp lệ: ${rule}`}>
      Lần tới: <b className={invalid ? 'rs-failed' : undefined}>{next ? formatNextRun(next) : '—'}</b>
      <span className="rs-muted"> · {rule}</span>
    </span>
  );
}

/** Compact latest-run line shown above both tabs (Heatmap | Bộ key). */
export function RunStatusLine({
  status,
  loading,
  onRefresh,
  request,
  onRunNow,
  runNowBusy,
  runNowError,
}: Props): React.ReactElement {
  // re-evaluate 'Lần tới' every minute
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  if (!status) {
    return (
      <div className="run-status" aria-live="polite">
        <span className="rs-muted">{loading ? 'Đang tải trạng thái lần chạy…' : 'Chưa có trạng thái lần chạy.'}</span>
      </div>
    );
  }
  const st = (status.status || '').toLowerCase();
  const failedPairs = status.pairsFailed ?? 0;
  const level =
    st === 'failed' ? 'danger' : st === 'partial' || failedPairs > 0 ? 'warn' : st === 'running' ? 'info' : 'ok';
  const label = st ? STATUS_LABEL[st] ?? st : '—';
  const icon = level === 'danger' ? '⛔' : level === 'warn' ? '⚠' : level === 'info' ? '⏳' : '●';
  return (
    <div className={`run-status rs-${level}`} role={level === 'danger' || level === 'warn' ? 'alert' : 'status'}>
      <span className="rs-main">
        <span className="rs-icon" aria-hidden>
          {icon}
        </span>
        Lần chạy gần nhất: <b>{formatIct(status.runAt)}</b> · <b className="rs-state">{label}</b> ·{' '}
        <b>
          {n(status.pairsFound)}/{n(status.pairsTotal)}
        </b>{' '}
        cặp
        {failedPairs > 0 && (
          <>
            {' '}
            · <b className="rs-failed">{failedPairs} lỗi/bị chặn</b>
          </>
        )}
        {status.pairsNotFound != null && (
          <span className="rs-muted"> · ngoài Top: {status.pairsNotFound}</span>
        )}
      </span>
      <span className="rs-sep">|</span>
      <NextRun status={status} now={now} />
      <span className="rs-sep">|</span>
      <span className="rs-muted" title="pull_base_to_db.py — Bộ key Base → DB">
        Pull Base: {formatIct(status.lastPulledAt)}
      </span>
      {status.mode === 'unavailable' && <span className="rs-demo">BASE KHÔNG KHẢ DỤNG</span>}
      {request ? (
        <RequestChip r={request} />
      ) : (
        <span className="rq-chip rq-muted" title="Chưa có yêu cầu Chạy ngay">
          Yêu cầu: <b>idle</b>
        </span>
      )}
      <button
        type="button"
        className="rs-run-now"
        onClick={onRunNow}
        disabled={status.mode !== 'bitable' || runNowBusy || isActive(request)}
        title={
          status.mode !== 'bitable'
            ? 'DEMO — không gửi yêu cầu'
            : isActive(request)
              ? 'Đã có yêu cầu đang chờ / đang chạy'
              : 'Gửi yêu cầu chạy ngay → Base run_request (pending). backend nhận yêu cầu.'
        }
      >
        {runNowBusy ? 'Đang gửi…' : '▶ Chạy ngay'}
      </button>
      <button type="button" className="rs-refresh" onClick={onRefresh} disabled={loading} title="Tải lại trạng thái">
        ↻
      </button>
      {runNowError && <div className="rs-error rs-err-strong">Không gửi được yêu cầu: {runNowError}</div>}
      {status.error && (level === 'danger' || level === 'warn') && (
        <div className="rs-error" title={status.error}>
          Lỗi: {status.error}
        </div>
      )}
      {status.mode === 'bitable' && status.loadError && (
        <div className="rs-error rs-muted">Không đọc được: {status.loadError}</div>
      )}
    </div>
  );
}
