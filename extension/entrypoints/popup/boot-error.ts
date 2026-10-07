/** If the popup bundle throws, show the error instead of an empty (invisible) popup. */
export function showFatal(error: unknown) {
  const root = document.getElementById("root");
  // only when React never rendered (the static fallback is still there); later errors keep the live UI
  if (!root || !root.querySelector("[data-fallback]")) return;
  const box = document.createElement("main");
  box.innerHTML = `<div class="box"><b class="bad">2J popup lỗi</b><small></small></div>`;
  box.querySelector("small")!.textContent = error instanceof Error ? error.message : String(error);
  root.replaceChildren(box);
}
