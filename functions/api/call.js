/* =====================================================================
   SATYAM GOLD — /api/call   (Owner/Manager; Authorization: Bearer CALL_ADMIN_TOKEN)
   GET  ?view=settings | dashboard | contacts | calls&ckey= | recording&id= | callbacks | pending | outbox | audit
   POST {action:'save_settings', settings}      → Settings (audit log के साथ)
        {action:'sync_contacts', contacts:[…]}  → नए customers insert; मौजूद में सिर्फ़ खाली fields भरो
        {action:'save_contact', contact}        → एक customer
        {action:'call_customer', ckey}          → एक customer को call (सब safety checks के बाद)
        {action:'stop_all', on:true|false}      → Kill switch      {action:'pause', on}
        {action:'test_n8n'}                     → n8n connection test
        {action:'approve_order', id, approve}   → बड़ा order approve/reject
        {action:'callback_done', id}
   n8n चालू न हो (N8N_BASE_URL/N8N_SECRET नहीं) → MOCK: नकली पर realistic नतीजा, कोई असली call नहीं.
   ===================================================================== */
import { json, authorized, connect, getSettings, getRuntime, setRuntime, cleanSettings, inWindow, n8n, n8nMode,
  mockResult, mockWav, last10 } from '../_lib/call.js';

const CTYPES = ['Customer', 'Dukandar', 'Hotel', 'Wheat Supplier', 'Other'];
const DMY = /^\d{2}-\d{2}-\d{4}$/;
const IST_TODAY = "(started_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date";
const keyOf = t => String(t || '').trim().toUpperCase().replace(/\s+/g, ' ');
const s = (v, n = 200) => String(v ?? '').slice(0, n);

async function audit(c, action, entity, detail, actor = 'owner') {
  await c.query('SELECT sgc_log($1,$2,$3,$4::jsonb)', [actor, action, entity, JSON.stringify(detail || {})]);
}

/* एक contact row साफ़ करके तैयार (insert/update दोनों के लिए) */
function cleanContact(x) {
  const ckey = keyOf(x.ckey || x.name); if (!ckey) throw new Error('name/ckey required');
  const call_no = last10(x.call_no), wa_no = last10(x.wa_no);
  if (call_no && call_no.length !== 10) throw new Error('Call No 10 अंक का होना चाहिए');
  if (wa_no && wa_no.length !== 10) throw new Error('WhatsApp No 10 अंक का होना चाहिए');
  const ctype = CTYPES.includes(x.ctype) ? x.ctype : 'Customer';
  const rd = x.reorder_days === undefined || x.reorder_days === '' ? 3 : Number(x.reorder_days);
  if (!Number.isInteger(rd) || rd < 1 || rd > 60) throw new Error('reorder_days 1–60');
  return { ckey, name: s(x.name || ckey, 120), address: s(x.address, 200), call_no, wa_no, same_flag: !!x.same_flag || (!!call_no && call_no === wa_no),
    area: s(x.area, 10), rate_area: s(x.rate_area, 20), ctype, reorder_days: rd, best_time: s(x.best_time, 40),
    do_not_call: !!x.do_not_call, wrong_number: !!x.wrong_number, notes: s(x.notes, 1000) };
}

export async function onRequestGet({ request, env }) {
  if (!authorized(request, env)) return json({ ok: false, error: 'Access key required (CALL_ADMIN_TOKEN)' }, 401);
  const u = new URL(request.url); const view = u.searchParams.get('view') || 'dashboard'; let c;
  try {
    c = await connect(env);
    if (view === 'settings') return json({ ok: true, settings: await getSettings(c), runtime: await getRuntime(c), n8n_mode: n8nMode(env) });
    if (view === 'dashboard') {
      const d = (await c.query('SELECT sgc_dashboard() AS d')).rows[0].d; const st = await getSettings(c);
      const live = (await c.query(`SELECT id,name,phone,kind,to_char(started_at AT TIME ZONE 'Asia/Kolkata','HH12:MI AM') AS t FROM sgc_calls WHERE status IN ('live','queued') AND started_at > now() - interval '30 minutes' ORDER BY id DESC LIMIT 5`)).rows;
      const recent = (await c.query(`SELECT id,name,phone,outcome,duration_sec,summary,is_mock,direction,status,to_char(started_at AT TIME ZONE 'Asia/Kolkata','DD-MM HH12:MI AM') AS t FROM sgc_calls ORDER BY id DESC LIMIT 12`)).rows;
      const cnt = (await c.query(`SELECT count(*)::int AS n FROM sgc_calls WHERE ${IST_TODAY} AND direction='out' AND NOT is_mock`)).rows[0].n;
      const pend = (await c.query(`SELECT id,name,total_qty,payload,to_char(created_at AT TIME ZONE 'Asia/Kolkata','DD-MM HH12:MI AM') AS t FROM sgc_pending_orders WHERE status='pending' ORDER BY id DESC LIMIT 20`)).rows;
      return json({ ok: true, dash: d, live, recent, pending_orders: pend, runtime: await getRuntime(c), n8n_mode: n8nMode(env),
        limits: { calls: st.daily_call_limit, cost: st.daily_cost_limit, calls_today: cnt } });
    }
    if (view === 'contacts') {
      const r = await c.query(`SELECT c.*, lc.at AS last_call_at, lc.outcome AS last_outcome, lt.outcome AS today_outcome,
          EXISTS (SELECT 1 FROM sgc_callbacks b WHERE b.ckey=c.ckey AND b.status='open') AS cb_open
        FROM sgc_contacts c
        LEFT JOIN LATERAL (SELECT to_char(started_at AT TIME ZONE 'Asia/Kolkata','DD-MM-YYYY') AS at, outcome FROM sgc_calls WHERE ckey=c.ckey AND status='completed' ORDER BY started_at DESC LIMIT 1) lc ON true
        LEFT JOIN LATERAL (SELECT outcome FROM sgc_calls WHERE ckey=c.ckey AND status='completed' AND ${IST_TODAY} ORDER BY started_at DESC LIMIT 1) lt ON true
        ORDER BY c.name LIMIT 3000`);
      return json({ ok: true, contacts: r.rows });
    }
    if (view === 'calls') {
      const ck = keyOf(u.searchParams.get('ckey')); const lim = Math.min(Number(u.searchParams.get('limit')) || 50, 200);
      const r = await c.query(`SELECT id,call_ref,direction,kind,name,phone,status,outcome,outcome_note,callback_at,duration_sec,cost,
          (recording_ref IS NOT NULL) AS has_rec,transcript,summary,reason,order_ref,is_mock,
          to_char(started_at AT TIME ZONE 'Asia/Kolkata','DD-MM-YYYY HH12:MI AM') AS t
        FROM sgc_calls WHERE ckey=$1 ORDER BY started_at DESC LIMIT $2`, [ck, lim]);
      return json({ ok: true, calls: r.rows });
    }
    if (view === 'recording') {   // raw URL/secret कभी browser को नहीं — server से stream
      const id = Number(u.searchParams.get('id'));
      const r = (await c.query('SELECT recording_ref,is_mock FROM sgc_calls WHERE id=$1', [id])).rows[0];
      if (!r || !r.recording_ref) return json({ ok: false, error: 'Recording नहीं मिली' }, 404);
      if (r.is_mock || String(r.recording_ref).startsWith('mock:')) return new Response(mockWav(), { headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } });
      if (n8nMode(env) !== 'live') return json({ ok: false, error: 'n8n जुड़ा नहीं — recording अभी नहीं चल सकती' }, 503);
      const resp = await fetch(env.N8N_BASE_URL.replace(/\/+$/, '') + '/webhook/sg-recording?ref=' + encodeURIComponent(r.recording_ref), { headers: { 'X-SG-Secret': env.N8N_SECRET } });
      if (!resp.ok) return json({ ok: false, error: 'Recording fetch fail (' + resp.status + ')' }, 502);
      return new Response(resp.body, { headers: { 'Content-Type': resp.headers.get('Content-Type') || 'audio/mpeg', 'Cache-Control': 'no-store' } });
    }
    if (view === 'callbacks') return json({ ok: true, callbacks: (await c.query(`SELECT id,ckey,name,phone,note,status,to_char(due_at AT TIME ZONE 'Asia/Kolkata','DD-MM-YYYY HH12:MI AM') AS due FROM sgc_callbacks ORDER BY (status='open') DESC, due_at LIMIT 200`)).rows });
    if (view === 'pending') return json({ ok: true, orders: (await c.query(`SELECT id,name,total_qty,payload,status,to_char(created_at AT TIME ZONE 'Asia/Kolkata','DD-MM HH12:MI AM') AS t FROM sgc_pending_orders ORDER BY id DESC LIMIT 100`)).rows });
    if (view === 'outbox') return json({ ok: true, outbox: (await c.query(`SELECT id,event,mode,status,response,to_char(created_at AT TIME ZONE 'Asia/Kolkata','DD-MM HH12:MI AM') AS t FROM sgc_outbox ORDER BY id DESC LIMIT 50`)).rows });
    if (view === 'audit') return json({ ok: true, audit: (await c.query(`SELECT id,actor,action,entity,detail,to_char(at AT TIME ZONE 'Asia/Kolkata','DD-MM HH12:MI AM') AS t FROM sgc_audit ORDER BY id DESC LIMIT 100`)).rows });
    return json({ ok: false, error: 'unknown view' }, 400);
  } catch (e) { return json({ ok: false, error: e.message }, 502); }
  finally { try { await c?.end(); } catch (_) {} }
}

/* ---------- call लगाने से पहले की सारी safety checks ---------- */
async function precheck(c, env, ct) {
  const st = await getSettings(c), rt = await getRuntime(c);
  if (rt.stopped) return { code: 'stopped', error: '⛔ Stop All Calls चालू है — पहले उसे हटाएँ' };
  if (rt.paused) return { code: 'paused', error: '⏸ Calls Pause हैं' };
  const w = inWindow(st); if (!w.ok) return { code: w.reason, error: w.error };
  if (ct.do_not_call) return { code: 'dnc', error: 'Do-Not-Call वाले customer को call नहीं हो सकती' };
  if (ct.wrong_number) return { code: 'wrong', error: 'यह number Wrong Number mark है — पहले number सुधारें' };
  if (last10(ct.call_no).length !== 10) return { code: 'nonumber', error: 'Call No भरा नहीं है' };
  const use = (await c.query(`SELECT count(*)::int AS n, COALESCE(sum(cost),0)::float AS cost FROM sgc_calls WHERE ${IST_TODAY} AND direction='out' AND NOT is_mock`)).rows[0];
  if (use.n >= st.daily_call_limit) return { code: 'limit_calls', error: `आज की call limit (${st.daily_call_limit}) पूरी हो गई` };
  if (use.cost >= st.daily_cost_limit) return { code: 'limit_cost', error: `आज की cost limit (₹${st.daily_cost_limit}) पूरी हो गई` };
  const o = (await c.query('SELECT sgc_ordered($1,$2) AS o', [ct.name, st.ordered_window_days])).rows[0].o;   // dial से ठीक पहले दोबारा check
  if (o.ordered) return { code: 'ordered', error: `इसका order आ चुका है (No ${o.no || ''}, ${o.date}) — call नहीं लगेगी`, order: o };
  const busy = (await c.query(`SELECT 1 FROM sgc_calls WHERE ckey=$1 AND status IN ('queued','live') AND started_at > now() - interval '10 minutes' LIMIT 1`, [ct.ckey])).rows.length;
  if (busy) return { code: 'busy', error: 'इसकी call अभी चल रही है' };
  return null;
}

async function callCustomer(c, env, ckey) {
  const ct = (await c.query('SELECT * FROM sgc_contacts WHERE ckey=$1', [keyOf(ckey)])).rows[0];
  if (!ct) return { status: 404, body: { ok: false, error: 'Customer नहीं मिला' } };
  const bad = await precheck(c, env, ct);
  if (bad) return { status: 409, body: { ok: false, ...bad } };
  const st = await getSettings(c);
  const ref = 'app-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const ins = (await c.query(`INSERT INTO sgc_calls(call_ref,direction,kind,ckey,name,phone,status,is_mock) VALUES ($1,'out','single',$2,$3,$4,'queued',$5) RETURNING id`,
    [ref, ct.ckey, ct.name, last10(ct.call_no), n8nMode(env) !== 'live'])).rows[0];
  const payload = { call_ref: ref, call_id: ins.id, contact: { ckey: ct.ckey, name: ct.name, phone: last10(ct.call_no), area: ct.area, rate_area: ct.rate_area, ctype: ct.ctype },
    language: 'hi', announce_recording: st.announce_recording };
  const r = await n8n(env, c, 'call_customer', payload);
  if (!r.ok) { await c.query("UPDATE sgc_calls SET status='failed', summary=$2 WHERE id=$1", [ins.id, 'n8n error: ' + r.response]); return { status: 502, body: { ok: false, error: 'n8n ने call नहीं ली: ' + r.status, call_id: ins.id } }; }
  if (r.mode === 'mock') {
    const m = mockResult(ct.ckey + ref);
    const done = (await c.query('SELECT sgc_call_completed($1::jsonb) AS r', [JSON.stringify({ call_ref: ref, direction: 'out', kind: 'single', contact: { ckey: ct.ckey, name: ct.name, phone: ct.call_no },
      outcome: m.outcome, outcome_note: m.note || '', duration: m.duration, cost: 0, recording_ref: m.duration ? 'mock:' + ref : null,
      transcript: m.transcript, summary: m.summary, is_mock: true,
      callback_at: m.outcome === 'callback' ? new Date(Date.now() + 6 * 3600e3).toISOString() : undefined })])).rows[0].r;
    return { status: 200, body: { ok: true, mock: true, call_id: ins.id, outcome: m.outcome, summary: m.summary, result: done } };
  }
  await c.query("UPDATE sgc_calls SET status='live' WHERE id=$1", [ins.id]);
  return { status: 200, body: { ok: true, mock: false, call_id: ins.id, message: 'Call शुरू हुई — नतीजा call_completed से आएगा' } };
}

export async function onRequestPost({ request, env }) {
  if (!authorized(request, env)) return json({ ok: false, error: 'Access key required (CALL_ADMIN_TOKEN)' }, 401);
  let c;
  try {
    const b = await request.json().catch(() => ({}));
    c = await connect(env);
    switch (b.action) {
      case 'save_settings': {
        const cur = await getSettings(c); const { s: ns, err } = cleanSettings(b.settings || {}, cur);
        if (err.length) return json({ ok: false, error: err.join(' · ') }, 400);
        if (ns.owner1 && ns.owner1 === ns.owner2) return json({ ok: false, error: 'Owner 1 और 2 अलग number होने चाहिए' }, 400);
        const changed = {}; for (const k of Object.keys(ns)) if (JSON.stringify(ns[k]) !== JSON.stringify(cur[k])) changed[k] = { from: cur[k], to: ns[k] };
        await c.query(`INSERT INTO sgc_settings(key,value) VALUES ('main',$1::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(ns)]);
        if (Object.keys(changed).length) await audit(c, 'settings_changed', 'settings', changed);
        return json({ ok: true, settings: ns, changed: Object.keys(changed) });
      }
      case 'sync_contacts': {
        const rows = Array.isArray(b.contacts) ? b.contacts.slice(0, 1000) : []; let n = 0;
        for (const x of rows) {
          let k; try { k = cleanContact(x); } catch (_) { continue; }
          const r = await c.query(`INSERT INTO sgc_contacts(ckey,name,address,call_no,wa_no,same_flag,area,rate_area,ctype,reorder_days)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (ckey) DO UPDATE SET
              address = CASE WHEN sgc_contacts.address='' THEN EXCLUDED.address ELSE sgc_contacts.address END,
              call_no = CASE WHEN sgc_contacts.call_no='' THEN EXCLUDED.call_no ELSE sgc_contacts.call_no END,
              wa_no   = CASE WHEN sgc_contacts.wa_no=''   THEN EXCLUDED.wa_no   ELSE sgc_contacts.wa_no END,
              area    = CASE WHEN sgc_contacts.area=''    THEN EXCLUDED.area    ELSE sgc_contacts.area END,
              rate_area = CASE WHEN sgc_contacts.rate_area='' THEN EXCLUDED.rate_area ELSE sgc_contacts.rate_area END
            RETURNING (xmax = 0) AS inserted`,
            [k.ckey, k.name, k.address, k.call_no, k.wa_no, k.same_flag, k.area, k.rate_area, k.ctype, k.reorder_days]);
          if (r.rows[0]?.inserted) n++;
        }
        return json({ ok: true, inserted: n, received: rows.length });
      }
      case 'save_contact': {
        let k; try { k = cleanContact(b.contact || {}); } catch (e) { return json({ ok: false, error: e.message }, 400); }
        const dup = k.call_no ? (await c.query('SELECT ckey,name FROM sgc_contacts WHERE right(call_no,10)=$1 AND ckey<>$2 LIMIT 1', [k.call_no, k.ckey])).rows[0] : null;
        const old = (await c.query('SELECT do_not_call,wrong_number,call_no,wa_no FROM sgc_contacts WHERE ckey=$1', [k.ckey])).rows[0];
        await c.query(`INSERT INTO sgc_contacts(ckey,name,address,call_no,wa_no,same_flag,area,rate_area,ctype,reorder_days,best_time,do_not_call,wrong_number,notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (ckey) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,call_no=EXCLUDED.call_no,wa_no=EXCLUDED.wa_no,same_flag=EXCLUDED.same_flag,
            area=EXCLUDED.area,rate_area=EXCLUDED.rate_area,ctype=EXCLUDED.ctype,reorder_days=EXCLUDED.reorder_days,best_time=EXCLUDED.best_time,
            do_not_call=EXCLUDED.do_not_call,wrong_number=EXCLUDED.wrong_number,notes=EXCLUDED.notes,updated_at=now()`,
          [k.ckey, k.name, k.address, k.call_no, k.wa_no, k.same_flag, k.area, k.rate_area, k.ctype, k.reorder_days, k.best_time, k.do_not_call, k.wrong_number, k.notes]);
        if (old && (old.do_not_call !== k.do_not_call || old.wrong_number !== k.wrong_number)) await audit(c, 'contact_flag', k.ckey, { do_not_call: k.do_not_call, wrong_number: k.wrong_number });
        if (old && (old.call_no !== k.call_no || old.wa_no !== k.wa_no)) await audit(c, 'contact_number', k.ckey, { call_no: k.call_no, wa_no: k.wa_no });
        return json({ ok: true, contact: k, duplicate: dup ? { ckey: dup.ckey, name: dup.name } : null });
      }
      case 'call_customer': { const r = await callCustomer(c, env, b.ckey); return json(r.body, r.status); }
      case 'stop_all': {
        const on = b.on !== false; const rt = await setRuntime(c, { stopped: on, stopped_at: on ? new Date().toISOString() : null });
        let ev = null;
        if (on) {
          await c.query("UPDATE sgc_campaigns SET status='stopped', ended_at=now() WHERE status IN ('running','paused')");
          await c.query("UPDATE sgc_calls SET status='failed', summary='Stop All Calls' WHERE status='queued'");
          ev = await n8n(env, c, 'stop_all_calls', { at: new Date().toISOString() });
        }
        await audit(c, on ? 'stop_all_calls' : 'resume_calls', 'runtime', { on });
        return json({ ok: true, runtime: rt, n8n: ev });
      }
      case 'pause': { const on = b.on !== false; const rt = await setRuntime(c, { paused: on }); await audit(c, on ? 'pause_calls' : 'resume_pause', 'runtime', { on }); return json({ ok: true, runtime: rt }); }
      case 'test_n8n': {
        if (n8nMode(env) !== 'live') return json({ ok: true, mode: 'mock', message: 'MOCK mode — N8N_BASE_URL / N8N_SECRET Cloudflare में set नहीं हैं. सब screens नकली data से चलेंगी.' });
        const r = await n8n(env, c, 'ping', { from: 'satyam-gold-app', at: new Date().toISOString() });
        return json({ ok: r.ok, mode: 'live', status: r.status, message: r.ok ? 'n8n से जुड़ गया ✔' : 'n8n जवाब नहीं दे रहा: ' + r.response });
      }
      case 'approve_order': {
        const id = Number(b.id); if (!Number.isInteger(id)) return json({ ok: false, error: 'id required' }, 400);
        const r = (await c.query('SELECT sgc_order_decide($1,$2,$3) AS r', [id, b.approve !== false, 'owner'])).rows[0].r;
        return json({ ok: true, result: r });
      }
      case 'callback_done': {
        await c.query("UPDATE sgc_callbacks SET status='done' WHERE id=$1", [Number(b.id)]); return json({ ok: true });
      }
      default: return json({ ok: false, error: 'unknown action' }, 400);
    }
  } catch (e) { return json({ ok: false, error: e.message }, 502); }
  finally { try { await c?.end(); } catch (_) {} }
}
