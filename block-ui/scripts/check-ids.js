#!/usr/bin/env node
/**
 * Block identity check. Values come from env (../.env or ./.env): LARK_APP_ID, BLOCK_TYPE_ID, RANKFLOW_BASE_URL.
 * app.json / block.json only hold placeholders. With STRICT=1 (used by `npm run upload`) missing/placeholder values fail.
 * Also guards against hard-coded tbl…/fld… ids creeping back into src/ (tables/fields are resolved by name).
 */
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../build/env');
loadEnv();
const root = path.resolve(__dirname, '..');
const strict = process.env.STRICT === '1';
const errors = [];
const warnings = [];
const appId = process.env.LARK_APP_ID || JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).appId;
const blockTypeId = process.env.BLOCK_TYPE_ID || JSON.parse(fs.readFileSync(path.join(root, 'block.json'), 'utf8')).blockTypeID;
(/^cli_[0-9a-f]{16}$/.test(appId || '') ? [] : (strict ? errors : warnings)).push(`LARK_APP_ID not set / invalid (${appId})`);
(/^blk_[0-9a-f]{24}$/.test(blockTypeId || '') ? [] : (strict ? errors : warnings)).push(`BLOCK_TYPE_ID not set / invalid (${blockTypeId})`);

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
for (const file of walk(path.join(root, 'src'))) {
  const text = fs.readFileSync(file, 'utf8');
  const hit = text.match(/\b(tbl[A-Za-z0-9]{12,}|fld[A-Za-z0-9]{8,}|cli_[0-9a-f]{16}|blk_[0-9a-f]{24})\b/);
  if (hit) errors.push(`${path.relative(root, file)} contains a hard-coded id ${hit[1]}`);
}
for (const w of warnings) console.warn('WARN ' + w + ' (ok for local builds; required for upload)');
if (errors.length) {
  console.error('Block identity check FAILED:\n  - ' + errors.join('\n  - '));
  process.exit(1);
}
console.log('Block identity check OK' + (warnings.length ? ' (with warnings)' : ''));
