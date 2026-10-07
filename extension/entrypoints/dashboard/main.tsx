import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { STORAGE, type GroupsCache, type LastRunRows } from "../../src/worker-state";
import { sendWorker, useStorageValue } from "../../src/use-storage";
import { StatusPill, useWorker } from "../../src/ui";
import { GroupsView, LogView, OverviewView, ResultsView, SettingsView, type Act } from "./views";
import "./app.css";

type Tab = "overview" | "groups" | "results" | "log" | "settings";
const TABS: Array<{ id: Tab; label: string; title: string; subtitle: string }> = [
  { id: "overview", label: "Tổng quan", title: "Tổng quan", subtitle: "Worker chỉ hoạt động khi backend có yêu cầu" },
  { id: "groups", label: "Nhóm", title: "Nhóm từ backend", subtitle: "Danh sách ASIN × keyword sẽ được crawl" },
  { id: "results", label: "Kết quả", title: "Kết quả gần nhất", subtitle: "Đã gửi về backend → Lark Base" },
  { id: "log", label: "Nhật ký", title: "Nhật ký", subtitle: "Sự kiện của worker trên Chrome này" },
  { id: "settings", label: "Cài đặt", title: "Cài đặt", subtitle: "Kết nối backend và worker" }
];

function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const { state, status, settings } = useWorker();
  const groups = useStorageValue<GroupsCache>(STORAGE.groups);
  const last = useStorageValue<LastRunRows>(STORAGE.lastRows);
  const act: Act = (payload) => sendWorker(payload);
  const meta = TABS.find((item) => item.id === tab)!;
  const running = Boolean(state?.currentRun);
  const counts: Partial<Record<Tab, number>> = { groups: groups?.groups.length, results: last?.rows.length };
  return <div className="shell">
    <aside className="side">
      <div className="logo"><img src="/icon-48.png" alt="2J"/><div><b>2J</b><small>Amazon Organic Rank</small></div></div>
      <nav className="nav">{TABS.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><span>{item.label}</span>{counts[item.id] ? <span className="count">{counts[item.id]}</span> : null}</button>)}</nav>
      <footer>RankFlow backend → Lark Base<br/>Worker {settings?.workerId ?? "…"} · v0.3.5</footer>
    </aside>
    <main className="main">
      <header className="top"><div><h1>{meta.title}</h1><p>{meta.subtitle}</p></div>
        <div className="actions"><StatusPill status={status}/><button className="primary" disabled={running || !groups?.groups.length} onClick={() => void act({ type: "WORKER_RUN_NOW" })}>Chạy ngay</button></div></header>
      {tab === "overview" && <OverviewView state={state} status={status} groups={groups} act={act} goto={(next) => setTab(next as Tab)}/>}
      {tab === "groups" && <GroupsView groups={groups} running={running} act={act}/>}
      {tab === "results" && <ResultsView last={last}/>}
      {tab === "log" && <LogView state={state}/>}
      {tab === "settings" && <SettingsView/>}
    </main>
  </div>;
}

void sendWorker({ type: "WORKER_REFRESH_GROUPS" });
createRoot(document.getElementById("root")!).render(<App/>);
