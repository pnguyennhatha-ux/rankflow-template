#!/usr/bin/env node
/** Owner logic tests (keyset diff + heatmap pivot): compiles the pure modules with tsc to a temp dir, then asserts. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const root = path.resolve(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-owner-'));
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck', '--esModuleInterop',
  '--jsx', 'react', '--outDir', out, '--rootDir', path.join(root, 'src'), 'src/data/keyset.ts', 'src/data/members.ts', 'src/utils/pivot.ts', 'src/utils/cellValue.ts'], { cwd: root, stdio: 'inherit' });
const ks = require(path.join(out, 'data/keyset.js'));
const pv = require(path.join(out, 'utils/pivot.js'));
const cv = require(path.join(out, 'utils/cellValue.js'));
const mb = require(path.join(out, 'data/members.js'));
const cfg = require(path.join(out, 'config.js'));

const OU1 = 'ou_' + '1'.repeat(32);
const OU2 = 'ou_' + '2'.repeat(32);
const A = 'B0AAAAAAAA', B = 'B0BBBBBBBB';
let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log(`  ✓ ${name}`); };

test('formatSaveError maps permission / B4 to a clear Vietnamese hint', () => {
  const vi = ks.formatSaveError({ code: 10214997, message: 'RecordPermissionDeniedError' });
  assert.match(vi, /Can edit/);
  assert.match(vi, /chỉ có quyền xem|Share/i);
  const b4 = ks.formatSaveError(new Error('Oops! Something went wrong. Please refresh the page and try again. (Error code:B4)'));
  assert.match(b4, /Can edit|quyền/i);
  assert.match(ks.formatSaveError(new Error('network boom')), /Lưu thất bại: network boom/);
  assert.equal(typeof ks.checkWritePermission, 'function');
});

test('date range follows new days after reload (sticky range hid new runs)', () => {
  const f = { dateFrom: '2026-09-23', dateTo: '2026-10-06', x: 1 };
  assert.deepEqual(pv.nextDateRange(f, { minDay: '2026-09-23', maxDay: '2026-10-06' }, { minDay: '2026-09-23', maxDay: '2026-10-07' }), { dateFrom: '2026-09-23', dateTo: '2026-10-07', x: 1 });
  assert.deepEqual(pv.nextDateRange({ dateFrom: '', dateTo: '' }, { minDay: '', maxDay: '' }, { minDay: '2026-09-23', maxDay: '2026-10-07' }), { dateFrom: '2026-09-23', dateTo: '2026-10-07' });
  const custom = { dateFrom: '2026-09-25', dateTo: '2026-09-29' };
  assert.equal(pv.nextDateRange(custom, { minDay: '2026-09-23', maxDay: '2026-10-06' }, { minDay: '2026-09-23', maxDay: '2026-10-07' }), custom);
  const last7 = { dateFrom: '2026-09-30', dateTo: '2026-10-06' };
  assert.equal(pv.nextDateRange(last7, { minDay: '2026-09-23', maxDay: '2026-10-06' }, { minDay: '2026-09-23', maxDay: '2026-10-07' }).dateTo, '2026-10-07');
});

test('asUser reads the first person of a user cell', () => {
  assert.deepEqual(cv.asUser([{ id: OU1, name: 'Hana', email: 'x' }]), { id: OU1, name: 'Hana' });
  assert.deepEqual(cv.asUser({ id: OU2, enName: 'Lan' }), { id: OU2, name: 'Lan' });
  assert.equal(cv.asUser([]), null);
  assert.equal(cv.asUser('Hana'), null);
  assert.equal(cv.userLabel({ id: OU2, name: null }), OU2);
});

const item = (recordId, asin, keyword, group, owner, enabled = true) => ({ recordId, watchlist_id: 'team-a', asin, keyword, enabled, group, owner });
const settings = { top: '190', zipOn: true, zip: '10001', sponsored: false, schedOn: false, schedDays: [], schedTime: '' };
const baseSettings = { recordId: 'w', watchlist_id: 'team-a', name: '', marketplace: 'amazon.com', zip: '10001', top_n: 190, sponsored: false, schedule_note: '', schedule_enabled: false, schedule_days: [], schedule_time: '' };

test('cards split by owner and an untouched load produces no diff', () => {
  const items = [item('r1', A, 'mug', 'G', { id: OU1, name: 'Hana' }), item('r2', A, 'cup', 'G', null), item('r3', B, 'mug', '', { id: OU2, name: 'Lan' })];
  const data = { mode: 'bitable', items, settings: baseSettings, owners: ks.knownOwners(items) };
  assert.deepEqual(data.owners.map((o) => o.name), ['Hana', 'Lan']);
  const { groups } = ks.groupsFromItems(items);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.ownerId).sort(), ['', OU1, OU2].sort());
  const diff = ks.computeDiff(data, groups.map(ks.parseGroup), settings);
  assert.equal(ks.hasChanges(diff), false, JSON.stringify(diff));
});

test('changing a card owner writes owner only to that card\'s pairs; new pairs carry it', () => {
  const items = [item('r1', A, 'mug', 'G', null), item('r2', A, 'cup', 'G', null), item('r3', B, 'tea', 'H', { id: OU2, name: 'Lan' })];
  const data = { mode: 'bitable', items, settings: baseSettings, owners: ks.knownOwners(items) };
  const { groups } = ks.groupsFromItems(items);
  const g = groups.find((x) => x.name === 'G');
  g.ownerId = OU2;
  g.kwText += '\nnew kw';
  const diff = ks.computeDiff(data, groups.map(ks.parseGroup), settings);
  assert.equal(diff.reowned.length, 2);
  assert.equal(diff.regrouped.length, 0);
  assert.deepEqual(diff._add.map((p) => [p.keyword, p.ownerId]), [['new kw', OU2]]);
  assert.deepEqual(diff._set.map((u) => [u.recordId, u.ownerId, u.group]).sort(), [['r1', OU2, undefined], ['r2', OU2, undefined]]);
});

test('clearing an owner sets ownerId "" (written as null)', () => {
  const items = [item('r1', A, 'mug', 'G', { id: OU1, name: 'Hana' })];
  const data = { mode: 'bitable', items, settings: baseSettings, owners: ks.knownOwners(items) };
  const { groups } = ks.groupsFromItems(items);
  groups[0].ownerId = '';
  const diff = ks.computeDiff(data, groups.map(ks.parseGroup), settings);
  assert.deepEqual(diff._set, [{ recordId: 'r1', enabled: true, ownerId: '' }]);
  assert.equal(diff.reowned[0].fromOwner, 'Hana');
});

const snap = (asin, keyword, day, owner_id, owner_name) => ({ asin, keyword, snapshot_day: day, organic_rank: 5, page_number: 1, position_on_page: 5, status: 'ranked', price_cents: null, run_id: 'r', group: 'G', owner_id, owner_name });
const filters = { asins: [], dateFrom: '', dateTo: '', onlyRankedKw: false, asinContains: '', keywordContains: '', groupContains: '', ownerId: '' };

test('heatmap: owner options, per-ASIN owners, keyword owner, owner filter', () => {
  const rows = [snap(A, 'mug', '2026-10-06', OU1, 'Hana'), snap(A, 'cup', '2026-10-06', OU2, 'Lan'), snap(B, 'tea', '2026-10-06', null, null)];
  assert.deepEqual(pv.ownerOptions(rows), [{ id: OU1, label: 'Hana' }, { id: OU2, label: 'Lan' }]);
  const p = pv.buildPivot(rows, filters);
  const a = p.asinGroups.find((g) => g.asin === A);
  assert.deepEqual(a.owners, ['Hana', 'Lan']);
  assert.deepEqual(a.keywordOwners, { cup: 'Lan', mug: 'Hana' });
  assert.deepEqual(pv.buildPivot(rows, { ...filters, ownerId: OU1 }).asinGroups.map((g) => [g.asin, g.keywords]), [[A, ['mug']]]);
  assert.deepEqual(pv.buildPivot(rows, { ...filters, ownerId: '-' }).asinGroups.map((g) => g.asin), [B]);
});

test('member table rows -> picker options (active only, person id first, avatar from URL cell)', () => {
  const F = cfg.MEMBER_FIELDS;
  const t = (x) => [{ type: 'text', text: x }];
  const rows = [
    { fields: { [F.name]: t('Thanh Nguyễn Văn'), [F.open_id]: t(OU1), [F.person]: [{ id: 'sdk-' + OU1, name: 'Thanh Nguyễn Văn' }], [F.en_name]: t('KEN'), [F.active]: true,
      [F.avatar_url]: [{ type: 'url', text: 'https://img/a.png', link: 'https://img/a.png' }], [F.departments]: t('ACME ORG') } },
    { fields: { [F.name]: t('Đặng Lan'), [F.open_id]: t(OU2), [F.active]: true, [F.avatar_url]: t('[https://img/b.png](https://img/b.png)') } },
    { fields: { [F.name]: t('Old Guy'), [F.open_id]: t('ou_old'), [F.active]: false } },
    { fields: { [F.name]: t('No flag'), [F.open_id]: t('ou_noflag') } },
  ];
  const m = mb.membersFromRows(rows);
  assert.deepEqual(m.map((o) => o.name), ['Đặng Lan', 'Thanh Nguyễn Văn']);
  const thang = m.find((o) => o.enName === 'KEN');
  assert.equal(thang.id, 'sdk-' + OU1); // the SDK's own id for the person cell is what gets written back
  assert.equal(thang.avatar, 'https://img/a.png');
  assert.equal(m.find((o) => o.id === OU2).avatar, 'https://img/b.png');
  const merged = mb.mergeOwnerOptions(m, [{ id: OU2, name: 'Lan' }, { id: 'ou_x', name: 'Ex Owner' }]);
  assert.deepEqual(merged.map((o) => [o.name, o.source]), [['Đặng Lan', 'member'], ['Ex Owner', 'owner'], ['Thanh Nguyễn Văn', 'member']]);
});

test('owner search is diacritics-insensitive over name / en name / department (not email)', () => {
  const opts = [{ id: '1', name: 'Thanh Nguyễn Văn', enName: 'KEN', departments: 'ACME ORG', source: 'member' },
    { id: '2', name: 'Đặng Lan', departments: 'Sales', source: 'member' }, { id: '3', name: 'Hana Nguyen', source: 'member' }];
  assert.deepEqual(mb.filterOwners(opts, 'thanh').map((o) => o.id), ['1']);
  assert.deepEqual(mb.filterOwners(opts, 'nguyen').map((o) => o.id), ['1', '3']);
  assert.deepEqual(mb.filterOwners(opts, 'dang').map((o) => o.id), ['2']);
  assert.deepEqual(mb.filterOwners(opts, 'ken').map((o) => o.id), ['1']);
  assert.deepEqual(mb.filterOwners(opts, 'sales').map((o) => o.id), ['2']);
  assert.equal(mb.filterOwners([{ id: '9', name: 'X', email: 'secret@x.com', source: 'member' }], 'secret').length, 0); // email is never searchable
  assert.deepEqual(mb.filterOwners(opts, 'hana nguyen').map((o) => o.id), ['3']);
  assert.equal(mb.filterOwners(opts, '  ').length, 3);
  assert.equal(mb.initials('Hana Nguyen'), 'HN');
});

fs.rmSync(out, { recursive: true, force: true });
console.log(`Owner logic OK (${n} tests)`);
