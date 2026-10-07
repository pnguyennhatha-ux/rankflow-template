import { defineConfig } from "wxt";

// Build output: extension/.output/chrome-mv3 (load this folder unpacked in chrome://extensions).
export default defineConfig({
  outDir: ".output",
  manifest: {
    name: "2J",
    short_name: "2J",
    description: "RankFlow worker: idles until the backend has a job, then crawls Amazon US organic keyword ranks in Chrome and reports results.",
    version: "0.3.5",
    icons: { 16: "icon-16.png", 32: "icon-32.png", 48: "icon-48.png", 128: "icon-128.png" },
    permissions: ["storage", "scripting", "notifications", "alarms"],
    host_permissions: ["http://localhost/*", "http://127.0.0.1/*", "https://www.amazon.com/*"],
    optional_host_permissions: ["https://*/*"],
    action: { default_title: "2J", default_popup: "popup.html", default_icon: { 16: "icon-16.png", 32: "icon-32.png" } },
    // Amazon product thumbnails in the dashboard/popup (images only; scripts stay 'self')
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; img-src 'self' data: https://m.media-amazon.com https://*.media-amazon.com https://images-na.ssl-images-amazon.com https://*.ssl-images-amazon.com" }
  }
});
