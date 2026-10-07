/** Loads ../.env (repo root) then ./.env (block-ui) into process.env without overriding existing vars. No secrets are needed here. */
const fs = require('fs');
const path = require('path');
function loadEnv() {
  for (const file of [path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '../.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const key = line.slice(0, i).trim();
      if (!(key in process.env)) process.env[key] = line.slice(i + 1).trim();
    }
  }
  return process.env;
}
/** Only these keys reach the browser bundle (never LARK_APP_SECRET). */
const PUBLIC_KEYS = ['LARK_APP_ID', 'BLOCK_TYPE_ID', 'RANKFLOW_BASE_URL', 'RANKFLOW_DEFAULT_WATCHLIST', 'RANKFLOW_ORG_LABEL', 'DEPTH'];
module.exports = { loadEnv, PUBLIC_KEYS };
