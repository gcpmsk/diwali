/* =====================================================================
   SATYAM GOLD — /api/stock   (Authorization: Bearer CALL_ADMIN_TOKEN)
   Phase A: summary, ledger, alerts, ack, test_alert, limits / item settings (audit log के साथ)
   Phase C में: ledger auto IN/OUT, Chakki entry, Physical count, Stock Add, alerts engine.
   ===================================================================== */
import { json, authorized, connect, n8n } from '../_lib/call.js';

const num = v => (v === '' || v === null || v === undefined) ? null : Number(v);
async function audit(c, action, entity, detail) { await c.query('SELECT sgc_log($1,$2,$3,$4::jsonb)', ['owner', action, entity, JSON.stringify(detail || {})]); }

export async function onRequestGet({ request, env }) {
  if (!authorized(request, env)) return json({ ok: false, error: 'Access key required (CALL_ADMIN_TOKEN)' }, 401);
  const u = new URL(request.url); const view = u.searchParams.get('view') || 'summary'; let c;
  try {
    c = await connect(env);
    if (view === 'summary') {
      const items = (await c.query('SELECT sgs_summary() AS s')).rows[0].s;
      const today = (await c.query(`SELECT item, COALESCE(sum(qty) FILTER (WHERE qty>0),0)::float AS in_qty, COALESCE(-sum(qty) FILTER (WHERE qty<0),0)::float AS out_qty
        FROM sgs_ledger WHERE (at AT TIME ZONE 'Asia/Kolkata')::date=(now() AT TIME ZONE 'Asia/Kolkata')::date GROUP BY item`)).rows;
      const alerts = (await c.query(`SELECT id,item,level,status,message,qty,to_char(created_at AT TIME ZONE 'Asia/Kolkata','DD-MM HH12:MI AM') AS t,acked_by FROM sgs_alerts ORDER BY id DESC LIMIT 30`)).rows;
      return json({ ok: true, items, today, alerts });
    }
    if (view === 'ledger') {
      const item = u.searchParams.get('item');
      const r = await c.query(`SELECT id,item,qty::float AS qty,source,ref,note,by_who,to_char(at AT TIME ZONE 'Asia/Kolkata','DD-MM HH12:MI AM') AS t
        FROM sgs_ledger ${item ? 'WHERE item=$1' : ''} ORDER BY id DESC LIMIT 200`, item ? [item] : []);
      return json({ ok: true, ledger: r.rows });
    }
    return json({ ok: false, error: 'unknown view' }, 400);
  } catch (e) { return json({ ok: false, error: e.message }, 502); }
  finally { try { await c?.end(); } catch (_) {} }
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) return json({ ok: false, error: 'Access key required (CALL_ADMIN_TOKEN)' }, 401);
  let c;
  try {
    const b = await request.json().catch(() => ({}));
    c = await connect(env);
    if (b.action === 'ack') {
      const id = Number(b.id); if (!Number.isInteger(id)) return json({ ok: false, error: 'id required' }, 400);
      const r = (await c.query('SELECT sgs_event($1::jsonb) AS r', [JSON.stringify({ type: 'ack', id, by: 'app' })])).rows[0].r;
      const ev = await n8n(env, c, 'ack_alert', { id }); await audit(c, 'alert_ack', 'alert', { id });
      return json({ ok: true, result: r, n8n: ev });
    }
    if (b.action === 'test_alert') {
      const ev = await n8n(env, c, 'test_alert', { item: String(b.item || 'wheat'), level: String(b.level || 'warning'), test: true });
      return json({ ok: ev.ok, mode: ev.mode, message: ev.mode === 'mock' ? 'MOCK — n8n जुड़ा नहीं; असली WhatsApp/call नहीं गई' : (ev.ok ? 'Test alert n8n को भेजा' : 'n8n error: ' + ev.response) });
    }
    if (b.action === 'save_limits') {
      const item = String(b.item || ''); const dir = b.direction === 'high' ? 'high' : 'low';
      const w = num(b.warn), e = num(b.emergency), k = num(b.critical);
      for (const v of [w, e, k]) if (v !== null && (!Number.isFinite(v) || v < 0)) return json({ ok: false, error: 'limits ≥ 0 संख्या चाहिए' }, 400);
      const set = [w, e, k].filter(v => v !== null);
      const ordered = dir === 'low' ? (w === null || e === null || w >= e) && (e === null || k === null || e >= k) && (w === null || k === null || w >= k)
                                    : (w === null || e === null || w <= e) && (e === null || k === null || e <= k) && (w === null || k === null || w <= k);
      if (set.length && !ordered) return json({ ok: false, error: dir === 'low' ? 'Warning ≥ Emergency ≥ Critical होना चाहिए' : 'Warning ≤ Emergency ≤ Critical होना चाहिए' }, 400);
      const cde = Math.round(Number(b.cooldown_emergency_min ?? 120)), cdc = Math.round(Number(b.cooldown_critical_min ?? 15));
      if (!(cde >= 1 && cde <= 1440 && cdc >= 1 && cdc <= 1440)) return json({ ok: false, error: 'cooldown 1–1440 मिनट' }, 400);
      if (!(await c.query('SELECT 1 FROM sgs_items WHERE code=$1', [item])).rows.length) return json({ ok: false, error: 'unknown item' }, 400);
      const old = (await c.query('SELECT direction,warn,emergency,critical FROM sgs_limits WHERE item=$1', [item])).rows[0] || null;
      await c.query(`INSERT INTO sgs_limits(item,direction,warn,emergency,critical,cooldown_emergency_min,cooldown_critical_min) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (item) DO UPDATE SET direction=EXCLUDED.direction,warn=EXCLUDED.warn,emergency=EXCLUDED.emergency,critical=EXCLUDED.critical,
          cooldown_emergency_min=EXCLUDED.cooldown_emergency_min,cooldown_critical_min=EXCLUDED.cooldown_critical_min,updated_at=now()`, [item, dir, w, e, k, cde, cdc]);
      await audit(c, 'stock_limits', item, { from: old, to: { direction: dir, warn: w, emergency: e, critical: k } });
      return json({ ok: true });
    }
    if (b.action === 'save_item') {
      const code = String(b.code || ''); const pu = Number(b.per_unit);
      if (!(pu > 0 && pu <= 10000)) return json({ ok: false, error: 'per_unit > 0 चाहिए' }, 400);
      const r = await c.query('UPDATE sgs_items SET enabled=$2, per_unit=$3, name=COALESCE(NULLIF($4,\'\'),name) WHERE code=$1 RETURNING code', [code, b.enabled !== false, pu, String(b.name || '').slice(0, 80)]);
      if (!r.rows.length) return json({ ok: false, error: 'unknown item' }, 400);
      await audit(c, 'stock_item', code, { enabled: b.enabled !== false, per_unit: pu });
      return json({ ok: true });
    }
    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (e) { return json({ ok: false, error: e.message }, 502); }
  finally { try { await c?.end(); } catch (_) {} }
}
