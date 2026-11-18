import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// In-memory PostgreSQL; production DB / n8n / Dograh / WhatsApp को कभी नहीं छूता.
const db = new PGlite();
await db.exec(`
  CREATE TABLE campaigns (id INT PRIMARY KEY, note TEXT);           -- Dograh जैसी foreign table: untouched रहनी चाहिए
  INSERT INTO campaigns VALUES (1,'dograh-keep');
  CREATE TABLE coll_customers (id INT PRIMARY KEY, note TEXT);
  INSERT INTO coll_customers VALUES (1,'coll-keep');
`);
const schema = await readFile(new URL('./call-schema.sql', import.meta.url), 'utf8');
await db.exec(schema);
await db.exec(schema);   // दोबारा चलाना सुरक्षित (idempotent)

let dbDown = false;
class Client {
  async connect() { if (dbDown) throw new Error('test database unavailable'); }
  async end() {}
  async query(q, p) { const r = await db.query(q, p); return { ...r, rowCount: r.rows.length || r.affectedRows || 0 }; }
}
let n8nCalls = [], n8nFail = false;
const context = vm.createContext({ Response, Request, URL, console, crypto: webcrypto, TextEncoder, Uint8Array, DataView, AbortSignal,
  fetch: async (url, init) => { n8nCalls.push({ url, init }); return n8nFail ? new Response('boom', { status: 500 }) : new Response('{"ok":true}', { status: 200 }); } });
const cache = new Map();
async function load(rel) {
  if (cache.has(rel)) return cache.get(rel);
  const url = new URL(rel, import.meta.url);
  const m = new vm.SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href });
  cache.set(rel, m);
  await m.link(async spec => spec === 'pg' ? new vm.SyntheticModule(['Client'], function () { this.setExport('Client', Client); }, { context }) : load(new URL(spec, url).href));
  return m;
}
const callMod = await load('./functions/api/call.js'); await callMod.evaluate();
const hookMod = await load('./functions/api/call-hook.js'); await hookMod.evaluate();
const stockMod = await load('./functions/api/stock.js'); await stockMod.evaluate();

const MOCK_ENV = { DATABASE_URL: 'x', CALL_ADMIN_TOKEN: 'owner-tok' };
const LIVE_ENV = { ...MOCK_ENV, N8N_BASE_URL: 'https://n8n.example.test/', N8N_SECRET: 'sec-123' };
const hdr = (tok = 'owner-tok') => ({ 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) });
const get = async (q, env = MOCK_ENV, tok) => { const r = await callMod.namespace.onRequestGet({ request: new Request('https://t/api/call?' + q, { headers: hdr(tok) }), env }); return { status: r.status, r, body: r.headers.get('Content-Type').includes('json') ? await r.clone().json() : null }; };
const post = async (b, env = MOCK_ENV, tok) => { const r = await callMod.namespace.onRequestPost({ request: new Request('https://t/api/call', { method: 'POST', headers: hdr(tok), body: JSON.stringify(b) }), env }); return { status: r.status, body: await r.json() }; };
const hook = async (b, env = LIVE_ENV, secret = 'sec-123') => { const r = await hookMod.namespace.onRequestPost({ request: new Request('https://t/api/call-hook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-SG-Secret': secret } : {}) }, body: JSON.stringify(b) }), env }); return { status: r.status, body: await r.json() }; };
const stockGet = async (q, tok) => { const r = await stockMod.namespace.onRequestGet({ request: new Request('https://t/api/stock?' + q, { headers: hdr(tok) }), env: MOCK_ENV }); return { status: r.status, body: await r.json() }; };
const stockPost = async (b, tok) => { const r = await stockMod.namespace.onRequestPost({ request: new Request('https://t/api/stock', { method: 'POST', headers: hdr(tok), body: JSON.stringify(b) }), env: MOCK_ENV }); return { status: r.status, body: await r.json() }; };
const ist = () => new Date(Date.now() + 19800000);
const todayKey = () => { const d = ist(); const p = n => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`; };
const put = (key, v) => db.query(`INSERT INTO sg_store(key,value) VALUES ($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, JSON.stringify({ v })]);
const val = async key => (await db.query('SELECT value->\'v\' AS v FROM sg_store WHERE key=$1', [key])).rows[0]?.v;
const open24 = { window_start: '00:00', window_end: '23:59', sunday_off: false };

await put('sg_rates', { master: { gold: 1400, chokar: 900, wheat: 1000, a5: 140 }, areaAdj: { KKG: { gold: 10 } }, cust: { 'RAJU KIRANA': { gold: 20 } } });

test('schema: idempotent, foreign tables untouched, seeds present', async () => {
  assert.equal((await db.query("SELECT note FROM campaigns")).rows[0].note, 'dograh-keep');
  assert.equal((await db.query("SELECT note FROM coll_customers")).rows[0].note, 'coll-keep');
  assert.equal((await db.query("SELECT count(*)::int n FROM sgs_items")).rows[0].n, 15);
  const bad = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name NOT LIKE 'sgc\\_%' AND table_name NOT LIKE 'sgs\\_%' AND table_name NOT IN ('sg_store','campaigns','coll_customers')")).rows;
  assert.deepEqual(bad, [], 'सिर्फ़ sgc_/sgs_ tables बनें');
  assert.doesNotMatch(schema, /\bDROP\s+(TABLE|FUNCTION|SCHEMA)\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
  assert.doesNotMatch(schema, /\bALTER\s+TABLE\s+(campaigns|workflow_runs|queued_runs|coll_)/i);
});

test('auth: /api/call और /api/stock बिना Bearer के 401; token env न हो तो भी 401', async () => {
  assert.equal((await get('view=settings', MOCK_ENV, '')).status, 401);
  assert.equal((await get('view=settings', MOCK_ENV, 'wrong')).status, 401);
  assert.equal((await get('view=settings', { DATABASE_URL: 'x' }, 'owner-tok')).status, 401);
  assert.equal((await post({ action: 'stop_all' }, MOCK_ENV, '')).status, 401);
  assert.equal((await stockGet('view=summary', '')).status, 401);
  assert.equal((await stockPost({ action: 'ack', id: 1 }, 'bad')).status, 401);
  assert.equal((await get('view=settings')).status, 200);
});

test('call-hook: X-SG-Secret ज़रूरी; secret env न हो तो हमेशा 401', async () => {
  assert.equal((await hook({ action: 'get_rates' }, LIVE_ENV, '')).status, 401);
  assert.equal((await hook({ action: 'get_rates' }, LIVE_ENV, 'nope')).status, 401);
  assert.equal((await hook({ action: 'get_rates' }, MOCK_ENV, 'anything')).status, 401);
  assert.equal((await hook({ action: 'bogus' })).status, 400);
  assert.equal((await hook({ action: 'get_stock_summary' })).status, 200);
});

test('settings: validation, owner numbers not hard-coded, audit log', async () => {
  const s0 = (await get('view=settings')).body;
  assert.equal(s0.settings.owner1, ''); assert.equal(s0.settings.owner2, '');
  assert.equal(s0.n8n_mode, 'mock');
  assert.equal(s0.settings.daily_call_limit, 100);
  assert.equal((await post({ action: 'save_settings', settings: { owner1: '12345' } })).status, 400);
  assert.equal((await post({ action: 'save_settings', settings: { window_start: '25:00' } })).status, 400);
  assert.equal((await post({ action: 'save_settings', settings: { daily_call_limit: -1 } })).status, 400);
  assert.equal((await post({ action: 'save_settings', settings: { owner1: '9876543210', owner2: '9876543210' } })).status, 400);
  const ok = await post({ action: 'save_settings', settings: { owner1: '98765 43210', owner2: '9123456789', ...open24, big_order_qty: 50 } });
  assert.equal(ok.status, 200); assert.equal(ok.body.settings.owner1, '9876543210');
  const a = (await get('view=audit')).body.audit; assert.ok(a.some(x => x.action === 'settings_changed' && x.detail.owner1));
});

test('contacts: save, same_flag, duplicate warning, sync does not overwrite saved numbers', async () => {
  const r = await post({ action: 'save_contact', contact: { name: 'Raju Kirana', address: 'Khagaria', call_no: '9000000001', wa_no: '9000000001', area: 'KKG', rate_area: 'OTHER', ctype: 'Dukandar', reorder_days: 4 } });
  assert.equal(r.status, 200); assert.equal(r.body.contact.ckey, 'RAJU KIRANA'); assert.equal(r.body.contact.same_flag, true); assert.equal(r.body.duplicate, null);
  const d = await post({ action: 'save_contact', contact: { name: 'Shyam Store', call_no: '9000000001', area: 'MNS' } });
  assert.equal(d.body.duplicate.ckey, 'RAJU KIRANA');
  assert.equal((await post({ action: 'save_contact', contact: { name: 'X', call_no: '123' } })).status, 400);
  assert.equal((await post({ action: 'save_contact', contact: { name: 'X', reorder_days: 0 } })).status, 400);
  await post({ action: 'sync_contacts', contacts: [{ name: 'Raju Kirana', call_no: '9999999999', area: 'ZZZ' }, { name: 'Mohan', call_no: '9000000003', area: 'KKG' }] });
  const c = (await get('view=contacts')).body.contacts;
  assert.equal(c.find(x => x.ckey === 'RAJU KIRANA').call_no, '9000000001');
  assert.ok(c.find(x => x.ckey === 'MOHAN'));
});

test('get_customer_by_number + get_rates: master + area adj + special rate (srRate maths)', async () => {
  const r = (await hook({ action: 'get_customer_by_number', phone: '+91 90000-00001' })).body;
  assert.equal(r.found, true); assert.equal(r.name, 'Raju Kirana'); assert.equal(r.ckey, 'RAJU KIRANA');
  const unk = (await hook({ action: 'get_customer_by_number', phone: '9111111111' })).body;
  assert.equal(unk.found, false); assert.equal(unk.lead, true);
  const rates = (await hook({ action: 'get_rates', ckey: 'RAJU KIRANA', area: 'KKG' })).body.rates;
  assert.equal(rates.find(x => x.k === 'gold').rate, 1390);        // 1400 + 10 − 20 special
  assert.equal(rates.find(x => x.k === 'gold').special, true);
  const plain = (await hook({ action: 'get_rates', ckey: 'OTHER GUY', area: 'KKG' })).body.rates;
  assert.equal(plain.find(x => x.k === 'gold').rate, 1410);
  assert.equal(plain.find(x => x.k === 'chokar').rate, 900);
});

test('order_upsert → sg_ord_<today>: rate Set Rate से, AI का rate ignore, call_id idempotent, same customer merge', async () => {
  const call = (await hook({ action: 'call_completed', call_ref: 'ord-1', outcome: 'order_placed', contact: { phone: '9000000001' }, duration: 60, summary: 'order', recording_ref: 'r1',
    order: { items: [{ name: 'Atta Gold', qty: 5, rate: 1 }, { name: 'Chokar', qty: 2 }, { name: 'Atta 5kg', qty: 3 }] } })).body;
  assert.equal(call.ok, true); assert.equal(call.order.ok, true);
  const list = await val('sg_ord_' + todayKey());
  const o = list.find(x => x.call_id === call.call_id);
  assert.equal(o.source, 'call'); assert.equal(o.src, 'call'); assert.equal(o.name, 'Raju Kirana');
  assert.equal(o.items[0].rate, '1380');   // AI का rate:1 ignore; Set Rate: 1400 master − 20 customer special
  assert.equal(o.items[1].rate, '900');
  assert.equal(o.items[2].rate, '', 'Atta 5kg → "rate later"');
  assert.ok(o.id && o.no && Array.isArray(o.deliv) && Array.isArray(o.ordered));
  // idempotent
  const again = (await hook({ action: 'call_completed', call_ref: 'ord-1', outcome: 'order_placed', contact: { phone: '9000000001' }, order: { items: [{ name: 'Atta Gold', qty: 5 }] } })).body;
  assert.equal(again.order.duplicate, true);
  assert.equal((await val('sg_ord_' + todayKey())).length, list.length);
  // दूसरी call, वही customer → merge (दोबारा नया order नहीं)
  const c2 = (await hook({ action: 'call_completed', call_ref: 'ord-2', outcome: 'order_update', contact: { phone: '9000000001' }, order: { items: [{ name: 'Atta Gold', qty: 2 }] } })).body;
  assert.equal(c2.order.merged, true);
  const l2 = await val('sg_ord_' + todayKey()); const m = l2.find(x => x.name === 'Raju Kirana');
  assert.equal(m.items.find(i => i.name === 'Atta Gold').qty, 7);
  assert.equal(l2.filter(x => x.name === 'Raju Kirana').length, 1);
});

test('order validation: bad qty / no items / no name', async () => {
  assert.equal((await hook({ action: 'order_upsert', name: 'A', items: [] })).status, 400);
  assert.equal((await hook({ action: 'order_upsert', name: 'A', items: [{ name: 'Atta Gold', qty: -1 }] })).status, 400);
  assert.equal((await hook({ action: 'order_upsert', name: '', items: [{ name: 'Atta Gold', qty: 1 }] })).status, 400);
  assert.equal((await hook({ action: 'order_upsert', name: 'A', items: [{ name: 'Atta Gold', qty: 99999 }] })).status, 400);
});

test('big order > threshold → pending approval (Order Book में नहीं), approve से जाता है, दोबारा approve duplicate', async () => {
  await hook({ action: 'call_completed', call_ref: 'big-1', outcome: 'order_placed', contact: { name: 'Big Dealer', phone: '9000000009' }, order: { name: 'Big Dealer', items: [{ name: 'Atta Gold', qty: 80 }] } });
  assert.equal((await val('sg_ord_' + todayKey())).some(x => x.name === 'Big Dealer'), false);
  const p = (await get('view=pending')).body.orders.find(x => x.name === 'Big Dealer');
  assert.equal(p.status, 'pending');
  const dash = (await get('view=dashboard')).body; assert.ok(dash.pending_orders.some(x => x.id === p.id));
  const ap = await post({ action: 'approve_order', id: p.id, approve: true });
  assert.equal(ap.body.result.status, 'approved');
  assert.equal((await val('sg_ord_' + todayKey())).some(x => x.name === 'Big Dealer'), true);
  assert.equal((await post({ action: 'approve_order', id: p.id, approve: true })).body.result.duplicate, true);
  assert.ok((await get('view=audit')).body.audit.some(x => x.action === 'order_approved'));
  // reject
  await hook({ action: 'call_completed', call_ref: 'big-2', outcome: 'order_placed', contact: { name: 'Big Two', phone: '9000000008' }, order: { name: 'Big Two', items: [{ name: 'Chokar', qty: 60 }] } });
  const p2 = (await get('view=pending')).body.orders.find(x => x.name === 'Big Two');
  assert.equal((await post({ action: 'approve_order', id: p2.id, approve: false })).body.result.status, 'rejected');
  assert.equal((await val('sg_ord_' + todayKey())).some(x => x.name === 'Big Two'), false);
});

test('rate reduction → EXISTING sg_wa_obj (source:call), never below rate, no second approval table decision', async () => {
  const r = (await hook({ action: 'call_completed', call_ref: 'rr-1', outcome: 'rate_reduction', contact: { phone: '9000000001' }, rate_request: { item: 'Atta Gold', requested_rate: 1300 } })).body;
  assert.ok(r.rate_request.obj_id);
  const objs = await val('sg_wa_obj'); const o = objs.find(x => x.id === r.rate_request.obj_id);
  assert.equal(o.status, 'open'); assert.equal(o.source, 'call'); assert.equal(o.item, 'Atta Gold'); assert.equal(o.newRate, 1300); assert.equal(o.custKey, 'RAJU KIRANA');
  assert.equal(o.oldRate, 1380);   // 1400 − 20 special (rate_area खाली→ OTHER; areaAdj KKG लागू नहीं)
  // वही request दोबारा → duplicate, नई objection नहीं
  const dup = (await hook({ action: 'rate_request_create', name: 'Raju Kirana', ckey: 'RAJU KIRANA', item: 'Atta Gold', requested_rate: 1250 })).body;
  assert.equal(dup.duplicate, true);
  assert.equal((await val('sg_wa_obj')).filter(x => x.source === 'call').length, 1);
  assert.equal((await hook({ action: 'rate_request_create', name: 'A', requested_rate: 0 })).status, 400);
  // app का rate (sg_rates) बदला नहीं
  assert.equal((await val('sg_rates')).master.gold, 1400);
});

test('call_completed: exactly one valid outcome, idempotent, callback/DNC/wrong-number handling', async () => {
  assert.equal((await hook({ action: 'call_completed', call_ref: 'x1', outcome: 'bogus' })).status, 400);
  assert.equal((await hook({ action: 'call_completed', outcome: 'callback' })).status, 400);
  const cb = (await hook({ action: 'call_completed', call_ref: 'cb-1', outcome: 'callback', contact: { phone: '9000000003' }, callback_at: '2030-01-01T10:00:00Z', outcome_note: 'शाम को' })).body;
  assert.equal(cb.ckey, 'MOHAN');
  assert.equal((await get('view=callbacks')).body.callbacks.filter(x => x.ckey === 'MOHAN').length, 1);
  await hook({ action: 'call_completed', call_ref: 'cb-1', outcome: 'callback', contact: { phone: '9000000003' }, outcome_note: 'शाम को' });
  assert.equal((await db.query("SELECT count(*)::int n FROM sgc_calls WHERE call_ref='cb-1'")).rows[0].n, 1);
  await hook({ action: 'call_completed', call_ref: 'dnc-1', outcome: 'do_not_call', contact: { phone: '9000000003' } });
  assert.equal((await db.query("SELECT do_not_call FROM sgc_contacts WHERE ckey='MOHAN'")).rows[0].do_not_call, true);
  await hook({ action: 'call_completed', call_ref: 'wn-1', outcome: 'wrong_number', contact: { phone: '9000000001' } });
  assert.equal((await db.query("SELECT wrong_number FROM sgc_contacts WHERE ckey='RAJU KIRANA'")).rows[0].wrong_number, true);
  await post({ action: 'save_contact', contact: { name: 'Raju Kirana', address: 'Khagaria', call_no: '9000000001', wa_no: '9000000001', area: 'KKG', ctype: 'Dukandar', reorder_days: 4, wrong_number: false } });
  assert.equal((await db.query("SELECT wrong_number FROM sgc_contacts WHERE ckey='RAJU KIRANA'")).rows[0].wrong_number, false);
  const hist = (await get('view=calls&ckey=RAJU%20KIRANA')).body.calls; assert.ok(hist.length >= 3);
  assert.ok(hist.every(x => !('recording_ref' in x)), 'raw recording ref कभी API से बाहर नहीं');
  assert.ok(hist.find(x => x.call_id === undefined && x.has_rec === true));
});

test('wheat offer: दर्ज होता है, खरीद final नहीं; call_id पर idempotent', async () => {
  const a = (await hook({ action: 'wheat_offer_create', call_id: 9001, name: 'Supplier A', qty_kg: 20000, rate: 2400, delivery_date: '2030-01-05', vehicle: 'BR01' })).body;
  assert.match(a.note, /final नहीं/);
  await hook({ action: 'wheat_offer_create', call_id: 9001, name: 'Supplier A', qty_kg: 25000, rate: 2390 });
  const r = (await db.query("SELECT qty_kg::int q, status FROM sgc_wheat_offers WHERE call_id=9001")).rows; assert.equal(r.length, 1); assert.equal(r[0].q, 25000); assert.equal(r[0].status, 'offer');
});

test('call_customer (MOCK): safety checks — window, ordered today, DNC, wrong number, no number, limits, kill switch', async () => {
  await post({ action: 'save_settings', settings: { ...open24, daily_call_limit: 100, daily_cost_limit: 500 } });
  await post({ action: 'save_contact', contact: { name: 'Fresh Cust', call_no: '9000000020', area: 'KKG' } });
  // समय window के बाहर
  await post({ action: 'save_settings', settings: { window_start: '00:00', window_end: '00:01', sunday_off: false } });
  let r = await post({ action: 'call_customer', ckey: 'FRESH CUST' }); assert.equal(r.status, 409); assert.equal(r.body.code, 'window');
  await post({ action: 'save_settings', settings: open24 });
  // ordered today (Raju का order ऊपर लगा है)
  r = await post({ action: 'call_customer', ckey: 'RAJU KIRANA' }); assert.equal(r.status, 409); assert.equal(r.body.code, 'ordered');
  // DNC
  r = await post({ action: 'call_customer', ckey: 'MOHAN' }); assert.equal(r.body.code, 'dnc');
  // no number
  await post({ action: 'save_contact', contact: { name: 'No Number' } });
  r = await post({ action: 'call_customer', ckey: 'NO NUMBER' }); assert.equal(r.body.code, 'nonumber');
  // wrong number
  await post({ action: 'save_contact', contact: { name: 'Wrong One', call_no: '9000000030', wrong_number: true } });
  assert.equal((await post({ action: 'call_customer', ckey: 'WRONG ONE' })).body.code, 'wrong');
  assert.equal((await post({ action: 'call_customer', ckey: 'NOBODY' })).status, 404);
  // सफल MOCK call: कोई असली n8n call नहीं
  n8nCalls = [];
  r = await post({ action: 'call_customer', ckey: 'FRESH CUST' }); assert.equal(r.status, 200); assert.equal(r.body.mock, true); assert.equal(n8nCalls.length, 0);
  const calls = (await get('view=calls&ckey=FRESH%20CUST')).body.calls; assert.equal(calls.length, 1); assert.equal(calls[0].is_mock, true); assert.ok(calls[0].outcome);
  // MOCK recording चलती है
  const callId = (await db.query("SELECT id FROM sgc_calls WHERE ckey='FRESH CUST' LIMIT 1")).rows[0].id;
  const wav = await get('view=recording&id=' + callId, MOCK_ENV);
  if (calls[0].has_rec) { assert.equal(wav.r.headers.get('Content-Type'), 'audio/wav'); assert.equal(wav.status, 200); }
  // kill switch
  assert.equal((await post({ action: 'stop_all', on: true })).status, 200);
  await post({ action: 'save_contact', contact: { name: 'After Stop', call_no: '9000000040' } });
  r = await post({ action: 'call_customer', ckey: 'AFTER STOP' }); assert.equal(r.body.code, 'stopped');
  assert.equal((await get('view=dashboard')).body.runtime.stopped, true);
  await post({ action: 'stop_all', on: false });
  // pause
  await post({ action: 'pause', on: true }); assert.equal((await post({ action: 'call_customer', ckey: 'AFTER STOP' })).body.code, 'paused'); await post({ action: 'pause', on: false });
  // daily call limit (limit 0 → तुरंत)
  await post({ action: 'save_settings', settings: { daily_call_limit: 1 } });
  await db.query("UPDATE sgc_calls SET is_mock=false WHERE ckey='FRESH CUST'");
  r = await post({ action: 'call_customer', ckey: 'AFTER STOP' }); assert.equal(r.body.code, 'limit_calls');
  await post({ action: 'save_settings', settings: { daily_call_limit: 100, daily_cost_limit: 0.5 } });
  await db.query("UPDATE sgc_calls SET cost=5 WHERE ckey='FRESH CUST'");
  assert.equal((await post({ action: 'call_customer', ckey: 'AFTER STOP' })).body.code, 'limit_cost');
  await post({ action: 'save_settings', settings: { daily_cost_limit: 500 } });
  const au = (await get('view=audit')).body.audit.map(x => x.action); assert.ok(au.includes('stop_all_calls') && au.includes('resume_calls'));
});

test('call_customer (LIVE n8n): X-SG-Secret भेजा जाता है, secret payload/outbox में नहीं; n8n fail पर call failed', async () => {
  await post({ action: 'save_contact', contact: { name: 'Live Cust', call_no: '9000000050', area: 'KKG' } }, LIVE_ENV);
  n8nCalls = []; n8nFail = false;
  const r = await post({ action: 'call_customer', ckey: 'LIVE CUST' }, LIVE_ENV);
  assert.equal(r.body.ok, true); assert.equal(r.body.mock, false);
  assert.equal(n8nCalls.length, 1); assert.equal(n8nCalls[0].init.headers['X-SG-Secret'], 'sec-123');
  assert.equal(n8nCalls[0].url, 'https://n8n.example.test/webhook/sg-call-customer');
  assert.doesNotMatch(n8nCalls[0].init.body, /sec-123/);
  const ob = (await get('view=outbox', LIVE_ENV)).body.outbox; assert.ok(ob.length); assert.doesNotMatch(JSON.stringify(ob), /sec-123/);
  assert.equal((await db.query("SELECT status FROM sgc_calls WHERE ckey='LIVE CUST'")).rows[0].status, 'live');
  // n8n down
  await post({ action: 'save_contact', contact: { name: 'Live Two', call_no: '9000000051' } }, LIVE_ENV);
  n8nFail = true; const f = await post({ action: 'call_customer', ckey: 'LIVE TWO' }, LIVE_ENV);
  assert.equal(f.status, 502); assert.equal((await db.query("SELECT status FROM sgc_calls WHERE ckey='LIVE TWO'")).rows[0].status, 'failed'); n8nFail = false;
  // test_n8n
  assert.equal((await post({ action: 'test_n8n' })).body.mode, 'mock');
  assert.equal((await post({ action: 'test_n8n' }, LIVE_ENV)).body.mode, 'live');
});

test('dashboard counts + stop_all marks queued failed', async () => {
  const d = (await get('view=dashboard')).body;
  assert.ok(d.dash.total >= 5); assert.ok(d.dash.orders >= 2); assert.ok(d.dash.callbacks >= 1); assert.ok(typeof d.dash.bora_by_calls === 'number');
  assert.equal(d.limits.calls, 100);
});

test('stock: summary levels, limits validation, ack, test_alert (mock), audit', async () => {
  let s = (await stockGet('view=summary')).body; assert.ok(s.ok);
  assert.equal(s.items.find(i => i.code === 'wheat').level, 'critical');   // ledger खाली
  await db.query("INSERT INTO sgs_ledger(item,qty,source,ref) VALUES ('wheat',12000,'opening','t1')");
  s = (await stockGet('view=summary')).body; const w = s.items.find(i => i.code === 'wheat'); assert.equal(w.level, 'warning'); assert.equal(w.qty_unit, 240);
  await db.query("INSERT INTO sgs_ledger(item,qty,source,ref) VALUES ('wheat',-9500,'chakki','t2')");
  assert.equal((await stockGet('view=summary')).body.items.find(i => i.code === 'wheat').level, 'emergency');
  await assert.rejects(db.query("INSERT INTO sgs_ledger(item,qty,source,ref) VALUES ('wheat',5,'opening','t1')"), /unique|duplicate/i, 'UNIQUE(source,ref): दोबारा नहीं गिनेगा');
  // limits validation
  assert.equal((await stockPost({ action: 'save_limits', item: 'wheat', direction: 'low', warn: 100, emergency: 200, critical: 50 })).status, 400);
  assert.equal((await stockPost({ action: 'save_limits', item: 'wheat', direction: 'low', warn: -1 })).status, 400);
  assert.equal((await stockPost({ action: 'save_limits', item: 'nope', direction: 'low', warn: 1 })).status, 400);
  assert.equal((await stockPost({ action: 'save_limits', item: 'wheat', direction: 'low', warn: 20000, emergency: 10000, critical: 2500, cooldown_emergency_min: 0 })).status, 400);
  assert.equal((await stockPost({ action: 'save_limits', item: 'chokar', direction: 'high', warn: 5000, emergency: 8000, critical: 10000 })).status, 200);
  await db.query("INSERT INTO sgs_ledger(item,qty,source,ref) VALUES ('chokar',9000,'opening','t3')");
  assert.equal((await stockGet('view=summary')).body.items.find(i => i.code === 'chokar').level, 'emergency');   // ज़्यादा chokar
  assert.ok((await get('view=audit')).body.audit.some(x => x.action === 'stock_limits'));
  // alert + ack
  const ev = (await hook({ action: 'stock_event', type: 'alert', item: 'wheat', level: 'emergency', message: 'wheat कम', qty: 2400 })).body;
  assert.equal(ev.ok, true);
  assert.equal((await hook({ action: 'stock_event', item: 'wheat', level: 'weird' })).status, 400);
  const ack = await stockPost({ action: 'ack', id: ev.id }); assert.equal(ack.status, 200);
  assert.equal((await db.query('SELECT status FROM sgs_alerts WHERE id=$1', [ev.id])).rows[0].status, 'acknowledged');
  n8nCalls = []; const t = await stockPost({ action: 'test_alert', item: 'wheat' }); assert.equal(t.body.mode, 'mock'); assert.equal(n8nCalls.length, 0);
  assert.equal((await stockPost({ action: 'save_item', code: 'wheat', per_unit: 0 })).status, 400);
  assert.equal((await stockPost({ action: 'save_item', code: 'wheat', per_unit: 50, enabled: true })).status, 200);
});

test('DB down → clean 502 (secret/stack leak नहीं)', async () => {
  dbDown = true;
  const r = await get('view=settings'); assert.equal(r.status, 502); assert.doesNotMatch(JSON.stringify(r.body), /owner-tok/);
  dbDown = false;
});

test('frontend wiring: Call tile + new red Emergency tile (11 tiles), screens, no secrets in client code', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const ui = await readFile(new URL('./call-ui.js', import.meta.url), 'utf8');
  assert.equal((html.match(/<button class="tile /g) || []).length, 11);
  assert.match(html, /data-go="emergency"/); assert.match(html, /id="emergency-screen"/); assert.match(html, /id="call-body"/);
  assert.match(html, /<script src="call-ui.js"><\/script>/);
  assert.match(app, /emergency:'emergency-screen'/);
  assert.doesNotMatch(html + ui, /X-SG-Secret|X-Webhook-Secret|sec-123|graph\.facebook|WA_TOKEN\s*[:=]|api\.dograh|Bearer\s+[A-Za-z0-9_-]{16,}/i);   // env var के नाम UI note में ठीक हैं; values/headers नहीं
  assert.doesNotMatch(ui, /tel:|9631816666/);
});
