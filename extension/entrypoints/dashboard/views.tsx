import React, { useEffect, useMemo, useState } from "react";
import { BackendError, fetchWorkerStatus, health, type BackendGroup, type WorkerStatusResponse } from "../../src/backend";
import { positionLabel, type DirectRankRow } from "../../src/rank";
import { countPairs, groupLabel, groupOwners, groupRunValue, ownerLabel } from "../../src/groups";
import { DEFAULT_BACKEND_URL, getSettings, isLoopbackUrl, saveSettings, type ExtensionSettings } from "../../src/settings";
import { Progress, StatusPill, duration, statusClass } from "../../src/ui";
import { sendWorker, timeAgo, type WorkerReply } from "../../src/use-storage";
import { getPending, type GroupsCache, type LastRunRows, type WorkerState } from "../../src/worker-state";
import type { WorkerStatus } from "../../src/status";
import { createDirectRankXlsx } from "../../src/xlsx-export";

export type Act = (payload: Record<string, unknown>) => Promise<WorkerReply>;

function uniqueKeywords(group: BackendGroup) {
  return new Set(group.asins.flatMap((asin) => asin.keywords.map((keyword) => keyword.toLocaleLowerCase("en-US")))).size;
}

// ---------------------------------------------------------------------------
export function OverviewView({ state, status, groups, act, goto }: { state?: WorkerState; status: WorkerStatus; groups?: GroupsCache; act: Act; goto: (tab: string) => void }) {
  const [server, setServer] = useState<WorkerStatusResponse | null>(null);
  useEffect(() => { const load = () => void fetchWorkerStatus().then(setServer).catch(() => setServer(null)); load(); const timer = setInterval(load, 15_000); return () => clearInterval(timer); }, []);
  const run = state?.currentRun;
  const last = state?.lastResult;
  const list = groups?.groups ?? [];
  const pairs = countPairs(list);
  return <>
    <section className="card status-card">
      <div className="status-line"><StatusPill status={status} large/><span className="detail">{status.detail}</span></div>
      {run && <>
        <Progress percent={status.percent}/>
        <div className="progress-meta"><span>Run <code>{run.runId}</code> · {run.completed}/{run.keywordsTotal} keyword · {run.pairsTotal} cặp</span><span>Bắt đầu {timeAgo(run.startedAt)} · heartbeat {timeAgo(run.lastHeartbeatAt)}</span></div>
        <div className="row"><button className="danger sm" onClick={() => { if (confirm("Dừng run? Phần đã xong vẫn được gửi về backend, phần còn lại backend sẽ chạy lại.")) void act({ type: "WORKER_CANCEL" }); }}>Dừng run</button></div>
      </>}
      {!run && state?.cooldownUntil && state.cooldownUntil > Date.now() && <div className="row"><button className="sm" onClick={() => void act({ type: "WORKER_CLEAR_COOLDOWN" })}>Bỏ tạm dừng</button></div>}
    </section>
    <div className="grid cols-3">
      <section className="card">
        <div className="card-head"><h2>Lần chạy gần nhất</h2>{last && <button className="ghost sm" onClick={() => goto("results")}>Xem kết quả →</button>}</div>
        {last ? <>
          <div className="stats"><div className="stat ok"><small>Ranked</small><b>{last.ranked}</b></div><div className="stat warn"><small>Not found</small><b>{last.notFound}</b></div><div className="stat bad"><small>Unverified</small><b>{last.unverified}</b></div></div>
          <dl className="kv" style={{ marginTop: 12 }}><dt>Run</dt><dd><code>{last.runId}</code></dd><dt>Kết thúc</dt><dd>{timeAgo(last.finishedAt)} · {duration(last.durationMs)}</dd><dt>Backend</dt><dd>{last.backendStatus ?? "—"}</dd></dl>
          {last.warnings?.length ? <div className="notice warn">{last.warnings.join(" ")}</div> : null}
          {last.error && <div className="notice bad">{last.error}</div>}
        </> : <p className="muted">Chưa có lần chạy nào trên Chrome này.</p>}
      </section>
      <section className="card">
        <div className="card-head"><h2>Nhóm từ backend</h2><button className="ghost sm" onClick={() => goto("groups")}>Xem nhóm →</button></div>
        <div className="stats"><div className="stat"><small>Nhóm</small><b>{list.length}</b></div><div className="stat"><small>ASIN</small><b>{new Set(list.flatMap((group) => group.asins.map((asin) => asin.asin))).size}</b></div><div className="stat"><small>Cặp</small><b>{pairs}</b></div></div>
        <p className="hint">Đồng bộ {timeAgo(groups?.syncedAt)}. Thêm/xoá nhóm ở block Lark (Bộ key), CLI hoặc admin API.</p>
      </section>
      <section className="card">
        <div className="card-head"><h2>Backend</h2></div>
        <dl className="kv">
          <dt>Kết nối</dt><dd>{state?.connected === undefined ? "Đang kết nối…" : state.connected ? "OK" : "Mất kết nối"}</dd>
          <dt>Run chờ</dt><dd>{server?.queued_runs ?? "—"}</dd>
          <dt>Lark sync</dt><dd>{server ? (server.live_enabled ? "Bật" : "Tắt (outbox chờ)") : "—"}{server ? ` · outbox ${server.outbox}` : ""}</dd>
          <dt>Run cuối</dt><dd>{server?.last_run ? `${server.last_run.status} · ${timeAgo(server.last_run.finished_at)}` : "—"}</dd>
        </dl>
      </section>
    </div>
    <section className="card">
      <div className="card-head"><h2>Nhật ký gần đây</h2><button className="ghost sm" onClick={() => goto("log")}>Tất cả →</button></div>
      <LogList entries={(state?.log ?? []).slice(0, 5)}/>
    </section>
  </>;
}

// ---------------------------------------------------------------------------
export function GroupsView({ groups, running, act }: { groups?: GroupsCache; running: boolean; act: Act }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const list = groups?.groups ?? [];
  const wl = Object.values(groups?.watchlists ?? {}).find(Boolean) ?? null;
  const run = async (key: string, payload: Record<string, unknown>) => {
    setBusy(key); setMessage(null);
    const reply = await act(payload);
    setBusy("");
    if (!reply.ok) setMessage({ kind: "bad", text: reply.error ?? "Lỗi" });
    else if (payload.type === "WORKER_RUN_NOW") setMessage({ kind: "ok", text: reply.runs?.length ? `Đã xếp hàng ${reply.runs.map((item) => item.run_id + (item.existing ? " (đang có)" : "")).join(", ")} — worker nhận ngay.` : "Không có cặp nào đang bật." });
    else setMessage({ kind: "ok", text: "Đã đồng bộ nhóm từ backend." });
  };
  return <section className="card">
    <div className="card-head">
      <div><h2>Nhóm ASIN × keyword</h2><p className="hint">Chỉ đọc · nguồn: backend (block Lark “Bộ key”, CLI <code>groups add|rm</code>, admin API) · đồng bộ {timeAgo(groups?.syncedAt)}</p></div>
      <div className="actions"><span className="badge">Top {wl?.top_n ?? "—"}</span><span className="badge">ZIP {wl?.zip || "—"}</span><span className="badge">Sponsored {wl?.sponsored ? "bật" : "tắt"}</span>
        <button className="sm" disabled={Boolean(busy)} onClick={() => void run("refresh", { type: "WORKER_REFRESH_GROUPS" })}>Làm mới</button>
        <button className="primary sm" disabled={Boolean(busy) || running || !list.length} onClick={() => void run("all", { type: "WORKER_RUN_NOW" })}>Chạy ngay tất cả</button></div>
    </div>
    {message && <div className={`notice ${message.kind}`} style={{ marginTop: 0, marginBottom: 12 }}>{message.text}</div>}
    {list.length ? <div className="table-wrap"><table>
      <thead><tr><th>Nhóm</th><th className="num">ASIN</th><th className="num">Keyword</th><th className="num">Cặp</th><th>Owner</th><th>Watchlist</th><th className="act"></th></tr></thead>
      <tbody>{list.map((group) => {
        const key = `${group.watchlist_id}|${group.group}`;
        return <React.Fragment key={key}>
          <tr>
            <td><button className="toggle" aria-label="Mở rộng" onClick={() => setOpen((value) => ({ ...value, [key]: !value[key] }))}>{open[key] ? "▾" : "▸"}</button><b>{groupLabel(group.group)}</b></td>
            <td className="num">{group.asins.length}</td><td className="num">{uniqueKeywords(group)}</td><td className="num">{group.pairs}</td><td>{groupOwners(group).map((owner) => <span className="badge owner" key={owner.id} title={owner.id}>{ownerLabel(owner)}</span>)}{groupOwners(group).length ? null : <span className="muted">—</span>}</td><td><span className="muted">{group.watchlist_id}</span></td>
            <td className="act"><button className="sm" disabled={Boolean(busy) || running} onClick={() => void run(key, { type: "WORKER_RUN_NOW", group: groupRunValue(group.group), watchlistId: group.watchlist_id })}>{busy === key ? "…" : "▶ Chạy"}</button></td>
          </tr>
          {open[key] && <tr className="group-detail"><td colSpan={7}>{group.asins.map((asin) => <div className="asin-line" key={asin.asin}><a href={`https://www.amazon.com/dp/${asin.asin}`} target="_blank" rel="noopener noreferrer">{asin.asin} ↗</a><div className="chips">{asin.keywords.map((keyword) => { const owner = asin.owners?.[keyword]; return <span className="chip" key={keyword} title={owner ? `owner: ${ownerLabel(owner)}` : undefined}>{keyword}{owner && <em className="chip-owner"> · {ownerLabel(owner)}</em>}</span>; })}</div></div>)}</td></tr>}
        </React.Fragment>;
      })}</tbody>
    </table></div> : <div className="empty">Backend chưa có nhóm nào. Thêm ở block Lark (Bộ key) hoặc: <code>python3 backend/rankflow.py groups add --group Test --asin B0XXXXXXXX --keyword "grandma mug"</code></div>}
  </section>;
}

// ---------------------------------------------------------------------------
export function ResultsView({ last }: { last?: LastRunRows }) {
  const [group, setGroup] = useState("");
  const [owner, setOwner] = useState("");
  const rowOwner = (row: DirectRankRow) => ownerLabel({ id: row.ownerId, name: row.ownerName });
  const rows = useMemo(() => (last?.rows ?? []).filter((row) => (!group || row.groupName === group) && (!owner || (owner === "-" ? !row.ownerId : row.ownerId === owner))), [last, group, owner]);
  const groupNames = useMemo(() => [...new Set((last?.rows ?? []).map((row) => row.groupName ?? ""))].filter(Boolean).sort(), [last]);
  const owners = useMemo(() => [...new Map((last?.rows ?? []).filter((row) => row.ownerId).map((row) => [row.ownerId!, rowOwner(row)])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [last]);
  const counts = { ranked: rows.filter((row) => row.status === "ranked").length, notFound: rows.filter((row) => row.status.startsWith("not_found")).length, bad: rows.filter((row) => row.status.startsWith("unverified")).length };
  const download = (blob: Blob, name: string) => { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000); };
  const csv = () => { const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`; const head = ["snapshot_day", "group", "owner", "keyword", "asin", "title", "organic_rank", "position_label", "page", "position", "sponsored_above", "featured_above", "sponsored_rank", "price", "image_url", "status", "note"]; download(new Blob([[head.join(","), ...rows.map((row) => [row.snapshotDay, row.groupName, rowOwner(row), row.keyword, row.asin, row.title, row.organicRank, positionLabel(row), row.pageNumber, row.positionOnPage, row.sponsoredAbove, row.featuredAbove, row.sponsoredRank, row.priceText, row.imageUrl, row.status, row.note].map(quote).join(","))].join("\n")], { type: "text/csv;charset=utf-8" }), `2j-${last?.runId ?? "run"}.csv`); };
  if (!last) return <section className="card"><div className="empty">Chưa có kết quả. Bấm “Chạy ngay” hoặc chạy từ block Lark — worker tự nhận job.</div></section>;
  return <section className="card">
    <div className="card-head">
      <div><h2>Kết quả · <code>{last.runId}</code></h2><p className="hint">{timeAgo(last.completedAt)} · {last.rows[0]?.snapshotDay ?? ""} · Top {last.rows[0]?.scanDepth ?? "—"}{last.notes?.length ? ` · ${last.notes.join(" · ")}` : ""}</p></div>
      <div className="toolbar">
        {groupNames.length > 1 && <select value={group} onChange={(event) => setGroup(event.target.value)} aria-label="Lọc nhóm"><option value="">Tất cả nhóm</option>{groupNames.map((name) => <option key={name}>{name}</option>)}</select>}
        {owners.length > 0 && <select value={owner} onChange={(event) => setOwner(event.target.value)} aria-label="Lọc owner"><option value="">Tất cả owner</option>{owners.map(([id, label]) => <option key={id} value={id}>{label}</option>)}<option value="-">(không owner)</option></select>}
        <button className="sm" disabled={!rows.length} onClick={csv}>CSV</button><button className="sm" disabled={!rows.length} onClick={() => download(createDirectRankXlsx(rows), `2j-${last.runId}.xlsx`)}>Excel</button>
      </div>
    </div>
    <div className="stats" style={{ marginBottom: 12 }}><div className="stat"><small>Cặp</small><b>{rows.length}</b></div><div className="stat ok"><small>Ranked</small><b>{counts.ranked}</b></div><div className="stat warn"><small>Ngoài Top</small><b>{counts.notFound}</b></div><div className="stat bad"><small>Unverified</small><b>{counts.bad}</b></div></div>
    {last.warnings.length > 0 && <div className="notice warn" style={{ marginBottom: 12 }}>{last.warnings.join(" ")}</div>}
    <div className="table-wrap"><table>
      <thead><tr><th>Nhóm</th><th>Owner</th><th>Keyword</th><th>Sản phẩm</th><th className="num">Giá</th><th className="num">Organic</th><th>Vị trí</th><th className="num" title="Tile có nhãn Sponsored (ô lưới) phía trên, cùng trang">Sponsored ↑</th><th className="num" title="Ô quảng cáo không có nhãn Sponsored (vd. Featured from Amazon brands) phía trên, cùng trang">Featured ↑</th><th>Trạng thái</th></tr></thead>
      <tbody>{rows.map((row: DirectRankRow, index) => <tr key={`${row.keyword}|${row.asin}|${index}`} title={row.note}>
        <td>{row.groupName ? <span className="badge group">{row.groupName}</span> : "—"}</td>
        <td>{row.ownerId ? <span className="badge owner" title={row.ownerId}>{rowOwner(row)}</span> : <span className="muted">—</span>}</td>
        <td>{row.keyword}</td>
        <td><div className="product"><Thumb src={row.imageUrl}/><span><a href={`https://www.amazon.com/dp/${row.asin}`} target="_blank" rel="noopener noreferrer">{row.asin} ↗</a><small title={row.title ?? ""}>{row.title ?? "—"}</small></span></div></td>
        <td className="num">{row.priceText ?? (row.priceCents ? `$${(row.priceCents / 100).toFixed(2)}` : "—")}</td>
        <td className="num"><span className="rank">{row.organicRank ?? "—"}</span></td>
        <td>{positionLabel(row) || "—"}</td>
        <td className="num">{row.sponsoredAbove ?? "—"}</td>
        <td className="num">{row.featuredAbove ?? "—"}</td>
        <td><span className={`badge ${statusClass(row.status)}`}>{row.status === "not_found_within_limit" ? `not found Top ${row.scanDepth}` : row.status.replaceAll("_", " ")}</span>{row.note && <small style={{ display: "block", marginTop: 4 }}>{row.note}</small>}</td>
      </tr>)}</tbody>
    </table></div>
    {last.navigations?.length ? <details className="nav-timing"><summary>Thời gian điều hướng ({last.navigations.length} lần tải trang)</summary>
      <div className="table-wrap"><table>
        <thead><tr><th className="num">#</th><th className="num">Bắt đầu</th><th className="num">Slot</th><th>Loại</th><th className="num" title="Từ lần điều hướng trước (mọi slot)">Cách lần trước</th><th className="num" title="Thời gian chờ throttle">Chờ</th><th className="num" title="Tải trang + chờ ổn định + đọc">Tải</th></tr></thead>
        <tbody>{last.navigations.map((nav, index) => <tr key={index}><td className="num">{index + 1}</td><td className="num">{seconds(nav.atMs)}</td><td className="num">{nav.slot + 1}</td><td>{nav.kind === "page" ? "trang kế" : index === 0 ? "ZIP/keyword" : "keyword"}</td><td className="num">{index ? seconds(nav.gapMs) : "—"}</td><td className="num">{seconds(nav.waitMs)}</td><td className="num">{nav.loadMs === null ? "—" : seconds(nav.loadMs)}</td></tr>)}</tbody>
      </table></div>
    </details> : null}
  </section>;
}

function seconds(ms: number) {
  return `${(ms / 1_000).toFixed(1)}s`;
}

/** Amazon thumbnail with a 2J placeholder when missing or when the image fails to load. */
function Thumb({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <span className="ph">2J</span>;
  return <img src={src} alt="" width={40} height={40} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)}/>;
}

// ---------------------------------------------------------------------------
export function LogList({ entries }: { entries: WorkerState["log"] }) {
  if (!entries.length) return <p className="muted">Chưa có sự kiện.</p>;
  return <ul className="log">{entries.map((entry, index) => <li key={`${entry.at}-${index}`} className={entry.resolved ? "resolved" : entry.level}><time>{new Date(entry.at).toLocaleTimeString("vi-VN", { timeZone: "Asia/Bangkok", hour12: false })}</time><span>{entry.message}{entry.resolved ? " · đã khắc phục" : ""}</span></li>)}</ul>;
}

export function LogView({ state }: { state?: WorkerState }) {
  const [pending, setPending] = useState(0);
  useEffect(() => { void getPending().then((items) => setPending(items.length)); }, [state]);
  return <section className="card">
    <div className="card-head"><h2>Nhật ký worker</h2><span className="muted">{pending ? `${pending} kết quả chờ gửi lại` : "Không có kết quả chờ gửi"}</span></div>
    <LogList entries={state?.log ?? []}/>
  </section>;
}

// ---------------------------------------------------------------------------
export function SettingsView() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [backendUrl, setBackendUrl] = useState("");
  const [workerToken, setWorkerToken] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getSettings().then((value) => { setSettings(value); setBackendUrl(value.backendUrl); setWorkerToken(value.workerToken); }); }, []);
  const save = async () => {
    setBusy(true); setMessage(null);
    try {
      const next = await saveSettings({ backendUrl, workerToken });
      setSettings(next); setBackendUrl(next.backendUrl);
      const info = await health(next);
      setMessage({ kind: "ok", text: `Đã lưu · ${info?.service ?? "backend"} (${info?.api ?? "?"}) phản hồi OK.` });
      void sendWorker({ type: "WORKER_KICK" });
    } catch (reason) {
      setMessage({ kind: "bad", text: reason instanceof BackendError ? reason.message : (reason as Error).message });
    } finally { setBusy(false); }
  };
  return <div className="grid cols-2">
    <section className="card">
      <div className="card-head"><h2>Backend RankFlow</h2></div>
      <label className="field">Backend URL<input value={backendUrl} onChange={(event) => setBackendUrl(event.target.value)} placeholder={DEFAULT_BACKEND_URL}/></label>
      <label className="field">Worker token (tuỳ chọn)<input type="password" autoComplete="off" value={workerToken} onChange={(event) => setWorkerToken(event.target.value)} placeholder={isLoopbackUrl(backendUrl || DEFAULT_BACKEND_URL) ? "Không cần với localhost" : "Bắt buộc với backend từ xa"}/></label>
      <div className="row"><button className="primary" disabled={busy} onClick={() => void save()}>{busy ? "Đang kiểm tra…" : "Lưu & kiểm tra"}</button><button onClick={() => setBackendUrl(DEFAULT_BACKEND_URL)}>Mặc định</button></div>
      {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
      <p className="hint">Mặc định {DEFAULT_BACKEND_URL}. Backend từ xa phải dùng HTTPS + worker token.</p>
    </section>
    <section className="card">
      <div className="card-head"><h2>Worker</h2></div>
      <label className="switch"><input type="checkbox" checked={settings?.workerEnabled ?? true} onChange={(event) => void saveSettings({ workerEnabled: event.target.checked }).then(setSettings)}/>Nhận job từ backend</label>
      <dl className="kv"><dt>Worker ID</dt><dd><code>{settings?.workerId ?? "—"}</code></dd><dt>Khi rảnh</dt><dd>1 long-poll <code>GET /job?wait=20</code> mỗi 30 s tới backend local; không mở Amazon.</dd><dt>Khi có job</dt><dd>2 slot song song trên 2 tab Amazon trong 1 cửa sổ crawl riêng, thu nhỏ, không lấy focus (dùng lại cho mọi keyword), đặt ZIP 1 lần cho cả lượt; giữa 2 lần tải trang bất kỳ luôn có delay ngẫu nhiên, 2 slot so le nhau; CAPTCHA → cả 2 slot cùng nghỉ.</dd></dl>
      <p className="hint">ZIP, Top, số keyword song song và delay do backend gửi kèm từng job.</p>
    </section>
  </div>;
}
