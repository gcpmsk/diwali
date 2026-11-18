/* =====================================================================
   SATYAM GOLD — Call/Stock shared helpers (Cloudflare Pages Functions)
   Env:  DATABASE_URL · CALL_ADMIN_TOKEN (Bearer) · N8N_BASE_URL · N8N_SECRET
   N8N_BASE_URL / N8N_SECRET न हों तो MOCK mode — असली call/WhatsApp कुछ नहीं जाता.
   ===================================================================== */
import { Client } from 'pg';

export const H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
export const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: H });

/* constant-time string compare (Bearer / X-SG-Secret) */
export function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export const authorized = (req, env) => {
  const h = req.headers.get('Authorization') || '';
  return !!env.CALL_ADMIN_TOKEN && h.startsWith('Bearer ') && safeEq(h.slice(7), env.CALL_ADMIN_TOKEN);
};
export const hookAuthorized = (req, env) =>
  !!env.N8N_SECRET && safeEq(req.headers.get('X-SG-Secret') || req.headers.get('X-Webhook-Secret'), env.N8N_SECRET);

export async function connect(env) {
  const url = env.DATABASE_URL || env.POSTGRES_URL || env.PG_URL;
  if (!url) throw new Error('DATABASE_URL missing');
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 8000 }); await c.connect(); return c;
}

/* ---------------- Settings (sgc_settings.main) — कुछ भी hard-coded नहीं, सब editable ---------------- */
export const DEFAULTS = {
  owner1: '', owner2: '',                       // Owner numbers सिर्फ़ Settings से (primary, secondary)
  window_start: '09:00', window_end: '19:00', sunday_off: true,
  daily_call_limit: 100, daily_cost_limit: 500,  // conservative; editable
  retry_max: 3, retry_gap_min: 60,
  ordered_window_days: 0,                        // 0 = सिर्फ़ आज
  big_order_qty: 50,                             // इससे ऊपर का order → pending approval (0 = बंद)
  announce_recording: true,
  concurrency: 1, pending_order_block: false,
  reorder_days_default: 3, auto_reorder: false, reorder_time: '10:00',
  auto_wheat: false,
  bag_tare_kg: 0.7, weights_include_bag: false, wheat_bora_kg: 50,
  wheat_per_atta_bora: ''                        // खाली = "wheat needed" वाला sentence छोड़ दो
};
export async function getSettings(c) {
  const r = await c.query("SELECT value FROM sgc_settings WHERE key='main'");
  return { ...DEFAULTS, ...(r.rows[0]?.value || {}) };
}
export async function getRuntime(c) {
  const r = await c.query("SELECT value FROM sgc_settings WHERE key='runtime'");
  return { stopped: false, paused: false, ...(r.rows[0]?.value || {}) };
}
export async function setRuntime(c, patch) {
  const cur = await getRuntime(c); const v = { ...cur, ...patch };
  await c.query(`INSERT INTO sgc_settings(key,value) VALUES ('runtime',$1::jsonb)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [JSON.stringify(v)]);
  return v;
}

/* Settings validation → (clean, errors) */
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const PH = /^\d{10}$/;
export const last10 = t => String(t || '').replace(/\D/g, '').slice(-10);
export function cleanSettings(inp, cur) {
  const s = { ...cur }, err = [];
  const num = (k, lo, hi, int) => { if (inp[k] === undefined) return; const n = Number(inp[k]);
    if (!Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) err.push(`${k}: ${lo}–${hi} के बीच संख्या चाहिए`); else s[k] = n; };
  const bool = k => { if (inp[k] !== undefined) s[k] = inp[k] === true || inp[k] === 'true'; };
  ['owner1', 'owner2'].forEach(k => { if (inp[k] === undefined) return; const v = last10(inp[k]);
    if (v && !PH.test(v)) err.push(`${k}: 10 अंक का mobile`); else s[k] = v; });
  ['window_start', 'window_end', 'reorder_time'].forEach(k => { if (inp[k] === undefined) return;
    if (!HM.test(String(inp[k]))) err.push(`${k}: HH:MM`); else s[k] = String(inp[k]); });
  num('daily_call_limit', 0, 5000, true); num('daily_cost_limit', 0, 1000000);
  num('retry_max', 0, 10, true); num('retry_gap_min', 1, 1440, true); num('ordered_window_days', 0, 30, true);
  num('big_order_qty', 0, 100000); num('concurrency', 1, 5, true); num('reorder_days_default', 1, 60, true);
  num('bag_tare_kg', 0, 5); num('wheat_bora_kg', 1, 200);
  if (inp.wheat_per_atta_bora !== undefined) { if (inp.wheat_per_atta_bora === '' || inp.wheat_per_atta_bora === null) s.wheat_per_atta_bora = '';
    else { const n = Number(inp.wheat_per_atta_bora); if (!(n > 0 && n < 100)) err.push('wheat_per_atta_bora: >0'); else s.wheat_per_atta_bora = n; } }
  ['sunday_off', 'announce_recording', 'pending_order_block', 'auto_reorder', 'auto_wheat', 'weights_include_bag'].forEach(bool);
  return { s, err };
}

/* ---------------- IST calling window ---------------- */
const hm = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
export function inWindow(s, d = new Date()) {
  const t = new Date(d.getTime() + 19800000), dow = t.getUTCDay(), mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  if (s.sunday_off && dow === 0) return { ok: false, reason: 'sunday', error: 'रविवार को calls बंद हैं (Settings)' };
  const a = hm(s.window_start), b = hm(s.window_end);
  if (mins < a || mins >= b) return { ok: false, reason: 'window', error: `Call का समय ${s.window_start}–${s.window_end} है; अभी समय के बाहर` };
  return { ok: true };
}

/* ---------------- app → n8n  (header X-SG-Secret) ---------------- */
export const n8nMode = env => (env.N8N_BASE_URL && env.N8N_SECRET ? 'live' : 'mock');
export async function n8n(env, c, event, payload = {}) {
  const mode = n8nMode(env); let status = 'sent', resp = '', ok = true;
  if (mode === 'live') {
    try {
      const url = env.N8N_BASE_URL.replace(/\/+$/, '') + '/webhook/sg-' + event.replace(/_/g, '-');
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SG-Secret': env.N8N_SECRET },
        body: JSON.stringify({ event, ...payload }),
        ...(typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(10000) } : {}) });
      resp = (await r.text()).slice(0, 500); ok = r.ok; if (!r.ok) status = 'failed:' + r.status;
    } catch (e) { ok = false; status = 'failed'; resp = String(e.message || e).slice(0, 300); }
  } else resp = 'MOCK — n8n जुड़ा नहीं';
  try { await c.query('INSERT INTO sgc_outbox(event,payload,mode,status,response) VALUES ($1,$2::jsonb,$3,$4,$5)', [event, JSON.stringify(payload), mode, status, resp]); } catch (_) {}
  return { ok, mode, status, response: resp };
}

/* ---------------- MOCK sample (realistic Hindi) ---------------- */
const MOCK = [
  { outcome: 'rate_enquiry', duration: 74, summary: 'ग्राहक ने आज का भाव पूछा। AI ने Set Rate वाला भाव बताया। अभी order नहीं दिया; शाम को सोचकर बताएगा।',
    transcript: 'AI: नमस्ते, सत्यम गोल्ड से बोल रहा हूँ। आज आटे का भाव बताऊँ?\nग्राहक: हाँ बताइए।\nAI: आज का भाव Set Rate के अनुसार है। Order लगाऊँ?\nग्राहक: अभी नहीं, शाम को बताता हूँ।\nAI: ठीक है, धन्यवाद।' },
  { outcome: 'callback', duration: 41, note: 'शाम 5 बजे दोबारा call करें', summary: 'ग्राहक दुकान पर व्यस्त था। शाम 5 बजे दोबारा call करने को कहा।',
    transcript: 'AI: नमस्ते, order के बारे में बात करनी थी।\nग्राहक: अभी busy हूँ, शाम को call करना।\nAI: ठीक है, शाम 5 बजे call करूँगा।' },
  { outcome: 'not_picked', duration: 0, summary: 'Phone नहीं उठा / busy।', transcript: '' },
  { outcome: 'not_interested', duration: 28, note: 'अभी stock है', summary: 'ग्राहक के पास अभी stock है, इसलिए आज order नहीं चाहिए।',
    transcript: 'AI: नमस्ते, आज order लगाना है?\nग्राहक: अभी stock है, ज़रूरत नहीं।\nAI: ठीक है, धन्यवाद।' }
];
export function mockResult(seed) {
  let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return MOCK[h % MOCK.length];
}
/* 1 सेकंड की हल्की beep WAV (mock recording) */
export function mockWav() {
  const sr = 8000, n = sr, buf = new Uint8Array(44 + n * 2), v = new DataView(buf.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 1200 * Math.min(1, (n - i) / 800)), true);
  return buf;
}
