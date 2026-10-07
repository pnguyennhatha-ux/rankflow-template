import React from "react";
import { createRoot } from "react-dom/client";
import { STORAGE } from "../../src/worker-state";
import { sendWorker, timeAgo, useStorageValue } from "../../src/use-storage";
import { Progress, StatusPill, duration, useWorker } from "../../src/ui";
import type { GroupsCache } from "../../src/worker-state";
import { showFatal } from "./boot-error";
import { countPairs, groupOwners } from "../../src/groups";
import "./style.css";

function Popup() {
  const { state, status, settings } = useWorker();
  const groups = useStorageValue<GroupsCache>(STORAGE.groups);
  const run = state?.currentRun;
  const last = state?.lastResult;
  // Count distinct (watchlist, ASIN, keyword) from the synced list itself rather than trusting a summed counter.
  const pairs = countPairs(groups?.groups);
  const owners = new Set((groups?.groups ?? []).flatMap((group) => groupOwners(group).map((owner) => owner.id))).size;
  React.useEffect(() => { void sendWorker({ type: "WORKER_REFRESH_GROUPS" }).catch(() => undefined); }, []);  // never show a stale count
  return <main>
    <div className="head"><img src="/icon-48.png" alt="2J"/><div><b>2J</b><small>RankFlow worker · {settings?.backendUrl.replace(/^https?:\/\//, "") ?? "…"}</small></div></div>
    <div className="box">
      <StatusPill status={status}/>
      {run ? <><Progress percent={status.percent}/><small>{run.message}</small></> : status.detail && <small>{status.detail}</small>}
    </div>
    <div className="box">
      <div className="line"><span>Nhóm từ backend</span><span title={groups?.syncedAt ? `Đồng bộ ${timeAgo(groups.syncedAt)}` : undefined}>{groups?.groups.length ?? 0} nhóm · {pairs} cặp{owners ? ` · ${owners} owner` : ""}</span></div>
      {last ? <div className="line"><span>Lần chạy cuối <b className={last.ok ? "ok" : "bad"}>{last.ok ? "OK" : "Lỗi"}</b></span><span>{last.ranked}/{last.rows} ranked · {duration(last.durationMs)} · {timeAgo(last.finishedAt)}</span></div> : <div className="line"><span>Chưa có lần chạy nào</span><span /></div>}
      {last?.warnings?.length ? <small className="warn">{last.warnings.join(" ")}</small> : null}
      {last?.error && <small className="bad">{last.error}</small>}
    </div>
    <div className="buttons">
      <button onClick={() => void sendWorker({ type: "WORKER_KICK" })}>Kiểm tra job</button>
      <button className="primary" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("/dashboard.html") })}>Mở Dashboard</button>
    </div>
  </main>;
}
window.addEventListener("error", (event) => showFatal(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => showFatal(event.reason));
try {
  createRoot(document.getElementById("root")!).render(<Popup/>);
} catch (error) {
  showFatal(error);
}
