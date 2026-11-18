-- =====================================================================
-- SATYAM GOLD — CALL + EMERGENCY/STOCK  (PostgreSQL)   Phase A
-- पूरा text Adminer → SQL command में paste करके Execute करें.
-- कोई DROP / DELETE नहीं. दोबारा चलाना सुरक्षित है (DB: postgres, Schema: public).
-- Prefix:  sgc_ = Call module     sgs_ = Stock module
-- Dograh की tables (campaigns, workflow_runs, queued_runs, telephony_* ...) और
-- Collection की coll_* tables को यह file छूती भी नहीं.
-- Orders / Rates / Objections app के पुराने keys में ही रहते हैं:
--     sg_ord_<DD-MM-YYYY>  sg_rates  sg_wa_obj  sg_wa_cust  sg_mobiles   (sg_store table)
-- n8n (Postgres node) सीधे ये functions चला सकता है:
--     SELECT sgc_get_customer_by_number('9876543210');
--     SELECT sgc_get_rates('RAJU KIRANA','KKG');
--     SELECT sgc_order_upsert('{"name":"RAJU","items":[{"name":"Atta Gold","qty":5}]}'::jsonb);
--     SELECT sgc_call_completed('{...}'::jsonb);
-- =====================================================================

BEGIN;
SET LOCAL search_path TO public;

-- App का main store (पहले से हो तो कुछ नहीं होगा)
CREATE TABLE IF NOT EXISTS sg_store (
    key        TEXT PRIMARY KEY,
    value      JSONB       NOT NULL,
    updated_at BIGINT      NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,
    synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sg_store_updated_at_idx ON sg_store (updated_at);

-- ---------------------------------------------------------------------
-- Settings (key 'main' = सारी settings, key 'runtime' = kill switch / pause)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sgc_settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Customers (key = Tally name key: UPPER + single spaces)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sgc_contacts (
    ckey         TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    address      TEXT NOT NULL DEFAULT '',
    call_no      TEXT NOT NULL DEFAULT '',
    wa_no        TEXT NOT NULL DEFAULT '',
    same_flag    BOOLEAN NOT NULL DEFAULT false,
    area         TEXT NOT NULL DEFAULT '',          -- ORD_AREAS code (KKG, MNS ...)
    rate_area    TEXT NOT NULL DEFAULT '',          -- tvArea(address): sg_rates areaAdj का key
    ctype        TEXT NOT NULL DEFAULT 'Customer'
                 CHECK (ctype IN ('Customer','Dukandar','Hotel','Wheat Supplier','Other')),
    reorder_days INT  NOT NULL DEFAULT 3 CHECK (reorder_days BETWEEN 1 AND 60),
    best_time    TEXT NOT NULL DEFAULT '',
    do_not_call  BOOLEAN NOT NULL DEFAULT false,
    wrong_number BOOLEAN NOT NULL DEFAULT false,
    notes        TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sgc_contacts_call_idx ON sgc_contacts (right(call_no, 10));
CREATE INDEX IF NOT EXISTS sgc_contacts_wa_idx   ON sgc_contacts (right(wa_no, 10));
CREATE INDEX IF NOT EXISTS sgc_contacts_area_idx ON sgc_contacts (area);

-- ---------------------------------------------------------------------
-- Calls (हर call का एक row, exactly एक outcome)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sgc_calls (
    id            BIGSERIAL PRIMARY KEY,
    call_ref      TEXT UNIQUE,                       -- app/n8n/Dograh की call id (idempotency)
    direction     TEXT NOT NULL DEFAULT 'out' CHECK (direction IN ('out','in')),
    kind          TEXT NOT NULL DEFAULT 'single',    -- single, area, reorder, custom, wheat, inbound, alert
    ckey          TEXT,
    name          TEXT NOT NULL DEFAULT '',
    phone         TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','live','completed','failed')),
    outcome       TEXT CHECK (outcome IS NULL OR outcome IN ('order_placed','rate_enquiry','rate_reduction','callback',
                    'not_interested','not_picked','wrong_number','do_not_call','order_update')),
    outcome_note  TEXT NOT NULL DEFAULT '',
    callback_at   TIMESTAMPTZ,
    duration_sec  INT NOT NULL DEFAULT 0,
    cost          NUMERIC(10,2) NOT NULL DEFAULT 0,
    recording_ref TEXT,                              -- सिर्फ़ reference; असली URL कभी frontend को नहीं
    transcript    TEXT NOT NULL DEFAULT '',
    summary       TEXT NOT NULL DEFAULT '',
    reason        TEXT NOT NULL DEFAULT '',          -- Dial Pad / custom call का instruction
    order_ref     JSONB,                             -- {date,no,id,qty,items} या pending approval
    campaign_id   BIGINT,
    is_mock       BOOLEAN NOT NULL DEFAULT false,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at      TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sgc_calls_ckey_idx    ON sgc_calls (ckey, started_at DESC);
CREATE INDEX IF NOT EXISTS sgc_calls_started_idx ON sgc_calls (started_at DESC);
CREATE INDEX IF NOT EXISTS sgc_calls_phone_idx   ON sgc_calls (right(phone, 10));

-- Campaign / queue (Phase B) — table अभी से तैयार
CREATE TABLE IF NOT EXISTS sgc_campaigns (
    id         BIGSERIAL PRIMARY KEY,
    kind       TEXT NOT NULL DEFAULT 'area',         -- area, reorder, wheat, selected
    areas      JSONB NOT NULL DEFAULT '[]'::jsonb,
    status     TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','paused','stopped','done')),
    params     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at   TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS sgc_queue (
    id          BIGSERIAL PRIMARY KEY,
    campaign_id BIGINT NOT NULL REFERENCES sgc_campaigns(id),
    ckey        TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    phone       TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','calling','done','removed','unreachable')),
    reason      TEXT NOT NULL DEFAULT '',
    tries       INT NOT NULL DEFAULT 0,
    next_try_at TIMESTAMPTZ,
    call_id     BIGINT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, ckey)
);

CREATE TABLE IF NOT EXISTS sgc_callbacks (
    id         BIGSERIAL PRIMARY KEY,
    call_id    BIGINT UNIQUE,
    ckey       TEXT, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
    due_at     TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day',
    note       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rate reduction request: असली objection sg_wa_obj (WhatsApp → Objection) में जाती है; यहाँ सिर्फ़ link
CREATE TABLE IF NOT EXISTS sgc_rate_requests (
    id             BIGSERIAL PRIMARY KEY,
    obj_id         TEXT UNIQUE,
    call_id        BIGINT,
    ckey           TEXT, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
    item           TEXT NOT NULL DEFAULT '',
    requested_rate NUMERIC, today_rate NUMERIC,
    status         TEXT NOT NULL DEFAULT 'open',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- बड़े order (threshold से ऊपर) — owner approve करे तभी Order Book (sg_ord_*) में जाते हैं
CREATE TABLE IF NOT EXISTS sgc_pending_orders (
    id         BIGSERIAL PRIMARY KEY,
    call_id    BIGINT,
    ckey       TEXT, name TEXT NOT NULL DEFAULT '',
    payload    JSONB NOT NULL,
    total_qty  NUMERIC NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    order_ref  JSONB,
    decided_by TEXT, decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wheat supplier के offers (AI कभी खरीद final नहीं करता)
CREATE TABLE IF NOT EXISTS sgc_wheat_offers (
    id            BIGSERIAL PRIMARY KEY,
    call_id       BIGINT,
    ckey          TEXT, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
    qty_kg        NUMERIC, rate NUMERIC, delivery_date DATE, vehicle TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'offer' CHECK (status IN ('offer','accepted','declined')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sgc_wheat_offers_call_uq ON sgc_wheat_offers (call_id) WHERE call_id IS NOT NULL;

-- app → n8n भेजे events का log (secret कभी नहीं लिखा जाता)
CREATE TABLE IF NOT EXISTS sgc_outbox (
    id         BIGSERIAL PRIMARY KEY,
    event      TEXT NOT NULL,
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    mode       TEXT NOT NULL DEFAULT 'mock',
    status     TEXT NOT NULL DEFAULT 'sent',
    response   TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit: rate, limit, stock, settings, kill switch
CREATE TABLE IF NOT EXISTS sgc_audit (
    id     BIGSERIAL PRIMARY KEY,
    at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor  TEXT NOT NULL DEFAULT 'owner',
    action TEXT NOT NULL,
    entity TEXT NOT NULL DEFAULT '',
    detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS sgc_audit_at_idx ON sgc_audit (at DESC);

-- ---------------------------------------------------------------------
-- STOCK  (sgs_)  — base unit kg (packing: pcs).  Ledger = single source of truth
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sgs_items (
    code     TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    grp      TEXT NOT NULL DEFAULT 'raw' CHECK (grp IN ('raw','pack','byproduct','finished','other')),
    unit     TEXT NOT NULL DEFAULT 'kg',            -- दिखाने की unit: bora / pcs / kg
    per_unit NUMERIC NOT NULL DEFAULT 1 CHECK (per_unit > 0),   -- 1 unit = कितने base (wheat bora = 50 kg)
    enabled  BOOLEAN NOT NULL DEFAULT true,
    sort     INT NOT NULL DEFAULT 100
);
CREATE TABLE IF NOT EXISTS sgs_ledger (
    id      BIGSERIAL PRIMARY KEY,
    item    TEXT NOT NULL REFERENCES sgs_items(code),
    qty     NUMERIC NOT NULL,                       -- +IN / -OUT (base unit)
    source  TEXT NOT NULL,                          -- maal, arcpt, wrcpt, chakki, opening, add, count
    ref     TEXT NOT NULL,                          -- source की unique id (दोबारा गिनती नहीं)
    note    TEXT NOT NULL DEFAULT '',
    by_who  TEXT NOT NULL DEFAULT 'system',
    at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, ref)
);
CREATE INDEX IF NOT EXISTS sgs_ledger_item_idx ON sgs_ledger (item, at DESC);
CREATE TABLE IF NOT EXISTS sgs_limits (
    item         TEXT PRIMARY KEY REFERENCES sgs_items(code),
    direction    TEXT NOT NULL DEFAULT 'low' CHECK (direction IN ('low','high')),   -- Chokar जैसे items 'high'
    warn         NUMERIC, emergency NUMERIC, critical NUMERIC,                       -- base unit
    cooldown_emergency_min INT NOT NULL DEFAULT 120,
    cooldown_critical_min  INT NOT NULL DEFAULT 15,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sgs_map (            -- receipt item → stock item (editable)
    src     TEXT NOT NULL,                      -- arcpt / wrcpt
    match   TEXT NOT NULL,                      -- receipt item name
    item    TEXT NOT NULL REFERENCES sgs_items(code),
    qty_per NUMERIC NOT NULL DEFAULT 1,         -- 1 receipt unit = कितना stock OUT
    PRIMARY KEY (src, match, item)
);
CREATE TABLE IF NOT EXISTS sgs_alerts (
    id          BIGSERIAL PRIMARY KEY,
    item        TEXT NOT NULL,
    level       TEXT NOT NULL CHECK (level IN ('warning','emergency','critical','resolved')),
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
    message     TEXT NOT NULL DEFAULT '',
    qty         NUMERIC,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_sent   TIMESTAMPTZ,
    acked_at    TIMESTAMPTZ, acked_by TEXT
);
CREATE INDEX IF NOT EXISTS sgs_alerts_item_idx ON sgs_alerts (item, created_at DESC);
CREATE TABLE IF NOT EXISTS sgs_counts (
    id         BIGSERIAL PRIMARY KEY,
    item       TEXT NOT NULL REFERENCES sgs_items(code),
    system_qty NUMERIC NOT NULL, actual_qty NUMERIC NOT NULL,
    reason     TEXT NOT NULL DEFAULT '', by_who TEXT NOT NULL DEFAULT 'owner',
    at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed (सिर्फ़ तब जब न हो) — सब Settings से editable
INSERT INTO sgs_items (code,name,grp,unit,per_unit,enabled,sort) VALUES
 ('wheat',    'Wheat (गेहूँ)',          'raw',      'bora', 50, true, 10),
 ('kali_bora','Kali bora / Bag',        'pack',     'pcs',   1, true, 20),
 ('pk_a18',   'Atta 18kg packet',       'pack',     'pcs',   1, true, 21),
 ('pk_a10',   'Atta 10kg packet',       'pack',     'pcs',   1, true, 22),
 ('pk_a5',    'Atta 5kg packet',        'pack',     'pcs',   1, true, 23),
 ('pk_sattu', 'Sattu packet',           'pack',     'pcs',   1, true, 24),
 ('pk_besan', 'Besan packet',           'pack',     'pcs',   1, true, 25),
 ('thread',   'Thread / Dhaga',         'pack',     'pcs',   1, false,26),
 ('labels',   'Labels',                 'pack',     'pcs',   1, false,27),
 ('chokar',   'Chokar',                 'byproduct','bora', 50, true, 30),
 ('chana',    'Chana',                  'raw',      'bora', 50, true, 40),
 ('daal',     'Daal',                   'raw',      'bora', 50, true, 41),
 ('roast',    'Roast',                  'raw',      'bora', 50, true, 42),
 ('atta_fin', 'Atta (finished)',        'finished', 'bora', 50, false,50),
 ('jut_bora', 'Jut Bora (empty)',       'pack',     'pcs',   1, false,51)
ON CONFLICT (code) DO NOTHING;

INSERT INTO sgs_limits (item,direction,warn,emergency,critical) VALUES
 ('wheat','low',15000,10000,2500),     -- 300 / 200 / 50 bora (1 bora = 50 kg)
 ('chokar','high',NULL,NULL,NULL)
ON CONFLICT (item) DO NOTHING;

INSERT INTO sgs_map (src,match,item,qty_per) VALUES
 ('arcpt','Atta 18kg','pk_a18',1), ('arcpt','Atta 10kg','pk_a10',1), ('arcpt','Atta 5kg','pk_a5',1),
 ('arcpt','Sattu','pk_sattu',1),   ('arcpt','Besan','pk_besan',1)
ON CONFLICT (src,match,item) DO NOTHING;

-- =====================================================================
-- FUNCTIONS
-- =====================================================================
CREATE OR REPLACE FUNCTION public.sgc_ist_date() RETURNS TEXT LANGUAGE sql AS $$ SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','DD-MM-YYYY') $$;
CREATE OR REPLACE FUNCTION public.sgc_ist_ts()   RETURNS TEXT LANGUAGE sql AS $$ SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','HH12:MI AM') $$;
CREATE OR REPLACE FUNCTION public.sgc_key(t TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT upper(regexp_replace(btrim(coalesce(t,'')),'\s+',' ','g')) $$;
CREATE OR REPLACE FUNCTION public.sgc_last10(t TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT right(regexp_replace(coalesce(t,''),'\D','','g'),10) $$;
CREATE OR REPLACE FUNCTION public.sgc_num(t TEXT) RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RETURN NULLIF(btrim(coalesce(t,'')),'')::numeric; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION public.sgc_setting(k TEXT, dflt TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT value->>k FROM sgc_settings WHERE key='main'), dflt) $$;

CREATE OR REPLACE FUNCTION public.sgc_log(p_actor TEXT, p_action TEXT, p_entity TEXT, p_detail JSONB) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO sgc_audit(actor,action,entity,detail) VALUES (COALESCE(p_actor,'system'),p_action,COALESCE(p_entity,''),COALESCE(p_detail,'{}'::jsonb)) $$;

-- Rate: Master → Area ±adj → Customer special  (app के srRate() जैसा; AI कभी इससे कम नहीं देता)
CREATE OR REPLACE FUNCTION public.sgc_rate(R JSONB, area TEXT, ckey TEXT, k TEXT) RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE base NUMERIC; sp TEXT; BEGIN
  base := COALESCE(NULLIF(R->'master'->>k,'')::NUMERIC,0) + COALESCE(NULLIF(R->'areaAdj'->area->>k,'')::NUMERIC,0);
  IF NULLIF(R->'area'->area->>k,'') IS NOT NULL THEN base := (R->'area'->area->>k)::NUMERIC; END IF;
  base := GREATEST(0,base);
  sp := NULLIF(R->'cust'->ckey->>k,''); IF sp IS NOT NULL THEN base := base - sp::NUMERIC; END IF;
  RETURN GREATEST(0, base);
EXCEPTION WHEN OTHERS THEN RETURN 0; END $$;

CREATE OR REPLACE FUNCTION public.sgc_rate_key(item TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lower(item) ~ 'gold' THEN 'gold'
    WHEN lower(item) ~ '(^|[^0-9])18\s*kg' THEN 'a18'
    WHEN lower(item) ~ '(^|[^0-9])10\s*kg' THEN 'a10'
    WHEN lower(item) ~ '(^|[^0-9])5\s*kg'  THEN 'a5'
    WHEN lower(item) ~ 'besan|बेसन' THEN 'besan'
    WHEN lower(item) ~ 'sattu|सत्तू' THEN 'sattu'
    WHEN lower(item) ~ 'chokar|चोकर' THEN 'chokar'
    WHEN lower(item) ~ 'wheat|गेहूँ|गेहूं' THEN 'wheat'
    ELSE NULL END $$;

-- आज के rates (customer के special rate के साथ)
CREATE OR REPLACE FUNCTION public.sgc_get_rates(p_ckey TEXT, p_area TEXT DEFAULT 'OTHER') RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE R JSONB; ck TEXT := sgc_key(p_ckey); ar TEXT := COALESCE(NULLIF(p_area,''),'OTHER'); out JSONB;
BEGIN
  SELECT value->'v' INTO R FROM sg_store WHERE key='sg_rates';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('k',k,'name',nm,'unit',un,'rate',rt,
           'special', NULLIF(R->'cust'->ck->>k,'') IS NOT NULL) ORDER BY ord), '[]'::jsonb) INTO out
  FROM (SELECT k,nm,un,ord,sgc_rate(R,ar,ck,k) AS rt FROM (VALUES
     ('gold','Atta Gold','बोरा',1),('a18','Atta 18kg','थैला',2),('a10','Atta 10kg','थैला',3),('a5','Atta 5kg','थैला',4),
     ('besan','Besan','kg',5),('sattu','Sattu','kg',6),('chokar','Chokar','बोरा',7),('wheat','Wheat','बोरा',8)) v(k,nm,un,ord)) t
  WHERE rt > 0;
  RETURN jsonb_build_object('date', sgc_ist_date(), 'rates', out, 'note', 'Rate सिर्फ़ Set Rate (sg_rates) से; AI इससे कम नहीं देगा');
END $$;

-- ordered check: आज (या last N दिन) किसी भी channel से order आया?
CREATE OR REPLACE FUNCTION public.sgc_ordered(p_name TEXT, p_days INT DEFAULT 0) RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE d INT; arr JSONB; o JSONB; ck TEXT := sgc_key(p_name); n INT := 0; last_no TEXT; last_date TEXT;
BEGIN
  IF ck = '' THEN RETURN jsonb_build_object('ordered',false,'count',0); END IF;
  FOR d IN 0..GREATEST(0,COALESCE(p_days,0)) LOOP
    SELECT value->'v' INTO arr FROM sg_store
      WHERE key = 'sg_ord_' || to_char((now() AT TIME ZONE 'Asia/Kolkata')::date - d,'DD-MM-YYYY');
    IF arr IS NOT NULL AND jsonb_typeof(arr)='array' THEN
      FOR o IN SELECT * FROM jsonb_array_elements(arr) LOOP
        IF sgc_key(o->>'name') = ck AND COALESCE(o->>'cancelled','false') <> 'true' THEN
          n := n + 1; last_no := o->>'no'; last_date := to_char((now() AT TIME ZONE 'Asia/Kolkata')::date - d,'DD-MM-YYYY');
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ordered', n>0, 'count', n, 'no', last_no, 'date', last_date);
END $$;

-- undelivered (pending) orders of one customer
CREATE OR REPLACE FUNCTION public.sgc_pending_for(p_name TEXT) RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('date', substr(s.key,8), 'no', o->>'no', 'items',
     (SELECT jsonb_agg(jsonb_build_object('name',i->>'name','qty',sgc_num(i->>'qty')))
        FROM jsonb_array_elements(COALESCE(o->'items','[]'::jsonb)) i WHERE COALESCE(sgc_num(i->>'qty'),0) > 0))), '[]'::jsonb)
  FROM sg_store s CROSS JOIN LATERAL jsonb_array_elements(s.value->'v') o
  WHERE s.key ~ '^sg_ord_[0-9]{2}-[0-9]{2}-[0-9]{4}$' AND jsonb_typeof(s.value->'v')='array'
    AND sgc_key(o->>'name') = sgc_key(p_name) AND COALESCE(o->>'cancelled','false') <> 'true'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(o->'items','[]'::jsonb)) i WHERE COALESCE(sgc_num(i->>'qty'),0) > 0) $$;

-- Caller को number से पहचानो: sgc_contacts → sg_wa_cust → sg_mobiles
CREATE OR REPLACE FUNCTION public.sgc_get_customer_by_number(p_phone TEXT) RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE l10 TEXT := sgc_last10(p_phone); c sgc_contacts%ROWTYPE; cust JSONB; mk TEXT;
  nm TEXT; ck TEXT; ad TEXT := ''; ar TEXT := 'OTHER'; src TEXT; ct TEXT := 'Customer'; dnc BOOLEAN := false; wn BOOLEAN := false;
  days INT := COALESCE(NULLIF(sgc_setting('ordered_window_days','0'),'')::int,0); lastc JSONB;
BEGIN
  IF length(l10) <> 10 THEN RETURN jsonb_build_object('found',false,'phone',l10); END IF;
  SELECT * INTO c FROM sgc_contacts WHERE right(call_no,10)=l10 OR right(wa_no,10)=l10 ORDER BY (right(call_no,10)=l10) DESC LIMIT 1;
  IF FOUND THEN
    nm:=c.name; ck:=c.ckey; ad:=c.address; ar:=COALESCE(NULLIF(c.rate_area,''),'OTHER'); ct:=c.ctype; dnc:=c.do_not_call; wn:=c.wrong_number; src:='contact';
  ELSE
    SELECT value->'v'->l10 INTO cust FROM sg_store WHERE key='sg_wa_cust';
    IF cust IS NOT NULL AND cust->>'name' IS NOT NULL THEN
      nm:=cust->>'name'; ck:=COALESCE(cust->>'key',sgc_key(nm)); ad:=COALESCE(cust->>'address',''); ar:=COALESCE(NULLIF(cust->>'area',''),'OTHER');
      IF cust->>'type'='cred' THEN ct:='Wheat Supplier'; END IF; src:='wa_cust';
    ELSE
      SELECT j.key INTO mk FROM sg_store s, jsonb_each_text(CASE WHEN jsonb_typeof(s.value->'v')='object' THEN s.value->'v' ELSE '{}'::jsonb END) j
        WHERE s.key='sg_mobiles' AND sgc_last10(j.value)=l10 LIMIT 1;
      IF mk IS NOT NULL THEN nm:=mk; ck:=mk; src:='tally_mobile'; END IF;
    END IF;
  END IF;
  IF nm IS NULL THEN RETURN jsonb_build_object('found',false,'phone',l10,'lead',true); END IF;
  SELECT jsonb_build_object('at',started_at,'outcome',outcome,'summary',summary) INTO lastc
    FROM sgc_calls WHERE ckey=ck AND status='completed' ORDER BY started_at DESC LIMIT 1;
  RETURN jsonb_build_object('found',true,'source',src,'phone',l10,'ckey',ck,'name',nm,'address',ad,'area',ar,'ctype',ct,
    'do_not_call',dnc,'wrong_number',wn,'ordered_today',sgc_ordered(nm,days),'pending_orders',sgc_pending_for(nm),
    'last_call',lastc,'rates',sgc_get_rates(ck,ar)->'rates','rates_date',sgc_ist_date());
END $$;

-- Contact flags (do_not_call / wrong_number) — ckey मालूम हो तभी
CREATE OR REPLACE FUNCTION public.sgc_contact_flag(p_ckey TEXT, p_name TEXT, p_phone TEXT, p_flag TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(p_ckey,'')='' THEN RETURN; END IF;
  INSERT INTO sgc_contacts(ckey,name,call_no) VALUES (p_ckey, COALESCE(NULLIF(p_name,''),p_ckey), sgc_last10(p_phone))
    ON CONFLICT (ckey) DO NOTHING;
  IF p_flag='do_not_call' THEN UPDATE sgc_contacts SET do_not_call=true, updated_at=now() WHERE ckey=p_ckey;
  ELSIF p_flag='wrong_number' THEN UPDATE sgc_contacts SET wrong_number=true, updated_at=now() WHERE ckey=p_ckey; END IF;
END $$;

-- ---------------------------------------------------------------------
-- ORDER → sg_ord_<आज>  (Order Book / WhatsApp वाली ही list)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sgc_order_write(p JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE okey TEXT := 'sg_ord_' || sgc_ist_date(); cur JSONB; ord JSONB; ix INT; mx INT; R JSONB; area TEXT; ck TEXT;
  nm TEXT := btrim(COALESCE(p->>'name','')); its JSONB := '[]'::jsonb; it JSONB; k TEXT; rt NUMERIC; q NUMERIC;
  ex JSONB; exi JSONB; j INT; found_ BOOLEAN; merged BOOLEAN := false; ordd JSONB; no_ TEXT; tot NUMERIC := 0;
BEGIN
  IF nm = '' THEN RAISE EXCEPTION 'name required'; END IF;
  IF jsonb_typeof(p->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'items')=0 THEN RAISE EXCEPTION 'items required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sgc:orders',0));
  SELECT value->'v' INTO R FROM sg_store WHERE key='sg_rates';
  area := COALESCE(NULLIF(p->>'rate_area',''),'OTHER'); ck := sgc_key(COALESCE(NULLIF(p->>'ckey',''),nm));
  FOR it IN SELECT * FROM jsonb_array_elements(p->'items') LOOP
    q := sgc_num(it->>'qty');
    IF q IS NULL OR q <= 0 OR q > 5000 THEN RAISE EXCEPTION 'invalid qty for %', COALESCE(it->>'name','item'); END IF;
    IF COALESCE(btrim(it->>'name'),'')='' THEN RAISE EXCEPTION 'item name required'; END IF;
    k := sgc_rate_key(it->>'name');
    rt := CASE WHEN k IN ('gold','chokar','wheat') THEN sgc_rate(R,area,ck,k) ELSE 0 END;   -- बाक़ी items: "rate later" (Order Book का पुराना व्यवहार)
    its := its || jsonb_build_object('name',btrim(it->>'name'),'qty',q,'rate',CASE WHEN rt>0 THEN trim_scale(rt)::text ELSE '' END,'note',COALESCE(it->>'note',''));
    tot := tot + q;
  END LOOP;
  SELECT COALESCE(value->'v','[]'::jsonb) INTO cur FROM sg_store WHERE key=okey FOR UPDATE; cur := COALESCE(cur,'[]'::jsonb);
  SELECT (n-1)::int, x INTO ix, ex FROM jsonb_array_elements(cur) WITH ORDINALITY a(x,n)
    WHERE sgc_key(x->>'name')=ck AND COALESCE(x->>'cancelled','false')<>'true' ORDER BY n LIMIT 1;
  IF ex IS NOT NULL THEN
    merged := true; ord := ex;
    FOR it IN SELECT * FROM jsonb_array_elements(its) LOOP
      found_ := false;
      FOR j IN 0..jsonb_array_length(COALESCE(ord->'items','[]'::jsonb))-1 LOOP
        exi := ord->'items'->j;
        IF lower(exi->>'name') = lower(it->>'name') THEN
          ord := jsonb_set(ord, ARRAY['items',j::text,'qty'], to_jsonb(COALESCE(sgc_num(exi->>'qty'),0) + (it->>'qty')::numeric));
          found_ := true; EXIT;
        END IF;
      END LOOP;
      IF NOT found_ THEN ord := jsonb_set(ord,'{items}', COALESCE(ord->'items','[]'::jsonb) || it); END IF;
    END LOOP;
    ord := ord || jsonb_build_object('ordered', COALESCE(ord->'ordered', ord->'items'), 'callMerged', true);
    cur := jsonb_set(cur, ARRAY[ix::text], ord); no_ := ord->>'no';
  ELSE
    SELECT COALESCE(max((o->>'no')::INT),0) INTO mx FROM sg_store s, jsonb_array_elements(COALESCE(s.value->'v','[]'::jsonb)) o
      WHERE s.key LIKE 'sg_ord_%' AND (o->>'no') ~ '^\d+$';
    no_ := CASE WHEN mx+1<10 THEN '0'||(mx+1)::TEXT ELSE (mx+1)::TEXT END;
    ord := jsonb_build_object('id','c'||md5(nm||clock_timestamp()::TEXT||random()::TEXT),'no',no_,'ts',sgc_ist_ts(),
      'name',nm,'address',COALESCE(p->>'address',''),'phone',COALESCE(NULLIF(sgc_last10(p->>'phone'),''),''),
      'src','call','source','call','call_id',p->'call_id','items',its,
      'ordered',(SELECT jsonb_agg(jsonb_build_object('name',x->>'name','qty',(x->>'qty')::numeric)) FROM jsonb_array_elements(its) x),'deliv','[]'::jsonb);
    cur := cur || ord;
  END IF;
  INSERT INTO sg_store(key,value,updated_at) VALUES (okey, jsonb_build_object('v',cur), (EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at, synced_at=now();
  RETURN jsonb_build_object('ok',true,'order_id',ord->>'id','no',no_,'date',sgc_ist_date(),'merged',merged,'qty',tot,'items',its);
END $$;

-- n8n/AI का order: idempotent (call_id), rate कभी AI से नहीं, बड़ा order → pending approval
CREATE OR REPLACE FUNCTION public.sgc_order_upsert(p JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE cid BIGINT := NULLIF(p->>'call_id','')::bigint; prev JSONB; thr NUMERIC := COALESCE(NULLIF(sgc_setting('big_order_qty','50'),'')::numeric,0);
  tot NUMERIC; res JSONB; pid BIGINT; ckx TEXT; it JSONB;
BEGIN
  IF jsonb_typeof(p->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'items')=0 THEN RAISE EXCEPTION 'items required'; END IF;
  IF COALESCE(btrim(p->>'name'),'')='' THEN RAISE EXCEPTION 'name required'; END IF;
  IF cid IS NOT NULL THEN
    SELECT order_ref INTO prev FROM sgc_calls WHERE id=cid FOR UPDATE;
    IF prev IS NOT NULL THEN RETURN prev || jsonb_build_object('duplicate',true); END IF;
  END IF;
  -- validation threshold-check से पहले (बड़ा/ग़लत qty बिना जाँच pending में न जाए)
  FOR it IN SELECT * FROM jsonb_array_elements(p->'items') LOOP
    IF COALESCE(btrim(it->>'name'),'')='' THEN RAISE EXCEPTION 'item name required'; END IF;
    IF sgc_num(it->>'qty') IS NULL OR sgc_num(it->>'qty') <= 0 OR sgc_num(it->>'qty') > 5000 THEN RAISE EXCEPTION 'invalid qty for %', COALESCE(it->>'name','item'); END IF;
  END LOOP;
  SELECT COALESCE(sum(COALESCE(sgc_num(x->>'qty'),0)),0) INTO tot FROM jsonb_array_elements(p->'items') x;
  ckx := sgc_key(COALESCE(NULLIF(p->>'ckey',''),p->>'name'));
  IF thr > 0 AND tot > thr THEN
    INSERT INTO sgc_pending_orders(call_id,ckey,name,payload,total_qty) VALUES (cid,ckx,btrim(p->>'name'),p,tot) RETURNING id INTO pid;
    res := jsonb_build_object('ok',true,'pending_approval',true,'pending_id',pid,'qty',tot,'message','बड़ा order — owner approval के बाद Order Book में जाएगा');
    PERFORM sgc_log('system','order_pending_approval','order',jsonb_build_object('pending_id',pid,'name',p->>'name','qty',tot,'threshold',thr));
  ELSE
    res := sgc_order_write(p);
  END IF;
  IF cid IS NOT NULL THEN UPDATE sgc_calls SET order_ref=res WHERE id=cid; END IF;
  RETURN res;
END $$;

CREATE OR REPLACE FUNCTION public.sgc_order_decide(p_id BIGINT, p_approve BOOLEAN, p_actor TEXT) RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE po sgc_pending_orders%ROWTYPE; res JSONB;
BEGIN
  SELECT * INTO po FROM sgc_pending_orders WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pending order not found'; END IF;
  IF po.status <> 'pending' THEN RETURN COALESCE(po.order_ref,'{}'::jsonb) || jsonb_build_object('status',po.status,'duplicate',true); END IF;
  IF p_approve THEN
    res := sgc_order_write(po.payload);
    UPDATE sgc_pending_orders SET status='approved', order_ref=res, decided_by=p_actor, decided_at=now() WHERE id=p_id;
    IF po.call_id IS NOT NULL THEN UPDATE sgc_calls SET order_ref=res WHERE id=po.call_id; END IF;
  ELSE
    res := jsonb_build_object('ok',true,'rejected',true);
    UPDATE sgc_pending_orders SET status='rejected', order_ref=res, decided_by=p_actor, decided_at=now() WHERE id=p_id;
    IF po.call_id IS NOT NULL THEN UPDATE sgc_calls SET order_ref=res WHERE id=po.call_id; END IF;
  END IF;
  PERFORM sgc_log(p_actor,CASE WHEN p_approve THEN 'order_approved' ELSE 'order_rejected' END,'order',jsonb_build_object('pending_id',p_id,'name',po.name,'qty',po.total_qty));
  RETURN res || jsonb_build_object('status',CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END);
END $$;

-- "Rate kam karo" → EXISTING objection list (sg_wa_obj) में source:'call' के साथ
CREATE OR REPLACE FUNCTION public.sgc_rate_request_create(p JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE cur JSONB; obj JSONB; oid TEXT; ck TEXT; nm TEXT := btrim(COALESCE(p->>'name','')); k TEXT; today_ NUMERIC; R JSONB; ar TEXT;
  req NUMERIC := sgc_num(p->>'requested_rate'); cid BIGINT := NULLIF(p->>'call_id','')::bigint; item TEXT := COALESCE(NULLIF(btrim(p->>'item'),''),'Atta'); ph TEXT; ex JSONB;
BEGIN
  IF nm='' THEN RAISE EXCEPTION 'name required'; END IF;
  IF req IS NULL OR req <= 0 THEN RAISE EXCEPTION 'requested_rate must be positive'; END IF;
  ck := sgc_key(COALESCE(NULLIF(p->>'ckey',''),nm)); ar := COALESCE(NULLIF(p->>'rate_area',''),'OTHER');
  SELECT value->'v' INTO R FROM sg_store WHERE key='sg_rates';
  k := sgc_rate_key(item); today_ := CASE WHEN k IS NULL THEN NULL ELSE sgc_rate(R,ar,ck,k) END;
  ph := CASE WHEN sgc_last10(p->>'phone')<>'' THEN '91'||sgc_last10(p->>'phone') ELSE '' END;
  PERFORM pg_advisory_xact_lock(hashtextextended('wa:objections',0));      -- WhatsApp objection जैसा ही lock
  SELECT value->'v' INTO cur FROM sg_store WHERE key='sg_wa_obj' FOR UPDATE; cur := COALESCE(cur,'[]'::jsonb);
  SELECT x INTO ex FROM jsonb_array_elements(cur) x WHERE x->>'status'='open' AND x->>'source'='call' AND x->>'custKey'=ck AND lower(x->>'item')=lower(item) LIMIT 1;
  IF ex IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'duplicate',true,'obj_id',ex->>'id'); END IF;
  oid := 'ob_'||md5(ck||clock_timestamp()::text||random()::text);
  obj := jsonb_build_object('id',oid,'phone',ph,'name',nm,'address',COALESCE(p->>'address',''),'custKey',ck,'sdate',sgc_ist_date(),'rdate',sgc_ist_date(),
    'rno','CALL'||COALESCE(cid::text,''),'rcIdx',NULL,'itemIdx',NULL,'item',item,'qty',0,'oldRate',COALESCE(today_,0),'newRate',req,'total',0,
    'status','open','date',sgc_ist_date(),'ts',sgc_ist_ts(),'source','call','callId',cid);
  INSERT INTO sg_store(key,value,updated_at) VALUES ('sg_wa_obj',jsonb_build_object('v',cur||obj),(extract(epoch from clock_timestamp())*1000)::bigint)
    ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,synced_at=now();
  INSERT INTO sgc_rate_requests(obj_id,call_id,ckey,name,phone,item,requested_rate,today_rate) VALUES (oid,cid,ck,nm,ph,item,req,today_);
  RETURN jsonb_build_object('ok',true,'obj_id',oid,'today_rate',today_,'requested_rate',req);
END $$;

CREATE OR REPLACE FUNCTION public.sgc_callback_create(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE id_ BIGINT; cid BIGINT := NULLIF(p->>'call_id','')::bigint; due TIMESTAMPTZ;
BEGIN
  due := COALESCE(NULLIF(p->>'due_at','')::timestamptz, now() + interval '1 day');
  INSERT INTO sgc_callbacks(call_id,ckey,name,phone,due_at,note) VALUES (cid,NULLIF(p->>'ckey',''),COALESCE(p->>'name',''),COALESCE(p->>'phone',''),due,COALESCE(p->>'note',''))
    ON CONFLICT (call_id) DO UPDATE SET due_at=EXCLUDED.due_at, note=EXCLUDED.note RETURNING id INTO id_;
  RETURN jsonb_build_object('ok',true,'callback_id',id_,'due_at',due);
END $$;

CREATE OR REPLACE FUNCTION public.sgc_wheat_offer_create(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE id_ BIGINT; cid BIGINT := NULLIF(p->>'call_id','')::bigint;
BEGIN
  INSERT INTO sgc_wheat_offers(call_id,ckey,name,phone,qty_kg,rate,delivery_date,vehicle,note)
    VALUES (cid,NULLIF(p->>'ckey',''),COALESCE(p->>'name',''),COALESCE(p->>'phone',''),sgc_num(p->>'qty_kg'),sgc_num(p->>'rate'),NULLIF(p->>'delivery_date','')::date,COALESCE(p->>'vehicle',''),COALESCE(p->>'note',''))
    ON CONFLICT (call_id) WHERE call_id IS NOT NULL DO UPDATE SET qty_kg=EXCLUDED.qty_kg, rate=EXCLUDED.rate, delivery_date=EXCLUDED.delivery_date, vehicle=EXCLUDED.vehicle, note=EXCLUDED.note
    RETURNING id INTO id_;
  RETURN jsonb_build_object('ok',true,'offer_id',id_,'note','Offer दर्ज — खरीद final नहीं, owner confirm करेंगे');
END $$;

-- ---------------------------------------------------------------------
-- call_completed: Dograh/n8n से call का नतीजा (idempotent: call_ref)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sgc_call_completed(p JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE ref TEXT := NULLIF(btrim(p->>'call_ref'),''); oc TEXT := NULLIF(btrim(p->>'outcome'),''); cid BIGINT; cn JSONB := COALESCE(p->'contact','{}'::jsonb);
  ph TEXT := COALESCE(NULLIF(cn->>'phone',''), p->>'phone', ''); ck TEXT := NULLIF(COALESCE(cn->>'ckey',p->>'ckey'),''); nm TEXT := COALESCE(NULLIF(cn->>'name',''), p->>'name','');
  info JSONB; dir TEXT := COALESCE(NULLIF(p->>'direction',''),'out'); st TEXT; ordres JSONB; rr JSONB; cbat TIMESTAMPTZ; ra TEXT;
BEGIN
  IF ref IS NULL THEN RAISE EXCEPTION 'call_ref required'; END IF;
  IF oc IS NULL OR oc NOT IN ('order_placed','rate_enquiry','rate_reduction','callback','not_interested','not_picked','wrong_number','do_not_call','order_update') THEN
    RAISE EXCEPTION 'invalid outcome: %', COALESCE(oc,'(none)'); END IF;
  IF dir NOT IN ('out','in') THEN RAISE EXCEPTION 'invalid direction'; END IF;
  IF ck IS NULL AND sgc_last10(ph) <> '' THEN
    info := sgc_get_customer_by_number(ph);
    IF (info->>'found')='true' THEN ck := info->>'ckey'; nm := COALESCE(NULLIF(nm,''),info->>'name'); ra := info->>'area'; END IF;
  END IF;
  ck := NULLIF(sgc_key(ck),''); st := CASE WHEN oc='not_picked' AND COALESCE((p->>'duration')::int,0)=0 THEN 'completed' ELSE 'completed' END;
  cbat := CASE WHEN oc='callback' THEN COALESCE(NULLIF(p->>'callback_at','')::timestamptz, now()+interval '1 day') END;
  INSERT INTO sgc_calls(call_ref,direction,kind,ckey,name,phone,status,outcome,outcome_note,callback_at,duration_sec,cost,recording_ref,transcript,summary,reason,is_mock,ended_at)
  VALUES (ref,dir,COALESCE(NULLIF(p->>'kind',''),CASE WHEN dir='in' THEN 'inbound' ELSE 'single' END),ck,nm,sgc_last10(ph),'completed',oc,COALESCE(p->>'outcome_note',p->>'reason_note',''),cbat,
          COALESCE(NULLIF(p->>'duration','')::int,0),COALESCE(sgc_num(p->>'cost'),0),NULLIF(p->>'recording_ref',''),COALESCE(p->>'transcript',''),COALESCE(p->>'summary',''),
          COALESCE(p->>'reason',''),COALESCE((p->>'is_mock')::boolean,false),now())
  ON CONFLICT (call_ref) DO UPDATE SET status='completed',outcome=EXCLUDED.outcome,outcome_note=EXCLUDED.outcome_note,callback_at=EXCLUDED.callback_at,
     duration_sec=EXCLUDED.duration_sec,cost=EXCLUDED.cost,recording_ref=COALESCE(EXCLUDED.recording_ref,sgc_calls.recording_ref),
     transcript=EXCLUDED.transcript,summary=EXCLUDED.summary,ckey=COALESCE(sgc_calls.ckey,EXCLUDED.ckey),name=CASE WHEN sgc_calls.name='' THEN EXCLUDED.name ELSE sgc_calls.name END,
     phone=CASE WHEN sgc_calls.phone='' THEN EXCLUDED.phone ELSE sgc_calls.phone END,ended_at=now()
  RETURNING id INTO cid;

  IF oc IN ('order_placed','order_update') AND jsonb_typeof(p->'order')='object' AND jsonb_typeof(p->'order'->'items')='array' THEN
    ordres := sgc_order_upsert((p->'order') || jsonb_build_object('call_id',cid,'name',COALESCE(NULLIF(p->'order'->>'name',''),nm),'ckey',COALESCE(ck,''),
              'phone',ph,'rate_area',COALESCE(ra,p->'order'->>'rate_area','')));
  END IF;
  IF oc = 'rate_reduction' AND jsonb_typeof(p->'rate_request')='object' THEN
    rr := sgc_rate_request_create((p->'rate_request') || jsonb_build_object('call_id',cid,'name',COALESCE(NULLIF(p->'rate_request'->>'name',''),nm),'ckey',COALESCE(ck,''),'phone',ph,'rate_area',COALESCE(ra,'')));
  END IF;
  IF oc = 'callback' THEN PERFORM sgc_callback_create(jsonb_build_object('call_id',cid,'ckey',ck,'name',nm,'phone',ph,'due_at',cbat,'note',COALESCE(p->>'outcome_note',''))); END IF;
  IF oc IN ('do_not_call','wrong_number') THEN PERFORM sgc_contact_flag(ck,nm,ph,oc);
    PERFORM sgc_log('system','contact_'||oc,'contact',jsonb_build_object('ckey',ck,'call_id',cid)); END IF;
  RETURN jsonb_build_object('ok',true,'call_id',cid,'call_ref',ref,'outcome',oc,'ckey',ck,'order',ordres,'rate_request',rr);
END $$;

-- Dashboard (आज की गिनती, IST)
CREATE OR REPLACE FUNCTION public.sgc_dashboard() RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('date',sgc_ist_date(),
    'total',        count(*) FILTER (WHERE status IN ('completed','live')),
    'answered',     count(*) FILTER (WHERE status='completed' AND outcome NOT IN ('not_picked','wrong_number')),
    'not_picked',   count(*) FILTER (WHERE outcome='not_picked'),
    'orders',       count(*) FILTER (WHERE outcome IN ('order_placed','order_update')),
    'rate_only',    count(*) FILTER (WHERE outcome IN ('rate_enquiry','rate_reduction')),
    'callbacks',    count(*) FILTER (WHERE outcome='callback'),
    'live',         count(*) FILTER (WHERE status='live'),
    'queued',       count(*) FILTER (WHERE status='queued'),
    'cost',         COALESCE(sum(cost),0),
    'bora_by_calls',COALESCE(sum(COALESCE(sgc_num(order_ref->>'qty'),0)) FILTER (WHERE outcome IN ('order_placed','order_update') AND COALESCE(order_ref->>'pending_approval','false')<>'true' AND order_ref->>'rejected' IS NULL),0))
  FROM sgc_calls WHERE (started_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date $$;

-- ---------------------------------------------------------------------
-- STOCK summary (ledger से) + n8n stock_event
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sgs_summary() RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code',i.code,'name',i.name,'grp',i.grp,'unit',i.unit,'per_unit',i.per_unit,
      'qty',q.qty,'qty_unit',round(q.qty / i.per_unit, 2),'direction',COALESCE(l.direction,'low'),
      'warn',l.warn,'emergency',l.emergency,'critical',l.critical,
      'level', CASE
         WHEN l.item IS NULL THEN 'ok'
         WHEN COALESCE(l.direction,'low')='low' THEN
              CASE WHEN l.critical  IS NOT NULL AND q.qty < l.critical  THEN 'critical'
                   WHEN l.emergency IS NOT NULL AND q.qty < l.emergency THEN 'emergency'
                   WHEN l.warn      IS NOT NULL AND q.qty < l.warn      THEN 'warning' ELSE 'ok' END
         ELSE CASE WHEN l.critical  IS NOT NULL AND q.qty > l.critical  THEN 'critical'
                   WHEN l.emergency IS NOT NULL AND q.qty > l.emergency THEN 'emergency'
                   WHEN l.warn      IS NOT NULL AND q.qty > l.warn      THEN 'warning' ELSE 'ok' END END
    ) ORDER BY i.sort, i.code), '[]'::jsonb)
  FROM sgs_items i LEFT JOIN sgs_limits l ON l.item=i.code
  CROSS JOIN LATERAL (SELECT COALESCE(sum(qty),0) AS qty FROM sgs_ledger WHERE item=i.code) q
  WHERE i.enabled $$;

CREATE OR REPLACE FUNCTION public.sgs_event(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE t TEXT := COALESCE(p->>'type','alert'); id_ BIGINT;
BEGIN
  IF t = 'ack' THEN
    UPDATE sgs_alerts SET status='acknowledged', acked_at=now(), acked_by=COALESCE(p->>'by','owner')
      WHERE (id = NULLIF(p->>'id','')::bigint OR (p->>'id') IS NULL AND item = p->>'item') AND status='open';
    RETURN jsonb_build_object('ok',true,'type','ack');
  ELSIF t = 'resolved' THEN
    UPDATE sgs_alerts SET status='resolved' WHERE item=p->>'item' AND status IN ('open','acknowledged');
    INSERT INTO sgs_alerts(item,level,status,message,qty,last_sent) VALUES (p->>'item','resolved','resolved',COALESCE(p->>'message',''),sgc_num(p->>'qty'),now()) RETURNING id INTO id_;
    RETURN jsonb_build_object('ok',true,'type','resolved','id',id_);
  END IF;
  IF COALESCE(p->>'level','') NOT IN ('warning','emergency','critical') THEN RAISE EXCEPTION 'invalid level'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sgs_items WHERE code=p->>'item') THEN RAISE EXCEPTION 'unknown item'; END IF;
  INSERT INTO sgs_alerts(item,level,message,qty,last_sent) VALUES (p->>'item',p->>'level',COALESCE(p->>'message',''),sgc_num(p->>'qty'),now()) RETURNING id INTO id_;
  RETURN jsonb_build_object('ok',true,'type','alert','id',id_);
END $$;

COMMIT;
