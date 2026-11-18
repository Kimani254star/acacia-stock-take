(function () {
  'use strict';
  /* Acacia Stock Count - mobile stock take for Acacia Books.
   * Log in with the same company name, email and password as Books. Pick an open stock take (or a warehouse), count
   * (type, +/-, scan), then "Push to Assessment". Books puts the counts on the stock take and shows the variance in
   * Inventory > Assessment. Counts are kept on the phone until you clear them, so a dropped connection loses nothing.
   * The phone never shows system quantities, so counting is always blind. */
  var SUPA = 'https://xglsampckermarjpczdf.supabase.co', KEY = 'sb_publishable_x-dPR7pzhvJgag9soW0I8w_yfKTmi6A';
  var INBOX = 'stocktakeMobile', PAGE = 80, VER = '1.2.0', ASSIGNMENTS = 'stocktakeAssignments', APPROVALS = 'stocktakeApprovals';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var low = function (v) { return String(v == null ? '' : v).trim().toLowerCase(); };
  var enc = encodeURIComponent;
  var LS = window.localStorage;
  function lget(k, d) { try { var v = JSON.parse(LS.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function lset(k, v) { try { LS.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast('Phone storage is full. Push your count now.'); return false; } }
  function pj(v) { try { for (var i = 0; i < 3 && typeof v === 'string'; i++) v = JSON.parse(v); } catch (e) { return null; } return v; }
  function fmt(n) { return (Math.round(Number(n) * 10000) / 10000).toLocaleString(undefined, { maximumFractionDigits: 4 }); }

  /* plain number for input boxes: no thousands separator, so 1500 is never read back as 1.5 */
  function plain(n) { return String(Math.round(Number(n) * 10000) / 10000); }

  var tt = null;
  function toast(m, ms) { var t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(tt); tt = setTimeout(function () { t.style.display = 'none'; }, ms || 2200); }

  /* ---------- cloud (same Supabase project as Books) ---------- */
  function api(path, opt) {
    opt = opt || {};
    var ctl = new AbortController(), to = setTimeout(function () { ctl.abort(); }, opt.timeout || 25000);
    var h = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + KEY }, opt.headers || {});
    return fetch(SUPA + '/rest/v1/' + path, { method: opt.method || 'GET', headers: h, body: opt.body, signal: ctl.signal }).then(function (r) {
      clearTimeout(to);
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) { var er = new Error((j && j.message) || ('Request failed (' + r.status + ')')); er.status = r.status; er.code = j && j.code; er.auth = (r.status === 401 || r.status === 403); throw er; }
        return j;
      });
    }, function (e) { clearTimeout(to); throw new Error(e && e.name === 'AbortError' ? 'The connection timed out.' : 'No internet connection.'); });
  }
  /* every read is for ONE company: the company_id filter is sent AND the rows that come back are checked, so another company's data is never used */
  function getState(cid, key) {
    if (!cid) return Promise.reject(new Error('No company on this login. Sign in again.'));
    return api('company_state?select=company_id,value,updated_at&company_id=eq.' + enc(cid) + '&key=eq.' + enc(key)).then(function (a) {
      a = (a || []).filter(function (r) { return r && String(r.company_id) === String(cid); });
      return a[0] || null;
    });
  }
  /* add/replace our entry in the shared inbox without overwriting other people's entries (compare-and-set on updated_at) */
  async function pushInbox(cid, sub) {
    for (var n = 0; n < 6; n++) {
      var cur = await getState(cid, INBOX), list = cur ? pj(cur.value) : [];
      if (!Array.isArray(list)) list = [];
      list = list.filter(function (x) { return x && x.id !== sub.id; }); list.push(sub);
      var body = JSON.stringify(list), now = new Date().toISOString();
      try {
        var res;
        if (cur) res = await api('company_state?company_id=eq.' + enc(cid) + '&key=eq.' + enc(INBOX) + '&updated_at=eq.' + enc(cur.updated_at), { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ value: body, updated_at: now }) });
        else res = await api('company_state', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ company_id: cid, key: INBOX, value: body, updated_at: now }) });
        if (res && res.length) return true;
      } catch (e) { if (e.status !== 409 && e.code !== '23505') throw e; }
      await new Promise(function (r) { setTimeout(r, 300 + Math.random() * 700); });   /* someone else wrote at the same moment: read again and retry */
    }
    throw new Error('Could not save the count (busy). Try again.');
  }

  /* ---------- login (same account + password check as Books) ---------- */
  async function sha(s) { var b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return Array.prototype.map.call(new Uint8Array(b), function (x) { return x.toString(16).padStart(2, '0'); }).join(''); }
  async function orgMatches(cid, company) {
    var keys = ['orgInfo_' + cid, 'orgInfo'];
    for (var i = 0; i < keys.length; i++) {
      try { var r = await getState(cid, keys[i]), o = r && pj(r.value); if (o && (low(o.name) === company || low(o.companyId) === company)) return true; } catch (e) {}
    }
    return false;
  }
  async function doLogin(company, email, pass) {
    if (!(window.crypto && crypto.subtle)) throw new Error('Open this page over https to sign in.');
    email = low(email); company = low(company);
    /* the password is checked inside Postgres (acx_login); this page never sees a hash */
    async function rpcLogin(co) {
      var r = await fetch(SUPA + '/rest/v1/rpc/acx_login', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_email: email, p_password: pass, p_company: co || null }) });
      if (r.status === 404) return null;                                   /* acx_login not installed yet: old path below */
      if (r.status === 429 || r.status === 400) { var t = await r.text(); throw new Error(/lock|too many/i.test(t) ? 'Too many wrong attempts. Try again in a few minutes.' : 'Invalid email, company name or password.'); }
      if (!r.ok) throw new Error('Could not sign in (' + r.status + ').');
      var j = await r.json(); return Array.isArray(j) ? j : [];
    }
    function accept(r) {
      var d = Object.assign({}, r.data || {}); d.companyId = d.companyId || r.company_id;
      if (d.disabled === true || d.active === false || /^(inactive|disabled|suspended|blocked)$/i.test(String(d.status || ''))) throw new Error('This account is switched off. Ask your administrator.');
      if (!d.companyId) throw new Error('This account has no company. Ask your administrator.');
      try { if (r.session && window.AcxSession) window.AcxSession.add(r.session); } catch (e) {}
      return { companyId: d.companyId, companyName: d.companyName || company, email: d.email || email, name: d.name || d.fullName || d.username || d.email || email, role: d.role || '' };
    }
    var found = await rpcLogin(company);
    if (found && found.length) return accept(found[0]);
    if (found) {                                                           /* company name may only match the organisation profile: check that here */
      var any = await rpcLogin(null);
      for (var k = 0; k < (any || []).length; k++) {
        var cid = any[k].company_id; try { if (window.AcxSession && any[k].session) window.AcxSession.add(any[k].session); } catch (e) {}
        if (await orgMatches(cid, company)) return accept(any[k]);
      }
      throw new Error('Invalid email, company name or password.');
    }
    var rows = await api('app_accounts?select=login_id,username,company_id,data&or=(login_id.eq.' + enc(email) + ',username.eq.' + enc(email) + ')');
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i], d = Object.assign({}, r.data || {}); d.companyId = d.companyId || r.company_id;
      if (![d.email, d.username, r.login_id, r.username].some(function (x) { return low(x) === email; })) continue;
      var okC = low(d.companyName) === company || low(d.companyId) === company || (Array.isArray(d.previousCompanyNames) && d.previousCompanyNames.some(function (x) { return low(x) === company; }));
      if (!okC) okC = await orgMatches(d.companyId, company);
      if (!okC) continue;
      if (!(d.passwordHash && d.passwordSalt && (await sha(d.passwordSalt + ':' + pass)) === d.passwordHash)) continue;
      return accept(r);
    }
    throw new Error('Invalid email, company name or password.');
  }

  /* ---------- state ---------- */
  var U = lget('acxst_user', null), S = { screen: 'home', sess: null, tab: 'all', q: '', shown: PAGE, view: [], takes: [], whs: [], loadErr: '', loading: false, scanInc: lget('acxst_inc', true), poll: null };
  var ACCENTS = { blue: '#1e3a8a', green: '#166534', purple: '#6d28d9', teal: '#0f766e', red: '#b91c1c', slate: '#334155' };
var FONTS = {   /* same list as Books > Settings > Appearance > Font; "System UI" is the default, as in Books */
    system: ['System UI', 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif'],
    inter: ['Inter', 'Inter,system-ui,-apple-system,"Segoe UI",Arial,sans-serif'],
    roboto: ['Roboto', 'Roboto,system-ui,-apple-system,"Segoe UI",Arial,sans-serif'],
    poppins: ['Poppins', 'Poppins,system-ui,-apple-system,"Segoe UI",Arial,sans-serif'],
    georgia: ['Georgia', 'Georgia,"Times New Roman",serif'],
    mono: ['Monospace', 'ui-monospace,Menlo,Consolas,"Courier New",monospace']
  };
  function applyLook() {
    var L = lget('acxst_look', {}), h = document.documentElement;
    if (L.theme === 'dark' || L.theme === 'light') h.setAttribute('data-theme', L.theme); else h.removeAttribute('data-theme');
    var c = ACCENTS[L.accent];
    if (c) { h.style.setProperty('--pri', c); h.style.setProperty('--pri2', c); } else { h.style.removeProperty('--pri'); h.style.removeProperty('--pri2'); }
    document.body.style.fontFamily = (FONTS[L.font] || FONTS.system)[1];
    document.body.style.fontSize = ({ s: '14px', m: '16px', l: '18px' })[L.size] || '16px';
    var m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', c || '#1e3a8a');
  }
  applyLook();
  var dev = LS.getItem('acxst_dev'); if (!dev) { dev = Math.random().toString(36).slice(2, 8); try { LS.setItem('acxst_dev', dev); } catch (e) {} }
  var skey = function (k) { return 'acxst_s_' + U.companyId + '_' + k; };
  var ikey = function () { return 'acxst_idx_' + U.companyId; };
  var saveT = null;
  function saveSess() { clearTimeout(saveT); saveT = setTimeout(function () { if (S.sess) lset(skey(S.sess.k), S.sess); }, 250); }
  function saveNow() { clearTimeout(saveT); if (S.sess) lset(skey(S.sess.k), S.sess); }
  function sessions() { return lget(ikey(), []).map(function (k) { return lget(skey(k), null); }).filter(Boolean); }
  function addIdx(k) { var a = lget(ikey(), []); if (a.indexOf(k) < 0) { a.push(k); lset(ikey(), a); } }
  var hkey = function () { return 'acxst_hidden_' + U.companyId; };
  function hidden() { return lget(hkey(), []); }
  function delSess(k) { LS.removeItem(skey(k)); lset(ikey(), lget(ikey(), []).filter(function (x) { return x !== k; })); }
  function audit(s, action, itemKey, detail) {
    if (!s) return;
    s.audit = Array.isArray(s.audit) ? s.audit : [];
    var ev={ id: 'AU-' + Date.now() + '-' + Math.random().toString(36).slice(2,7), action: action, itemKey: itemKey || '', detail: detail || {}, assessment:s.title, by: U ? U.name : 'Unknown', email: U ? U.email : '', at: new Date().toISOString(), device: dev }; s.audit.push(ev);
    if (U && navigator.onLine) saveCloudList('stocktakeAuditTrail', ev).catch(function(){});
    if (s.audit.length > 1500) s.audit = s.audit.slice(-1500);
    saveSess();
  }
  function allSessions() { return sessions(); }
  function varianceRows(s) {
    return (s.items || []).filter(function(i){ return i.systemQty != null && s.counts[i.key] != null; }).map(function(i){
      var counted = Number(s.counts[i.key]), diff = counted - Number(i.systemQty), pct = Number(i.systemQty) ? diff / Math.abs(Number(i.systemQty)) * 100 : (diff ? 100 : 0);
      return { item:i, system:Number(i.systemQty), counted:counted, diff:diff, pct:pct, value:i.unitCost == null ? null : diff * Number(i.unitCost) };
    });
  }
  function itemMeta(s, key) { s.itemMeta = s.itemMeta || {}; return s.itemMeta[key] || {}; }
  async function cloudList(key) { var r = await getState(U.companyId, key), a = pj(r && r.value); return Array.isArray(a) ? a : []; }
  async function saveCloudList(key, record) {
    for (var n=0;n<6;n++) {
      var cur=await getState(U.companyId,key), list=cur?pj(cur.value):[]; if(!Array.isArray(list)) list=[];
      list=list.filter(function(x){return x && x.id!==record.id;}); list.push(record); if(key==='stocktakeAuditTrail' && list.length>3000) list=list.slice(-3000); if(key===ASSIGNMENTS && list.length>1000) list=list.slice(-1000);
      var now=new Date().toISOString(), body=JSON.stringify(list), res;
      try {
        if(cur) res=await api('company_state?company_id=eq.'+enc(U.companyId)+'&key=eq.'+enc(key)+'&updated_at=eq.'+enc(cur.updated_at),{method:'PATCH',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({value:body,updated_at:now})});
        else res=await api('company_state',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({company_id:U.companyId,key:key,value:body,updated_at:now})});
        if(res && res.length) return true;
      } catch(e) { if(e.status!==409 && e.code!=='23505') throw e; }
      await new Promise(function(r){setTimeout(r,250+Math.random()*500);});
    }
    throw new Error('Could not save shared company record. Try again.');
  }
  function stats(s) {
    var c = 0, units = 0; s.items.forEach(function (i) { var v = s.counts[i.key]; if (v != null) { c++; units += v; } });
    return { total: s.items.length, counted: c, left: s.items.length - c, units: units };
  }

  /* one entry per item key, so two lines with the same SKU/name can never share one count */
  function uniqLines(a) { var seen = {}, out = []; (a || []).forEach(function (l) { if (!l) return; var key = l.key || low(l.sku || l.name); if (!key || seen[key]) return; seen[key] = 1; out.push({ key: key, name: l.name || l.sku || '', sku: l.sku || '', barcode: l.barcode || '', barcodes: Array.isArray(l.barcodes) ? l.barcodes : [], category: l.category || '', systemQty: l.systemQty != null ? Number(l.systemQty) : null, unitCost: l.unitCost != null ? Number(l.unitCost) : null, section: l.section || l.location || '', serialTracked: !!l.serialTracked, batchTracked: !!l.batchTracked }); }); return out; }

  /* ---------- data for the home screen ---------- */
  async function loadHome(force) {
    var ck = 'acxst_cache_' + U.companyId, cache = lget(ck, null);
    if (cache && !force) { S.takes = cache.takes || []; S.whs = cache.whs || []; }
    S.loading = true; S.loadErr = ''; render();
    try {
      var rt = await getState(U.companyId, 'stockTakes'), rw = await getState(U.companyId, 'warehouses');
      var all = pj(rt && rt.value); all = Array.isArray(all) ? all : [];
      S.takes = all.filter(function (t) { return t && (t.status === 'Draft' || t.status === 'Counting'); }).map(function (t) {
        return { id: t.id, no: t.no, warehouse: t.warehouse, category: t.category || '', date: t.date || '', status: t.status, count: uniqLines(t.lines).length,
          lines: uniqLines(t.lines) };
      }).reverse();
      var w = pj(rw && rw.value); S.whs = (Array.isArray(w) ? w : []).map(function (x) { return x && x.name; }).filter(Boolean);
      lset(ck, { takes: S.takes.map(function (t) { return { id: t.id, no: t.no, warehouse: t.warehouse, category: t.category, date: t.date, status: t.status, count: t.count }; }), whs: S.whs });
    } catch (e) { S.loadErr = (e.auth ? 'Your session may have expired. Log out and sign in again. ' : '') + e.message + (cache ? ' Showing what was loaded last time.' : ''); }
    S.loading = false; render();
  }

  /* ---------- starting a count ---------- */
  function startTake(no) {
    var t = S.takes.filter(function (x) { return x.no === no; })[0]; if (!t) return;
    var k = 'T:' + t.no, s = lget(skey(k), null);
    if (!s && !t.lines) return toast('Tap the refresh button to load the items first.', 3000);
    if (!s) { s = { k: k, kind: 'take', takeNo: t.no, takeId: t.id, warehouse: t.warehouse, category: t.category, title: t.no + ' - ' + t.warehouse, startedAt: new Date().toISOString(), items: t.lines, counts: {}, section: '', assignment: '', status: 'Counting', itemMeta: {}, audit: [] }; lset(skey(k), s); addIdx(k); }
    openCount(s);
  }
  /* items of one warehouse, read from Books' cloud copy (read only; the phone never writes stock). Cached for offline use. */
  var icKey = function (wh) { return 'acxst_inv_' + U.companyId + '_' + wh; };
  async function readWarehouse(wh) {
    try {
      var r = await getState(U.companyId, 'inventory_' + wh), a = pj(r && r.value); a = Array.isArray(a) ? a : [];
      var seen = {}, items = [];
      a.forEach(function (it) {
        if (!it || !it.name) return; var key = low(it.sku || it.name); if (seen[key]) return; seen[key] = 1;
        var q = ['quantity','qty','qtyOnHand','stock','stockOnHand','availableStock','currentStock','stockQty','onHand'].map(function(k){ return it[k]; }).filter(function(v){ return v !== undefined && v !== null && v !== ''; })[0];
        var cost = ['costPrice','purchasePrice','unitCost','buyingPrice','averageCost','cost','purchase_rate'].map(function(k){ return it[k]; }).filter(function(v){ return v !== undefined && v !== null && v !== ''; })[0];
        items.push({ key: key, name: it.name, sku: it.sku || '', barcode: it.barcode || '', barcodes: Array.isArray(it.barcodes) ? it.barcodes : (Array.isArray(it.alternateBarcodes) ? it.alternateBarcodes : []), category: it.category || it.categoryName || '', systemQty: q == null || isNaN(Number(q)) ? null : Number(q), unitCost: cost == null || isNaN(Number(cost)) ? null : Number(cost), section: it.section || it.location || it.bin || '', serialTracked: !!(it.serialTracked || it.trackSerial), batchTracked: !!(it.batchTracked || it.trackBatch) });
      });
      lset(icKey(wh), { at: new Date().toISOString(), items: items });
      return items;
    } catch (e) { var c = lget(icKey(wh), null); if (c && c.items) return c.items; throw e; }   /* offline: use the last synced list */
  }
  async function startWarehouse(wh) {
    var k = 'W:' + wh, s = lget(skey(k), null);
    if (!s) {
      toast('Loading items...');
      try {
        var items = await readWarehouse(wh);
        if (!items.length) return toast('No items found in ' + wh + '.');
        s = { k: k, kind: 'wh', takeNo: '', warehouse: wh, category: '', title: wh + ' (new count)', startedAt: new Date().toISOString(), items: items, counts: {}, section: '', assignment: '', status: 'Counting', itemMeta: {}, audit: [] }; lset(skey(k), s); addIdx(k);
      } catch (e) { return toast(e.message); }
    }
    openCount(s);
  }
  /* Pull the latest stock list from Books. New items are added to counts already started; counts you entered are never touched. */
  async function syncStock(btn) {
    if (!navigator.onLine) return toast('You are offline. Connect to sync stock from Books.', 3000);
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }
    var added = 0, fresh = 0, err = '';
    try {
      await loadHome(true);
      if (S.loadErr) throw new Error(S.loadErr);
      for (var i = 0; i < S.whs.length; i++) { await readWarehouse(S.whs[i]); fresh++; }
      sessions().forEach(function (ss) {
        var src = null;
        if (ss.kind === 'wh') { var c = lget(icKey(ss.warehouse), null); src = c && c.items; }
        else if (ss.kind === 'take') { var t = S.takes.filter(function (x) { return x.no === ss.takeNo; })[0]; src = t && t.lines; }
        if (!src) return;
        var have = {}; ss.items.forEach(function (i) { have[i.key] = 1; });
        var n = 0; src.forEach(function (i) { if (!have[i.key]) { ss.items.push(i); have[i.key] = 1; n++; } });
        if (n) { added += n; lset(skey(ss.k), ss); if (S.sess && S.sess.k === ss.k) S.sess = ss; }
      });
      lset('acxst_synced_' + U.companyId, new Date().toISOString());
    } catch (e) { err = e.message; }
    if (err) toast('Sync failed: ' + err, 3500); else toast('Synced ' + fresh + ' warehouse' + (fresh === 1 ? '' : 's') + (added ? ' · ' + added + ' new item' + (added === 1 ? '' : 's') + ' added to your counts' : ' · stock list is up to date'), 3500);
    render();
  }
  function openCount(s) { S.sess = s; s.status = s.status || 'Counting'; S.screen = 'count'; S.tab = 'all'; S.q = ''; S.section=''; S.shown = PAGE; render(); }

  /* ---------- counting ---------- */
  function setCount(key, v) {
    var s = S.sess, old = s.counts[key]; if (v == null || v === '') delete s.counts[key]; else s.counts[key] = v;
    audit(s, 'COUNT_UPDATED', key, { before: old == null ? null : old, after: v == null || v === '' ? null : v });
    s.pushedAt = null; saveSess(); progress();
  }
  function parseQ(v) {
    var x = String(v == null ? '' : v).replace(/\s/g, ''); if (x === '') return null;
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(x)) x = x.replace(/,/g, '');   /* 1,500 = 1500 */
    else if (/^\d*,\d+$/.test(x)) x = x.replace(',', '.');                  /* 2,5 = 2.5 */
    if (/^\d+\.$/.test(x)) x = x.slice(0, -1);
    if (!/^\d*\.?\d+$/.test(x)) return NaN; return parseFloat(x);
  }
  function filtered() {
    var s = S.sess, q = low(S.q);
    return s.items.filter(function (i) {
      var c = s.counts[i.key] != null;
      if (S.section && String(i.section||'') !== S.section) return false;
      if (S.tab === 'todo' && c) return false; if (S.tab === 'done' && !c) return false;
      return !q || (low(i.name) + ' ' + low(i.sku) + ' ' + low(i.barcode) + ' ' + low(i.category)).indexOf(q) > -1;
    });
  }
  function rowHtml(i) {
    var v = S.sess.counts[i.key];
    return '<div class="row' + (v != null ? ' done' : '') + '" data-k="' + esc(i.key) + '"><div class="t"><b>' + esc(i.name) + '</b><span>' + esc([i.sku, i.barcode, i.category].filter(Boolean).join(' · ')) + '</span></div>' +
      '<div class="q"><button data-a="itemmeta" data-item="' + esc(i.key) + '" aria-label="Item details">⋯</button><button data-a="dec" aria-label="less">&minus;</button><input type="text" inputmode="decimal" data-a="inp" value="' + (v == null ? '' : esc(plain(v))) + '" placeholder="-" aria-label="Counted quantity for ' + esc(i.name) + '"><button data-a="inc" aria-label="more">+</button></div></div>';
  }
  function drawList() {
    var box = $('#list'); if (!box) return;
    S.view = filtered(); var out = S.view.slice(0, S.shown).map(rowHtml).join('');
    if (!S.view.length) out = '<div class="more center mute">' + (S.q ? 'Nothing matches "' + esc(S.q) + '".' : S.tab === 'todo' ? 'Everything has been counted.' : 'No items here yet.') + '</div>';
    else if (S.view.length > S.shown) out += '<div class="more"><button class="btn sec" data-a="more">Show more (' + (S.view.length - S.shown) + ' left)</button></div>';
    box.innerHTML = out;
  }
  function progress() {
    var st = stats(S.sess), a = $('#prog'), b = $('#bari'), f = $('#fcount');
    if (a) a.textContent = st.counted + ' of ' + st.total + ' counted';
    if (b) b.style.width = (st.total ? st.counted * 100 / st.total : 0) + '%';
    if (f) f.textContent = st.counted + ' / ' + st.total;
  }
  function rowEl(key) { var rs = document.querySelectorAll('#list .row'); for (var i = 0; i < rs.length; i++) if (rs[i].getAttribute('data-k') === key) return rs[i]; return null; }
  function refreshRow(key) {
    var r = rowEl(key); if (!r) return; var v = S.sess.counts[key];
    r.classList.toggle('done', v != null); r.querySelector('input').value = v == null ? '' : plain(v);
  }
  function bump(key, d) {
    var cur = S.sess.counts[key], nv = cur == null ? (d > 0 ? d : 0) : Math.max(0, Math.round((cur + d) * 10000) / 10000);
    setCount(key, nv); refreshRow(key);
  }
  /* a scan (camera, Bluetooth scanner or typed code + Enter): exact barcode or SKU */
  function handleCode(code) {
    var c = low(code), s = S.sess, hit = null; if (!c) return null;
    for (var n = 0; n < s.items.length; n++) { var i = s.items[n]; if (low(i.barcode) === c || low(i.sku) === c || (i.barcodes || []).some(function(x){ return low(x) === c; })) { hit = i; break; } }
    if (!hit) { var uk='acxst_unknown_'+U.companyId, ua=lget(uk,[]); ua.push({code:String(code),warehouse:s.warehouse,assessment:s.title,at:new Date().toISOString(),by:U.email}); lset(uk,ua.slice(-500)); return { ok: false, msg: 'Unknown code recorded: ' + code }; }
    if (S.scanInc) { bump(hit.key, 1); return { ok: true, msg: hit.name + ' → ' + fmt(s.counts[hit.key]) }; }
    S.q = hit.sku || hit.barcode || hit.name; S.tab = 'all'; S.shown = PAGE; var qi = $('#q'); if (qi) qi.value = S.q; drawList();
    var r = rowEl(hit.key); if (r) { r.classList.add('flash'); r.scrollIntoView({ block: 'center' }); var inp = r.querySelector('input'); if (inp) { inp.focus(); inp.select(); } }
    return { ok: true, msg: hit.name };
  }

  /* ---------- camera scanner ---------- */
  var cam = { stream: null, timer: null, zx: null, last: '', at: 0 };
  function beep() { try { var a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(); o.frequency.value = 880; o.connect(a.destination); o.start(); setTimeout(function () { o.stop(); a.close(); }, 90); } catch (e) {} try { navigator.vibrate && navigator.vibrate(40); } catch (e) {} }
  function onCam(code) {
    var now = Date.now(); if (code === cam.last && now - cam.at < 1800) return; cam.last = code; cam.at = now;
    var r = handleCode(code); if (!r) return; if (r.ok) beep(); else { try { navigator.vibrate && navigator.vibrate([60, 40, 60]); } catch (e) {} } $('#scanMsg').textContent = r.msg;
  }
  async function openScan() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return toast('This browser cannot open the camera. Use a Bluetooth scanner or type the code.');
    var sc = $('#scan'), vid = $('#scanVid'); sc.style.display = 'flex'; $('#scanMsg').textContent = 'Point the camera at a barcode';
    try {
      if ('BarcodeDetector' in window) {
        var want = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code'], have = BarcodeDetector.getSupportedFormats ? await BarcodeDetector.getSupportedFormats() : want;
        var det = new BarcodeDetector({ formats: want.filter(function (f) { return have.indexOf(f) > -1; }) });
        cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        vid.srcObject = cam.stream; await vid.play();
        cam.timer = setInterval(function () { if (vid.readyState < 2) return; det.detect(vid).then(function (r) { if (r && r.length) onCam(r[0].rawValue); }, function () {}); }, 220);
      } else {
        await new Promise(function (ok, no) { if (window.ZXing) return ok(); var s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js'; s.onload = ok; s.onerror = function () { no(new Error('Could not load the scanner. Check your connection.')); }; document.head.appendChild(s); });
        cam.zx = new ZXing.BrowserMultiFormatReader();
        cam.zx.decodeFromVideoDevice(null, vid, function (res) { if (res) onCam(res.getText()); });
      }
    } catch (e) { closeScan(); toast(e && e.name === 'NotAllowedError' ? 'Camera permission was blocked.' : (e.message || 'Could not start the camera.'), 3500); }
  }
  function closeScan() {
    clearInterval(cam.timer); cam.timer = null;
    try { if (cam.zx) cam.zx.reset(); } catch (e) {} cam.zx = null;
    if (cam.stream) { cam.stream.getTracks().forEach(function (t) { t.stop(); }); cam.stream = null; }
    var v = $('#scanVid'); if (v) v.srcObject = null; $('#scan').style.display = 'none';
  }

  /* ---------- push ---------- */
  async function doPush(by, zero) {
    var s = S.sess, lines = [];
    s.items.forEach(function (i) { var v = s.counts[i.key]; if (v == null && zero) v = 0; if (v != null) { var meta=itemMeta(s,i.key); lines.push({ name:i.name, sku:i.sku, barcode:i.barcode, barcodes:i.barcodes||[], qty:v, section:i.section||meta.section||'', batch:meta.batch||'', expiry:meta.expiry||'', serialNumbers:meta.serials||[], condition:meta.condition||'Good' }); } });
    if (!lines.length) throw new Error('Nothing has been counted yet.');
    audit(s, 'SUBMITTED_TO_BOOKS', '', { lineCount: lines.length });
    var sub = { id: 'MC-' + dev + '-' + s.k.replace(/[^A-Za-z0-9_-]/g, '_'), by: by, byEmail: U.email, at: new Date().toISOString(), warehouse: s.warehouse, takeNo: s.takeNo || '', assessmentId: s.k, device: dev, applied: false, lines: lines };
    await pushInbox(U.companyId, sub);
    s.pushedAt = sub.at; s.subId = sub.id; s.pushedLines = lines.length; saveNow();
    return sub;
  }
  function startPoll(id) {
    clearInterval(S.poll); var n = 0;
    S.poll = setInterval(async function () {
      if (S.screen !== 'review' || ++n > 90) return clearInterval(S.poll);
      try {
        var r = await getState(U.companyId, INBOX), a = pj(r && r.value), m = Array.isArray(a) && a.filter(function (x) { return x && x.id === id; })[0], b = $('#recv'); if (!m || !b) return;
        if (m.applied === true) { b.className = 'msg ok'; b.innerHTML = '<b>Received in Books as ' + esc(m.takeNo) + '.</b><br>' + esc(m.matched) + ' item(s) counted' + (m.unmatched ? ', ' + esc(m.unmatched) + ' not found in the stock take' : '') + '. Open <b>Inventory &gt; Assessment</b> in Books and tap <b>View Variance</b>.'; clearInterval(S.poll); }
        else if (m.applied === 'rejected') { b.className = 'msg bad'; b.innerHTML = '<b>Books could not use this count.</b><br>' + esc(m.note || ''); clearInterval(S.poll); }
      } catch (e) {}
    }, 10000);
  }

  /* ---------- screens ---------- */
  function topbar(title, sub, back, right) {
    return '<div class="top">' + MENU + LOGO + (back ? '<button class="ib" data-a="back" aria-label="back">&#8592;</button>' : '') + '<h1>' + esc(title) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</h1>' + (right || '') + '</div>' + (navigator.onLine ? '' : '<div class="off">Offline - counts are saved on this phone</div>');
  }
  var LOGO = '<img class="tl" src="icon-96.png" alt="Acacia" width="38" height="38">';
  var MENU = '<button class="ib menu" data-a="menu" aria-label="menu">&#9776;</button>';
  function vLogin(err, co, em) {
    return '<div class="wrap"><img class="logo" src="icon-192.png" alt="Acacia Books" width="96" height="96"><h1 class="center" style="margin:6px 0 2px;font-size:22px">Acacia Stock Count</h1><p class="center mute" style="margin:0 0 16px">Sign in with your Acacia Books login</p>' +
      '<div class="card"><label>Company name</label><input id="lc" type="text" autocomplete="organization" autocapitalize="none" value="' + esc(co != null ? co : lget('acxst_lastco', '')) + '">' +
      '<label>Email</label><input id="le" type="email" autocomplete="username" autocapitalize="none" value="' + esc(em != null ? em : lget('acxst_lastem', '')) + '">' +
      '<label>Password</label><input id="lp" type="password" autocomplete="current-password"><label class="sw"><input type="checkbox" id="showpw"> Show password</label>' +
      (err ? '<div class="msg bad">' + esc(err) + '</div>' : '') + '<button class="btn" id="lgo" data-a="login">Sign in</button></div></div>';
  }
  function vHome() {
    var ss = sessions(), h = topbar('Dashboard', U.companyName + ' · ' + U.name, false, '<button class="ib" data-a="refresh" aria-label="refresh">&#8635;</button>') + '<div class="wrap">';
    if (S.loadErr) h += '<div class="msg warn">' + esc(S.loadErr) + '</div>';
    var lsy = lget('acxst_synced_' + U.companyId, '');
    h += '<div class="card"><h2>Assessment overview</h2><div class="sum"><div><b>'+ss.length+'</b><span>assessments</span></div><div><b>'+ss.filter(function(x){return x.pushedAt;}).length+'</b><span>submitted</span></div><div><b>'+ss.reduce(function(n,x){return n+stats(x).counted;},0)+'</b><span>items counted</span></div><div><b>'+ss.reduce(function(n,x){return n+(x.audit||[]).length;},0)+'</b><span>audit events</span></div></div></div><div class="card"><h2>Stock from Books</h2><div class="mute">' + (lsy ? 'Last synced ' + esc(new Date(lsy).toLocaleString()) : 'Not synced yet') + '. Items are read from Books; nothing is changed in Books.</div><button class="btn sec" data-a="sync">Sync stock from Books</button></div>';
    h += '<div class="card"><h2>On this phone</h2>';
    if (!ss.length) h += '<div class="mute">No counts started yet.</div>';
    ss.forEach(function (s) {
      var st = stats(s);
      h += '<div class="item"><div class="t"><b>' + esc(s.title) + '</b><span>' + st.counted + ' of ' + st.total + ' counted' + (s.pushedAt ? ' · sent ' + new Date(s.pushedAt).toLocaleString() : '') + '</span></div>' + (s.pushedAt ? '<span class="pill ok">sent</span>' : '') + '<button class="go" data-a="resume" data-k="' + esc(s.k) + '">Edit</button><button class="go dng" data-a="del" data-k="' + esc(s.k) + '" aria-label="Delete this count">Delete</button></div>';
    });
    h += '</div><div class="card"><h2>Stock takes waiting in Books</h2>' + (S.loading ? '<div class="mute">Loading...</div>' : '');
    if (!S.loading && !S.takes.length) h += '<div class="mute">No open stock takes. Create one in Books (Inventory &gt; Assessment) or count a warehouse below.</div>';
    var hid = hidden(), vis = S.takes.filter(function (t) { return hid.indexOf(t.no) < 0; });
    if (!S.loading && S.takes.length && !vis.length) h += '<div class="mute">All open stock takes are deleted from this phone.</div>';
    vis.forEach(function (t) {
      var mine = lget(skey('T:' + t.no), null);
      h += '<div class="item"><div class="t"><b>' + esc(t.no) + ' · ' + esc(t.warehouse) + '</b><span>' + esc(t.category || 'All categories') + ' · ' + t.count + ' items' + (t.date ? ' · ' + esc(t.date) : '') + '</span></div><button class="go" data-a="take" data-no="' + esc(t.no) + '">' + (mine ? 'Continue' : 'Count') + '</button><button class="go dng" data-a="deltake" data-no="' + esc(t.no) + '" aria-label="Delete this stock take">Delete</button></div>';
    });
    if (hid.length) h += '<button class="btn sec" data-a="unhide">Show deleted stock takes (' + hid.length + ')</button>';
    h += '</div><div class="card"><h2>Count a warehouse</h2><div class="mute" style="margin-bottom:8px">Books will add this count to that warehouse\'s open stock take, or start a new one.</div>';
    if (!S.whs.length && !S.loading) h += '<div class="mute">No warehouses loaded.</div>';
    S.whs.forEach(function (w) { h += '<div class="item"><div class="t"><b>' + esc(w) + '</b></div><button class="go" data-a="wh" data-w="' + esc(w) + '">' + (lget(skey('W:' + w), null) ? 'Continue' : 'Count') + '</button></div>'; });
    return h + '</div></div>';
  }
  function vCount() {
    var s = S.sess, st = stats(s);
    return '<div class="stick"><div class="top">' + MENU + LOGO + '<button class="ib" data-a="back" aria-label="back">&#8592;</button><h1>' + esc(s.title) + '<small id="prog">' + st.counted + ' of ' + st.total + ' counted</small><div class="bar"><i id="bari" style="width:' + (st.total ? st.counted * 100 / st.total : 0) + '%"></i></div></h1><button class="ib" data-a="scan" aria-label="scan">&#128247;</button></div>' + (navigator.onLine ? '' : '<div class="off">Offline - counts are saved on this phone</div>') +
      '<div class="tools"><div class="srch"><input id="q" type="search" placeholder="Search, or scan a barcode / SKU" value="' + esc(S.q) + '" autocomplete="off"></div>' +
      '<label>Warehouse section</label><select id="sectionFilter"><option value="">All sections</option>' + Array.from(new Set(s.items.map(function(i){return i.section;}).filter(Boolean))).map(function(x){return '<option value="'+esc(x)+'"'+(S.section===x?' selected':'')+'>'+esc(x)+'</option>';}).join('') + '</select><div class="tabs"><button data-a="tab" data-t="all" class="' + (S.tab === 'all' ? 'on' : '') + '">All</button><button data-a="tab" data-t="todo" class="' + (S.tab === 'todo' ? 'on' : '') + '">To count</button><button data-a="tab" data-t="done" class="' + (S.tab === 'done' ? 'on' : '') + '">Counted</button></div>' +
      '<label class="sw"><input type="checkbox" id="inc"' + (S.scanInc ? ' checked' : '') + '> A scan adds 1 to the count</label></div></div>' +
      '<div id="list"></div><div class="foot"><div style="min-width:70px"><b id="fcount">' + st.counted + ' / ' + st.total + '</b><div class="mute" style="font-size:11px">counted</div></div><button class="btn" data-a="review">Review &amp; push</button></div>';
  }
  function vReview(msg) {
    var s = S.sess, st = stats(s), h = topbar('Push to Assessment', s.title, true) + '<div class="wrap"><div class="card"><div class="sum"><div><b>' + st.counted + '</b><span>items counted</span></div><div><b>' + st.left + '</b><span>not counted</span></div><div><b>' + fmt(st.units) + '</b><span>units counted</span></div><div><b>' + st.total + '</b><span>items on the list</span></div></div></div>';
    if (st.left && !s.pushedAt) h += '<div class="msg warn">' + st.left + ' item(s) have no count. They are left out of the variance unless you tick the box below. <button class="go" data-a="todo" style="margin-top:8px">Show items not counted</button></div>';
    if (s.pushedAt) {
      h += '<div class="msg ok"><b>Sent ' + esc(new Date(s.pushedAt).toLocaleTimeString()) + '.</b> ' + esc(s.pushedLines) + ' item(s) are waiting for Books.</div><div id="recv" class="msg warn">Waiting for Books to pick it up. Books must be open and signed in on a computer. You can close this screen.</div>' +
        '<button class="btn ok" data-a="reedit">Edit counts and send again</button><button class="btn sec" data-a="back">Back to counting</button><button class="btn sec" data-a="csv">Download counts (CSV)</button><button class="btn sec" data-a="clear">Delete this count from the phone</button>';
    } else {
      h += '<div class="card"><label>Counted by</label><input id="by" type="text" value="' + esc(lget('acxst_by', U.name)) + '">' +
        (st.left ? '<label class="sw" style="margin-top:14px"><input type="checkbox" id="zero"> Treat the ' + st.left + ' uncounted item(s) as 0 (not on the shelf)</label>' : '') + '</div>' +
        (msg ? '<div class="msg bad">' + esc(msg) + '</div>' : '') + '<button class="btn ok" id="pgo" data-a="push">Push to Assessment</button><button class="btn sec" data-a="back">Back to counting</button><button class="btn sec" data-a="csv">Download counts (CSV)</button><button class="btn sec" data-a="clear">Delete this count from the phone</button>';
    }
    return h + '</div>';
  }

  /* ---------- export counts as a CSV (backup, or to open in Excel) ---------- */
  function csvCell(v) { v = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; }
  async function exportCsv(k) {
    var s = k ? lget(skey(k), null) : null; if (!s && S.sess && (!k || S.sess.k === k)) s = S.sess; if (!s) return toast('Count not found.');
    var rows = [['Name', 'SKU', 'Barcode', 'Additional Barcodes', 'Category', 'System Quantity (manager review only)', 'Counted Quantity', 'Variance', 'Variance %', 'Unit Cost', 'Variance Value', 'Section', 'Batch', 'Expiry', 'Serial Numbers', 'Condition']];
    s.items.forEach(function (i) { var v=s.counts[i.key], m=itemMeta(s,i.key), sys=i.systemQty, diff=(sys!=null&&v!=null)?Number(v)-Number(sys):'', pct=(sys!=null&&v!=null)?(Number(sys)?Number(diff)/Math.abs(Number(sys))*100:(diff?100:0)):'', cost=i.unitCost, value=(diff!==''&&cost!=null)?Number(diff)*Number(cost):''; rows.push([i.name,i.sku,i.barcode,(i.barcodes||[]).join('; '),i.category,sys==null?'':sys,v==null?'':plain(v),diff,pct,cost==null?'':cost,value,i.section||m.section||'',m.batch||'',m.expiry||'',(m.serials||[]).join('; '),m.condition||'']); });
    var text = '\ufeff' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var name = 'stock-count-' + String(s.title || 'count').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    try {
      var file = new File([text], name, { type: 'text/csv' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: s.title }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); toast('Counts saved as a CSV file.');
  }

  /* ---------- what's new ---------- */
  var LOG = [
    { v: '1.2.0', d: '18 Nov 2026', added: ['Stock Assessment register, Variance Management, Recount Management, Approval Centre, Counting Assignments, Stock Reports and Audit Trail.', 'Warehouse sections, shelves, racks and bins can be assigned to items and counted section by section.', 'Additional barcode / QR aliases, unknown-code register, batch, expiry, serial and item-condition capture.', 'Company-scoped cloud assignment and audit event sync when online.', 'Variance analysis and variance valuation where Books provides on-hand quantities and unit cost.'], fixed: ['Preserved blind counting: expected quantities are not shown on the counter screen.', 'Kept Books stock updates behind the existing push-to-Books workflow; local review status does not post adjustments.'] },
    { v: '1.1.0', d: '18 Nov 2026', fixed: [
      'Logo and icons were not loading (wrong folder), which also stopped the offline copy from installing. Fixed.',
      'Quantities of 1,000 or more could be misread (1,500 became 1.5) after editing. Fixed.',
      'Pressing Enter on a name search that found nothing now tells you; it used to do nothing.',
      'Going offline or online while typing a quantity no longer throws the number away.',
      'The same SKU twice in a stock take could share one count. Each item is now listed once.',
      'Counts are now also saved when the app goes to the background, not only when it closes.',
      'A failed login no longer clears the company name and email you typed.',
      'The offline cache no longer stores error pages, and one missing file no longer breaks it.'
    ], added: [
      'Download or share your counts as a CSV from the review screen or Reports.',
      'Show password on the sign-in screen.',
      'Tapping a quantity box selects it, so you can type straight over it.',
      'A different buzz when a scanned code is not in the list.',
      'Clear message when your session has expired.',
      'Screen-reader labels on quantity boxes, and stricter security headers.'
    ] }
  ];
  function moduleHeader(title, sub) { return topbar(title, sub || U.companyName, true) + '<div class="wrap">'; }
  function vAssessments() {
    var a=allSessions(), h=moduleHeader('Stock Assessments','All assessments saved on this device');
    h+='<div class="card"><h2>Assessment register</h2><div class="sum"><div><b>'+a.length+'</b><span>assessments</span></div><div><b>'+a.filter(function(x){return x.pushedAt;}).length+'</b><span>sent to Books</span></div><div><b>'+a.filter(function(x){return !x.pushedAt;}).length+'</b><span>in progress</span></div><div><b>'+a.reduce(function(n,x){return n+stats(x).counted;},0)+'</b><span>items counted</span></div></div></div>';
    if(!a.length) h+='<div class="card mute">No assessments on this device yet. Start one from the Dashboard.</div>';
    a.slice().reverse().forEach(function(x){var st=stats(x);h+='<div class="card"><b>'+esc(x.title)+'</b><div class="mute">'+esc(x.warehouse)+' · '+st.counted+'/'+st.total+' counted · '+esc(x.status|| (x.pushedAt?'Submitted':'Counting'))+'</div><button class="go" data-a="resume" data-k="'+esc(x.k)+'">Open</button> <button class="go" data-a="csv" data-k="'+esc(x.k)+'">CSV</button></div>';});
    return h+'</div>';
  }
  function vVariance() {
    var a=allSessions(), rows=[]; a.forEach(function(x){varianceRows(x).forEach(function(r){rows.push({s:x,r:r});});});
    var h=moduleHeader('Variance Management','Only available when Books supplies a system quantity');
    h+='<div class="card"><h2>Variance summary</h2><div class="sum"><div><b>'+rows.filter(function(x){return x.r.diff<0;}).length+'</b><span>shortages</span></div><div><b>'+rows.filter(function(x){return x.r.diff>0;}).length+'</b><span>overages</span></div><div><b>'+rows.filter(function(x){return x.r.diff===0;}).length+'</b><span>matched</span></div><div><b>'+rows.filter(function(x){return x.r.value!=null;}).length+'</b><span>valued lines</span></div></div></div>';
    if(!rows.length) h+='<div class="msg warn">No comparable system quantities are available in the synced Books records yet. Physical counts remain blind. Variance figures will appear when the Books inventory data includes its on-hand quantity field.</div>';
    rows.forEach(function(x){var r=x.r;h+='<div class="card"><b>'+esc(r.item.name)+'</b><div class="mute">'+esc(x.s.title)+' · System '+fmt(r.system)+' · Counted '+fmt(r.counted)+'</div><div class="sum"><div><b>'+fmt(r.diff)+'</b><span>difference</span></div><div><b>'+fmt(r.pct)+'%</b><span>variance</span></div></div><div class="mute">'+(r.value==null?'Cost not available': 'Variance value: '+fmt(r.value))+'</div><button class="go" data-a="recount" data-k="'+esc(x.s.k)+'" data-item="'+esc(r.item.key)+'">Request recount</button></div>';});
    return h+'</div>';
  }
  function vRecounts() {
    var a=allSessions(), list=[]; a.forEach(function(x){(x.items||[]).forEach(function(i){var m=itemMeta(x,i.key);if(m.recount)list.push({s:x,i:i,m:m});});});
    var h=moduleHeader('Recount Management','Items flagged for verification');
    if(!list.length) h+='<div class="card mute">No recounts have been requested.</div>';
    list.forEach(function(x){h+='<div class="card"><b>'+esc(x.i.name)+'</b><div class="mute">'+esc(x.s.title)+' · '+esc(x.m.recountStatus||'Requested')+'</div><button class="go" data-a="recountopen" data-k="'+esc(x.s.k)+'" data-item="'+esc(x.i.key)+'">Open recount</button><button class="go" data-a="recountdone" data-k="'+esc(x.s.k)+'" data-item="'+esc(x.i.key)+'">Mark verified</button></div>';});
    return h+'</div>';
  }
  function vApprovals() {
    var a=allSessions().filter(function(x){return x.pushedAt;}), shared=lget('acxst_shared_'+U.companyId+'_approvals',[]);
    a.forEach(function(x){var r=shared.filter(function(z){return z.assessmentKey===x.k;})[0];if(r){x.approvalStatus=r.status;x.approvalUpdatedAt=r.updatedAt;}});
    var h=moduleHeader('Approval Centre','Local review tracker · final stock posting remains in Books');
    h+='<div class="msg warn">This centre tracks review decisions on this device. It does not approve or post inventory adjustments in Acacia Books. Complete the authorised approval in Books.</div>';
    if(!a.length) h+='<div class="card mute">No submitted assessments awaiting review.</div>';
    a.forEach(function(x){h+='<div class="card"><b>'+esc(x.title)+'</b><div class="mute">Sent '+esc(new Date(x.pushedAt).toLocaleString())+' · '+esc(x.approvalStatus||'Awaiting Books review')+'</div><button class="go" data-a="approval" data-k="'+esc(x.k)+'" data-v="Reviewed">Mark reviewed</button> <button class="go" data-a="approval" data-k="'+esc(x.k)+'" data-v="Needs follow-up">Needs follow-up</button></div>';});
    return h+'</div>';
  }
  function vAssignments() {
    var local=lget('acxst_assign_'+U.companyId,[]), h=moduleHeader('Counting Assignments','Allocate work to counters');
    h+='<div class="card"><label>Assessment / warehouse</label><input id="asstitle" type="text" placeholder="e.g. Main Store - Aisle 1"><label>Assigned staff email</label><input id="asemail" type="email" placeholder="staff@company.com"><label>Section / location</label><input id="assect" type="text" placeholder="Aisle, rack, shelf or bin"><button class="btn" data-a="assign">Create assignment</button></div>';
    if(!local.length)h+='<div class="card mute">No assignments created on this device.</div>';
    local.slice().reverse().forEach(function(x){h+='<div class="card"><b>'+esc(x.title)+'</b><div class="mute">'+esc(x.email)+' · '+esc(x.section)+' · '+esc(x.status)+'</div>'+(x.status==='Assigned'?'<button class="go" data-a="assignDone" data-id="'+esc(x.id)+'">Mark completed</button>':'')+'</div>';});
    return h+'</div>';
  }
  function vStockReports() {
    var a=allSessions(), h=moduleHeader('Stock Reports','Assessment performance and audit summaries');
    var counted=a.reduce(function(n,x){return n+stats(x).counted;},0), total=a.reduce(function(n,x){return n+stats(x).total;},0), audits=a.reduce(function(n,x){return n+(x.audit||[]).length;},0), metaItems=[];a.forEach(function(x){(x.items||[]).forEach(function(i){var m=itemMeta(x,i.key);if((m.condition && m.condition!=='Good') || (m.expiry && /^\d{4}-\d{2}-\d{2}$/.test(m.expiry) && new Date(m.expiry+'T23:59:59').getTime()<Date.now()))metaItems.push({name:i.name,condition:(m.condition&&m.condition!=='Good'?m.condition:'Expired by date'),assessment:x.title});});});
    h+='<div class="card"><h2>Performance</h2><div class="sum"><div><b>'+a.length+'</b><span>assessments</span></div><div><b>'+counted+'</b><span>counted lines</span></div><div><b>'+(total?Math.round(counted*100/total):0)+'%</b><span>completion</span></div><div><b>'+audits+'</b><span>audit events</span></div></div></div>';
    a.forEach(function(x){var st=stats(x), pct=st.total?Math.round(st.counted*100/st.total):0;h+='<div class="card"><b>'+esc(x.title)+'</b><div class="mute">'+pct+'% complete · '+st.counted+' counted · '+st.left+' remaining</div><button class="go" data-a="csv" data-k="'+esc(x.k)+'">Export CSV</button></div>';});
    h+='<div class="card"><h2>Condition and traceability alerts</h2>'+(metaItems.length?metaItems.map(function(m){return '<div class="item"><div class="t"><b>'+esc(m.name)+'</b><span>'+esc(m.condition)+' · '+esc(m.assessment)+'</span></div></div>';}).join(''):'<div class="mute">No damaged or expired items recorded.</div>')+'</div><button class="btn sec" data-a="auditcsv">Export audit trail CSV</button>';return h+'</div>'; 
  }
  function vAudit() {
    var a=allSessions(), events=[];a.forEach(function(x){(x.audit||[]).forEach(function(e){events.push({s:x,e:e});});});(lget('acxst_shared_'+U.companyId+'_audit',[])||[]).forEach(function(e){if(!events.some(function(x){return x.e.id===e.id;}))events.push({s:{title:e.assessment||'Assessment'},e:e});});events.sort(function(x,y){return y.e.at.localeCompare(x.e.at);});
    var h=moduleHeader('Audit Trail','Activity recorded on this device');
    if(!events.length)h+='<div class="card mute">No audit events yet. Counting changes and workflow actions will appear here.</div>';
    events.slice(0,250).forEach(function(x){h+='<div class="item"><div class="t"><b>'+esc(x.e.action.replace(/_/g,' '))+'</b><span>'+esc(x.s.title)+' · '+esc(x.e.by)+' · '+esc(new Date(x.e.at).toLocaleString())+'</span></div></div>';});
    return h+'</div>';
  }
  function vAbout() {
    var h = topbar("What's new", 'Version ' + VER, false, '') + '<div class="wrap">';
    LOG.forEach(function (r) {
      h += '<div class="card"><h2>Version ' + esc(r.v) + ' · ' + esc(r.d) + '</h2>';
      if (r.added && r.added.length) h += '<b>New</b><ul>' + r.added.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
      if (r.fixed && r.fixed.length) h += '<b>Fixed</b><ul>' + r.fixed.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
      h += '</div>';
    });
    return h + '</div>';
  }

  function vSide() {
    var on = ['reports','appearance','about','assessments','variance','recounts','approvals','assignments','stockreports','audit'].indexOf(S.screen)>-1 ? S.screen : 'home';
    function it(id, ico, label) { return '<button class="nav' + (on === id ? ' on' : '') + '" data-a="nav" data-s="' + id + '"><span>' + ico + '</span>' + label + '</button>'; }
    return '<aside class="side" id="side"><div class="sh"><img src="icon-96.png" alt="Acacia Books"><div><b>Stock Count</b><small>' + esc(U.companyName || '') + '</small></div></div>' +
      '<nav>' + it('home', '&#9632;', 'Dashboard') + it('assessments', '&#9633;', 'Stock Assessments') + it('variance', '&#177;', 'Variance Management') + it('recounts', '&#8635;', 'Recount Management') + it('approvals', '&#10003;', 'Approval Centre') + it('assignments', '&#9776;', 'Counting Assignments') + it('stockreports', '&#9638;', 'Stock Reports') + it('audit', '&#9711;', 'Audit Trail') + it('reports', '&#9776;', 'Reports') + it('appearance', '&#9788;', 'Appearance') + it('about', '&#9432;', "What's new") + '</nav>' +
      '<div class="sf"><div class="mute" style="margin:0 12px 8px">' + esc(U.name || U.email || '') + ' · v' + VER + '</div><button class="nav out" data-a="logout"><span>&#9211;</span>Log out</button></div></aside><div class="scrim" id="scrim" data-a="menu"></div>';
  }
  function vReports() {
    var ss = sessions(), sent = 0, units = 0, counted = 0, h = topbar('Reports', U.companyName + ' · ' + U.name, false, '') + '<div class="wrap">';
    ss.forEach(function (s) { var st = stats(s); if (s.pushedAt) sent++; units += st.units; counted += st.counted; });
    h += '<div class="card"><h2>Summary</h2><div class="sum"><div><b>' + ss.length + '</b><span>counts on this phone</span></div><div><b>' + sent + '</b><span>sent to Books</span></div><div><b>' + fmt(counted) + '</b><span>items counted</span></div><div><b>' + fmt(units) + '</b><span>units counted</span></div></div></div>';
    h += '<div class="card"><h2>Counts</h2>';
    if (!ss.length) h += '<div class="mute">No counts yet. Start one from the Dashboard.</div>';
    ss.slice().sort(function (a, b) { return String(b.startedAt || '').localeCompare(String(a.startedAt || '')); }).forEach(function (s) {
      var st = stats(s), pct = st.total ? Math.round(st.counted * 100 / st.total) : 0;
      h += '<div class="item"><div class="t"><b>' + esc(s.title) + '</b><span>' + st.counted + ' of ' + st.total + ' counted (' + pct + '%) · ' + fmt(st.units) + ' units · ' + st.left + ' left' + (s.startedAt ? ' · started ' + new Date(s.startedAt).toLocaleDateString() : '') + (s.pushedAt ? ' · sent ' + new Date(s.pushedAt).toLocaleString() : '') + '</span></div>' + (s.pushedAt ? '<span class="pill ok">sent</span>' : '<span class="pill warn">not sent</span>') + '<button class="go" data-a="csv" data-k="' + esc(s.k) + '">CSV</button><button class="go" data-a="resume" data-k="' + esc(s.k) + '">Edit</button><button class="go dng" data-a="del" data-k="' + esc(s.k) + '" aria-label="Delete this count">Delete</button></div>';
    });
    return h + '</div></div>';
  }
  function vAppearance() {
    var L = lget('acxst_look', {}), th = L.theme || 'auto', ac = L.accent || 'blue', sz = L.size || 'm', fn = FONTS[L.font] ? L.font : 'system';
    function seg(a, cur, opts) { return '<div class="tabs">' + opts.map(function (o) { return '<button data-a="' + a + '" data-v="' + o[0] + '" class="' + (cur === o[0] ? 'on' : '') + '">' + o[1] + '</button>'; }).join('') + '</div>'; }
    var sw = Object.keys(ACCENTS).map(function (k) { return '<button class="swatch' + (ac === k ? ' on' : '') + '" data-a="accent" data-v="' + k + '" style="background:' + ACCENTS[k] + '" aria-label="' + k + '"></button>'; }).join('');
    return topbar('Appearance', 'Saved on this phone', false, '') + '<div class="wrap"><div class="card"><h2>Theme</h2>' + seg('theme', th, [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]) + '</div>' +
      '<div class="card"><h2>Colour</h2><div class="swatches">' + sw + '</div></div><div class="card"><h2>Font</h2><div class="fonts">' + Object.keys(FONTS).map(function (k) { return '<button class="fontbtn' + (fn === k ? ' on' : '') + '" data-a="font" data-v="' + k + '" style="font-family:' + FONTS[k][1].replace(/"/g, "'") + '">' + FONTS[k][0] + '<small>Aa 123</small></button>'; }).join('') + '</div></div><div class="card"><h2>Text size</h2>' + seg('size', sz, [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']]) + '</div></div>';
  }
  function render() {
    var app = $('#app'); if (!app) return;
    if (!U) { app.innerHTML = vLogin(); return; }
    var body, after = null;
    if (S.screen === 'count' && S.sess) { body = vCount(); after = drawList; }
    else if (S.screen === 'review' && S.sess) { body = vReview(); after = function () { if (S.sess.pushedAt && S.sess.subId) startPoll(S.sess.subId); }; }
    else if (S.screen === 'reports') body = vReports();
    else if (S.screen === 'assessments') body = vAssessments();
    else if (S.screen === 'variance') body = vVariance();
    else if (S.screen === 'recounts') body = vRecounts();
    else if (S.screen === 'approvals') body = vApprovals();
    else if (S.screen === 'assignments') body = vAssignments();
    else if (S.screen === 'stockreports') body = vStockReports();
    else if (S.screen === 'audit') body = vAudit();
    else if (S.screen === 'appearance') body = vAppearance();
    else if (S.screen === 'about') body = vAbout();
    else { S.screen = 'home'; body = vHome(); }
    app.innerHTML = '<div class="shell">' + vSide() + '<main class="main">' + body + '</main></div>';
    if (after) after();
  }

  /* ---------- events ---------- */
  document.addEventListener('click', async function (e) {
    var b = e.target.closest && e.target.closest('[data-a]'); if (!b) return; var a = b.getAttribute('data-a');
    if (a === 'inp') return;
    if (a === 'menu') { var sd = $('#side'), sc = $('#scrim'); if (sd) { sd.classList.toggle('open'); sc.classList.toggle('on', sd.classList.contains('open')); } return; }
    if (a === 'nav') {
      var to = b.getAttribute('data-s'); clearInterval(S.poll); saveNow(); closeScan(); S.sess = null; S.screen = to; render();
      if (to === 'home') loadHome();
      if (to === 'assignments' || to === 'audit' || to === 'approvals') { var cloudKey=to==='assignments'?ASSIGNMENTS:(to==='audit'?'stocktakeAuditTrail':APPROVALS); cloudList(cloudKey).then(function(list){lset('acxst_shared_'+U.companyId+'_'+to,list);if(to==='assignments'){var own=lget('acxst_assign_'+U.companyId,[]), ids={};own.forEach(function(x){ids[x.id]=1;});list.forEach(function(x){if(!ids[x.id])own.push(x);});lset('acxst_assign_'+U.companyId,own);} if(S.screen===to)render();}).catch(function(){}); }
      window.scrollTo(0, 0); return;
    }
    if (a === 'theme' || a === 'accent' || a === 'size' || a === 'font') { var L = lget('acxst_look', {}); L[a] = b.getAttribute('data-v'); lset('acxst_look', L); applyLook(); render(); return; }
    if (a === 'login') {
      var c = $('#lc').value.trim(), em = $('#le').value.trim(), pw = $('#lp').value.trim();
      if (!c || !em || !pw) return toast('Enter company name, email and password.');
      b.disabled = true; b.textContent = 'Signing in...';
      try { U = await doLogin(c, em, pw); lset('acxst_user', U); lset('acxst_lastco', c); lset('acxst_lastem', em); S.screen = 'home'; loadHome(); }
      catch (er) { $('#app').innerHTML = vLogin(er.message, c, em); }
    }
    else if (a === 'logout') { if (confirm('Sign out? Counts not yet pushed stay on this phone.')) { LS.removeItem('acxst_user'); try { window.AcxSession && window.AcxSession.clear(true); } catch (e) {} U = null; S.sess = null; S.screen = 'home'; render(); } }
    else if (a === 'refresh') loadHome(true);
    else if (a === 'sync') syncStock(b);
    else if (a === 'take') startTake(b.getAttribute('data-no'));
    else if (a === 'wh') startWarehouse(b.getAttribute('data-w'));
    else if (a === 'resume') { var s = lget(skey(b.getAttribute('data-k')), null); if (s) openCount(s); }
    else if (a === 'back') { clearInterval(S.poll); if (S.screen === 'review') { S.screen = 'count'; render(); } else { saveNow(); closeScan(); S.screen = 'home'; S.sess = null; render(); } }
    else if (a === 'tab') { S.tab = b.getAttribute('data-t'); S.shown = PAGE; render(); }
    else if (a === 'todo') { S.tab = 'todo'; S.screen = 'count'; S.shown = PAGE; render(); }
    else if (a === 'more') { S.shown += PAGE; drawList(); }
    else if (a === 'scan') openScan();
    else if (a === 'review') { saveNow(); S.screen = 'review'; render(); }
    else if (a === 'inc' || a === 'dec') { var r = b.closest('.row'); if (r) bump(r.getAttribute('data-k'), a === 'inc' ? 1 : -1); }
    else if (a === 'del') {
      var dk = b.getAttribute('data-k'), ds = lget(skey(dk), null); if (!ds) return;
      var dm = 'Delete "' + ds.title + '" from this phone? ' + (ds.pushedAt ? 'It was already sent to Books; the copy in Books is not changed. ' : 'It has not been sent to Books, so the counts will be lost. ') + 'This cannot be undone.';
      if (confirm(dm)) { delSess(dk); if (S.sess && S.sess.k === dk) S.sess = null; toast('Count deleted.'); render(); }
    }
    else if (a === 'deltake') {
      var tn = b.getAttribute('data-no'), mk = lget(skey('T:' + tn), null);
      if (confirm('Delete stock take ' + tn + ' from this phone? ' + (mk ? 'The counts you entered on this phone for it will be lost. ' : '') + 'Nothing is changed in Books. This cannot be undone.')) {
        delSess('T:' + tn); if (S.sess && S.sess.k === 'T:' + tn) S.sess = null;
        var hd = hidden(); if (hd.indexOf(tn) < 0) { hd.push(tn); lset(hkey(), hd); }
        toast('Stock take deleted from this phone.'); render();
      }
    }
    else if (a === 'itemmeta') {
      var ik=b.getAttribute('data-item'), ss=S.sess, ii=ss.items.filter(function(x){return x.key===ik;})[0];if(!ii)return;
      var mm=itemMeta(ss,ik), section=prompt('Section / shelf / rack / bin:',ii.section||mm.section||'');if(section===null)return;
      var alt=prompt('Additional barcode / QR codes, separated by commas:',(ii.barcodes||[]).join(', '));if(alt===null)return; ii.barcodes=alt.split(',').map(function(x){return x.trim();}).filter(Boolean);ii.section=section;
      var batch=prompt('Batch / lot number (leave blank if not applicable):',mm.batch||'');if(batch===null)return;
      var expiry=prompt('Expiry date (YYYY-MM-DD, if applicable):',mm.expiry||'');if(expiry===null)return;
      var serial=prompt('Serial number(s), separated by commas (if applicable):',(mm.serials||[]).join(', '));if(serial===null)return;
      var condition=prompt('Condition: Good, Damaged, Expired or Other',mm.condition||'Good');if(condition===null)return;
      var serialList=serial.split(',').map(function(x){return x.trim();}).filter(Boolean);if(ii.serialTracked && ss.counts[ik]!=null && serialList.length!==Number(ss.counts[ik])){if(!confirm('This item is serial-tracked, but you entered '+serialList.length+' serial number(s) for a count of '+ss.counts[ik]+'. Save anyway?'))return;}
      ss.itemMeta=ss.itemMeta||{};ss.itemMeta[ik]={batch:batch,expiry:expiry,serials:serialList,condition:condition,section:section};audit(ss,'ITEM_TRACEABILITY_UPDATED',ik,{batch:batch,expiry:expiry,serialCount:ss.itemMeta[ik].serials.length,condition:condition});saveNow();toast('Item traceability saved.');
    }
    else if (a === 'recount' || a === 'recountopen' || a === 'recountdone') {
      var rk=b.getAttribute('data-k'), ri=b.getAttribute('data-item'), rs=lget(skey(rk),null); if(!rs)return;
      rs.itemMeta=rs.itemMeta||{};rs.itemMeta[ri]=rs.itemMeta[ri]||{};
      if(a==='recount'){rs.itemMeta[ri].recount=true;rs.itemMeta[ri].recountStatus='Requested';audit(rs,'RECOUNT_REQUESTED',ri);toast('Recount requested.');}
      else if(a==='recountdone'){rs.itemMeta[ri].recountStatus='Verified';rs.itemMeta[ri].recount=false;audit(rs,'RECOUNT_VERIFIED',ri);toast('Recount marked verified.');}
      else {S.sess=rs;openCount(rs);S.q=rs.items.filter(function(i){return i.key===ri;})[0].name;S.tab='all';render();}
      lset(skey(rk),rs);render();
    }
    else if(a==='approval') {var ak=b.getAttribute('data-k'), av=lget(skey(ak),null);if(av){av.approvalStatus=b.getAttribute('data-v');av.approvalUpdatedAt=new Date().toISOString();audit(av,'APPROVAL_STATUS_CHANGED','',{status:av.approvalStatus});lset(skey(ak),av);var ar={id:'AP-'+String(ak).replace(/[^A-Za-z0-9_-]/g,'_'),assessmentKey:ak,assessment:av.title,status:av.approvalStatus,reviewer:U.email,updatedAt:av.approvalUpdatedAt,companyId:U.companyId};try{await saveCloudList(APPROVALS,ar);var sh=lget('acxst_shared_'+U.companyId+'_approvals',[]);sh=sh.filter(function(x){return x.id!==ar.id;});sh.push(ar);lset('acxst_shared_'+U.companyId+'_approvals',sh);toast('Review status synced for this company.');}catch(ex){toast('Saved locally; cloud sync failed: '+ex.message,3500);}render();}}
    else if(a==='assign') {
      var title=($('#asstitle').value||'').trim(), email=low($('#asemail').value), section=($('#assect').value||'').trim();if(!title||!email||!section)return toast('Enter assessment, staff email and section.');
      var cloudAssignments=[];try{cloudAssignments=await cloudList(ASSIGNMENTS);}catch(ex){}
      if(cloudAssignments.some(function(x){return low(x.title)===low(title)&&low(x.section)===low(section)&&x.status==='Assigned';}))return toast('This section already has an active assignment. Refresh assignments before allocating it again.',3500);
      var rec={id:'AS-'+dev+'-'+Date.now(),title:title,email:email,section:section,status:'Assigned',assignedBy:U.email,at:new Date().toISOString(),companyId:U.companyId};
      var aa=lget('acxst_assign_'+U.companyId,[]);aa.push(rec);lset('acxst_assign_'+U.companyId,aa);
      try{await saveCloudList(ASSIGNMENTS,rec);toast('Assignment saved for this company.');}catch(er){toast('Saved on this phone; cloud sync failed: '+er.message,3500);}render();
    }
    else if(a==='assignDone') {var aid=b.getAttribute('data-id'), al=lget('acxst_assign_'+U.companyId,[]);al.forEach(function(x){if(x.id===aid)x.status='Completed';});lset('acxst_assign_'+U.companyId,al);var ca=await cloudList(ASSIGNMENTS);var cr=ca.filter(function(x){return x.id===aid;})[0];if(cr){cr.status='Completed';try{await saveCloudList(ASSIGNMENTS,cr);}catch(ex){}}toast('Assignment completed.');render();}
    else if(a==='auditcsv') {
      var ev=[];allSessions().forEach(function(x){(x.audit||[]).forEach(function(e){ev.push([x.title,e.action,e.by,e.email,e.at,e.itemKey,JSON.stringify(e.detail)]);});});
      var blob=new Blob([['Assessment','Action','User','Email','Date','Item key','Details'].concat(ev).map(function(r){return r.map(csvCell).join(',');}).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='acacia-stock-audit.csv';link.click();URL.revokeObjectURL(url);
    }
    else if (a === 'csv') exportCsv(b.getAttribute('data-k') || (S.sess && S.sess.k));
    else if (a === 'unhide') { LS.removeItem(hkey()); render(); }
    else if (a === 'reedit') {
      if (confirm('Edit this count and send it again? The new count replaces the one already sent. If Books has already applied it, check the variance in Books again afterwards.')) {
        clearInterval(S.poll); delete S.sess.pushedAt; delete S.sess.pushedLines; saveNow(); S.screen = 'count'; render();
      }
    }
    else if (a === 'clear') { if (confirm('Remove this count from the phone? It cannot be undone.')) { delSess(S.sess.k); S.sess = null; S.screen = 'home'; render(); } }
    else if (a === 'push') {
      var by = ($('#by').value || '').trim() || U.name, zero = !!($('#zero') && $('#zero').checked), st = stats(S.sess);
      if (zero && !confirm('Mark ' + st.left + ' uncounted item(s) as 0? Books will show them as missing stock.')) return;
      if (!navigator.onLine) return toast('No internet. Your count is saved; push again when you are online.', 3500);
      lset('acxst_by', by); b.disabled = true; b.textContent = 'Sending...';
      try { await doPush(by, zero); render(); }
      catch (er) { $('#app').innerHTML = vReview(er.message); }
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'showpw') { var pw = $('#lp'); if (pw) pw.type = t.checked ? 'text' : 'password'; return; }
    if (t.id === 'sectionFilter') { S.section=t.value;S.shown=PAGE;drawList();return; }
    if (t.id === 'inc') { S.scanInc = t.checked; lset('acxst_inc', S.scanInc); return; }
    if (t.getAttribute && t.getAttribute('data-a') === 'inp') {
      var r = t.closest('.row'), k = r.getAttribute('data-k'), v = parseQ(t.value);
      if (isNaN(v)) { toast('Enter a number (0 or more).'); refreshRow(k); return; }
      setCount(k, v); refreshRow(k);
    }
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'q') { S.q = e.target.value; S.shown = PAGE; clearTimeout(S.qt); S.qt = setTimeout(drawList, 150); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'q') { var v = e.target.value.trim(); if (!v) return; var r = handleCode(v); if (r && r.ok) { if (S.scanInc) { S.q = ''; e.target.value = ''; drawList(); } toast(r.msg); } else if (r && !S.view.length) toast(r.msg, 2500); else if (r) e.target.blur(); e.preventDefault(); }
    else if (e.target.id === 'lp') { var g = $('#lgo'); if (g) g.click(); }
    else if (e.target.getAttribute && e.target.getAttribute('data-a') === 'inp') e.target.blur();
  });
  $('#scanClose').addEventListener('click', closeScan);
  /* tapping a quantity box selects it, so typing replaces the number */
  document.addEventListener('focusin', function (e) { var t = e.target; if (t && t.getAttribute && t.getAttribute('data-a') === 'inp') setTimeout(function () { try { t.select(); } catch (x) {} }, 0); });
  /* going online/offline redraws the banner; commit a half-typed quantity first so it is not lost */
  function netChange() { var ae = document.activeElement; if (ae && ae.tagName === 'INPUT' && ae.blur) ae.blur(); render(); }
  window.addEventListener('online', netChange);
  window.addEventListener('offline', netChange);
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') saveNow(); });

  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  if (U) loadHome(); else render();
})();
