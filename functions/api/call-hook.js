/* =====================================================================
   SATYAM GOLD — /api/call-hook   (n8n → app; header  X-SG-Secret: N8N_SECRET)
   POST {action, ...data}   action =
     call_completed · order_upsert · rate_request_create · callback_create · wheat_offer_create
     get_customer_by_number · get_rates · get_stock_summary · stock_event
   सब काम वही SQL functions करते हैं जो n8n के Postgres node से भी चल सकते हैं (call-schema.sql).
   N8N_SECRET set न हो तो हर request 401 — inbound hook कभी "mock" में खुला नहीं रहता.
   Rate कभी payload से नहीं लिया जाता: order में rate Set Rate (sg_rates) से लगता है.
   ===================================================================== */
import { json, hookAuthorized, connect } from '../_lib/call.js';

const ACTIONS = {
  call_completed:        ['SELECT sgc_call_completed($1::jsonb) AS r', d => [JSON.stringify(d)]],
  order_upsert:          ['SELECT sgc_order_upsert($1::jsonb) AS r', d => [JSON.stringify(d)]],
  rate_request_create:   ['SELECT sgc_rate_request_create($1::jsonb) AS r', d => [JSON.stringify(d)]],
  callback_create:       ['SELECT sgc_callback_create($1::jsonb) AS r', d => [JSON.stringify(d)]],
  wheat_offer_create:    ['SELECT sgc_wheat_offer_create($1::jsonb) AS r', d => [JSON.stringify(d)]],
  get_customer_by_number:['SELECT sgc_get_customer_by_number($1) AS r', d => [String(d.phone || '')]],
  get_rates:             ['SELECT sgc_get_rates($1,$2) AS r', d => [String(d.ckey || d.name || ''), String(d.area || 'OTHER')]],
  get_stock_summary:     ['SELECT sgs_summary() AS r', () => []],
  stock_event:           ['SELECT sgs_event($1::jsonb) AS r', d => [JSON.stringify(d)]]
};

export async function onRequestPost({ request, env }) {
  if (!hookAuthorized(request, env)) return json({ ok: false, error: 'bad or missing X-SG-Secret' }, 401);
  let c;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ ok: false, error: 'JSON body required' }, 400);
    const action = String(body.action || body.event || '');
    const def = ACTIONS[action];
    if (!def) return json({ ok: false, error: 'unknown action: ' + action, actions: Object.keys(ACTIONS) }, 400);
    const data = body.data && typeof body.data === 'object' ? body.data : body;
    c = await connect(env);
    const r = await c.query(def[0], def[1](data));
    const out = r.rows[0]?.r;
    return json(out && typeof out === 'object' && !Array.isArray(out) ? { ok: true, ...out } : { ok: true, result: out });
  } catch (e) {
    const msg = String(e.message || e);
    // SQL function के RAISE EXCEPTION (validation) → 400; बाकी → 502
    return json({ ok: false, error: msg }, /required|invalid|unknown|positive|not found|must/i.test(msg) ? 400 : 502);
  } finally { try { await c?.end(); } catch (_) {} }
}
export async function onRequestGet({ request, env }) {
  return json({ ok: true, service: 'sg call-hook', note: 'POST with X-SG-Secret', secret_configured: !!env.N8N_SECRET });
}
