/* =====================================================================
   SATYAM GOLD — 📞 CALL module + 🚨 EMERGENCY/STOCK  (Phase A)
   • Data: Postgres (/api/call, /api/stock — CALL_ADMIN_TOKEN key, एक बार पूछ कर याद रहता है)
   • Customers: Tally debtors/creditors + Order Book + sg_wa_cust + manual  (tvBuild / ordAll / sg_mobiles)
   • Orders sg_ord_<date>, rates sg_rates, objections sg_wa_obj — वही पुरानी keys, दोबारा कहीं copy नहीं
   • कोई secret frontend में नहीं (n8n/Dograh/Meta सब server env में)
   ===================================================================== */
'use strict';
const CL_KEY_LS='__call_key';           // 'sg_' prefix नहीं → cloud sync में नहीं जाता
const CL_TYPES=['Customer','Dukandar','Hotel','Wheat Supplier','Other'];
const CL_OUT={order_placed:['✅ Order Placed','g'],rate_enquiry:['💬 Rate Enquiry','b'],rate_reduction:['📉 Rate Kam Request','o'],callback:['🔔 Callback','p'],
  not_interested:['🙅 Not Interested','n'],not_picked:['📵 Not Picked/Busy','n'],wrong_number:['❌ Wrong Number','r'],do_not_call:['⛔ Do Not Call','r'],order_update:['✏️ Order Update','g']};
const CLS={tab:'dash',contacts:[],local:[],q:'',f:{area:'',flag:''},sel:new Set(),server:false,dash:null,settings:null,runtime:{},mode:'mock',err:''};
const clE=s=>(typeof esc==='function'?esc(s):String(s??''));
const clK=s=>String(s||'').trim().toUpperCase().replace(/\s+/g,' ');
const clD=s=>{ const p=String(s||'').split('-'); return p.length===3?p[2]+p[1]+p[0]:''; };
const clMobile=v=>String(v||'').replace(/\D/g,'').slice(-10);
const clToday=()=>typeof todayStr==='function'?todayStr():'';

/* ---------- API + key ---------- */
let clKey=''; try{ clKey=localStorage.getItem(CL_KEY_LS)||''; }catch(e){}
async function clAsk(){
  if(clKey) return clKey;
  clKey=await new Promise(res=>popup({title:'Call access key',
    body:'<label>CALL_ADMIN_TOKEN <input id="cl-key-in" type="password" autocomplete="off"></label><div class="pp-note" style="margin-top:8px">सिर्फ़ एक बार — इस device पर याद रहेगा (cloud में sync नहीं होता).</div>',
    foot:'<button class="pp-btn cancel" id="cl-k-no">Cancel</button><button class="pp-btn save" id="cl-k-ok">Continue</button>',
    onOpen(el){ el.querySelector('#cl-k-ok').onclick=()=>{ const v=el.querySelector('#cl-key-in').value.trim(); closePopup(); res(v); };
      el.querySelector('#cl-k-no').onclick=()=>{ closePopup(); res(''); }; }}));
  if(!clKey) throw new Error('Access key required');
  return clKey;
}
async function clApi(path,body,raw){
  const key=await clAsk();
  const r=await fetch(path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},...(body?{body:JSON.stringify(body)}:{})});
  if(raw) { if(r.status===401){ clKey=''; try{localStorage.removeItem(CL_KEY_LS);}catch(e){} } return r; }
  const j=await r.json().catch(()=>({ok:false,error:'Server से सही जवाब नहीं मिला (HTTP '+r.status+')'}));
  if(r.status===401){ clKey=''; try{localStorage.removeItem(CL_KEY_LS);}catch(e){} }
  else if(r.ok&&j.ok){ try{localStorage.setItem(CL_KEY_LS,key);}catch(e){} }
  if(!r.ok||j.ok===false){ const er=new Error(j.error||'Request failed'); er.code=j.code; er.data=j; throw er; }
  return j;
}

/* ---------- CSS ---------- */
(function(){ const css=document.createElement('style'); css.textContent=`
.tile-em{background:linear-gradient(135deg,#ff4d4d,#a40000);box-shadow:0 14px 28px -10px rgba(164,0,0,.7);animation:tileIn .7s cubic-bezier(.2,.9,.3,1.3) .5s backwards,sosPulse 2.2s ease-in-out 1.4s infinite;}
#call-screen .sub-head,#emergency-screen .sub-head{max-width:1100px}
.cl-wrap{width:100%;max-width:1100px;z-index:2}
.cl-tabs{display:flex;gap:8px;margin:0 0 12px;flex-wrap:wrap}
.cl-tab{flex:1;min-width:110px;border:none;border-radius:12px;padding:13px 8px;font-weight:900;font-size:15px;cursor:pointer;background:#e9eef6;color:#556}
.cl-tab.on{background:linear-gradient(135deg,#ff9ff3,#e84393);color:#fff;box-shadow:0 8px 18px -10px rgba(232,67,147,.9)}
.cl-tab.off{opacity:.5;cursor:not-allowed}
.cl-card{background:#fff;border-radius:16px;padding:14px;margin:0 0 12px;box-shadow:0 10px 24px -14px rgba(31,97,141,.35);border:1.5px solid #e3ebf5;color:#243447}
.cl-card h4{margin:0 0 8px;font-size:16px}
.cl-note{font-size:13px;color:#667;line-height:1.5}
.cl-banner{padding:10px 14px;border-radius:12px;margin:0 0 12px;font-weight:700;font-size:14px}
.cl-banner.mock{background:#fff4d6;color:#7a5600;border:1.5px solid #f6b93b}
.cl-banner.live{background:#e6f9ee;color:#11633a;border:1.5px solid #2ecc71}
.cl-banner.stop{background:#ffe3e3;color:#a40000;border:1.5px solid #ff6b6b}
.cl-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:0 0 12px}
.cl-stat{background:#fff;border-radius:14px;padding:12px;text-align:center;border:1.5px solid #e3ebf5;color:#243447}
.cl-stat b{display:block;font-size:28px;line-height:1.1}.cl-stat span{font-size:12px;color:#778}
.cl-btn{border:none;border-radius:12px;padding:12px 18px;font-size:15px;font-weight:800;cursor:pointer;min-height:46px;color:#fff;background:#4b7bec}
.cl-btn:active{transform:scale(.95)}.cl-btn.g{background:linear-gradient(135deg,#20bf6b,#0b6e4f)}.cl-btn.r{background:linear-gradient(135deg,#ff5252,#b71c1c)}
.cl-btn.y{background:linear-gradient(135deg,#f6b93b,#e58e26)}.cl-btn.n{background:#e9edf3;color:#40506b}.cl-btn.sm{padding:7px 11px;min-height:34px;font-size:13px}
.cl-btn.xl{font-size:20px;padding:16px 26px;min-height:60px}.cl-btn[disabled]{opacity:.5}
.cl-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px}
.cl-bar input,.cl-bar select,.cl-f input,.cl-f select,.cl-f textarea{padding:11px;border:1.5px solid #cfd8e6;border-radius:10px;font-size:16px;background:#fff;color:#243447;font-family:inherit}
.cl-bar input[type=search]{flex:1;min-width:160px}
.cl-tw{overflow-x:auto;background:#fff;border-radius:14px;border:1.5px solid #e3ebf5}
.cl-t{width:100%;border-collapse:collapse;font-size:14px;min-width:860px;color:#243447}
.cl-t th{background:#f4f7fb;text-align:left;padding:10px 8px;position:sticky;top:0;font-size:13px}
.cl-t td{padding:9px 8px;border-top:1px solid #eef2f7;vertical-align:middle}
.cl-t tr.dnc{background:#fff0f0}.cl-t tr.ord{background:#f1fff6}
.cl-t small{color:#778;display:block}
.cl-t .acts{white-space:nowrap;display:flex;gap:5px}
.cl-chip{display:inline-block;border-radius:10px;padding:2px 9px;font-size:12px;font-weight:800;background:#eef2f7;color:#456}
.cl-chip.g{background:#dcf7e6;color:#11633a}.cl-chip.b{background:#e0ecff;color:#1b4aa8}.cl-chip.o{background:#fff0d6;color:#8a5200}
.cl-chip.p{background:#f0e4ff;color:#5b2a9e}.cl-chip.r{background:#ffe0e0;color:#a40000}.cl-chip.n{background:#eceff3;color:#556}
.cl-f{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
.cl-f label{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:700;color:#445}
.cl-f label.row{flex-direction:row;align-items:center;gap:8px}.cl-f label.row input{width:22px;height:22px}
.cl-f .full{grid-column:1/-1}
.cl-call{border:1px solid #e3ebf5;border-radius:12px;padding:10px;margin:8px 0;background:#fafcff}
.cl-call audio{width:100%;margin-top:6px}.cl-call details{margin-top:6px;font-size:13px}.cl-call pre{white-space:pre-wrap;font-family:inherit;background:#f4f7fb;padding:8px;border-radius:8px}
.cl-stock{margin:0 0 10px}.cl-stock .bar{height:16px;border-radius:9px;background:#e9eef6;overflow:hidden;margin-top:4px}
.cl-stock .bar i{display:block;height:100%}.cl-lv-ok{background:#2ecc71}.cl-lv-warning{background:#f1c40f}.cl-lv-emergency{background:#e67e22}.cl-lv-critical{background:#e74c3c}
.cl-stock .hd{display:flex;justify-content:space-between;gap:8px;font-weight:800;flex-wrap:wrap}
`; document.head.appendChild(css); })();

/* ---------- Local customer candidates (Tally + Order Book + WhatsApp + sg_mobiles) ---------- */
function clLocal(){
  const m={}; const add=(name,addr,type,wa)=>{ const k=clK(name); if(!k) return; const x=m[k]||(m[k]={ckey:k,name:String(name).trim(),address:'',ctype:'Customer',call_no:'',wa_no:''});
    if(addr&&!x.address) x.address=String(addr).trim(); if(type&&x.ctype!=='Wheat Supplier') x.ctype=type; if(wa&&!x.wa_no) x.wa_no=wa; return x; };
  try{ const D=tvBuild(); (D.cred||[]).forEach(d=>add(d.name,d.address,d.cats&&d.cats.wheat?'Wheat Supplier':'Other')); (D.deb||[]).forEach(d=>add(d.name,d.address,'Customer')); }catch(e){}
  try{ ordAll().forEach(o=>add(o.name,o.address)); }catch(e){}
  try{ const wc=JSON.parse(localStorage.getItem('sg_wa_cust')||'{}')||{}; Object.keys(wc).forEach(mob=>{ const c=wc[mob]; if(c&&c.name) add(c.name,c.address,c.type==='cred'?'Other':'',mob); }); }catch(e){}
  const mob=(()=>{ try{ return JSON.parse(localStorage.getItem('sg_mobiles')||'{}')||{}; }catch(e){ return {}; } })();
  return Object.keys(m).map(k=>{ const x=m[k]; const mb=clMobile(mob[k]); x.call_no=mb; if(!x.wa_no) x.wa_no=mb;
    let a={code:'—'}; try{ a=areaOf(x.address); }catch(e){} x.area=a.code||''; try{ x.rate_area=tvArea(x.address); }catch(e){ x.rate_area=''; } x.same_flag=!!mb&&x.wa_no===mb; return x; });
}
/* Last Order = Order Book date vs Atta Receipt date (जो बाद का); Today status */
function clOrderInfo(){
  const last={}, today={}; const T=clToday(); const bump=(k,d)=>{ if(!d) return; if(!last[k]||clD(d)>clD(last[k])) last[k]=d; };
  try{ ordAll().forEach(o=>{ if(o.cancelled) return; const k=clK(o.name); bump(k,o.date); if(o.date===T) today[k]=o; }); }catch(e){}
  try{ (tvBuild().deb||[]).forEach(d=>(d.due||[]).forEach(x=>{ if(x.src==='arcpt'&&!x.cut) bump(d.key,x.date); })); }catch(e){}
  return {last,today};
}
const clDays=d=>{ if(!d) return null; const p=d.split('-'); const t=Date.UTC(+p[2],+p[1]-1,+p[0]); const n=new Date(Date.now()+19800000); return Math.floor((Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate())-t)/864e5); };
function clMerge(){
  const loc=clLocal(), srv={}; CLS.contacts.forEach(c=>srv[c.ckey]=c); const oi=clOrderInfo(); const rr=new Set();
  try{ waObjs().filter(o=>o.status==='open').forEach(o=>rr.add(clK(o.custKey||o.name))); }catch(e){}
  const wheat=new Set(); const all={}; loc.forEach(x=>all[x.ckey]=x);
  Object.keys(srv).forEach(k=>{ all[k]=Object.assign({},all[k]||{},srv[k]); });   // server में saved data जीतता है
  return Object.values(all).map(c=>{ c.last_order=oi.last[c.ckey]||''; c.ordered_today=!!oi.today[c.ckey]; c.gap=clDays(c.last_order); c.rate_req=rr.has(c.ckey); return c; })
    .sort((a,b)=>String(a.name).localeCompare(String(b.name),'hi'));
}
function clTally(key){ try{ const d=(tvBuild().deb||[]).find(x=>x.key===key); return d?d.bal:null; }catch(e){ return null; } }

/* ---------- Screen ---------- */
async function clRender(){
  const el=document.getElementById('call-body'); if(!el) return;
  el.innerHTML=`<div class="cl-wrap"><div class="cl-tabs">${[['dash','📊 Dashboard'],['cust','👥 Customers'],['cb','🔔 Callbacks'],['set','⚙️ Settings']].map(t=>`<button class="cl-tab ${CLS.tab===t[0]?'on':''}" data-t="${t[0]}">${t[1]}</button>`).join('')}
    <button class="cl-tab off" title="Phase B">📍 Area Auto-Call</button><button class="cl-tab off" title="Phase B">☎️ Dial Pad</button><button class="cl-tab off" title="Phase D">🔁 Reorder/Inbound/Wheat</button></div>
    <div id="cl-pane"><div class="cl-card">⏳ लोड हो रहा है…</div></div></div>`;
  el.querySelectorAll('.cl-tab:not(.off)').forEach(b=>b.onclick=()=>{ CLS.tab=b.dataset.t; clRender(); });
  try{
    if(CLS.tab==='dash') await clDash(); else if(CLS.tab==='cust') await clCust(); else if(CLS.tab==='cb') await clCb(); else await clSet();
  }catch(e){ if(e.message!=='Access key required') document.getElementById('cl-pane').innerHTML=`<div class="cl-card"><b>⚠️ ${clE(e.message)}</b><div class="cl-note">${/CALL_ADMIN_TOKEN|Access key/.test(e.message)?'Cloudflare में CALL_ADMIN_TOKEN set करें, फिर सही key डालें.':'call-schema.sql Adminer में चलाई है? /api/health देखें.'}</div><button class="cl-btn y" onclick="clRender()">🔄 दोबारा</button></div>`;
    else document.getElementById('cl-pane').innerHTML='<div class="cl-card">Key नहीं डाली — <button class="cl-btn y" onclick="clRender()">Key डालें</button></div>'; }
}
const clPane=()=>document.getElementById('cl-pane');
const clBanner=(mode,rt)=>rt&&rt.stopped?'<div class="cl-banner stop">⛔ STOP ALL CALLS चालू है — कोई call नहीं लगेगी</div>'
  :mode==='live'?'<div class="cl-banner live">🟢 n8n जुड़ा है (LIVE)</div>':'<div class="cl-banner mock">🟡 MOCK mode — n8n जुड़ा नहीं. Call नकली नतीजा देगी, असली call/WhatsApp नहीं जाएगी.</div>';

/* ---- Dashboard ---- */
async function clDash(){
  const j=await clApi('/api/call?view=dashboard'); CLS.dash=j; const d=j.dash;
  const S=(n,l)=>`<div class="cl-stat"><b>${clE(n)}</b><span>${l}</span></div>`;
  clPane().innerHTML=`${clBanner(j.n8n_mode,j.runtime)}
  <div class="cl-stats">${S(d.total,'आज की calls')}${S(d.answered,'Answered')}${S(d.not_picked,'Not picked')}${S(d.orders,'Orders')}${S(d.rate_only,'Rate only')}${S(d.callbacks,'Callbacks')}${S(d.bora_by_calls,'Bora (calls से)')}${S('₹'+Number(d.cost).toFixed(2),'आज की cost')}</div>
  <div class="cl-card"><h4>⚡ Control</h4><div class="cl-bar">
    <button class="cl-btn y" id="cl-pause">${j.runtime.paused?'▶️ Resume':'⏸ Pause'}</button>
    <button class="cl-btn r xl" id="cl-stop">${j.runtime.stopped?'✅ Calls फिर चालू करें':'🛑 STOP ALL CALLS'}</button></div>
    <div class="cl-note">आज की limit: ${j.limits.calls_today} / ${j.limits.calls} calls · cost ₹${Number(d.cost).toFixed(2)} / ₹${j.limits.cost}${d.live?` · 🔴 live: ${d.live}`:''}</div></div>
  ${j.live.length?`<div class="cl-card"><h4>🔴 Live / Queue</h4>${j.live.map(x=>`<div>${clE(x.name)} · ${clE(x.phone)} · ${clE(x.t)}</div>`).join('')}</div>`:''}
  ${j.pending_orders.length?`<div class="cl-card"><h4>⏳ Pending Approval — बड़े orders</h4>${j.pending_orders.map(p=>`<div class="cl-call"><b>${clE(p.name)}</b> · कुल qty <b>${clE(p.total_qty)}</b> · ${clE(p.t)}<div class="cl-note">${(p.payload.items||[]).map(i=>clE(i.name)+' × '+clE(i.qty)).join(', ')}</div>
     <div class="cl-bar"><button class="cl-btn g sm" data-ap="${p.id}" data-v="1">✅ Approve → Order Book</button><button class="cl-btn n sm" data-ap="${p.id}" data-v="0">✖ Reject</button></div></div>`).join('')}</div>`:''}
  <div class="cl-card"><h4>🕘 हाल की calls</h4>${j.recent.map(x=>{ const o=CL_OUT[x.outcome]||[x.status,'n']; return `<div class="cl-call"><b>${clE(x.name||x.phone)}</b> ${x.direction==='in'?'📥':'📤'} <span class="cl-chip ${o[1]}">${o[0]}</span>${x.is_mock?' <span class="cl-chip o">MOCK</span>':''} <small>${clE(x.t)} · ${x.duration_sec}s</small><div class="cl-note">${clE(x.summary||'')}</div></div>`; }).join('')||'<div class="cl-note">अभी कोई call नहीं.</div>'}</div>`;
  const P=clPane();
  P.querySelector('#cl-pause').onclick=async()=>{ try{ await clApi('/api/call',{action:'pause',on:!j.runtime.paused}); clRender(); }catch(e){ toast(e.message); } };
  P.querySelector('#cl-stop').onclick=async()=>{ const on=!j.runtime.stopped; if(on&&!confirm('सारी calls तुरंत बंद करें?')) return;
    try{ await clApi('/api/call',{action:'stop_all',on}); toast(on?'⛔ सारी calls बंद':'Calls फिर चालू'); clRender(); }catch(e){ toast(e.message); } };
  P.querySelectorAll('[data-ap]').forEach(b=>b.onclick=async()=>{ const ok=b.dataset.v==='1'; if(!confirm(ok?'Order Book में डालें?':'Reject करें?')) return;
    try{ await clApi('/api/call',{action:'approve_order',id:b.dataset.ap,approve:ok}); window.sgSync?.pull?.(); toast(ok?'Order Book में गया ✔':'Reject ✔'); clRender(); }catch(e){ toast(e.message); } });
}

/* ---- Customers table ---- */
async function clCust(){
  let err='';
  try{ CLS.contacts=(await clApi('/api/call?view=contacts')).contacts; CLS.server=true; }catch(e){ if(e.message==='Access key required') throw e; err=e.message; CLS.server=false; CLS.contacts=[]; }
  if(CLS.server){ const loc=clLocal().filter(x=>!CLS.contacts.find(c=>c.ckey===x.ckey)); if(loc.length&&!clCust._sync){ clCust._sync=1;
    clApi('/api/call',{action:'sync_contacts',contacts:loc}).then(()=>{ clCust._sync=0; }).catch(()=>{ clCust._sync=0; }); } }
  const rows=clMerge(); const areas=[...new Set(rows.map(r=>r.area).filter(Boolean))].sort();
  const F=CLS.f, q=clK(CLS.q);
  const vis=rows.filter(r=>{
    if(q&&!(r.ckey.includes(q)||String(r.call_no).includes(q)||String(r.wa_no).includes(q))) return false;
    if(F.area&&r.area!==F.area) return false;
    switch(F.flag){ case 'ord': return r.ordered_today; case 'noord': return !r.ordered_today; case 'gap3': return !r.ordered_today&&(r.gap===null||r.gap>=3);
      case 'rate': return r.rate_req; case 'cb': return r.cb_open; case 'wrong': return r.wrong_number; case 'wheat': return r.ctype==='Wheat Supplier'; case 'dnc': return r.do_not_call; }
    return true; });
  CLS._vis=vis;
  clPane().innerHTML=`${err?`<div class="cl-banner stop">⚠️ ${clE(err)} — सिर्फ़ local list दिख रही है</div>`:''}
  <div class="cl-bar"><input type="search" id="cl-q" placeholder="🔎 नाम / नंबर" value="${clE(CLS.q)}">
    <select id="cl-fa"><option value="">सब Area</option>${areas.map(a=>`<option ${F.area===a?'selected':''}>${clE(a)}</option>`).join('')}</select>
    <select id="cl-ff">${[['','सब'],['ord','आज Order आया'],['noord','आज Order नहीं'],['gap3','3+ दिन Order नहीं'],['rate','Rate Request'],['cb','Callback pending'],['wrong','Wrong number'],['wheat','Wheat Supplier'],['dnc','Do-Not-Call']].map(o=>`<option value="${o[0]}" ${F.flag===o[0]?'selected':''}>${o[1]}</option>`).join('')}</select>
    <button class="cl-btn g" id="cl-addc">➕ नया</button><button class="cl-btn y" id="cl-cs">📞 Selected को Call (${CLS.sel.size})</button></div>
  <div class="cl-note" style="margin-bottom:6px">${vis.length} / ${rows.length} customers</div>
  <div class="cl-tw"><table class="cl-t"><thead><tr><th></th><th>Name</th><th>Call No.</th><th>WhatsApp No.</th><th>Area</th><th>Last Order</th><th>Last Call</th><th>Today</th><th></th></tr></thead><tbody>
  ${vis.map(r=>{ const o=CL_OUT[r.today_outcome]; const st=r.ordered_today?'<span class="cl-chip g">✅ Order आया</span>':o?`<span class="cl-chip ${o[1]}">${o[0]}</span>`:'<span class="cl-chip">—</span>';
    return `<tr class="${r.do_not_call?'dnc':r.ordered_today?'ord':''}" data-k="${clE(r.ckey)}"><td><input type="checkbox" class="cl-sel" ${CLS.sel.has(r.ckey)?'checked':''} style="width:22px;height:22px"></td>
    <td><b>${clE(r.name)}</b><small>${clE(r.address||'')} ${r.ctype!=='Customer'?'· '+clE(r.ctype):''}${r.rate_req?' · 📉':''}${r.do_not_call?' · ⛔DNC':''}${r.wrong_number?' · ❌wrong':''}</small></td>
    <td>${clE(r.call_no)||'<small>—</small>'}</td><td>${clE(r.wa_no)||'<small>—</small>'}</td><td>${clE(r.area||'—')}</td>
    <td>${clE(r.last_order||'—')}${r.gap!==null&&r.gap!==undefined?`<small>${r.gap} दिन पहले</small>`:''}</td><td>${clE(r.last_call_at||'—')}</td><td>${st}</td>
    <td class="acts"><button class="cl-btn g sm" data-a="call">📞 Call</button><button class="cl-btn n sm" data-a="hist">📜 History</button><button class="cl-btn n sm" data-a="wa">💬</button></td></tr>`; }).join('')||'<tr><td colspan="9" style="text-align:center;padding:24px;color:#99a">कोई customer नहीं</td></tr>'}
  </tbody></table></div>`;
  const P=clPane();
  P.querySelector('#cl-q').oninput=e=>{ CLS.q=e.target.value; clearTimeout(clCust._t); clCust._t=setTimeout(()=>{ const p=e.target.selectionStart; clCust._render=1; clCustDraw(); },250); };
  P.querySelector('#cl-fa').onchange=e=>{ CLS.f.area=e.target.value; clCustDraw(); };
  P.querySelector('#cl-ff').onchange=e=>{ CLS.f.flag=e.target.value; clCustDraw(); };
  P.querySelector('#cl-addc').onclick=()=>clDetail(null);
  P.querySelector('#cl-cs').onclick=()=>clCallMany([...CLS.sel]);
  P.querySelectorAll('tbody tr[data-k]').forEach(tr=>{ const k=tr.dataset.k;
    tr.querySelector('.cl-sel').onchange=e=>{ e.target.checked?CLS.sel.add(k):CLS.sel.delete(k); P.querySelector('#cl-cs').textContent='📞 Selected को Call ('+CLS.sel.size+')'; };
    tr.querySelector('[data-a=call]').onclick=()=>clCallOne(k);
    tr.querySelector('[data-a=hist]').onclick=()=>clDetail(k);
    tr.querySelector('[data-a=wa]').onclick=()=>{ const r=rows.find(x=>x.ckey===k); const n=clMobile(r&&(r.wa_no||r.call_no)); if(n.length!==10) return toast('WhatsApp number भरा नहीं है'); window.open('https://wa.me/91'+n,'_blank','noopener'); }; });
}
let clDrawing=false;
async function clCustDraw(){ if(clDrawing) return; clDrawing=true; try{ await clCust(); }finally{ clDrawing=false; } }

/* ---- एक/कई customers को call ---- */
async function clCallOne(k,quiet){
  const r=clMerge().find(x=>x.ckey===k); if(!r) return {ok:false};
  if(!quiet&&!confirm(`${r.name} को call लगाएँ?`+(CLS.mode==='live'?'':'\n(MOCK mode — नकली call)'))) return {ok:false,cancelled:true};
  try{ const j=await clApi('/api/call',{action:'call_customer',ckey:k}); if(!quiet) toast(j.mock?`MOCK: ${(CL_OUT[j.outcome]||[j.outcome])[0]}`:'📞 Call शुरू हुई'); return j; }
  catch(e){ if(!quiet) toast(e.message); return {ok:false,error:e.message,code:e.code}; }
}
async function clCallMany(keys){
  if(!keys.length) return toast('पहले customers चुनें');
  if(!confirm(`${keys.length} customers को एक-एक करके call लगाएँ?`)) return;
  let done=0, skipped=[]; const hard=['stopped','paused','window','sunday','limit_calls','limit_cost'];
  for(const k of keys){ const r=await clCallOne(k,true); if(r.ok) done++; else { skipped.push((clMerge().find(x=>x.ckey===k)||{}).name+': '+(r.error||'')); if(hard.includes(r.code)){ break; } } }
  CLS.sel.clear(); toast(`${done} calls · ${skipped.length} skip`); if(skipped.length) alert('Skip हुए:\n'+skipped.join('\n')); clRender();
}

/* ---- Customer detail ---- */
async function clDetail(k){
  const base=k?clMerge().find(x=>x.ckey===k):null; const c=Object.assign({ckey:'',name:'',address:'',call_no:'',wa_no:'',same_flag:false,area:'',ctype:'Customer',reorder_days:3,best_time:'',do_not_call:false,wrong_number:false,notes:''},base||{});
  let calls=[]; if(k&&CLS.server){ try{ calls=(await clApi('/api/call?view=calls&ckey='+encodeURIComponent(k))).calls; }catch(e){} }
  const due=k?clTally(k):null; let orders=[]; try{ orders=ordAll().filter(o=>clK(o.name)===k&&!o.cancelled).sort((a,b)=>clD(b.date).localeCompare(clD(a.date))).slice(0,8); }catch(e){}
  let rr=[]; try{ rr=waObjs().filter(o=>clK(o.custKey||o.name)===k); }catch(e){}
  const bk=popup({title:k?`👤 ${clE(c.name)}`:'➕ नया Customer',
    body:`<div class="cl-f">
      ${k?'':`<label class="full">नाम (English, Tally जैसा)<input id="cd-name" value="${clE(c.name)}"></label>`}
      <label class="full">पता<input id="cd-addr" value="${clE(c.address)}"></label>
      <label>📞 Call No.<input id="cd-call" inputmode="numeric" maxlength="10" value="${clE(c.call_no)}"></label>
      <label>💬 WhatsApp No.<input id="cd-wa" inputmode="numeric" maxlength="10" value="${clE(c.wa_no)}"></label>
      <label class="row"><input type="checkbox" id="cd-same" ${c.same_flag?'checked':''}> दोनों नंबर एक ही हैं</label>
      <label>Area<input id="cd-area" value="${clE(c.area)}" maxlength="10"></label>
      <label>Type<select id="cd-type">${CL_TYPES.map(t=>`<option ${c.ctype===t?'selected':''}>${t}</option>`).join('')}</select></label>
      <label>कितने दिन में Reorder<input type="number" id="cd-rd" min="1" max="60" value="${clE(c.reorder_days)}"></label>
      <label>Best call time<input id="cd-bt" value="${clE(c.best_time)}" placeholder="जैसे सुबह 10-12"></label>
      <label class="row"><input type="checkbox" id="cd-dnc" ${c.do_not_call?'checked':''}> ⛔ Do Not Call</label>
      <label class="row"><input type="checkbox" id="cd-wr" ${c.wrong_number?'checked':''}> ❌ Wrong Number</label>
      <label class="full">Notes<textarea id="cd-notes" rows="2">${clE(c.notes)}</textarea></label></div>
    ${k?`<div class="cl-card" style="margin-top:12px"><h4>💰 Tally बाक़ी: ${due===null?'—':'₹'+Number(due).toLocaleString('en-IN')}</h4>
      ${rr.length?`<div class="cl-note">📉 Rate requests: ${rr.map(o=>clE(o.item)+' ₹'+clE(o.newRate)+' ('+clE(o.status)+')').join(' · ')} — फ़ैसला: Home → WhatsApp → Objection</div>`:''}</div>
    <div class="cl-card"><h4>🧾 Orders (Order Book)</h4>${orders.map(o=>`<div class="cl-call"><b>#${clE(o.no)}</b> ${clE(o.date)} ${o.source==='call'||o.src==='call'?'📞':o.src==='wa'?'💬':''} — ${(o.items||[]).map(i=>clE(i.name)+' '+clE(i.qty)).join(', ')}
        <button class="cl-btn y sm" data-ord="${clE(o.date)}|${clE(o.id)}">✏️ Order badlo</button></div>`).join('')||'<div class="cl-note">कोई order नहीं</div>'}</div>
    <div class="cl-card"><h4>📜 Call History</h4>${calls.map(x=>{ const o=CL_OUT[x.outcome]||[x.status,'n']; return `<div class="cl-call"><b>${clE(x.t)}</b> ${x.direction==='in'?'📥':'📤'} <span class="cl-chip ${o[1]}">${o[0]}</span> ${x.is_mock?'<span class="cl-chip o">MOCK</span>':''} <small>${x.duration_sec}s${x.cost>0?' · ₹'+x.cost:''}</small>
      ${x.outcome_note?`<div class="cl-note">📝 ${clE(x.outcome_note)}</div>`:''}<div>${clE(x.summary||'')}</div>
      ${x.has_rec?`<button class="cl-btn n sm" data-rec="${x.id}">▶️ Recording सुनें</button><span></span>`:''}
      ${x.transcript?`<details><summary>📄 पूरा Transcript</summary><pre>${clE(x.transcript)}</pre></details>`:''}</div>`; }).join('')||`<div class="cl-note">${CLS.server?'अभी कोई call नहीं':'Server से जुड़ने पर history दिखेगी'}</div>`}</div>`:''}`,
    foot:`<button class="pp-btn cancel" onclick="closePopup()">बंद</button><div style="display:flex;gap:8px">${k?'<button class="pp-btn addmore" id="cd-call-btn">📞 Call</button>':''}<button class="pp-btn save" id="cd-save">💾 Save</button></div>`,
    onOpen(el){
      el.querySelector('.pp').style.maxWidth='760px'; el.querySelector('.pp-body').style.maxHeight='72vh'; el.querySelector('.pp-body').style.overflowY='auto';
      const call=el.querySelector('#cd-call'), wa=el.querySelector('#cd-wa'), same=el.querySelector('#cd-same');
      const sync=()=>{ if(same.checked){ wa.value=call.value; wa.disabled=true; } else wa.disabled=false; };
      call.oninput=()=>{ if(same.checked) wa.value=call.value; }; same.onchange=sync; sync();
      el.querySelectorAll('[data-ord]').forEach(b=>b.onclick=()=>{ const [d,id]=b.dataset.ord.split('|'); const f=typeof ordFind==='function'&&ordFind(d,id); if(!f) return toast('Order नहीं मिला'); closePopup(); go('orderbook'); orderForm(Object.assign({},f.o,{date:d})); });
      el.querySelectorAll('[data-rec]').forEach(b=>b.onclick=async()=>{ b.disabled=true; b.textContent='⏳…';
        try{ const r=await clApi('/api/call?view=recording&id='+b.dataset.rec,null,true); if(!r.ok){ const j=await r.json().catch(()=>({})); throw new Error(j.error||'Recording नहीं चली'); }
          const url=URL.createObjectURL(await r.blob()); b.outerHTML=`<audio controls autoplay src="${url}"></audio>`; }catch(e){ toast(e.message); b.disabled=false; b.textContent='▶️ Recording सुनें'; } });
      const cb=el.querySelector('#cd-call-btn'); if(cb) cb.onclick=async()=>{ closePopup(); await clCallOne(k); clDetail(k); };
      el.querySelector('#cd-save').onclick=async()=>{
        const name=k?c.name:el.querySelector('#cd-name').value.trim(); if(!name) return toast('नाम भरें');
        const body={ckey:k||clK(name),name,address:el.querySelector('#cd-addr').value.trim(),call_no:clMobile(call.value),wa_no:clMobile(same.checked?call.value:wa.value),same_flag:same.checked,
          area:el.querySelector('#cd-area').value.trim().toUpperCase(),ctype:el.querySelector('#cd-type').value,reorder_days:el.querySelector('#cd-rd').value,
          best_time:el.querySelector('#cd-bt').value.trim(),do_not_call:el.querySelector('#cd-dnc').checked,wrong_number:el.querySelector('#cd-wr').checked,notes:el.querySelector('#cd-notes').value.trim()};
        try{ body.rate_area=(typeof tvArea==='function')?tvArea(body.address):''; if(!body.area){ try{ body.area=areaOf(body.address).code||''; }catch(e){} }
          const j=await clApi('/api/call',{action:'save_contact',contact:body});
          /* Tally + WhatsApp bot इसी sg_mobiles से चलते हैं — WhatsApp number को प्राथमिकता */
          const mob=body.wa_no||body.call_no; if(mob&&typeof tvSetMob==='function') tvSetMob(body.ckey,mob);
          if(j.duplicate) alert('⚠️ यही Call number पहले से "'+j.duplicate.name+'" में है.');
          toast('Save ✔'); closePopup(); CLS.tab='cust'; clRender(); }catch(e){ toast(e.message); } };
    }});
}

/* ---- Callbacks ---- */
async function clCb(){
  const j=await clApi('/api/call?view=callbacks');
  clPane().innerHTML=`<div class="cl-card"><h4>🔔 Callback list</h4>${j.callbacks.map(x=>`<div class="cl-call ${x.status}"><b>${clE(x.name||x.phone)}</b> · ${clE(x.phone)} · ⏰ ${clE(x.due)} ${x.status==='done'?'<span class="cl-chip g">Done</span>':''}
    <div class="cl-note">${clE(x.note||'')}</div>${x.status==='open'?`<div class="cl-bar">${x.ckey?`<button class="cl-btn g sm" data-c="${clE(x.ckey)}">📞 Call</button>`:''}<button class="cl-btn n sm" data-d="${x.id}">✔ हो गया</button></div>`:''}</div>`).join('')||'<div class="cl-note">कोई callback नहीं</div>'}</div>`;
  clPane().querySelectorAll('[data-c]').forEach(b=>b.onclick=async()=>{ await clCallOne(b.dataset.c); clRender(); });
  clPane().querySelectorAll('[data-d]').forEach(b=>b.onclick=async()=>{ try{ await clApi('/api/call',{action:'callback_done',id:b.dataset.d}); clRender(); }catch(e){ toast(e.message); } });
}

/* ---- Settings ---- */
async function clSet(){
  const j=await clApi('/api/call?view=settings'); const s=j.settings; CLS.settings=s; CLS.mode=j.n8n_mode;
  const I=(k,l,t='text',x='')=>`<label>${l}<input id="cs-${k}" type="${t}" value="${clE(s[k]??'')}" ${x}></label>`;
  const C=(k,l)=>`<label class="row"><input type="checkbox" id="cs-${k}" ${s[k]?'checked':''}> ${l}</label>`;
  clPane().innerHTML=`${clBanner(j.n8n_mode,j.runtime)}
  <div class="cl-card"><h4>📱 Owner numbers (कहीं hard-code नहीं)</h4><div class="cl-f">${I('owner1','Owner 1 (Primary)','tel','maxlength="10" inputmode="numeric"')}${I('owner2','Owner 2 (Secondary)','tel','maxlength="10" inputmode="numeric"')}</div></div>
  <div class="cl-card"><h4>🕘 Call समय और limits</h4><div class="cl-f">${I('window_start','शुरू','time')}${I('window_end','बंद','time')}${I('daily_call_limit','Daily call limit','number','min="0"')}${I('daily_cost_limit','Daily cost limit ₹','number','min="0"')}
    ${I('retry_max','Not-picked retry (बार)','number','min="0" max="10"')}${I('retry_gap_min','Retry gap (मिनट)','number','min="1"')}${I('ordered_window_days','"Ordered" window (दिन; 0 = सिर्फ़ आज)','number','min="0" max="30"')}${I('big_order_qty','बड़ा order (qty) → approval; 0 = बंद','number','min="0"')}
    ${I('concurrency','एक साथ calls (1 = एक-एक)','number','min="1" max="5"')}${I('reorder_days_default','Default Reorder दिन','number','min="1"')}</div>
    <div class="cl-f" style="margin-top:10px">${C('sunday_off','रविवार बंद')}${C('announce_recording','Call में "recording हो रही है" बोलें')}${C('pending_order_block','Pending (undelivered) order वालों को भी skip करें')}${C('auto_reorder','Auto Reorder (Phase D)')}${C('auto_wheat','Wheat Procurement Auto-start (default OFF)')}</div></div>
  <div class="cl-card"><h4>🌾 Stock settings</h4><div class="cl-f">${I('wheat_bora_kg','1 wheat bora = kg','number','min="1"')}${I('bag_tare_kg','Bag tare (kg/bora)','number','step="any" min="0"')}${I('wheat_per_atta_bora','1 bora atta के लिए wheat (खाली = skip)','number','step="any"')}${C('weights_include_bag','Weights में bag शामिल है')}</div></div>
  <div class="cl-card"><h4>🔌 n8n connection</h4><div class="cl-note">Base URL / secret सिर्फ़ Cloudflare Environment Variables में (N8N_BASE_URL, N8N_SECRET) — यहाँ नहीं. Mode: <b>${j.n8n_mode==='live'?'LIVE':'MOCK'}</b></div>
    <div class="cl-bar"><button class="cl-btn y" id="cs-test">🔌 n8n Test</button><button class="cl-btn r" id="cs-stop">🛑 Stop All Calls</button><button class="cl-btn n" id="cs-audit">🧾 Audit log</button></div></div>
  <button class="cl-btn g xl" id="cs-save">💾 Settings Save</button>`;
  const P=clPane(); const ids=['owner1','owner2','window_start','window_end','daily_call_limit','daily_cost_limit','retry_max','retry_gap_min','ordered_window_days','big_order_qty','concurrency','reorder_days_default','wheat_bora_kg','bag_tare_kg','wheat_per_atta_bora'];
  const bools=['sunday_off','announce_recording','pending_order_block','auto_reorder','auto_wheat','weights_include_bag'];
  P.querySelector('#cs-save').onclick=async()=>{ const o={}; ids.forEach(k=>o[k]=P.querySelector('#cs-'+k).value); bools.forEach(k=>o[k]=P.querySelector('#cs-'+k).checked);
    try{ const r=await clApi('/api/call',{action:'save_settings',settings:o}); toast('Settings save ✔ ('+r.changed.length+' बदली)'); clRender(); }catch(e){ toast(e.message); } };
  P.querySelector('#cs-test').onclick=async()=>{ try{ const r=await clApi('/api/call',{action:'test_n8n'}); alert((r.mode==='live'?'LIVE: ':'MOCK: ')+r.message); }catch(e){ alert(e.message); } };
  P.querySelector('#cs-stop').onclick=async()=>{ if(!confirm('सारी calls तुरंत बंद करें?')) return; try{ await clApi('/api/call',{action:'stop_all',on:true}); toast('⛔ सारी calls बंद'); clRender(); }catch(e){ toast(e.message); } };
  P.querySelector('#cs-audit').onclick=async()=>{ try{ const a=(await clApi('/api/call?view=audit')).audit; popup({title:'🧾 Audit log',body:a.map(x=>`<div class="cl-call"><b>${clE(x.action)}</b> ${clE(x.entity)} <small>${clE(x.t)}</small><div class="cl-note">${clE(JSON.stringify(x.detail)).slice(0,300)}</div></div>`).join('')||'खाली',foot:'<span></span><button class="pp-btn cancel" onclick="closePopup()">बंद</button>'}); }catch(e){ toast(e.message); } };
}

/* =====================================================================
   🚨 EMERGENCY / STOCK  (Phase A: dashboard + limits + alerts; Phase C में ledger entries)
   ===================================================================== */
const EML={ok:'ठीक',warning:'⚠️ Warning',emergency:'🟠 Emergency',critical:'🔴 Critical'};
async function emRender(){
  const el=document.getElementById('em-body'); if(!el) return;
  el.innerHTML='<div class="cl-wrap"><div class="cl-card">⏳ लोड हो रहा है…</div></div>';
  try{
    const j=await clApi('/api/stock?view=summary'); const today={}; j.today.forEach(t=>today[t.item]=t);
    const bar=i=>{ const top=Math.max(Number(i.warn)||0,Number(i.qty)||0,1)*1.25; const dir=i.direction==='high'; const pct=Math.min(100,Math.max(0,(i.qty/(dir?(Number(i.critical)||top):top))*100)); return pct; };
    el.innerHTML=`<div class="cl-wrap"><div class="cl-bar"><button class="cl-btn n" disabled title="Phase C">➕ Stock Add</button><button class="cl-btn n" disabled title="Phase C">🏭 Chakki Entry</button><button class="cl-btn n" disabled title="Phase C">🔢 Physical Count</button>
      <button class="cl-btn y" id="em-test">🧪 Test Alert</button><button class="cl-btn n" disabled title="Phase C/D">📞 Wheat Suppliers</button></div>
      <div class="cl-banner mock">Phase A: Stock का ढाँचा, limits और alerts तैयार. Notebook "माल आवत" से auto IN, receipts से auto OUT, Chakki entry और Count — Phase C में.</div>
      ${j.items.map(i=>{ const t=today[i.code]||{in_qty:0,out_qty:0}; const lv=i.level;
        return `<div class="cl-card cl-stock"><div class="hd"><span>${clE(i.name)}</span><span>${i.qty_unit} ${clE(i.unit)} <small>(${Number(i.qty).toLocaleString('en-IN')} ${i.grp==='pack'?'pcs':'kg'})</small> · <span class="cl-chip ${lv==='ok'?'g':lv==='warning'?'o':'r'}">${EML[lv]}</span></span></div>
        <div class="bar"><i class="cl-lv-${lv}" style="width:${bar(i).toFixed(0)}%"></i></div>
        <div class="cl-note">आज IN ${Number(t.in_qty).toLocaleString('en-IN')} · OUT ${Number(t.out_qty).toLocaleString('en-IN')} · Limits (${i.direction==='high'?'ज़्यादा होने पर':'कम होने पर'}): W ${i.warn??'—'} / E ${i.emergency??'—'} / C ${i.critical??'—'}
        <button class="cl-btn n sm" data-lim="${clE(i.code)}">⚙️ Limits</button></div></div>`; }).join('')}
      <div class="cl-card"><h4>🔔 Alert history</h4>${j.alerts.map(a=>`<div class="cl-call"><b>${clE(a.item)}</b> <span class="cl-chip ${a.level==='resolved'?'g':a.level==='warning'?'o':'r'}">${clE(a.level)}</span> ${clE(a.status)} <small>${clE(a.t)}${a.acked_by?' · ack: '+clE(a.acked_by):''}</small>
        <div class="cl-note">${clE(a.message)}</div>${a.status==='open'&&a.level!=='resolved'?`<button class="cl-btn g sm" data-ack="${a.id}">✅ Acknowledge</button>`:''}</div>`).join('')||'<div class="cl-note">कोई alert नहीं</div>'}</div></div>`;
    el.querySelector('#em-test').onclick=async()=>{ try{ const r=await clApi('/api/stock',{action:'test_alert',item:'wheat',level:'warning'}); alert(r.message); }catch(e){ alert(e.message); } };
    el.querySelectorAll('[data-ack]').forEach(b=>b.onclick=async()=>{ try{ await clApi('/api/stock',{action:'ack',id:b.dataset.ack}); toast('Acknowledged ✔'); emRender(); }catch(e){ toast(e.message); } });
    el.querySelectorAll('[data-lim]').forEach(b=>b.onclick=()=>emLimits(j.items.find(x=>x.code===b.dataset.lim)));
  }catch(e){ el.innerHTML=`<div class="cl-wrap"><div class="cl-card"><b>⚠️ ${clE(e.message)}</b><div class="cl-note">call-schema.sql Adminer में चलाई है और CALL_ADMIN_TOKEN set है?</div><button class="cl-btn y" onclick="emRender()">🔄 दोबारा</button></div></div>`; }
}
function emLimits(i){
  if(!i) return; const f=i.per_unit||1; const v=x=>x===null||x===undefined?'':+(x/f).toFixed(2);
  popup({title:`⚙️ ${clE(i.name)} — Limits (${clE(i.unit)} में)`,body:`<div class="cl-f">
    <label class="full">कब alert<select id="el-dir"><option value="low" ${i.direction!=='high'?'selected':''}>Stock कम होने पर</option><option value="high" ${i.direction==='high'?'selected':''}>Stock ज़्यादा होने पर (जैसे Chokar)</option></select></label>
    <label>Warning<input id="el-w" type="number" step="any" value="${v(i.warn)}"></label><label>Emergency<input id="el-e" type="number" step="any" value="${v(i.emergency)}"></label><label>Critical<input id="el-c" type="number" step="any" value="${v(i.critical)}"></label>
    <label>Emergency cooldown (मिनट)<input id="el-ce" type="number" value="120"></label><label>Critical cooldown (मिनट)<input id="el-cc" type="number" value="15"></label></div>
    <div class="pp-note">कम होने पर: Warning ≥ Emergency ≥ Critical. 1 ${clE(i.unit)} = ${f} ${i.grp==='pack'?'pcs':'kg'}.</div>`,
    foot:'<button class="pp-btn cancel" onclick="closePopup()">रद्द</button><button class="pp-btn save" id="el-save">💾 Save</button>',
    onOpen(el){ el.querySelector('#el-save').onclick=async()=>{ const m=id=>{ const x=el.querySelector(id).value; return x===''?'':Number(x)*f; };
      try{ await clApi('/api/stock',{action:'save_limits',item:i.code,direction:el.querySelector('#el-dir').value,warn:m('#el-w'),emergency:m('#el-e'),critical:m('#el-c'),
          cooldown_emergency_min:el.querySelector('#el-ce').value,cooldown_critical_min:el.querySelector('#el-cc').value});
        toast('Limits save ✔'); closePopup(); emRender(); }catch(e){ toast(e.message); } }; }});
}

/* ---------- navigation hook ---------- */
(function(){ const _g=go; go=function(n){ _g(n); if(n==='call') clRender(); if(n==='emergency') emRender(); }; })();
