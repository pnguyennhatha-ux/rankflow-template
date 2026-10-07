import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  checkWritePermission,
  computeDiff,
  formatSaveError,
  groupsFromItems,
  hasChanges,
  loadKeySet,
  newUid,
  pairKey,
  parseGroup,
  saveDiff,
  settingsErrors,
  tidyLines,
  type GroupDraft,
  type KeySetData,
  type KeySetDiff,
  type PairRef,
  type SettingsDraft,
} from '../data/keyset';
import {
  DAY_LONG_VI,
  DAY_SHORT_VI,
  DAY_TOKENS,
  formatNextRun,
  formatNextRunFull,
  nextRun,
  scheduleErrors,
  type DayToken,
} from '../utils/schedule';
import { formatIct } from '../data/runStatus';
import { isActive, type RunRequest } from '../data/runRequest';
import { DEFAULT_TOP_N, ORG_LABEL } from '../config';
import { OwnerPicker } from './OwnerPicker';

interface Props {
  /** ASIN to scroll to (from Heatmap); nonce forces re-scroll on repeat clicks. */
  focus: { asin: string; nonce: number } | null;
  active: boolean;
  /** called after a successful save (App reloads the status line → 'Lần tới'). */
  onSaved?: () => void;
  /** v0.2.4 Chạy ngay — shared with status line */
  request?: RunRequest | null;
  onRunNow?: () => void;
  runNowBusy?: boolean;
  runNowError?: string | null;
  bitableMode?: boolean;
}

type Toast = { kind: 'ok' | 'err' | 'info'; text: string } | null;

function settingsFrom(data: KeySetData): SettingsDraft {
  return {
    top: String(data.settings.top_n),
    zipOn: !!data.settings.zip,
    zip: data.settings.zip || '',
    sponsored: data.settings.sponsored,
    schedOn: data.settings.schedule_enabled ?? false,
    schedDays: [...data.settings.schedule_days],
    schedTime: data.settings.schedule_time,
  };
}

function PairList({ title, rows, render }: { title: string; rows: PairRef[]; render?: (p: PairRef) => string }) {
  if (!rows.length) return null;
  return (
    <details className="ks-diff-list" open={rows.length <= 12}>
      <summary>
        {title} ({rows.length})
      </summary>
      <ul>
        {rows.map((p) => (
          <li key={pairKey(p.asin, p.keyword)}>
            <code>{p.asin}</code> · {p.keyword}
            {render ? <span className="muted"> {render(p)}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function KeySetPage({ focus, active, onSaved, request = null, onRunNow, runNowBusy = false, runNowError = null, bitableMode = false }: Props): React.ReactElement {
  const [data, setData] = useState<KeySetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<GroupDraft[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [settings, setSettings] = useState<SettingsDraft>({
    top: String(DEFAULT_TOP_N),
    zipOn: true,
    zip: '10001',
    sponsored: false,
    schedOn: false,
    schedDays: [],
    schedTime: '',
  });
  const [confirm, setConfirm] = useState<KeySetDiff | null>(null);
  const [saving, setSaving] = useState(false);
  const [canWrite, setCanWrite] = useState(true);
  const [writeBlockReason, setWriteBlockReason] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const d = await loadKeySet();
      setData(d);
      const g = groupsFromItems(d.items);
      setGroups(g.groups.length ? g.groups : [{ uid: newUid(), name: 'Nhóm 1', asinText: '', kwText: '' }]);
      setNotes(g.notes);
      setSettings(settingsFrom(d));
      if (d.mode === 'bitable') {
        try {
          const { bitable } = await import('@lark-opdev/block-bitable-api');
          const perm = await checkWritePermission(bitable);
          setCanWrite(perm.ok);
          setWriteBlockReason(
            perm.ok
              ? null
              : formatSaveError({ code: 10214997, message: 'RecordPermissionDeniedError' })
          );
        } catch {
          setCanWrite(true); // probe failed — allow Save; saveDiff will format the error
          setWriteBlockReason(null);
        }
      } else {
        setCanWrite(false);
        setWriteBlockReason(null);
      }
    } catch (e) {
      setToast({ kind: 'err', text: `Không tải được bộ key: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), toast.kind === 'err' ? 9000 : 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const parsed = useMemo(() => groups.map(parseGroup), [groups]);
  const ownerName = (id?: string) => (id ? data?.owners.find((o) => o.id === id)?.name ?? id : '(trống)');
  const ownerFoot = data?.memberSource
    ? data.memberSource.error
      ? `Danh sách thành viên: ${data.memberSource.error} — đang dùng owner hiện có.`
      : `${data.memberSource.count} thành viên ${ORG_LABEL} · bảng member (backend đồng bộ hằng ngày)`
    : undefined;
  const sErrs = useMemo(() => settingsErrors(settings), [settings]);
  const schedErrs = useMemo(
    () => scheduleErrors({ enabled: settings.schedOn, days: settings.schedDays, time: settings.schedTime }),
    [settings.schedOn, settings.schedDays, settings.schedTime]
  );
  const crawlErrs = sErrs.filter((e) => !schedErrs.includes(e));
  const schedNext = useMemo(
    () => nextRun({ enabled: settings.schedOn, days: settings.schedDays, time: settings.schedTime.trim() }),
    [settings.schedOn, settings.schedDays, settings.schedTime]
  );
  const toggleDay = (d: DayToken) =>
    setSettings((s) => ({
      ...s,
      schedDays: s.schedDays.includes(d) ? s.schedDays.filter((x) => x !== d) : [...s.schedDays, d],
    }));
  const hasErrors = parsed.some((p) => p.errors.length) || sErrs.length > 0;

  const counts = useMemo(() => {
    const pairs = new Set<string>();
    const kws = new Set<string>();
    let n = 0;
    for (const p of parsed) {
      if (p.asins.length && p.keywords.length) n += 1;
      for (const a of p.asins) for (const k of p.keywords) pairs.add(pairKey(a, k));
      for (const k of p.keywords) kws.add(k);
    }
    return { groups: n, pairs: pairs.size, queries: kws.size };
  }, [parsed]);

  const dupPairs = useMemo(() => {
    const seen = new Map<string, string>();
    const dups = new Map<string, string[]>();
    for (const p of parsed) {
      for (const a of p.asins)
        for (const k of p.keywords) {
          const key = pairKey(a, k);
          const first = seen.get(key);
          if (first && first !== p.uid) dups.set(p.uid, [...(dups.get(p.uid) ?? []), `${a} · ${k}`]);
          else seen.set(key, p.uid);
        }
    }
    return dups;
  }, [parsed]);

  const liveDiff = useMemo(
    () => (data && !hasErrors ? computeDiff(data, parsed, settings) : null),
    [data, parsed, settings, hasErrors]
  );
  const dirty = !!liveDiff && hasChanges(liveDiff);

  // Scroll to group containing ASIN (from Heatmap)
  useEffect(() => {
    if (!focus || !active || loading) return;
    const hit = parsed.find((p) => p.asins.includes(focus.asin));
    if (!hit) {
      setToast({ kind: 'info', text: `${focus.asin} chưa có trong bộ key đang bật.` });
      return;
    }
    const el = cardRefs.current.get(hit.uid);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlash(hit.uid);
      const t = setTimeout(() => setFlash(null), 1800);
      return () => clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, active, loading]);

  const update = (uid: string, patch: Partial<GroupDraft>) =>
    setGroups((gs) => gs.map((g) => (g.uid === uid ? { ...g, ...patch } : g)));
  const remove = (uid: string) => setGroups((gs) => gs.filter((g) => g.uid !== uid));
  const addGroup = () =>
    setGroups((gs) => [...gs, { uid: newUid(), name: `Nhóm ${gs.length + 1}`, asinText: '', kwText: '' }]);

  const readOnly = data?.mode !== 'bitable';

  const onSave = () => {
    if (!data || readOnly || hasErrors) return;
    if (!canWrite) {
      setToast({ kind: 'err', text: writeBlockReason || formatSaveError({ code: 10214997, message: 'RecordPermissionDeniedError' }) });
      return;
    }
    const d = computeDiff(data, parsed, settings);
    if (!hasChanges(d)) {
      setToast({ kind: 'info', text: 'Không có thay đổi so với Base.' });
      return;
    }
    setConfirm(d);
  };

  const doSave = async () => {
    if (!data || !confirm) return;
    setSaving(true);
    try {
      const r = await saveDiff(data, confirm, settings);
      setConfirm(null);
      const base = `Đã lưu: +${r.added} mới · ${r.updated} cập nhật${r.settings ? ' · settings' : ''}. Áp dụng từ lần chạy kế tiếp.`;
      const msg = r.ownerWarning ? `${base} ⚠ ${r.ownerWarning}` : base;
      setToast({ kind: r.ownerWarning ? 'err' : 'ok', text: msg });
      try {
        const { bitable, ToastType } = await import('@lark-opdev/block-bitable-api');
        await bitable.ui.showToast({
          toastType: r.ownerWarning ? ToastType.warning : ToastType.success,
          message: msg.slice(0, 200),
        });
      } catch {
        // local toast is enough — never let a toast failure look like a save failure
      }
      await reload();
      onSaved?.();
    } catch (e) {
      // Keep the confirm dialog open so the user can retry after the Base owner grants Can edit.
      setToast({ kind: 'err', text: formatSaveError(e) });
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) return <div className="loading">Đang tải bộ key…</div>;

  return (
    <div className="ks-page">
      {readOnly && (
        <div className="demo-banner" role="alert">
          <strong>KHÔNG CÓ DỮ LIỆU LIVE</strong> — {data?.error} Nút <b>Lưu</b> bị tắt.
        </div>
      )}
      {!readOnly && writeBlockReason && (
        <div className="demo-banner" role="alert">
          <strong>Chỉ xem — không lưu được</strong> — {writeBlockReason}
        </div>
      )}
      <div className="ks-head">
        <div>
          <h2>Nhóm ASIN &amp; keyword</h2>
          <p className="sub">
            {counts.groups} nhóm · {counts.pairs} pairs · {counts.queries} query
            {data ? (
              <>
                {' '}· watchlist <code>{data.settings.watchlist_id}</code>
                {data.settings.schedule_note ? ` · ${data.settings.schedule_note}` : ''}
              </>
            ) : null}
          </p>
        </div>
        <div className="header-actions">
          {dirty && <span className="ks-dirty">● Có thay đổi chưa lưu</span>}
          <button type="button" onClick={() => void reload()} disabled={loading || saving}>
            Tải lại
          </button>
        </div>
      </div>

      {notes.map((n) => (
        <div key={n} className="ks-note">
          {n}
        </div>
      ))}

      <section className={`ks-card ks-sched${settings.schedOn ? '' : ' off'}`} role="group" aria-labelledby="ks-sched-title">
        <div className="ks-sched-head">
          <h3 id="ks-sched-title">Lịch chạy</h3>
          <span className="ks-sched-tz" title="schedule_time lưu theo giờ Asia/Bangkok (ICT, UTC+7), không phụ thuộc múi giờ máy bạn">
            Giờ Việt Nam (ICT, UTC+7)
          </span>
          {readOnly && <span className="ks-sched-ro">Base không khả dụng · chỉ xem</span>}
        </div>
        <div className="ks-sched-row">
          <label className="ks-switch" title="schedule_enabled — box tự chạy theo lịch">
            <input
              type="checkbox"
              role="switch"
              aria-checked={settings.schedOn}
              checked={settings.schedOn}
              onChange={(e) => setSettings((s) => ({ ...s, schedOn: e.target.checked }))}
              disabled={readOnly}
            />
            <span className="ks-switch-track" aria-hidden>
              <span className="ks-switch-thumb" />
            </span>
            <span className="ks-switch-label">{settings.schedOn ? 'Bật' : 'Tắt'}</span>
          </label>
          <div className="ks-day-chips" role="group" aria-label="Ngày chạy" title="schedule_days">
            {DAY_TOKENS.map((d) => {
              const on = settings.schedDays.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  className={`ks-day-chip${on ? ' on' : ''}`}
                  aria-pressed={on}
                  title={`${DAY_LONG_VI[d]} (${d})`}
                  onClick={() => toggleDay(d)}
                  disabled={readOnly}
                >
                  {DAY_SHORT_VI[d]}
                </button>
              );
            })}
          </div>
          <label className="ks-field" title="schedule_time — HH:MM 24h, giờ Việt Nam (ICT, UTC+7)">
            Giờ
            <input
              className={`filter-input ks-time${schedErrs.some((e) => e.startsWith('Giờ')) ? ' invalid' : ''}`}
              value={settings.schedTime}
              placeholder="HH:MM"
              inputMode="numeric"
              maxLength={5}
              onChange={(e) => setSettings((s) => ({ ...s, schedTime: e.target.value }))}
              onBlur={() =>
                setSettings((s) => {
                  // '9:55' / '955' → '09:55' tidy only when unambiguous
                  const t = s.schedTime.trim();
                  const m = t.match(/^(\d{1,2})[:h.]?(\d{2})$/);
                  return m ? { ...s, schedTime: `${m[1].padStart(2, '0')}:${m[2]}` } : { ...s, schedTime: t };
                })
              }
              disabled={readOnly}
            />
          </label>
          <span className="ks-sched-note">
            {schedErrs.length ? (
              <span className="ks-err-inline">{schedErrs.join(' ')}</span>
            ) : settings.schedOn && schedNext ? (
              <span title={formatNextRunFull(schedNext)}>
                Lần tới: <b>{formatNextRun(schedNext)}</b>
              </span>
            ) : (
              'Tắt lịch: box không tự chạy.'
            )}
          </span>
        </div>
        <div className="ks-runnow-row">
          <button
            type="button"
            className="ks-run-now"
            onClick={() => onRunNow?.()}
            disabled={!bitableMode || readOnly || runNowBusy || isActive(request) || !onRunNow}
            title={
              !bitableMode || readOnly
                ? 'Base không khả dụng — không gửi yêu cầu'
                : isActive(request)
                  ? 'Đã có yêu cầu đang chờ / đang chạy'
                  : 'Ghi pending vào Base run_request; backend nhận yêu cầu (WAKE_CONTRACT.md)'
            }
          >
            {runNowBusy ? 'Đang gửi…' : '▶ Chạy ngay'}
          </button>
          <span className="ks-runnow-status" title={request?.requestId || 'Chưa có yêu cầu'}>
            {(() => {
              const r = request;
              if (!r) return <>Trạng thái yêu cầu: <b>idle</b></>;
              const map: Record<string, string> = {
                pending: 'pending',
                claimed: 'pending',
                running: 'running',
                done: 'done',
                failed: 'failed',
                cancelled: 'cancelled',
              };
              const label = map[r.status] ?? r.status;
              const when =
                r.status === 'running'
                  ? r.startedAt ?? r.requestedAt
                  : r.finishedAt ?? r.startedAt ?? r.requestedAt;
              return (
                <>
                  Trạng thái yêu cầu: <b className={isActive(r) ? 'ks-rq-active' : r.status === 'failed' ? 'ks-rq-failed' : r.status === 'done' ? 'ks-rq-done' : undefined}>{label}</b>
                  {' · '}
                  {formatIct(when)}
                  {r.requestId ? (
                    <>
                      {' · '}
                      <code>{r.requestId}</code>
                    </>
                  ) : null}
                </>
              );
            })()}
          </span>
          {runNowError ? <span className="ks-err-inline">Lỗi: {runNowError}</span> : null}
        </div>
        <p className="ks-sched-help">
          Box tự lấy bộ key + lịch từ Base <b>55 phút trước giờ chạy</b>, rồi chạy đúng giờ. Bấm <b>Lưu</b> để ghi lịch
          (cùng nút Lưu bộ key). <b>Chạy ngay</b> ghi một dòng <code>pending</code> vào Base{' '}
          <code>run_request</code> — backend nhận yêu cầu (không dùng poller 2 phút).
        </p>
      </section>

      <div className="ks-groups">
        {groups.map((g, i) => {
          const p = parsed[i];
          const dups = dupPairs.get(g.uid);
          return (
            <div
              key={g.uid}
              className={`ks-card${p.errors.length ? ' has-error' : ''}${flash === g.uid ? ' flash' : ''}`}
              ref={(el) => {
                if (el) cardRefs.current.set(g.uid, el);
                else cardRefs.current.delete(g.uid);
              }}
            >
              <div className="ks-card-head">
                <input
                  className="filter-input ks-name"
                  value={g.name}
                  placeholder="Tên nhóm"
                  onChange={(e) => update(g.uid, { name: e.target.value })}
                  disabled={readOnly}
                />
                <span className="ks-badge" title="ASIN × keyword">
                  {p.asins.length} × {p.keywords.length}
                </span>
                <button
                  type="button"
                  className="ks-remove"
                  title="Xoá nhóm (các pair sẽ bị tắt khi Lưu)"
                  onClick={() => remove(g.uid)}
                  disabled={readOnly}
                >
                  ×
                </button>
              </div>
              <div className="ks-owner-row">
                <span className="ks-col-label">Owner · nhận thông báo kết quả</span>
                <OwnerPicker
                  value={g.ownerId ?? ''}
                  options={data?.owners ?? []}
                  onChange={(id) => update(g.uid, { ownerId: id })}
                  disabled={readOnly}
                  footnote={ownerFoot}
                />
              </div>
              <div className="ks-card-body">
                <label className="ks-col ks-col-asin">
                  <span className="ks-col-label">ASIN · mỗi dòng một ASIN</span>
                  <textarea
                    value={g.asinText}
                    spellCheck={false}
                    placeholder="B0XXXXXXXX"
                    rows={Math.min(10, Math.max(4, g.asinText.split('\n').length + 1))}
                    onChange={(e) => update(g.uid, { asinText: e.target.value })}
                    onBlur={() => update(g.uid, { asinText: tidyLines(g.asinText, 'asin') })}
                    disabled={readOnly}
                  />
                </label>
                <label className="ks-col ks-col-kw">
                  <span className="ks-col-label">Keywords · mỗi dòng một từ</span>
                  <textarea
                    value={g.kwText}
                    spellCheck={false}
                    placeholder="halloween mug"
                    rows={Math.min(10, Math.max(4, g.kwText.split('\n').length + 1))}
                    onChange={(e) => update(g.uid, { kwText: e.target.value })}
                    onBlur={() => update(g.uid, { kwText: tidyLines(g.kwText, 'kw') })}
                    disabled={readOnly}
                  />
                </label>
              </div>
              {(p.errors.length > 0 || dups) && (
                <ul className="ks-errors">
                  {p.errors.map((er) => (
                    <li key={er}>{er}</li>
                  ))}
                  {dups && (
                    <li className="warn">
                      Trùng pair với nhóm phía trên (giữ nhóm đầu): {dups.slice(0, 5).join('; ')}
                      {dups.length > 5 ? ` … +${dups.length - 5}` : ''}
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
        <button type="button" className="ks-add" onClick={addGroup} disabled={readOnly}>
          + Thêm nhóm
        </button>
      </div>

      <div className="ks-footer">
        <label className="ks-field">
          Top
          <input
            type="number"
            min={1}
            max={1000}
            className="filter-input ks-top"
            value={settings.top}
            onChange={(e) => setSettings((s) => ({ ...s, top: e.target.value }))}
            disabled={readOnly}
          />
        </label>
        <label className="ks-field">
          <input
            type="checkbox"
            checked={settings.zipOn}
            onChange={(e) => setSettings((s) => ({ ...s, zipOn: e.target.checked }))}
            disabled={readOnly}
          />
          ZIP
          <input
            className="filter-input ks-zip"
            value={settings.zip}
            inputMode="numeric"
            maxLength={5}
            onChange={(e) => setSettings((s) => ({ ...s, zip: e.target.value }))}
            disabled={readOnly || !settings.zipOn}
          />
        </label>
        <label className="ks-field">
          <input
            type="checkbox"
            checked={settings.sponsored}
            onChange={(e) => setSettings((s) => ({ ...s, sponsored: e.target.checked }))}
            disabled={readOnly}
          />
          Sponsored
        </label>
        <span className="ks-footer-note">
          {crawlErrs.length ? (
            <span className="ks-err-inline">{crawlErrs.join(' ')}</span>
          ) : readOnly ? (
            'DEMO: không thể lưu.'
          ) : (
            'Lưu chỉ áp dụng cho lần chạy kế tiếp — không crawl ngay.'
          )}
        </span>
        <button
          type="button"
          className="btn-primary ks-save"
          onClick={onSave}
          disabled={readOnly || !canWrite || hasErrors || saving || loading}
          title={
            readOnly
              ? 'DEMO mode — read-only'
              : !canWrite
                ? 'Base chỉ cho xem — cần Can edit'
                : hasErrors
                  ? 'Sửa lỗi trước khi lưu'
                  : 'Lưu vào Base'
          }
        >
          {saving ? 'Đang lưu…' : 'Lưu'}
        </button>
      </div>

      {confirm && (
        <div className="ks-modal-backdrop" role="dialog" aria-modal="true">
          <div className="ks-modal">
            <h3>Xác nhận lưu bộ key</h3>
            <div className="ks-diff-counts">
              <span className="c-add">+{confirm.added.length} thêm mới</span>
              <span className="c-re">↺ {confirm.reenabled.length} bật lại</span>
              <span className="c-off">− {confirm.disabled.length} tắt</span>
              <span className="c-grp">✎ {confirm.regrouped.length} đổi nhóm</span>
              {confirm.reowned.length > 0 && <span className="c-grp">👤 {confirm.reowned.length} đổi owner</span>}
              <span className="muted">= {confirm.unchanged} giữ nguyên</span>
            </div>
            <PairList title="Thêm mới" rows={confirm.added} render={(p) => `→ ${p.group}`} />
            <PairList title="Bật lại" rows={confirm.reenabled} render={(p) => `→ ${p.group}`} />
            <PairList title="Tắt (enabled=false, không xoá)" rows={confirm.disabled} />
            <PairList title="Đổi nhóm" rows={confirm.regrouped} render={(p) => `${p.fromGroup} → ${p.group}`} />
            <PairList title="Đổi owner" rows={confirm.reowned} render={(p) => `${p.fromOwner} → ${ownerName(p.ownerId)}`} />
            {confirm.settings.length > 0 && (
              <div className="ks-diff-settings">
                <b>Settings:</b>{' '}
                {confirm.settings.map((s) => `${s.field}: ${s.from} → ${s.to}`).join(' · ')}
              </div>
            )}
            <p className="sub">Ghi vào Base (source=ui). Áp dụng cho lần chạy kế tiếp; không crawl ngay.</p>
            {confirm.settings.some((x) => x.kind === 'schedule') && (
              <p className="sub">
                Lịch (giờ Việt Nam) ghi vào <code>watchlist</code>: schedule_enabled / schedule_days / schedule_time (+
                schedule_note hiển thị). Box nhận lịch mới ở lần lấy dữ liệu kế tiếp (55 phút trước giờ chạy).
              </p>
            )}
            <div className="ks-modal-actions">
              <button type="button" onClick={() => setConfirm(null)} disabled={saving}>
                Huỷ
              </button>
              <button type="button" className="btn-primary" onClick={() => void doSave()} disabled={saving}>
                {saving ? 'Đang lưu…' : 'Xác nhận lưu'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`ks-toast ${toast.kind}`} role="status" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
