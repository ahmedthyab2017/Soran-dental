
'use strict';

// ═══════════════════════════════════════════════════
//  Fetch with timeout — uses Promise.race instead of AbortSignal
//  to avoid postMessage clone issues on Android webviews
// ═══════════════════════════════════════════════════
function fetchWithTimeout(url, opts, ms) {
  opts = opts || {};
  ms = ms || 8000;
  return Promise.race([
    fetch(url, opts),
    new Promise(function(_, rej){
      setTimeout(function(){ rej(new Error('timeout')); }, ms);
    })
  ]);
}

// ═══════════════════════════════════════════════════
//  CLOUD — Firestore REST API (zero external SDK)
// ═══════════════════════════════════════════════════
//  CLOUD CLASS — Offline-First + Encrypted + Queue
// ═══════════════════════════════════════════════════
class CloudStorage {
  constructor() {
    this.API   = 'AIzaSyDOCs3S0ljNck8hL4DXpB_4_69j5Zerv5Y';
    this.PROJ  = 'mydent-9fb95';
    this.BASE  = 'https://firestore.googleapis.com/v1/projects/mydent-9fb95/databases/(default)/documents';
    this.ENC_KEY = 'soran_dental_2026_secure';
    this._queue  = this._loadQueue();
    this._syncing = false;
    var self = this;
    setInterval(function(){ self._processQueue(); }, 15000);
    window.addEventListener('online', function(){ self._processQueue(); });
  }
  // ── Clinic ID ──────────────────────────────────────
  cid() { return localStorage.getItem('clinicId') || 'soran_main'; }

  // ── Lightweight XOR Encryption ────────────────────
  _encrypt(text) {
    try {
      const key = this.ENC_KEY;
      let result = '';
      for (let i = 0; i < text.length; i++) {
        result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
      }
      return btoa(unescape(encodeURIComponent(result)));
    } catch(e) { return btoa(text); }
  }

  _decrypt(encoded) {
    try {
      const key = this.ENC_KEY;
      const text = decodeURIComponent(escape(atob(encoded)));
      let result = '';
      for (let i = 0; i < text.length; i++) {
        result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
      }
      return result;
    } catch(e) {
      try { return atob(encoded); } catch(e2) { return encoded; }
    }
  }

  // ── Firestore Path ─────────────────────────────────
  _path(key) { return 'clinics/' + this.cid() + '/data/' + key; }
  _url(key)  { return this.BASE + '/' + this._path(key) + '?key=' + this.API; }

  // ── Queue Management ───────────────────────────────
  _loadQueue() {
    try { return JSON.parse(localStorage.getItem('_syncQueue') || '[]'); }
    catch(e) { return []; }
  }

  _saveQueue() {
    try { localStorage.setItem('_syncQueue', JSON.stringify(this._queue)); }
    catch(e) {}
  }

  _addToQueue(key, value) {
    // Remove old entry for same key
    this._queue = this._queue.filter(function(q){ return q.key !== key; });
    this._queue.push({ key, value, ts: Date.now(), retries: 0 });
    this._saveQueue();
  }

  async _processQueue() {
    if (this._syncing || !navigator.onLine || !this._queue.length) return;
    this._syncing = true;
    const batch = [...this._queue];
    for (const item of batch) {
      try {
        await this._pushToFirestore(item.key, item.value);
        this._queue = this._queue.filter(function(q){ return q.key !== item.key; });
        this._saveQueue();
      } catch(e) {
        item.retries = (item.retries || 0) + 1;
        // Drop after 10 failed retries
        if (item.retries > 10) {
          this._queue = this._queue.filter(function(q){ return q.key !== item.key; });
          this._saveQueue();
        }
      }
    }
    this._syncing = false;
    if (this._queue.length === 0) showSync('✅ تمت المزامنة', true, false);
  }

  // ── Core: Push to Firestore ────────────────────────
  async _pushToFirestore(key, value) {
    const encrypted = this._encrypt(JSON.stringify(value));
    const body = {
      fields: {
        value:     { stringValue: encrypted },
        updatedAt: { stringValue: new Date().toISOString() },
        clinicId:  { stringValue: this.cid() }
      }
    };
    const r = await fetchWithTimeout(this._url(key), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 8000);
    if (!r.ok) throw new Error('Firestore error: ' + r.status);
  }

  // ── PUBLIC: saveData (Offline-First) ───────────────
  async saveData(key, value) {
    // 1. Save locally INSTANTLY
    _cache[key] = value;
    localStorage.setItem(key, JSON.stringify(value));
    // 2. Queue for background cloud sync
    this._addToQueue(key, value);
    // 3. Try immediate sync if online
    if (navigator.onLine) {
      this._processQueue().catch(() => {});
    } else {
      showSync('⚡ محفوظ محلياً — سيُزامن عند الاتصال', false, true);
    }
  }

  // ── PUBLIC: fetchData ──────────────────────────────
  async fetchData(key) {
    if (!navigator.onLine) {
      // Return local cache
      const local = localStorage.getItem(key);
      return local ? JSON.parse(local) : null;
    }
    try {
      const r = await fetchWithTimeout(this._url(key), {}, 6000);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('fetch failed: ' + r.status);
      const doc = await r.json();
      if (!doc.fields || !doc.fields.value) return null;
      const raw = doc.fields.value.stringValue;
      // Try decrypt, fallback to plain JSON
      let value;
      try { value = JSON.parse(this._decrypt(raw)); }
      catch(e) { value = JSON.parse(raw); }
      // Update local cache
      _cache[key] = value;
      localStorage.setItem(key, JSON.stringify(value));
      return value;
    } catch(e) {
      // Network errors are expected (offline / weak connection) — fall back silently
      var msg = (e && e.message) || '';
      if (msg !== 'timeout' && msg.indexOf('Failed to fetch') < 0 && msg.indexOf('NetworkError') < 0) {
        console.warn('fetchData unexpected error:', msg);
      }
      // Fallback to local
      const local = localStorage.getItem(key);
      return local ? JSON.parse(local) : null;
    }
  }

  // ── PUBLIC: deleteData ─────────────────────────────
  async deleteData(key) {
    delete _cache[key];
    localStorage.removeItem(key);
    if (!navigator.onLine) return;
    try {
      await fetchWithTimeout(this._url(key), {
        method: 'DELETE'
      }, 5000);
    } catch(e) {
      var msg = (e && e.message) || '';
      if (msg !== 'timeout' && msg.indexOf('Failed to fetch') < 0 && msg.indexOf('NetworkError') < 0) {
        console.warn('deleteData unexpected error:', msg);
      }
    }
  }

  // ── PUBLIC: sync (fetch all keys from cloud) ───────
  async sync(keys) {
    if (!navigator.onLine) {
      showSync('⚠️ لا يوجد اتصال — البيانات محلية', false, true);
      return false;
    }
    showSync('🔄 جاري المزامنة...');
    let updated = false;
    var self = this;
    await Promise.all(keys.map(async function(key) {
      try {
        const v = await self.fetchData(key);
        if (v !== null) {
          // Don't overwrite staff with empty array
          if (key === 'staff' && Array.isArray(v) && v.length === 0) return;
          _cache[key] = v;
          localStorage.setItem(key, JSON.stringify(v));
          updated = true;
        }
      } catch(e) { console.warn('sync key error:', key, e.message); }
    }));
    showSync(updated ? '✅ متصل بالسحابة' : '⚠️ البيانات محلية', updated, !updated);
    return updated;
  }

  // ── COMPAT: keep old API working ───────────────────
  async set(key, value) { return this.saveData(key, value); }
  async get(key) { return this.fetchData(key); }
  async setDoc(docPath, obj) {
    try {
      const url = this.BASE + '/' + docPath + '?key=' + this.API;
      const fields = {};
      Object.keys(obj).forEach(function(k) { fields[k] = { stringValue: String(obj[k]) }; });
      const r = await fetchWithTimeout(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      }, 8000);
      if (!r.ok) throw new Error('setDoc failed ' + r.status);
    } catch(e) { throw e; }
  }
}

const CLOUD = new CloudStorage();

// ═══════════════════════════════════════════════════
//  DATA LAYER
// ═══════════════════════════════════════════════════
var _cache = {};

function G(k, def) {
  if (def === undefined) def = null;
  if (k in _cache) return _cache[k];
  try { var v = JSON.parse(localStorage.getItem(k)); _cache[k] = v !== null ? v : def; }
  catch(e) { _cache[k] = def; }
  return _cache[k];
}

// Local save only (fast, used internally)
function Sl(k, v) { _cache[k] = v; localStorage.setItem(k, JSON.stringify(v)); }

// Save local + cloud (Offline-First via queue)
function S(k, v) {
  Sl(k, v);
  CLOUD.saveData(k, v).catch(function(e) { console.warn('cloud save:', e.message); });
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,5); }
function today() { return new Date().toISOString().split('T')[0]; }
function sm() { var m={}; G('staff',[]).forEach(function(s){m[s.id]=s;}); return m; }
function pm() { var m={}; G('patients',[]).forEach(function(p){m[p.id]=p;}); return m; }

// ═══════════════════════════════════════════════════
//  BOOKING CONSTRAINTS — Clinic hours & minimum gap
// ═══════════════════════════════════════════════════
var CLINIC_OPEN_HOUR  = 9;   // 9:00 صباحاً
var CLINIC_CLOSE_HOUR = 21;  // 9:00 مساءً
var APPT_MIN_GAP_MIN  = 25;  // الحد الأدنى للفارق بين أي حجزين للطبيب نفسه باليوم نفسه

// يبني خيارات الـ <select> للوقت (9:00 — 21:00) بفارق step دقائق (افتراضي 15 دقيقة)
function buildTimeOptions(selectedValue, opts){
  opts = opts || {};
  var step = opts.step || 15;
  var html = '<option value="">-- اختر الوقت --</option>';
  for (var h = CLINIC_OPEN_HOUR; h <= CLINIC_CLOSE_HOUR; h++){
    for (var m = 0; m < 60; m += step){
      if (h === CLINIC_CLOSE_HOUR && m > 0) break; // نتوقف عند 21:00
      var hh = (h<10?'0':'')+h;
      var mm = (m<10?'0':'')+m;
      var v = hh+':'+mm;
      // عرض ودود بالعربية: 9:00 صباحاً / 1:30 ظهراً / 7:45 مساءً
      var period = (h < 12) ? 'صباحاً' : (h < 17 ? 'ظهراً' : 'مساءً');
      var displayH = (h===0)?12:(h>12?h-12:h);
      var disp = displayH + ':' + mm + ' ' + period;
      var sel = (v === selectedValue) ? ' selected' : '';
      html += '<option value="'+v+'"'+sel+'>'+disp+'</option>';
    }
  }
  return html;
}

// تحقق أن الوقت "HH:MM" ضمن ساعات العيادة (9 صباحاً – 9 مساءً)
function isWithinClinicHours(timeStr){
  if (!timeStr) return false;
  var parts = timeStr.split(':');
  if (parts.length < 2) return false;
  var h = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return false;
  var totalMin = h*60 + m;
  return totalMin >= CLINIC_OPEN_HOUR*60 && totalMin <= CLINIC_CLOSE_HOUR*60;
}

// يعيد أول موعد متعارض (فارق < APPT_MIN_GAP_MIN) لنفس الطبيب وبنفس التاريخ، وإلا null
function findApptConflict(date, time, doctorId, excludeApptId){
  if (!date || !time || !doctorId) return null;
  var parts = time.split(':');
  if (parts.length < 2) return null;
  var newMin = parseInt(parts[0],10)*60 + parseInt(parts[1],10);
  if (isNaN(newMin)) return null;
  var appts = G('appointments', []);
  for (var i=0; i<appts.length; i++){
    var a = appts[i];
    if (excludeApptId && a.id === excludeApptId) continue;
    if (a.status === 'cancelled') continue;
    if (a.date !== date) continue;
    if (a.doctorId !== doctorId) continue;
    if (!a.time) continue;
    var p2 = a.time.split(':');
    if (p2.length<2) continue;
    var existMin = parseInt(p2[0],10)*60 + parseInt(p2[1],10);
    if (isNaN(existMin)) continue;
    if (Math.abs(existMin - newMin) < APPT_MIN_GAP_MIN) {
      return a;
    }
  }
  return null;
}

var DEFAULT_STAFF = [
  {id:'s1',name:'د. أحمد عبيد المحمدي',          role:'doctor-manager',username:'ahmed',   phone:'',comm:30,pass:'manager123', subRole:''},
  {id:'s2',name:'د. مصطفى رياض العزاوي',         role:'doctor',        username:'mustafa', phone:'',comm:30,pass:'mustafa2026', subRole:''},
  {id:'s3',name:'د. محمد رياض الجبوري',          role:'doctor',        username:'muhammad',phone:'',comm:30,pass:'muhammad2026', subRole:''},
  {id:'s4',name:'د. بان ضاري الغريري',           role:'doctor',        username:'ban',     phone:'',comm:30,pass:'ban2026', subRole:''},
  {id:'s5',name:'إيلاف',                          role:'reception',     username:'ilaf',    phone:'',comm:0, pass:'ilaf2026', subRole:'تعقيم'},
  {id:'s6',name:'علي',                            role:'marketer',      username:'ali',     phone:'',comm:5, pass:'ali2026', subRole:''},
  {id:'s7',name:'د. محمد ضياء',                  role:'doctor',        username:'diaa',    phone:'',comm:10,pass:'diaa2026', subRole:'إداري'},
];

function initDefaults() {
  var clinic = localStorage.getItem('clinic');
  if (!clinic) {
    var c = { name:'عيادة سوران للرعاية بالفم والأسنان', phone:'07810151042', address:'الفلوجة - شارع الرئيسي', logo:'🦷' };
    localStorage.setItem('clinic', JSON.stringify(c));
    _cache['clinic'] = c;
  }
  var staff = localStorage.getItem('staff');
  if (!staff || staff === '[]' || staff === 'null') {
    localStorage.setItem('staff', JSON.stringify(DEFAULT_STAFF));
    _cache['staff'] = DEFAULT_STAFF;
  } else {
    try { _cache['staff'] = JSON.parse(staff); } catch(e) { localStorage.setItem('staff', JSON.stringify(DEFAULT_STAFF)); _cache['staff'] = DEFAULT_STAFF; }
  }
  if (!localStorage.getItem('patients'))     { localStorage.setItem('patients',     '[]'); _cache['patients']     = []; }
  if (!localStorage.getItem('appointments')) { localStorage.setItem('appointments', '[]'); _cache['appointments'] = []; }
  if (!localStorage.getItem('plans'))        { localStorage.setItem('plans',        '[]'); _cache['plans']        = []; }
  if (!localStorage.getItem('payments'))     { localStorage.setItem('payments',     '[]'); _cache['payments']     = []; }
  if (!localStorage.getItem('inventory'))    { localStorage.setItem('inventory',    '[]'); _cache['inventory']    = []; }
  if (!localStorage.getItem('consents'))     { localStorage.setItem('consents',     '[]'); _cache['consents']     = []; }
  if (!localStorage.getItem('tasks'))        { localStorage.setItem('tasks',        '[]'); _cache['tasks']        = []; }
  if (!localStorage.getItem('chatMessages')) { localStorage.setItem('chatMessages', '[]'); _cache['chatMessages'] = []; }
  if (!localStorage.getItem('marketerCommissions')) { localStorage.setItem('marketerCommissions', '[]'); _cache['marketerCommissions'] = []; }
}

async function loadCloud() {
  const keys = ['staff','patients','appointments','plans','payments','clinic','inventory','consents','consentTpls','orthoDevTpls','tasks','chatMessages','staffCalls','bookingRequests','patientInquiries','otpRequests','clinicDebts','settlements','vendors','marketerCommissions'];
  return await CLOUD.sync(keys);
}

function startPolling() {
  setInterval(async function() {
    if (!navigator.onLine) return;
    var keys = ['staff','patients','appointments','plans','payments','inventory','consents','consentTpls','orthoDevTpls','tasks','chatMessages','staffCalls','bookingRequests','patientInquiries','otpRequests','clinicDebts','settlements','vendors','marketerCommissions'];
    for (var i=0; i<keys.length; i++) {
      try {
        var k = keys[i];
        var v = await CLOUD.fetchData(k);
        if (v !== null && JSON.stringify(v) !== JSON.stringify(_cache[k])) {
          Sl(k, v);
          var a = document.querySelector('.page.active');
          if (a) renderPage(a.id.replace('pg-',''));
        }
      } catch(e) {}
    }
  }, 30000);
}

function showSync(msg, ok, warn) {
  var el = document.getElementById('syncBadge');
  if (!el) { el=document.createElement('div'); el.id='syncBadge'; el.style.cssText='position:fixed;bottom:80px;left:12px;z-index:9999;font-size:11px;font-weight:700;padding:5px 10px;border-radius:20px;transition:opacity 1s;font-family:Tajawal,sans-serif;'; document.body.appendChild(el); }
  el.textContent = msg;
  el.style.background = warn?'#fef5ec':ok?'#eafaf1':'#e8f4f8';
  el.style.color = warn?'#e67e22':ok?'#27ae60':'#1a6b8a';
  el.style.opacity='1';
  if (ok) setTimeout(function(){el.style.opacity='0';},3000);
}

// ═══════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async function() {
  // Splash
  var sp = document.createElement('div');
  sp.style.cssText = 'position:fixed;inset:0;background:linear-gradient(135deg,#07293a,#0d5c7a);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:99999;color:#fff;font-family:Tajawal,sans-serif;transition:opacity .4s';
  sp.innerHTML = '<div style="font-size:56px;margin-bottom:16px">🦷</div>'
    +'<div style="font-size:18px;font-weight:800;margin-bottom:6px">سوران للرعاية بالفم والأسنان</div>'
    +'<div style="font-size:13px;opacity:.7;margin-bottom:24px">جاري التحميل...</div>'
    +'<div style="width:44px;height:44px;border:4px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite"></div>'
    +'<style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
  document.body.appendChild(sp);
  var _splashDone = false;
  var _authDone = false;
  function dismiss() {
    if (_splashDone) return;
    _splashDone = true;
    sp.style.opacity='0';
    setTimeout(function(){if(sp.parentNode)sp.remove();},400);
  }
  function safeAuth() {
    if (_authDone) return;
    _authDone = true;
    try { checkAutoLogin(); }
    catch(e) { console.error('Auth error:', e); try { showScreen('login'); } catch(e2){} }
  }

  // ═══ STEP 1: Always init defaults — login MUST work even if cloud fails ═══
  try { initDefaults(); }
  catch(e) { console.error('initDefaults error:', e); }

  // ═══ STEP 2: Hard safety net — splash dismisses in 10s no matter what ═══
  setTimeout(function() {
    console.log('Splash safety triggered');
    dismiss();
    safeAuth();
  }, 10000);

  // ═══ STEP 3: Try cloud sync (race against 10s timeout — gives slow networks a chance) ═══
  try {
    await Promise.race([
      loadCloud().then(function(){
        // ✅ نجحت المزامنة قبل المهلة — أعد رسم الصفحة الحالية إن كان المستخدم داخل التطبيق
        try {
          var active = document.querySelector('.page.active');
          if (active && typeof renderPage === 'function') {
            var pgId = (active.id||'').replace(/^pg-/,'');
            if (pgId) renderPage(pgId);
          }
        } catch(e){}
      }).catch(function(e){ console.warn('loadCloud failed:', e&&e.message); }),
      new Promise(function(res){setTimeout(res,10000);})
    ]);
  } catch(e) { console.warn('cloud sync error:', e&&e.message); }

  // ═══ STEP 3.5: مزامنة خلفية ثانية بعد ٥ ثوانٍ، ثم إعادة رسم الواجهة ═══
  // هذا يحلّ مشكلة "البيانات الفارغة عند فتح أول مرة على دومين جديد"
  setTimeout(async function(){
    try {
      await loadCloud();
      var active = document.querySelector('.page.active');
      if (active && typeof renderPage === 'function') {
        var pgId = (active.id||'').replace(/^pg-/,'');
        if (pgId) {
          renderPage(pgId);
          if (typeof showToast === 'function') showToast('✅ تمت المزامنة من السحابة', 'success');
        }
      }
    } catch(e){ console.warn('background sync err', e); }
  }, 5000);

  // ═══ STEP 4: Defensive — restore default staff if cloud wiped it ═══
  try {
    var staffNow = localStorage.getItem('staff');
    if (!staffNow || staffNow === '[]' || staffNow === 'null') {
      localStorage.setItem('staff', JSON.stringify(DEFAULT_STAFF));
      _cache['staff'] = DEFAULT_STAFF;
      console.log('Restored DEFAULT_STAFF after empty cloud sync');
    }
  } catch(e) { console.error('staff restore error:', e); }

  // ═══ STEP 4.5: Auto-migrate old staff names/roles to v4 ═══
  try {
    var migDone = localStorage.getItem('staffMigV4');
    if (migDone !== '1') {
      var staffArr = G('staff', []);
      var changed = false;
      staffArr.forEach(function(s){
        if (s.id === 's2' && s.name === 'د. مصطفى رياض')        { s.name = 'د. مصطفى رياض العزاوي'; changed = true; }
        if (s.id === 's3' && s.name === 'د. محمد رياض')           { s.name = 'د. محمد رياض الجبوري'; changed = true; }
        if (s.id === 's4' && (s.name === 'د. بان ضايي' || s.name.indexOf('ضايي')>=0))
                                                                    { s.name = 'د. بان ضاري الغريري'; changed = true; }
        if (s.id === 's5' && s.role === 'manager')                { s.role = 'reception'; s.subRole = 'تعقيم'; changed = true; }
        if (typeof s.subRole === 'undefined')                     { s.subRole = ''; changed = true; }
      });
      if (changed) {
        Sl('staff', staffArr);
        try { CLOUD.saveData('staff', staffArr); } catch(e){}
        console.log('Auto-migration v4: staff names/roles updated');
      }
      localStorage.setItem('staffMigV4', '1');
    }
  } catch(e) { console.warn('migration error:', e); }

  // ═══ STEP 4.6: v5 — Remove old consent images from localStorage to free space ═══
  try {
    var v5MigDone = localStorage.getItem('consentImgMigV5');
    if (v5MigDone !== '1') {
      var removed = 0;
      var totalSize = 0;
      // Find all keys matching consent_img_*
      var keysToRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf('consent_img_') === 0) {
          keysToRemove.push(key);
          var val = localStorage.getItem(key);
          if (val) totalSize += val.length;
        }
      }
      keysToRemove.forEach(function(k){
        try { localStorage.removeItem(k); removed++; } catch(e){}
      });
      // Clean imageStored markers from consents
      var consents = G('consents', []);
      var changed = false;
      consents.forEach(function(c){
        if (c.imageStored) { delete c.imageStored; changed = true; }
      });
      if (changed) Sl('consents', consents);
      if (removed > 0) {
        console.log('v5 cleanup: removed', removed, 'old consent images, freed ~', Math.round(totalSize/1024), 'KB');
      }
      localStorage.setItem('consentImgMigV5', '1');
    }
  } catch(e) { console.warn('v5 cleanup error:', e); }

  // ═══ STEP 5: Background polling + show login ═══
  try { startPolling(); } catch(e) { console.warn('startPolling error:', e); }
  dismiss();
  safeAuth();
});

// ═══════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════
var CU = null;   // current user
var CPid = null; // current patient id
var _cpOpt = '';

var ROLE_LABEL = {doctor:'طبيب أسنان','doctor-manager':'طبيب مدير',manager:'مدير العيادة',reception:'استقبال',marketer:'مسوّق',patient:'مريض'};
var ROLE_ICON  = {doctor:'👨‍⚕️','doctor-manager':'👨‍⚕️📊',reception:'🖥️',marketer:'📢',patient:'👤'};

function showScreen(name) {
  document.getElementById('loginScreen').style.display      = 'none';
  document.getElementById('registerScreen').style.display   = 'none';
  document.getElementById('subExpiredScreen').style.display = 'none';
  document.getElementById('app').style.display              = 'none';
  var pls = document.getElementById('patientLoginScreen'); if (pls) pls.style.display = 'none';
  if (name === 'login')         { document.getElementById('loginScreen').style.display = 'flex'; try { renderQuickLoginList(); } catch(e){} }
  if (name === 'register')      { document.getElementById('registerScreen').style.display = 'flex'; }
  if (name === 'expired')       { document.getElementById('subExpiredScreen').style.display = 'flex'; }
  if (name === 'app')           { document.getElementById('app').style.display = 'block'; }
  if (name === 'patientLogin')  {
    if (pls) pls.style.display = 'flex';
    // Reset to step 1
    var s1 = document.getElementById('ptStep1'); if (s1) s1.style.display = 'block';
    var s2 = document.getElementById('ptStep2'); if (s2) s2.style.display = 'none';
  }
}

// On the login screen we only show a generic hint (no credentials list)
function renderQuickLoginList(){
  var hintEl = document.getElementById('loginMgrHint');
  if (hintEl) hintEl.style.display = 'block';
}

// Restore default staff (kept for manager use from staff page)
function restoreDefaultStaff(){
  try {
    var staff = G('staff', []) || [];
    var existingUsernames = new Set(staff.map(function(s){return (s.username||'').toLowerCase();}));
    var added = 0;
    DEFAULT_STAFF.forEach(function(d){
      if (!existingUsernames.has((d.username||'').toLowerCase())) {
        var copy = Object.assign({}, d, {id:'s_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,5)});
        staff.push(copy);
        added++;
      }
    });
    if (added > 0) {
      S('staff', staff);
      alert('✅ تم إضافة '+added+' من الكادر الافتراضي.');
      if (typeof renderStaff === 'function') renderStaff();
    } else {
      alert('جميع الكادر الافتراضي موجود بالفعل.');
    }
  } catch(e) {
    alert('❌ خطأ: '+(e.message||'unknown'));
  }
}

function doLogin() {
  try {
    var username = (document.getElementById('loginUser').value||'').trim().toLowerCase().replace(/\s+/g,'');
    var pass     = (document.getElementById('loginPass').value||'').replace(/^\s+|\s+$/g,''); // trim only edges, not internal
    var errEl    = document.getElementById('loginErr');
    if (!username) { errEl.textContent='❌ أدخل اسم المستخدم'; errEl.style.display='block'; return; }
    if (!pass)     { errEl.textContent='❌ أدخل كلمة المرور';  errEl.style.display='block'; return; }
    errEl.style.display='none';
    var staff = G('staff',[]);
    // Fallback to DEFAULT_STAFF if localStorage is empty
    if (!staff || !staff.length) { staff = DEFAULT_STAFF; localStorage.setItem('staff', JSON.stringify(DEFAULT_STAFF)); _cache['staff'] = DEFAULT_STAFF; }
    console.log('Login attempt:', username, '— staff count:', staff.length);
    var s = staff.find(function(x){ return (x.username||'').toLowerCase() === username; });
    if (!s)                       { errEl.textContent='❌ اسم المستخدم غير موجود'; errEl.style.display='block'; return; }
    // Forgiving password check: exact match OR case-insensitive match (helps with mobile auto-capitalization)
    var realPass = (s.pass||s.password||'');
    var passOk = (realPass === pass) || (realPass.toLowerCase() === pass.toLowerCase());
    if (!passOk){ errEl.textContent='❌ كلمة المرور غير صحيحة'; errEl.style.display='block'; return; }
    CU = Object.assign({},s);
    if (document.getElementById('rememberMe').checked) {
      localStorage.setItem('autoLogin', JSON.stringify({userId:s.id, expiry:Date.now()+7*864e5}));
    }
    document.getElementById('loginUser').value='';
    document.getElementById('loginPass').value='';
    startApp();
  } catch(e) {
    console.error('doLogin crash:', e);
    var errEl=document.getElementById('loginErr');
    if(errEl){ errEl.textContent='❌ خطأ غير متوقع — راجع Console (F12)'; errEl.style.display='block'; }
    alert('خطأ بالدخول:\n'+(e&&e.message||'unknown'));
  }
}

function togglePassView(){
  var inp=document.getElementById('loginPass');
  var btn=document.getElementById('togglePassBtn');
  if(!inp)return;
  if(inp.type==='password'){inp.type='text';if(btn)btn.textContent='🙈';}
  else{inp.type='password';if(btn)btn.textContent='👁️';}
}
function fillLogin(u,p){
  var uEl=document.getElementById('loginUser');
  var pEl=document.getElementById('loginPass');
  if(uEl)uEl.value=u;
  if(pEl)pEl.value=p;
  // Auto-trigger login
  setTimeout(doLogin,80);
}

function checkAutoLogin() {
  try {
    var saved = JSON.parse(localStorage.getItem('autoLogin')||'null');
    if (!saved || Date.now()>saved.expiry) { localStorage.removeItem('autoLogin'); showScreen('login'); return; }
    var s = G('staff',[]).find(function(x){return x.id===saved.userId;});
    if (!s) { localStorage.removeItem('autoLogin'); showScreen('login'); return; }
    CU = Object.assign({},s);
    startApp();
  } catch(e) { showScreen('login'); }
}

function doLogout() {
  CU=null; localStorage.removeItem('autoLogin');
  showScreen('login');
  document.getElementById('loginUser').value='';
  document.getElementById('loginPass').value='';
  // Hide bell + clear any active ring
  var fab = document.getElementById('bellFab'); if (fab) fab.style.display = 'none';
  if (typeof _ringInterval !== 'undefined' && _ringInterval) { clearInterval(_ringInterval); _ringInterval = null; }
  _activeIncomingCall = null;
  var ic = document.getElementById('mo-incomingCall'); if (ic) ic.classList.remove('open');
}

function checkSub() {
  var clinic = G('clinic',{});
  var sub = clinic.subscription;
  if (!sub || sub.status==='active') return true;
  if (sub.status==='trial') {
    if (new Date() <= new Date(sub.expiresAt)) return true;
    var d = Math.floor((new Date()-new Date(sub.expiresAt))/86400000);
    document.getElementById('subExpMsg').textContent = 'انتهت الفترة التجريبية لعيادة "'+clinic.name+'". تواصل مع الدعم لتجديد الاشتراك.';
    document.getElementById('subExpDetails').innerHTML = '📅 انتهت في: <strong>'+sub.expiresAt+'</strong>'+(d>0?'<br>⏰ منذ '+d+' يوم':'');
    showScreen('expired'); return false;
  }
  if (sub.status==='expired') {
    document.getElementById('subExpMsg').textContent = 'انتهى اشتراك عيادة "'+clinic.name+'".';
    document.getElementById('subExpDetails').innerHTML = '📅 انتهى في: <strong>'+sub.expiresAt+'</strong>';
    showScreen('expired'); return false;
  }
  return true;
}

function startApp() {
  try {
    if (!checkSub()) return;
    document.getElementById('sbName').textContent = CU.name;
    var rL = (ROLE_ICON[CU.role]||'') + ' ' + (ROLE_LABEL[CU.role]||CU.role);
    if (CU.subRole) rL += ' + ' + CU.subRole;
    document.getElementById('sbRole').textContent = rL;
    buildNav();
    loadNotifs();
    setTimeout(initOneSignal, 1500);
    var cs = document.getElementById('clinicSettings');
    if (cs) cs.style.display = (CU.role==='manager'||CU.role==='doctor-manager')?'block':'none';
    showScreen('app');
    navTo(CU.role==='patient'?'myfile':'dashboard');
    try { showBellFab(); } catch(e){}
    // Check immediately for any pending calls addressed to this user
    setTimeout(function(){ try { checkIncomingCalls(); } catch(e){} }, 1500);
    // Weekly backup reminder for managers
    try { checkBackupReminder(); } catch(e){}
    console.log('App started for', CU.username||CU.name, '— role:', CU.role);
  } catch(e) {
    console.error('startApp crash:', e);
    alert('خطأ بفتح التطبيق:\n'+(e&&e.message||'unknown')+'\n\nراجع Console (F12) لتفاصيل أكثر.');
  }
}

// ═══════════════════════════════════════════════════
//  REGISTER NEW CLINIC
// ═══════════════════════════════════════════════════
async function doRegister() {
  var cn  = (document.getElementById('regClinicName').value||'').trim();
  var cp  = (document.getElementById('regClinicPhone').value||'').trim();
  var ca  = (document.getElementById('regClinicAddr').value||'').trim();
  var mn  = (document.getElementById('regMgrName').value||'').trim();
  var mu  = (document.getElementById('regMgrUser').value||'').trim().toLowerCase();
  var mp  = (document.getElementById('regMgrPass').value||'').trim();
  var mph = (document.getElementById('regMgrPhone').value||'').trim();
  var err = document.getElementById('regErr');
  err.style.display='none';
  function e(m){err.textContent='❌ '+m;err.style.display='block';}
  if (!cn) return e('اسم العيادة مطلوب');
  if (!cp) return e('هاتف العيادة مطلوب');
  if (!mn) return e('اسم المدير مطلوب');
  if (!mu) return e('اسم المستخدم مطلوب');
  if (mp.length<4) return e('كلمة المرور 4 أحرف على الأقل');
  var btn=document.getElementById('regBtn');
  btn.disabled=true; btn.textContent='⏳ جاري التسجيل...';
  var newCid = 'clinic_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6);
  var trial = new Date(Date.now()+30*864e5).toISOString().split('T')[0];
  var clinicDoc = {name:cn,phone:cp,address:ca,logo:'🦷',createdAt:today(),subscription:{status:'trial',expiresAt:trial,plan:'basic'}};
  var staffDoc  = [{id:'s_'+Date.now().toString(36),name:mn,role:'doctor-manager',username:mu,phone:mph||cp,comm:30,pass:mp}];
  try {
    var ts = new Date().toISOString();
    var b = BASE_DOC_PATH(newCid);
    await CLOUD.setDoc(b+'/clinic',      {value:JSON.stringify(clinicDoc),updatedAt:ts});
    await CLOUD.setDoc(b+'/staff',       {value:JSON.stringify(staffDoc), updatedAt:ts});
    await CLOUD.setDoc(b+'/patients',    {value:'[]',updatedAt:ts});
    await CLOUD.setDoc(b+'/appointments',{value:'[]',updatedAt:ts});
    await CLOUD.setDoc(b+'/plans',       {value:'[]',updatedAt:ts});
    await CLOUD.setDoc(b+'/payments',    {value:'[]',updatedAt:ts});
    await CLOUD.setDoc(b+'/inventory',   {value:'[]',updatedAt:ts});
    localStorage.clear();
    localStorage.setItem('clinicId',newCid);
    alert('✅ تم تسجيل العيادة بنجاح!\nاسم المستخدم: '+mu+'\nكلمة المرور: '+mp+'\nفترة تجريبية: 30 يوم');
    location.reload();
  } catch(ex) {
    e('فشل التسجيل: '+ex.message);
    btn.disabled=false; btn.textContent='✅ تسجيل العيادة';
  }
}
function BASE_DOC_PATH(cid) {
  return 'clinics/'+cid+'/data';
}

function resetToDefaults() {
  if (!confirm('سيتم مسح جميع البيانات وإعادة التهيئة. هل أنت متأكد؟')) return;
  ['staff','patients','appointments','plans','payments','inventory','clinic','autoLogin','consents','consentTpls','orthoDevTpls','orthoMsgLog','tasks','chatMessages','notifs','chatRead','chatReadMap','staffCalls','shownCallIds'].forEach(function(k){ localStorage.removeItem(k); delete _cache[k]; });
  // Clean up consent image files (separate keys)
  try {
    var rm=[];
    for (var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if(k&&k.indexOf('consent_img_')===0) rm.push(k); }
    rm.forEach(function(k){ localStorage.removeItem(k); });
  } catch(e){}
  localStorage.setItem('staff', JSON.stringify(DEFAULT_STAFF));
  _cache['staff'] = DEFAULT_STAFF;
  initDefaults();
  alert('✅ تمت إعادة التهيئة\nاسم المستخدم: ahmed\nكلمة المرور: manager123');
}

// ═══════════════════════════════════════════════════
//  NAV
// ═══════════════════════════════════════════════════
var NAV_CFG = {
  'doctor-manager':[['🏠','dashboard','لوحة التحكم'],['🔍','search','بحث'],['👥','patients','المرضى'],['📅','appointments','المواعيد'],['📋','tasks','المهام'],['💬','chat','المحادثة'],['📨','requests','طلبات المرضى'],['🔔','recall','Recall'],['👨‍⚕️','staff','الكادر'],['💰','commissions','العمولات'],['💵','settlements','تصفية الأطباء'],['📊','finance','التقارير'],['⚠️','debtors','ديون المرضى'],['💼','clinicDebts','ديون العيادة'],['🏢','vendors','المختبرات والمكاتب'],['🛒','inventory','المشتريات'],['📢','marketing','التسويق']],
  'manager':       [['🏠','dashboard','لوحة التحكم'],['🔍','search','بحث'],['👥','patients','المرضى'],['📅','appointments','المواعيد'],['📋','tasks','المهام'],['💬','chat','المحادثة'],['📨','requests','طلبات المرضى'],['🔔','recall','Recall'],['👨‍⚕️','staff','الكادر'],['💰','commissions','العمولات'],['💵','settlements','تصفية الأطباء'],['📊','finance','التقارير'],['⚠️','debtors','ديون المرضى'],['💼','clinicDebts','ديون العيادة'],['🏢','vendors','المختبرات والمكاتب'],['🛒','inventory','المشتريات'],['📢','marketing','التسويق']],
  'reception':     [['🏠','dashboard','لوحة التحكم'],['🔍','search','بحث'],['👥','patients','المرضى'],['📅','appointments','المواعيد'],['📋','tasks','مهامي'],['💬','chat','المحادثة'],['📨','requests','طلبات المرضى'],['🔔','recall','Recall'],['⚠️','debtors','ديون المرضى'],['🏢','vendors','المختبرات والمكاتب'],['🛒','inventory','المشتريات']],
  'doctor':        [['🏠','dashboard','لوحة التحكم'],['🔍','search','بحث'],['👥','patients','مرضاي'],['📅','appointments','مواعيدي'],['📋','tasks','مهامي'],['💬','chat','المحادثة'],['💰','commissions','عمولاتي'],['💵','settlements','تصفياتي'],['🏢','vendors','المختبرات والمكاتب'],['🛒','inventory','المشتريات']],
  'marketer':      [['🏠','dashboard','لوحة التحكم'],['🔍','search','بحث'],['👥','patients','المرضى'],['📅','appointments','المواعيد'],['📋','tasks','مهامي'],['💬','chat','المحادثة'],['🔔','recall','Recall'],['📢','marketing','التسويق']],
  'patient':       [['🏠','myfile','ملفي'],['📅','bookappt','حجز موعد'],['💬','myinquiries','استفساراتي'],['📚','articles','المكتبة الطبية']],
};
var PAGE_TITLES = {dashboard:'لوحة التحكم',patients:'المرضى',appointments:'المواعيد',staff:'الكادر',commissions:'العمولات',settlements:'تصفية الأطباء',finance:'التقارير',debtors:'ديون المرضى',clinicDebts:'ديون العيادة',vendors:'المختبرات والمكاتب',recall:'نظام Recall',myfile:'ملفي الطبي',myrx:'وصفاتي الطبية',myconsents:'موافقاتي',profile:'ملف المريض',search:'بحث سريع',inventory:'المشتريات',marketing:'التسويق',tasks:'المهام',chat:'محادثة الكادر',requests:'طلبات المرضى',bookappt:'حجز موعد جديد',myinquiries:'استفساراتي',articles:'المكتبة الطبية',article:'مقال طبي'};

function buildNav() {
  var items = NAV_CFG[CU.role] || NAV_CFG.reception;
  document.getElementById('sbNav').innerHTML = items.map(function(x) {
    return '<div class="sb-item" id="sb-'+x[1]+'" onclick="navTo(\''+x[1]+'\');closeSb()"><span class="si">'+x[0]+'</span>'+x[2]+'</div>';
  }).join('');
  document.getElementById('bnList').innerHTML = items.slice(0,5).map(function(x) {
    return '<button class="bn-btn" id="bn-'+x[1]+'" onclick="navTo(\''+x[1]+'\')"><span class="bn-icon">'+x[0]+'</span><span class="bn-label">'+x[2]+'</span></button>';
  }).join('');
  // Show chat unread badges
  try { if (typeof renderChatBadge === 'function') renderChatBadge(); } catch(e){}
}

function navTo(pg) {
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active')});
  document.querySelectorAll('.sb-item,.bn-btn').forEach(function(n){n.classList.remove('active')});
  var p=document.getElementById('pg-'+pg); if(p) p.classList.add('active');
  var sb=document.getElementById('sb-'+pg); if(sb) sb.classList.add('active');
  var bn=document.getElementById('bn-'+pg); if(bn) bn.classList.add('active');
  var tt=document.getElementById('topbarTitle'); if(tt) tt.textContent=PAGE_TITLES[pg]||'سوران';
  renderPage(pg);
}

function renderPage(pg) {
  if (pg==='dashboard')    renderDash();
  else if (pg==='patients')    renderPatients();
  else if (pg==='appointments')renderAppts();
  else if (pg==='staff')       renderStaff();
  else if (pg==='commissions') { commSetTab(_commTab||'docs'); }
  else if (pg==='settlements') renderSettlements();
  else if (pg==='finance')     renderFinance();
  else if (pg==='debtors')     renderDebtors();
  else if (pg==='clinicDebts') renderClinicDebts();
  else if (pg==='vendors')     renderVendors();
  else if (pg==='recall')      renderRecall();
  else if (pg==='myfile')      renderMyFile();
  else if (pg==='myrx')        renderMyRx();
  else if (pg==='myconsents')  renderMyConsents();
  else if (pg==='search')      renderSearch();
  else if (pg==='inventory')   renderInventory();
  else if (pg==='marketing')   renderMarketing();
  else if (pg==='tasks')       renderTasks();
  else if (pg==='chat')        renderChatPage();
  else if (pg==='requests')    renderRequests();
  else if (pg==='bookappt')    renderBookAppt();
  else if (pg==='myinquiries') renderMyInquiries();
  else if (pg==='articles')    renderArticles();
  else if (pg==='article')     renderArticle();
}

function toggleSb() { document.getElementById('sidebar').classList.toggle('open'); document.getElementById('sbOverlay').classList.toggle('open'); }
function closeSb()  { document.getElementById('sidebar').classList.remove('open');  document.getElementById('sbOverlay').classList.remove('open'); }

function openModal(id) {
  if (id==='mo-addPlan')    prepPlan();
  if (id==='mo-addAppt')    prepAppt();
  if (id==='mo-addPatient') prepPatient();
  document.getElementById(id).classList.add('open');
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.addEventListener('click', function(e){ if(e.target.classList.contains('overlay')) e.target.classList.remove('open'); });

function emptyState(icon,msg){return '<div class="empty"><div class="e-icon">'+icon+'</div><p>'+msg+'</p></div>';}
function infoRow(l,v){return '<div><div class="text-muted">'+l+'</div><div class="fw-600 mt-4">'+(v||'-')+'</div></div>';}

// ═══════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════
function renderDash() {
  var el=document.getElementById('dashDate');
  if(el) el.textContent=new Date().toLocaleDateString('ar-IQ',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  var patients=G('patients',[]),appts=G('appointments',[]),pays=G('payments',[]),plans=G('plans',[]);
  var todayStr=today(), todayAppts=appts.filter(function(a){return a.date===todayStr;});
  var totalRev=pays.reduce(function(s,p){return s+(p.amount||0);},0);
  var activePlans=plans.filter(function(p){return p.status!=='completed';});
  var totalDebt=plans.filter(function(p){return p.status==='completed'&&(p.debtAmount||0)>0;}).reduce(function(s,p){return s+(p.debtAmount||0);},0);
  document.getElementById('dashStats').innerHTML=
    '<div class="stat-box"><span class="s-icon">👥</span><div class="s-label">إجمالي المرضى</div><div class="s-val">'+patients.length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📅</span><div class="s-label">مواعيد اليوم</div><div class="s-val">'+todayAppts.length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📋</span><div class="s-label">خطط نشطة</div><div class="s-val">'+activePlans.length+'</div></div>'+
    '<div class="stat-box" style="'+(totalDebt>0?'border-color:var(--red);background:var(--red-lt)':'')+'" '+(totalDebt>0?'onclick="navTo(\'debtors\')" style="cursor:pointer"':'')+'>'+
      '<span class="s-icon">'+(totalDebt>0?'⚠️':'💰')+'</span>'+
      '<div class="s-label">'+(totalDebt>0?'ديون مستحقة':'إجمالي الإيرادات')+'</div>'+
      '<div class="s-val" style="color:'+(totalDebt>0?'var(--red)':'var(--blue2)')+'">'+(totalDebt>0?totalDebt:totalRev).toLocaleString()+'</div>'+
    '</div>';
  var smap=sm(),pmap=pm();
  var ae=document.getElementById('dashAppts');
  if (!todayAppts.length) { ae.innerHTML=emptyState('📅','لا توجد مواعيد اليوم'); }
  else ae.innerHTML=todayAppts.map(function(a){
    var pt=pmap[a.patientId],doc=smap[a.doctorId];
    var stTag = a.status==='arrived' ? '<span class="badge badge-blue">✓ وصل</span>' : (a.status==='completed' ? '<span class="badge badge-green">مكتمل</span>' : '<span class="badge badge-orange">'+(a.type||'كشف')+'</span>');
    var arrBtn = (a.status==='scheduled') ? ' <button class="btn btn-xs" style="background:#0d5c7a;color:#fff" onclick="markArrived(\''+a.id+'\')" title="وصل المريض">🛎</button>' : '';
    return '<div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--gray2)"><div><div class="fw-700 text-sm">'+(pt?pt.name:'؟')+'</div><div class="text-muted">'+(doc?doc.name:'')+(a.time?' • '+a.time:'')+'</div></div><div style="display:flex;align-items:center;gap:6px">'+stTag+arrBtn+'</div></div>';
  }).join('');
  var pe=document.getElementById('dashPlans');
  if (!activePlans.length) { pe.innerHTML=emptyState('📋','لا توجد خطط نشطة'); }
  else pe.innerHTML=activePlans.slice(0,5).map(function(pl){
    var pt=pmap[pl.patientId];
    return '<div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--gray2);cursor:pointer" onclick="openProfile(\''+pl.patientId+'\')"><div><div class="fw-700 text-sm">'+(pt?pt.name:'؟')+'</div><div class="text-muted">'+pl.description+'</div></div><span class="badge badge-orange">'+(pl.planType==='implant'?'🦷':pl.planType==='ortho'?'🔧':'🔬')+'</span></div>';
  }).join('');
}

// ═══════════════════════════════════════════════════
//  PATIENTS
// ═══════════════════════════════════════════════════
function renderPatients() {
  var q=(document.getElementById('ptSearch').value||'').toLowerCase();
  var patients=G('patients',[]).filter(function(p){return !q||p.name.toLowerCase().includes(q)||p.phone.includes(q);});
  var plans=G('plans',[]),appts=G('appointments',[]);
  var plansByPt={},apptsByPt={};
  plans.forEach(function(pl){(plansByPt[pl.patientId]||(plansByPt[pl.patientId]=[])).push(pl);});
  appts.forEach(function(a){(apptsByPt[a.patientId]||(apptsByPt[a.patientId]=[])).push(a);});
  var tbody=document.getElementById('ptBody');
  if (!patients.length) { tbody.innerHTML='<tr><td colspan="6">'+emptyState('👥','لا يوجد مرضى')+'</td></tr>'; return; }
  tbody.innerHTML=patients.map(function(p,i){
    var pp=plansByPt[p.id]||[];
    var active=pp.filter(function(x){return x.status!=='completed';}).length;
    var done=pp.filter(function(x){return x.status==='completed';}).length;
    var pa=apptsByPt[p.id]||[];
    var last=pa.length?pa.reduce(function(mx,a){return a.date>mx?a.date:mx;},''):null;
    return '<tr><td class="text-muted">'+(i+1)+'</td><td><div class="fw-700">'+p.name+'</div><div class="text-muted">'+(p.gender||'')+(p.age?' • '+p.age+' سنة':'')+'</div></td><td>'+p.phone+'</td><td class="text-muted">'+(last||'-')+'</td><td>'+(active?'<span class="badge badge-orange">'+active+' نشطة</span> ':'')+( done?'<span class="badge badge-green">'+done+' مكتملة</span>':'')+(!pp.length?'<span class="text-muted">-</span>':'')+'</td><td><button class="btn btn-primary btn-xs" onclick="openProfile(\''+p.id+'\')">فتح الملف</button></td></tr>';
  }).join('');
}

function prepPatient() {
  // Reset all text inputs in the new-patient modal
  ['pName','pPhone','pAge','pAddress','pHistory'].forEach(function(id){
    var el=document.getElementById(id); if(el) el.value='';
  });
  var g=document.getElementById('pGender'); if(g) g.value='';
}

// ─── Oral assessment helpers (used by the addPatient modal) ───
function oralToggle(el, key) {
  if (!el) return;
  el.classList.toggle('active');
  // If toggled OFF, clear its count input (when present)
  if (!el.classList.contains('active')) {
    var inp=el.querySelector('.oral-num');
    if (inp) inp.value=0;
  }
  oralRenderSuggestions();
}
function oralUpdateCount(input, key) {
  if (!input) return;
  var v=parseInt(input.value||'0',10);
  if (isNaN(v) || v<0) v=0;
  if (v>32) v=32;
  input.value=v;
  // Reflect "active" visual on parent card based on count
  var item=input.closest ? input.closest('.oral-item') : null;
  if (item) {
    if (v>0) item.classList.add('active');
    else item.classList.remove('active');
  }
  oralRenderSuggestions();
}
function oralRenderSuggestions() {
  var grid=document.getElementById('oralAssessGrid'); if(!grid) return;
  var sug=document.getElementById('oralSuggestions'); if(!sug) return;
  var active=grid.querySelectorAll('.oral-item.active');
  if (!active.length) { sug.style.display='none'; sug.textContent=''; return; }
  var hints={
    filling_simple:'حشوات بسيطة',filling_deep:'حشوات عميقة',nerve:'علاج عصب',
    extraction:'قلع',missing:'تعويض مفقود',crown:'تيجان/جسر',
    ortho:'تقويم',bite:'تصحيح إطباق',cleaning:'تنظيف جير',healthy:'سليمة'
  };
  var parts=[];
  active.forEach(function(it){
    var k=it.getAttribute('data-key');
    if (!k) return;
    var inp=it.querySelector('.oral-num');
    var n=inp ? parseInt(inp.value||'0',10) : 0;
    parts.push((hints[k]||k)+(n>0?' ('+n+')':''));
  });
  sug.style.display='block';
  sug.textContent='💡 ملخص الحالة: '+parts.join(' • ');
}
function readOralAssessment() {
  var grid=document.getElementById('oralAssessGrid'); if(!grid) return null;
  var out={};
  grid.querySelectorAll('.oral-item.active').forEach(function(it){
    var k=it.getAttribute('data-key'); if(!k) return;
    var inp=it.querySelector('.oral-num');
    var n=inp ? parseInt(inp.value||'0',10) : 0;
    out[k]=n>0?n:true;
  });
  return Object.keys(out).length ? out : null;
}

function savePatient() {
  var name=(document.getElementById('pName').value||'').trim();
  var phone=(document.getElementById('pPhone').value||'').trim();
  if (!name||!phone) { alert('الاسم والهاتف مطلوبان'); return; }
  var pts=G('patients',[]);
  pts.push({
    id:'p'+uid(),name:name,phone:phone,
    age:document.getElementById('pAge').value,
    gender:document.getElementById('pGender').value,
    address:document.getElementById('pAddress').value,
    history:document.getElementById('pHistory').value,
    createdAt:today(),
    createdBy: CU ? CU.id : '',
    createdByRole: CU ? CU.role : ''
  });
  S('patients',pts);
  closeModal('mo-addPatient');
  prepPatient();
  renderPatients();
}

// ─── Initial Exam (oral assessment) — opened from patient profile ───
function openInitExam(){
  if (!CPid) { alert('افتح ملف المريض أولاً'); return; }
  var p = pm()[CPid];
  if (!p) return;
  var hdr=document.getElementById('examPatientHdr');
  if (hdr) hdr.innerHTML='👤 المريض: <span style="color:#0d5c7a">'+p.name+'</span>'+(p.phone?' • '+p.phone:'');
  // Reset grid then prefill from existing assessment if present
  var grid=document.getElementById('oralAssessGrid');
  if (grid){
    grid.querySelectorAll('.oral-item').forEach(function(it){ it.classList.remove('active'); });
    grid.querySelectorAll('.oral-num').forEach(function(n){ n.value=0; });
  }
  var sug=document.getElementById('oralSuggestions');
  if (sug){ sug.style.display='none'; sug.textContent=''; }
  if (p.oralAssessment && typeof p.oralAssessment==='object'){
    Object.keys(p.oralAssessment).forEach(function(k){
      var item=grid && grid.querySelector('.oral-item[data-key="'+k+'"]');
      if (!item) return;
      item.classList.add('active');
      var v=p.oralAssessment[k];
      var inp=item.querySelector('.oral-num');
      if (inp && typeof v==='number') inp.value=v;
    });
    oralRenderSuggestions();
  }
  var en=document.getElementById('examNotes');
  if (en) en.value = p.examNotes || '';
  openModal('mo-initExam');
}

function saveInitExam(){
  if (!CPid) return;
  var pts=G('patients',[]);
  var p=pts.find(function(x){return x.id===CPid;});
  if (!p) return;
  p.oralAssessment = readOralAssessment();
  p.examNotes = (document.getElementById('examNotes').value||'').trim();
  p.examDate  = today();
  p.examBy    = CU ? CU.id : '';
  S('patients', pts);
  closeModal('mo-initExam');
  // Re-render the profile info tab to reflect changes
  renderProfInfo(p);
}

// ═══════════════════════════════════════════════════
//  PROFILE
// ═══════════════════════════════════════════════════
function openProfile(pid) {
  CPid=pid;
  var p=G('patients',[]).find(function(x){return x.id===pid;});
  if (!p) return;
  document.getElementById('profName').textContent=p.name;
  document.getElementById('profMeta').textContent=(p.phone||'')+(p.gender?' • '+p.gender:'')+(p.age?' • '+p.age+' سنة':'')+(p.address?' • '+p.address:'');
  document.querySelectorAll('.tab-btn').forEach(function(b,i){b.classList.toggle('active',i===0);});
  document.querySelectorAll('.tab-panel').forEach(function(s,i){s.classList.toggle('active',i===0);});
  renderProfInfo(p); renderPlansList(pid); renderProfAppts(pid); renderProfPays(pid); renderConsents(pid);
  var bEdit=document.getElementById('btnEditConsentTpls');
  if(bEdit) bEdit.style.display=(CU&&(CU.role==='manager'||CU.role==='doctor-manager'))?'inline-block':'none';
  navTo('profile'); document.getElementById('pg-profile').classList.add('active');
}
function switchTab(tab,el) {
  document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active');});
  el.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(function(s){s.classList.remove('active');});
  document.getElementById('tp-'+tab).classList.add('active');
}
function renderProfInfo(p) {
  var oralHtml='';
  if (p && p.oralAssessment && typeof p.oralAssessment==='object') {
    var labels={
      filling_simple:'🪥 تسوس بسيط',filling_deep:'🔴 تسوس عميق',nerve:'🩺 بحاجة عصب',
      extraction:'🔩 بحاجة قلع',missing:'❌ أسنان مفقودة',crown:'👑 تيجان/جسر',
      ortho:'🔧 يحتاج تقويم',bite:'😬 مشاكل إطباق',cleaning:'✨ تنظيف جير',healthy:'✅ سليمة'
    };
    var pills=Object.keys(p.oralAssessment).map(function(k){
      var v=p.oralAssessment[k]; var n=(typeof v==='number'&&v>0)?(' ('+v+')'):'';
      return '<span style="display:inline-block;background:var(--blue-lt);color:var(--blue);border:1px solid var(--blue2);border-radius:14px;padding:4px 10px;margin:2px;font-size:11px;font-weight:700">'+(labels[k]||k)+n+'</span>';
    });
    if (pills.length) oralHtml='<div style="grid-column:1/-1"><div class="text-muted">🦷 تقييم الحالة الفموية</div><div class="mt-4">'+pills.join('')+'</div></div>';
  }
  document.getElementById('profInfo').innerHTML='<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">'+infoRow('الاسم',p.name)+infoRow('الهاتف',p.phone)+infoRow('العمر',p.age)+infoRow('الجنس',p.gender)+infoRow('العنوان',p.address)+infoRow('تاريخ التسجيل',p.createdAt)+'<div style="grid-column:1/-1">'+infoRow('التاريخ الطبي / الحساسيات',p.history)+'</div>'+oralHtml+'</div>';
}
function callPatient(){var p=G('patients',[]).find(function(x){return x.id===CPid;}); if(p&&p.phone) window.open('tel:'+p.phone);}
function waPatient(){var p=G('patients',[]).find(function(x){return x.id===CPid;}); if(p&&p.phone){var n=p.phone.replace(/\D/g,'');window.open('https://wa.me/'+(n.startsWith('0')?'964'+n.slice(1):n));}}
function openAddApptForPatient(){prepAppt();openModal('mo-addAppt'); if(CPid) document.getElementById('apptPat').value=CPid;}

// ═══════════════════════════════════════════════════
//  PLANS
// ═══════════════════════════════════════════════════
function prepPlan() {
  var docs=G('staff',[]).filter(function(s){return s.role==='doctor'||s.role==='doctor-manager';});
  document.getElementById('tpDoc').innerHTML=docs.map(function(d){return '<option value="'+d.id+'">'+d.name+'</option>';}).join('');
  if (CU&&(CU.role==='doctor'||CU.role==='doctor-manager')) document.getElementById('tpDoc').value=CU.id;
  document.getElementById('tpTeeth').value='';
  document.getElementById('dcDisplay').textContent='لم يتم تحديد أسنان';
  document.getElementById('tpCost').value='';
  document.getElementById('tpSess').value='1';
  document.getElementById('tpDesc').value='';
  document.getElementById('tpNotes').value='';
  document.getElementById('tpType').value='general';
  onPlanTypeChange(); buildChart();
}

function onPlanTypeChange() {
  var t=document.getElementById('tpType').value;
  document.getElementById('tpImplantExtra').style.display=t==='implant'?'block':'none';
  document.getElementById('tpOrthoExtra').style.display=t==='ortho'?'block':'none';
  // Default sessions per type
  var def={implant:'3',ortho:'12',smile:'6',filling:'1',extraction:'1',general:'1'};
  document.getElementById('tpSess').value = def[t] || '1';
  // Show marketer commission preview
  var box = document.getElementById('tpMktInfo');
  if (box){
    var amt = MKT_COMM_BY_TYPE[t] || 0;
    if (amt > 0 && CPid) {
      var ref = findReferringMarketer(CPid);
      if (ref) {
        box.innerHTML = '💡 سيُسجَّل حافز <strong>'+amt.toLocaleString()+' د.ع</strong> للمسوّق <strong>'+ref.name+'</strong> عند حفظ الخطة (لأنّه حجز هذه الحالة).';
        box.style.display='block';
      } else {
        box.style.display='none';
      }
    } else {
      box.style.display='none';
    }
  }
}

// ─── Marketer commission rates per case type (IQD) ───
var MKT_COMM_BY_TYPE = {
  implant:    25000,
  ortho:      25000,
  smile:      25000,
  filling:     5000,
  extraction:  3000,
  general:        0
};
var MKT_TYPE_LABEL = {
  implant:'زراعة', ortho:'تقويم', smile:'ابتسامة',
  filling:'حشوات', extraction:'قلع', general:'علاج عام'
};

// Find the marketer who booked this patient most recently (within 60 days),
// or the patient's permanent referredBy if set.
function findReferringMarketer(patientId){
  if (!patientId) return null;
  var smap = sm();
  // 1) Permanent attribution on patient record (manual override)
  var p = pm()[patientId];
  if (p && p.referredBy && smap[p.referredBy] && smap[p.referredBy].role==='marketer'){
    return smap[p.referredBy];
  }
  // 2) Most recent appointment booked by a marketer within 60 days
  var cutoff = Date.now() - 60*86400000;
  var apts = G('appointments',[]).filter(function(a){
    if (a.patientId !== patientId) return false;
    if (a.bookedByRole !== 'marketer' || !a.bookedBy) return false;
    var t = new Date(a.createdAt || (a.date+'T00:00:00')).getTime();
    return t >= cutoff;
  }).sort(function(x,y){
    return new Date(y.createdAt||y.date).getTime() - new Date(x.createdAt||x.date).getTime();
  });
  if (apts.length){
    var s = smap[apts[0].bookedBy];
    if (s && s.role==='marketer') return s;
  }
  return null;
}

function awardMarketerCommission(plan){
  if (!plan) return null;
  var amount = MKT_COMM_BY_TYPE[plan.planType] || 0;
  if (amount <= 0) return null;
  var marketer = findReferringMarketer(plan.patientId);
  if (!marketer) return null;
  // Avoid double-awarding for the same plan
  var existing = G('marketerCommissions',[]);
  if (existing.some(function(x){return x.planId === plan.id;})) return null;
  var entry = {
    id: 'mkc'+uid(),
    marketerId: marketer.id,
    patientId:  plan.patientId,
    planId:     plan.id,
    caseType:   plan.planType,
    caseTypeLabel: MKT_TYPE_LABEL[plan.planType] || plan.planType,
    amount:     amount,
    date:       today(),
    createdAt:  new Date().toISOString(),
    awardedBy:  CU ? CU.id : '',
    note:       plan.description || ''
  };
  existing.push(entry);
  S('marketerCommissions', existing);
  // Notify the marketer
  try {
    pushNotify('💰 حافز جديد', amount.toLocaleString()+' د.ع — حالة '+(MKT_TYPE_LABEL[plan.planType]||'')+' بدأت العلاج', {type:'mkt_comm'});
  } catch(e){}
  return entry;
}

function savePlan() {
  var desc=(document.getElementById('tpDesc').value||'').trim();
  if (!desc) { alert('وصف العلاج مطلوب'); return; }
  var type=document.getElementById('tpType').value;
  var pl={id:'pl'+uid(),patientId:CPid,planType:type,description:desc,
    doctorId:document.getElementById('tpDoc').value,
    sessions:parseInt(document.getElementById('tpSess').value)||1,
    totalCost:parseFloat(document.getElementById('tpCost').value)||0,
    costExact:false,  // السعر تقريبي افتراضياً، يُثبَّت في الجلسة الأولى
    teeth:document.getElementById('tpTeeth').value,
    notes:document.getElementById('tpNotes').value,
    status:'active',completedSessions:0,sessionRecords:[],paidAmount:0,payments:[],createdAt:today(),
    createdBy: CU ? CU.id : ''};
  if (type==='implant'){
    pl.impCo=document.getElementById('tpImpCo').value;
    pl.impSize=document.getElementById('tpImpSize').value;
    var ip=parseFloat(document.getElementById('tpImpPaid').value)||0;
    if(ip>0){pl.paidAmount=ip;pl.payments=[{amount:ip,date:today(),note:'دفعة أولى'}];addPay(CPid,pl.doctorId,ip,today(),desc,'دفعة أولى - زراعة');}
  } else if (type==='ortho'){
    pl.orthoDev=document.getElementById('tpOrthoDev').value;
    pl.orthoCo=document.getElementById('tpOrthoCo').value;
    pl.orthoNotes=document.getElementById('tpOrthoNotes').value;
  }
  var plans=G('plans',[]); plans.push(pl); S('plans',plans);

  // ─── Marketer commission (if any marketer referred this case) ───
  var awarded = awardMarketerCommission(pl);

  closeModal('mo-addPlan'); renderPlansList(CPid);
  // Notify the patient about their new plan
  try {
    var _typeLabel = MKT_TYPE_LABEL[type] || 'علاج';
    pushNotifyPatient(CPid, '📋 خطة علاج جديدة', 'تمت إضافة خطة '+_typeLabel+': '+desc, {type:'new_plan'});
  } catch(e){}
  // Friendly toast for awarded commission
  if (awarded){
    setTimeout(function(){
      addNotif('💰','حافز للمسوّق', awarded.amount.toLocaleString()+' د.ع — '+(MKT_TYPE_LABEL[type]||''),'navTo(\'commissions\')');
    },200);
  }
}

function renderPlansList(pid) {
  var plans=G('plans',[]).filter(function(pl){return pl.patientId===pid;});
  var smap=sm();
  var el=document.getElementById('plansList');
  if (!plans.length){el.innerHTML=emptyState('📋','لا توجد خطط علاج');return;}
  el.innerHTML=plans.map(function(pl){return planCard(pl,smap);}).join('');
}

function planCard(pl,smap){
  var doc=smap[pl.doctorId];
  var done=pl.completedSessions||0,total=pl.sessions||1;
  var pct=Math.round(done/total*100);
  var records=pl.sessionRecords||[];
  var paid=pl.paidAmount||0,rem=(pl.totalCost||0)-paid;
  var typeMap={
    general:   ['🔬 علاج عام','badge-blue',  'plan-active'],
    implant:   ['🦷 زراعة',   'badge-gold',  'plan-implant'],
    ortho:     ['🔧 تقويم',   'badge-purple','plan-ortho'],
    smile:     ['✨ ابتسامة', 'badge-pink',  'plan-active'],
    filling:   ['🪥 حشوات',  'badge-blue',  'plan-active'],
    extraction:['🔩 قلع',    'badge-orange','plan-active']
  };
  var tm=typeMap[pl.planType]||typeMap.general;
  var cls=pl.status==='completed'?'plan-done':tm[2];
  var dots=Array.from({length:total},function(_,i){
    var rec=records.find(function(r){return r.index===i;});
    var isDone=i<done,isCur=i===done&&pl.status!=='completed';
    var dc=isDone?'done':isCur?'current':'future';
    var title=rec?'جلسة '+(i+1)+': '+rec.work.substring(0,25):'جلسة '+(i+1);
    var click=(isDone||isCur)?'openSession(\''+pl.id+'\','+i+')':'';
    return '<button class="s-dot '+dc+'" onclick="'+click+'" title="'+title+'">'+(i+1)+'</button>';
  }).join('');
  var addBtn=pl.status!=='completed'?'<button class="s-dot-add" onclick="openSession(\''+pl.id+'\','+done+')">+ جلسة '+(done+1)+'</button>':'';
  var debtAmt=pl.debtAmount||0;
  var costBadge = (pl.totalCost>0 && pl.status!=='completed')?
    (pl.costExact ? '<span class="badge" style="background:#dcfce7;color:#15803d;font-size:9px;padding:2px 6px;margin-right:6px">✓ سعر نهائي</span>' :
                    '<span class="badge" style="background:#fef3c7;color:#92400e;font-size:9px;padding:2px 6px;margin-right:6px">~ تقديري</span>') : '';
  var finHTML=pl.totalCost>0?
    '<div class="finance-row"><div class="f-box"><div class="f-l">'+(pl.costExact||pl.status==='completed'?'التكلفة الكلية':'التكلفة التقديرية')+costBadge+'</div><div class="f-v" style="color:var(--blue2)">'+pl.totalCost.toLocaleString()+' د.ع</div></div><div class="f-box"><div class="f-l">المدفوع</div><div class="f-v" style="color:var(--green)">'+paid.toLocaleString()+' د.ع</div></div><div class="f-box"><div class="f-l">'+(pl.status==='completed'&&debtAmt>0?'دين ⚠️':'المتبقي')+'</div><div class="f-v" style="color:'+(debtAmt>0||rem>0?'var(--red)':'var(--green)')+'">'+( pl.status==='completed'?debtAmt:Math.max(0,rem)).toLocaleString()+' د.ع</div></div></div>'+
    (pl.status==='completed'&&debtAmt>0?'<div style="margin-top:8px;display:flex;gap:8px;align-items:center"><span class="badge badge-red">⚠️ دين مستحق</span><button class="btn btn-success btn-xs" onclick="openSettleDebt(\''+pl.id+'\')">💳 تسوية الدين</button></div>':''):''
  var logHTML=records.length?'<div class="session-log">'+records.slice().sort(function(a,b){return a.index-b.index;}).map(function(r){
    var d=smap[r.doctorId];
    var meds=r.medications&&r.medications.length?'<div style="margin-top:5px;padding:6px 8px;background:var(--green-lt);border-radius:6px;border-right:3px solid var(--green)"><div style="font-size:10px;font-weight:700;color:#1a7042;margin-bottom:4px">💊 الأدوية</div>'+r.medications.map(function(m){var nm=typeof m==='string'?m:m.name;var det=typeof m==='object'?[m.dose,m.duration,m.note].filter(Boolean).join(' • '):'';return '<div style="font-size:11px;font-weight:700">'+nm+'</div>'+(det?'<div style="font-size:10px;color:var(--gray5)">'+det+'</div>':'');}).join('')+'</div>':'';
    var ratingHTML='';
    if(pl.planType==='ortho' && r.rating && (r.rating.hygiene||r.rating.compliance)){
      var stars=function(v){return '<span style="color:#f59e0b;letter-spacing:1px">'+'★'.repeat(v||0)+'</span><span style="color:#d1d5db;letter-spacing:1px">'+'★'.repeat(5-(v||0))+'</span>';};
      ratingHTML='<div style="margin-top:5px;padding:6px 8px;background:#faf5ff;border-radius:6px;border-right:3px solid #c084fc;font-size:11px"><div style="display:flex;justify-content:space-between;gap:8px"><span>🪥 النظافة</span>'+stars(r.rating.hygiene)+'</div><div style="display:flex;justify-content:space-between;gap:8px;margin-top:3px"><span>📋 الالتزام</span>'+stars(r.rating.compliance)+'</div></div>';
    }
    return '<div class="session-log-item"><div class="sli-hdr"><span>جلسة '+(r.index+1)+' — '+(d?d.name:'')+'</span><div style="display:flex;gap:6px"><span>'+(r.date||'')+'</span><button class="btn btn-ghost btn-xs" onclick="rxPrintSaved(\''+pl.id+'\','+r.index+')">🖨️</button><button class="btn btn-ghost btn-xs" onclick="openSession(\''+pl.id+'\','+r.index+')">✏️</button></div></div><div class="sli-work">'+r.work+'</div>'+meds+ratingHTML+'</div>';
  }).join('')+'</div>':'';
  return '<div class="tp-card '+cls+'"><div class="tp-hdr"><div><div class="tp-title">'+pl.description+'</div><div class="tp-meta"><span><span class="badge '+tm[1]+'">'+tm[0]+'</span></span><span>👨‍⚕️ '+(doc?doc.name:'-')+'</span>'+(pl.teeth?'<span>🦷 '+pl.teeth+'</span>':'')+(pl.createdAt?'<span>📅 '+pl.createdAt+'</span>':'')+'</div></div>'+(pl.status!=='completed'?'<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">'+(pl.planType==='ortho' && CU && CU.role!=='patient'?'<button class="btn btn-xs" style="background:#6c2fa0;color:#fff;border:none;font-weight:700" onclick="odOpenPicker(\''+pl.id+'\')" title="رسالة جهاز التقويم">📱</button>':'')+'<button class="btn btn-success btn-xs" onclick="openComplete(\''+pl.id+'\')">✅ إكمال</button><button class="btn btn-danger btn-xs" onclick="deletePlan(\''+pl.id+'\')">🗑</button></div>':'<div style="display:flex;gap:4px">'+(pl.planType==='ortho' && CU && CU.role!=='patient'?'<button class="btn btn-xs" style="background:#6c2fa0;color:#fff;border:none;font-weight:700" onclick="odOpenPicker(\''+pl.id+'\')" title="رسالة جهاز التقويم">📱</button>':'')+'<span class="badge badge-green">✅ مكتمل</span></div>')+'</div>'+
    (pl.status!=='completed'?'<div class="progress-track"><div class="progress-fill" style="width:'+pct+'%"></div></div>':'')+
    '<div class="session-row">'+dots+addBtn+'</div>'+finHTML+logHTML+'</div>';
}

function deletePlan(id){if(!confirm('حذف خطة العلاج؟'))return;S('plans',G('plans',[]).filter(function(p){return p.id!==id;}));renderPlansList(CPid);}

// ═══════════════════════════════════════════════════
//  COMPLETE PLAN
// ═══════════════════════════════════════════════════
function openComplete(planId){
  var pl=G('plans',[]).find(function(p){return p.id===planId;}); if(!pl)return;
  document.getElementById('cpPlanId').value=planId;
  var rem=Math.max(0,(pl.totalCost||0)-(pl.paidAmount||0));
  document.getElementById('cpInfo').textContent='⚠️ المبلغ المتبقي: '+rem.toLocaleString()+' د.ع — ماذا تريد أن تفعل به؟';
  _cpOpt=''; cpSelect('paid'); document.getElementById('cpExtraFields').innerHTML='';
  ['paid','edit','debt'].forEach(function(o){var el=document.getElementById('cpOpt-'+o);if(el){el.style.border='1.5px solid var(--border)';el.style.background='';}});
  openModal('mo-completePlan');
}
function cpSelect(opt){
  _cpOpt=opt;
  ['paid','edit','debt'].forEach(function(o){var el=document.getElementById('cpOpt-'+o);if(el){el.style.border=o===opt?'1.5px solid var(--blue2)':'1.5px solid var(--border)';el.style.background=o===opt?'var(--blue-lt)':'';}});
  var ef=document.getElementById('cpExtraFields');
  if (opt==='paid') ef.innerHTML='<div class="form-group"><label>المبلغ المدفوع الآن (د.ع)</label><input class="form-control" id="cpPaidAmt" type="number" placeholder="0"></div>';
  else if (opt==='edit') ef.innerHTML='<div class="form-group"><label>التكلفة الكلية الجديدة (د.ع)</label><input class="form-control" id="cpNewCost" type="number" placeholder="0"></div>';
  else ef.innerHTML='<div class="alert alert-warning" style="margin:0">⚠️ سيظهر المبلغ المتبقي في قائمة ديون المرضى.</div>';
}
function confirmComplete(){
  var planId=document.getElementById('cpPlanId').value;
  var plans=G('plans',[]); var pl=plans.find(function(p){return p.id===planId;}); if(!pl)return;
  if (_cpOpt==='paid'){
    var extra=parseFloat(document.getElementById('cpPaidAmt').value)||0;
    if(extra>0){pl.paidAmount=(pl.paidAmount||0)+extra;addPay(pl.patientId,pl.doctorId,extra,today(),pl.description,'دفع عند الإكمال');}
    pl.debtAmount=0;
  } else if (_cpOpt==='edit'){
    var newCost=parseFloat(document.getElementById('cpNewCost').value)||0;
    pl.totalCost=newCost; pl.debtAmount=Math.max(0,newCost-(pl.paidAmount||0));
  } else {
    pl.debtAmount=Math.max(0,(pl.totalCost||0)-(pl.paidAmount||0));
  }
  pl.status='completed';pl.completedSessions=pl.sessions;pl.completedAt=today();
  S('plans',plans);closeModal('mo-completePlan');renderPlansList(CPid);

  // ─── اقتراح رسالة تذكير دين عند إكمال الخطة بدين متبقٍ ───
  if ((pl.debtAmount||0) > 0){
    var pt = pm()[pl.patientId];
    if (pt && pt.phone){
      var debtAmt = pl.debtAmount;
      var totalCost = pl.totalCost||0;
      var paidAmt = pl.paidAmount||0;
      if (confirm('✅ تم إكمال خطة العلاج.\n\n'+
                  '⚠️ يبقى مبلغ متبقٍ على المريض: '+debtAmt.toLocaleString()+' د.ع\n\n'+
                  'هل تريد فتح واتساب لاقتراح رسالة تذكير للمريض؟')){
        var msg = 'السلام عليكم '+pt.name+' 🌿\n\n'+
                  'نحمد الله على إكمال علاجك في عيادة سوران ✨\n\n'+
                  '📋 العلاج: '+(pl.description||'')+'\n'+
                  '💰 التكلفة الكلية: '+totalCost.toLocaleString()+' د.ع\n'+
                  '✅ المدفوع: '+paidAmt.toLocaleString()+' د.ع\n'+
                  '⚠️ المتبقي: '+debtAmt.toLocaleString()+' د.ع\n\n'+
                  'نرجو منك تسديد المبلغ المتبقي في أقرب فرصة ممكنة.\n'+
                  'يمكنك المرور بالعيادة أو التواصل معنا لترتيب طريقة الدفع.\n\n'+
                  'شكراً لثقتك بنا 🤝';
        openWaTo(pt.phone, msg);
      }
    }
  }
}

// ═══════════════════════════════════════════════════
//  SETTLE DEBT
// ═══════════════════════════════════════════════════
function openSettleDebt(planId){
  var pl=G('plans',[]).find(function(p){return p.id===planId;}); if(!pl)return;
  var pt=pm()[pl.patientId];
  document.getElementById('sdPlanId').value=planId;
  document.getElementById('sdAmt').value=pl.debtAmount||0;
  document.getElementById('sdNote').value='';
  document.getElementById('sdInfo').innerHTML='<div class="fw-700">'+pl.description+'</div><div class="text-muted mt-4">المريض: '+(pt?pt.name:'-')+'</div><div style="color:var(--red);font-weight:700;margin-top:6px">الدين: '+(pl.debtAmount||0).toLocaleString()+' د.ع</div>';
  openModal('mo-settleDebt');
}
function confirmSettleDebt(){
  var planId=document.getElementById('sdPlanId').value;
  var amt=parseFloat(document.getElementById('sdAmt').value)||0;
  if (amt<=0){alert('أدخل المبلغ المدفوع');return;}
  var plans=G('plans',[]); var pl=plans.find(function(p){return p.id===planId;}); if(!pl)return;
  addPay(pl.patientId,pl.doctorId,amt,today(),'تسوية دين: '+pl.description,document.getElementById('sdNote').value||'تسوية دين');
  pl.paidAmount=(pl.paidAmount||0)+amt; pl.debtAmount=Math.max(0,(pl.debtAmount||0)-amt);
  S('plans',plans); closeModal('mo-settleDebt'); renderDebtors(); if(CPid)renderPlansList(CPid);
}

// ═══════════════════════════════════════════════════
//  SESSION
// ═══════════════════════════════════════════════════
function openSession(planId,idx){
  var pl=G('plans',[]).find(function(p){return p.id===planId;});
  if(!pl||pl.status==='completed')return;
  if(idx>pl.completedSessions)return;

  // ─── تثبيت السعر النهائي عند فتح الجلسة الأولى ───
  if (idx === 0 && !pl.costExact){
    var oldCost = pl.totalCost || 0;
    var prompt1 = '💰 تثبيت السعر النهائي للخطة\n\n'+
                  'العلاج: '+(pl.description||'')+'\n'+
                  'السعر التقديري الحالي: '+oldCost.toLocaleString()+' د.ع\n\n'+
                  'اكتب السعر النهائي (يمكن تعديله لاحقاً عند الحاجة):';
    var newCostStr = prompt(prompt1, oldCost);
    if (newCostStr === null) return; // المستخدم ألغى
    var newCost = parseFloat(newCostStr);
    if (isNaN(newCost) || newCost < 0){ alert('⚠️ السعر غير صالح'); return; }
    var allPlans = G('plans', []);
    var pIdx = allPlans.findIndex(function(p){return p.id===planId;});
    if (pIdx >= 0){
      allPlans[pIdx].totalCost = newCost;
      allPlans[pIdx].costExact = true;
      allPlans[pIdx].costFinalizedAt = new Date().toISOString();
      allPlans[pIdx].costFinalizedBy = CU?CU.id:'';
      allPlans[pIdx].debtAmount = Math.max(0, newCost - (allPlans[pIdx].paidAmount||0));
      S('plans', allPlans);
      pl = allPlans[pIdx];
    }
  }

  var docs=G('staff',[]).filter(function(s){return s.role==='doctor'||s.role==='doctor-manager';});
  document.getElementById('sessDoc').innerHTML=docs.map(function(d){return '<option value="'+d.id+'">'+d.name+'</option>';}).join('');
  document.getElementById('sessDoc').value=pl.doctorId||docs[0]&&docs[0].id;
  document.getElementById('sessPlanId').value=planId;
  document.getElementById('sessIdx').value=idx;
  document.getElementById('sessTitle').textContent='📝 تسجيل الجلسة '+(idx+1);
  document.getElementById('sessDate').value=today();
  document.getElementById('sessNextDate').value='';
  // تعبئة قائمة الأوقات (9 ص – 9 م)
  document.getElementById('sessNextTime').innerHTML = buildTimeOptions('', {step:15});
  document.getElementById('sessWork').value='';
  document.getElementById('sessPaid').value='0';
  document.getElementById('sessNotes').value='';
  window._meds=[]; window._tips=[];
  // Reset rating + show only for ortho
  window._sessRating={hygiene:0,compliance:0};
  sessShowRating(pl.planType);
  var ex=(pl.sessionRecords||[]).find(function(r){return r.index===idx;});
  if(ex){
    document.getElementById('sessWork').value=ex.work||'';
    document.getElementById('sessPaid').value=ex.paid||0;
    document.getElementById('sessDate').value=ex.date||today();
    document.getElementById('sessNextDate').value=ex.nextDate||'';
    // إعادة بناء القائمة مع تحديد القيمة المحفوظة
    document.getElementById('sessNextTime').innerHTML = buildTimeOptions(ex.nextTime||'', {step:15});
    document.getElementById('sessNotes').value=ex.notes||'';
    if(ex.doctorId)document.getElementById('sessDoc').value=ex.doctorId;
    if(document.getElementById('sessDiscount'))document.getElementById('sessDiscount').value=ex.discount||0;
    window._meds=(ex.medications||[]).map(function(m){return typeof m==='string'?{name:m,dose:'',duration:'',note:''}:m;});
    window._tips=(ex.tips||[]).slice();
    if(ex.rating){window._sessRating={hygiene:ex.rating.hygiene||0,compliance:ex.rating.compliance||0};}
  }
  sessRenderStars();
  // Quick amount buttons
  // Quick amounts
  var AMTS=[15000,20000,25000,30000,35000,40000,45000,50000,75000,90000,100000,120000,140000,150000,200000];
  document.getElementById('sessQuickAmt').innerHTML=AMTS.map(function(v){
    var lbl=v>=1000?(v/1000)+'k':v;
    return '<button type="button" class="btn btn-ghost btn-xs" style="font-size:11px;padding:4px 8px" onclick="document.getElementById(\'sessPaid\').value=\''+v+'\';sessCalcNet()">'+lbl+'</button>';
  }).join('');
  // Reset discount
  if(document.getElementById('sessDiscount'))document.getElementById('sessDiscount').value=0;
  if(document.getElementById('sessNetResult'))document.getElementById('sessNetResult').style.display='none';
  rxInit(planId);
  openModal('mo-session');
}

function saveSession(){
  var planId=document.getElementById('sessPlanId').value;
  var idx=parseInt(document.getElementById('sessIdx').value);
  var work=(document.getElementById('sessWork').value||'').trim();
  if(!work){alert('وصف العمل مطلوب');return;}
  // ─── تحقق من الموعد القادم إن وُجد ───
  var _ndate = document.getElementById('sessNextDate').value;
  var _ntime = document.getElementById('sessNextTime').value;
  var _ndoc  = document.getElementById('sessDoc').value;
  if (_ndate && _ntime){
    if (!isWithinClinicHours(_ntime)){
      alert('⛔ وقت الموعد القادم خارج ساعات العمل (9 ص – 9 م).');
      return;
    }
    var _nconflict = findApptConflict(_ndate, _ntime, _ndoc);
    if (_nconflict){
      var _ptC = pm()[_nconflict.patientId];
      if (!confirm('⚠️ يوجد موعد آخر للطبيب يوم '+_ndate+' الساعة '+_nconflict.time+
                   (_ptC?(' (المريض: '+_ptC.name+')'):'')+
                   '.\n\nالفارق أقل من ٢٥ دقيقة. هل تريد المتابعة على أي حال؟')){
        return;
      }
    }
  }
  rxSyncBeforeSave();
  var plans=G('plans',[]); var pl=plans.find(function(p){return p.id===planId;}); if(!pl)return;
  if(!pl.sessionRecords)pl.sessionRecords=[];
  var rec={index:idx,work:work,doctorId:document.getElementById('sessDoc').value,paid:sessGetNetPaid(),discount:parseFloat(document.getElementById('sessDiscount').value)||0,date:document.getElementById('sessDate').value,nextDate:document.getElementById('sessNextDate').value,nextTime:document.getElementById('sessNextTime').value,notes:document.getElementById('sessNotes').value,medications:window._meds||[],tips:window._tips||[],rating:{hygiene:window._sessRating.hygiene||0,compliance:window._sessRating.compliance||0},savedAt:new Date().toISOString()};
  var exIdx=pl.sessionRecords.findIndex(function(r){return r.index===idx;});
  var isEdit=exIdx>=0;
  var oldPaid=isEdit?(pl.sessionRecords[exIdx].paid||0):0;
  if(isEdit)pl.sessionRecords[exIdx]=rec;else pl.sessionRecords.push(rec);
  if(!isEdit&&idx===pl.completedSessions)pl.completedSessions=idx+1;
  var diff=rec.paid-oldPaid;
  if(diff!==0){pl.paidAmount=(pl.paidAmount||0)+diff;if(!pl.payments)pl.payments=[];if(!isEdit)pl.payments.push({amount:rec.paid,date:rec.date,note:'جلسة '+(idx+1)});if(rec.paid>0||isEdit)addPay(pl.patientId,rec.doctorId||pl.doctorId,diff,rec.date,pl.description,isEdit?'تعديل جلسة '+(idx+1):'جلسة '+(idx+1));}
  S('plans',plans);
  if(rec.nextDate){var appts=G('appointments',[]);var nextApptId='a'+uid();appts.push({id:nextApptId,patientId:pl.patientId,doctorId:rec.doctorId||pl.doctorId,date:rec.nextDate,time:rec.nextTime||'',type:pl.description,notes:'جلسة '+(idx+2),status:'scheduled',createdAt:new Date().toISOString()});S('appointments',appts);try{scheduleApptReminders(nextApptId);}catch(e){}}
  closeModal('mo-session');renderPlansList(CPid);renderProfPays(CPid);
  // Notify manager of payment
  var _net=rec.paid||0;
  if(_net>0){
    var _pt2=pm()[pl.patientId], _dr2=sm()[rec.doctorId||pl.doctorId];
    pushNotifyRole(
      '💳 دفعة مستلمة',
      (_pt2?_pt2.name:'مريض')+' دفع '+_net.toLocaleString()+' د.ع'+(_dr2?' • '+_dr2.name:''),
      'doctor-manager'
    );
    pushNotifyRole('💳 دفعة مستلمة',(_pt2?_pt2.name:'مريض')+' دفع '+_net.toLocaleString()+' د.ع','manager');
  }
  if(_net>0) addNotif('💳','دفعة مستلمة',(_pt2?_pt2.name:'مريض')+' دفع '+_net.toLocaleString()+' د.ع','navTo(\'finance\')');
  // Smart WhatsApp suggestion based on rating (ortho only)
  setTimeout(function(){ try{ checkRatingMessage(planId,rec); }catch(e){console.warn('rating check err',e);} }, 400);
}

// ═══════════════════════════════════════════════════
//  SESSION PAYMENT HELPERS
// ═══════════════════════════════════════════════════
function sessCalcNet(){
  var paid=parseFloat(document.getElementById('sessPaid').value)||0;
  var disc=parseFloat(document.getElementById('sessDiscount').value)||0;
  var net=paid-disc;
  var el=document.getElementById('sessNetResult');
  if(!el)return;
  if(disc>0){
    el.style.display='block';
    el.innerHTML='المبلغ بعد الخصم: <span style="color:var(--green);font-size:16px">'+net.toLocaleString()+' د.ع</span>';
  } else {
    el.style.display='none';
  }
}
function sessSetDisc(v){
  document.getElementById('sessDiscount').value=v;
  sessCalcNet();
}
function sessGetNetPaid(){
  var paid=parseFloat(document.getElementById('sessPaid').value)||0;
  var disc=parseFloat(document.getElementById('sessDiscount').value)||0;
  return Math.max(0,paid-disc);
}

// ═══════════════════════════════════════════════════
//  SESSION RATING (Ortho only)
// ═══════════════════════════════════════════════════
var RATING_LABELS={
  hygiene:{1:'❌ ضعيفة جداً',2:'⚠️ ضعيفة',3:'😐 متوسطة',4:'👍 جيدة',5:'⭐ ممتازة'},
  compliance:{1:'❌ ضعيف جداً',2:'⚠️ ضعيف',3:'😐 متوسط',4:'👍 جيد',5:'⭐ ممتاز'}
};
window._sessRating={hygiene:0,compliance:0};

function sessShowRating(planType){
  var box=document.getElementById('sessRatingBox');
  if(!box)return;
  box.style.display=(planType==='ortho')?'block':'none';
}
function sessRenderStars(){
  ['hygiene','compliance'].forEach(function(k){
    var row=document.querySelector('.star-row[data-rating-key="'+k+'"]');
    if(!row)return;
    var val=window._sessRating[k]||0;
    row.innerHTML=[1,2,3,4,5].map(function(i){
      var on=i<=val;
      return '<button type="button" onclick="sessSetStar(\''+k+'\','+i+')" style="background:none;border:none;font-size:28px;cursor:pointer;padding:2px;color:'+(on?'#f59e0b':'#d1d5db')+'">★</button>';
    }).join('');
    var lbl=document.getElementById('sessRating'+(k.charAt(0).toUpperCase()+k.slice(1))+'Lbl');
    if(lbl)lbl.textContent=val>0?RATING_LABELS[k][val]:'لم يُقيَّم بعد';
  });
}
function sessSetStar(key,val){
  if(window._sessRating[key]===val) val=val-1; // toggle off if same
  window._sessRating[key]=val;
  sessRenderStars();
}
function sessResetRating(){
  window._sessRating={hygiene:0,compliance:0};
  sessRenderStars();
}

// ═══════════════════════════════════════════════════
//  WHATSAPP SMART MESSAGES (Rating-based)
// ═══════════════════════════════════════════════════
var ENCOURAGE_TPLS=[
  'السلام عليكم {اسم_المريض} 🌟\nالتزامك بالعلاج جيد، استمر على هذا المستوى وستحصل على نتائج ممتازة بإذن الله.\nنتطلع لرؤيتك في موعدك القادم {موعد_القادم}.\nد. {اسم_الطبيب}',
  'مرحباً {اسم_المريض} 😊\nنشكرك على حضورك واهتمامك بصحة فمك.\nاستمر في التنظيف اليومي وارتداء المطاطات بانتظام للحصول على أفضل نتيجة.\nموعدك القادم {موعد_القادم} - عيادة سوران',
  'تحياتي {اسم_المريض} 🦷\nتقدمك في علاج التقويم ملحوظ، وهذا يدل على التزامك.\nواصل على نفس المنوال 💪\nالموعد القادم: {موعد_القادم}\nد. {اسم_الطبيب}'
];
var WARNING_TPLS=[
  'مرحباً {اسم_المريض} 🦷\nلاحظنا في الجلسة الأخيرة أن هناك تراكمات على الأسنان والجهاز.\nيرجى الاهتمام أكثر بالتنظيف اليومي:\n• فرشاة بعد كل وجبة\n• استخدام فرشاة التقويم الخاصة\n• المضمضة بالماء الدافئ\nالموعد القادم: {موعد_القادم}\nد. {اسم_الطبيب} - عيادة سوران',
  'السلام عليكم {اسم_المريض} ⚠️\nنذكركم بأهمية ارتداء المطاطات والمثبتات حسب التعليمات.\nعدم الالتزام يؤخر العلاج ويزيد المدة.\nنتطلع لتعاونكم 🙏\nالموعد القادم {موعد_القادم}\nد. {اسم_الطبيب}',
  'تحياتي {اسم_المريض}\nنبهناكم في الجلسة الأخيرة على ضرورة الالتزام بـ:\n✅ التنظيف اليومي\n✅ ارتداء المطاطات\n✅ تجنب الأطعمة الصلبة\n✅ الحضور بالموعد\nاستمرار الإهمال سيؤثر على نتيجة العلاج.\nالموعد القادم: {موعد_القادم}\nد. {اسم_الطبيب} - عيادة سوران'
];

function fillTpl(tpl,vars){
  var out=tpl;
  Object.keys(vars).forEach(function(k){
    out=out.split('{'+k+'}').join(vars[k]||'');
  });
  return out;
}

function checkRatingMessage(planId,rec){
  var pl=G('plans',[]).find(function(p){return p.id===planId;});
  if(!pl||pl.planType!=='ortho')return;
  var rt=rec.rating; if(!rt||(!rt.hygiene&&!rt.compliance))return;
  var vals=[rt.hygiene,rt.compliance].filter(function(v){return v>0;});
  if(!vals.length)return;
  var avg=vals.reduce(function(a,b){return a+b;},0)/vals.length;
  // ≥4: nothing, =3: encourage optional, ≤2: warn optional, ≤1.5: strong warn
  if(avg>=4) return;
  var pt=pm()[pl.patientId]; if(!pt||!pt.phone)return;
  var doc=sm()[rec.doctorId||pl.doctorId];
  var nextStr=rec.nextDate?(rec.nextDate+(rec.nextTime?' الساعة '+rec.nextTime:'')):'سنحدده لاحقاً';
  var vars={
    'اسم_المريض':pt.name||'',
    'اسم_الطبيب':doc?doc.name:'',
    'موعد_القادم':nextStr,
    'نوع_الجهاز':pl.orthoDev||''
  };
  var isWarn=avg<=2;
  var tpls=isWarn?WARNING_TPLS:ENCOURAGE_TPLS;
  var auto=avg<=1.5; // very bad → auto suggest immediately
  showRatingWaModal(pt,vars,tpls,isWarn,avg,auto);
}

function showRatingWaModal(pt,vars,tpls,isWarn,avg,auto){
  var msgs=tpls.map(function(t){return fillTpl(t,vars);});
  var color=isWarn?'#dc2626':'#16a34a';
  var bg=isWarn?'#fef2f2':'#f0fdf4';
  var border=isWarn?'#fca5a5':'#86efac';
  var icon=isWarn?'⚠️':'🌟';
  var title=isWarn?'تقييم منخفض - رسالة تنبيه':'تقييم متوسط - رسالة تشجيعية';
  var subtitle='التقييم العام: '+avg.toFixed(1)+'/5'+(auto?' (منخفض جداً ⚠️)':'');
  var html='<div class="overlay open" id="mo-ratingWa" style="z-index:10010"><div class="modal modal-lg">';
  html+='<div class="modal-header" style="background:'+color+';color:#fff"><span class="modal-title">'+icon+' '+title+'</span><button class="modal-close" onclick="closeRatingWa()" style="color:#fff">✕</button></div>';
  html+='<div class="modal-body">';
  html+='<div style="background:'+bg+';border:1.5px solid '+border+';border-radius:var(--r);padding:12px;margin-bottom:12px">';
  html+='<div style="font-size:13px;font-weight:700;color:'+color+'">📞 '+(pt.name||'المريض')+' • '+(pt.phone||'')+'</div>';
  html+='<div style="font-size:11px;color:#666;margin-top:4px">'+subtitle+'</div>';
  html+='</div>';
  html+='<div style="font-size:12px;font-weight:600;color:#444;margin-bottom:8px">اختر القالب المناسب:</div>';
  html+=msgs.map(function(m,i){
    return '<div style="border:1.5px solid #e5e7eb;border-radius:var(--r);padding:10px;margin-bottom:8px;background:#fff">'+
      '<div style="font-size:12px;color:#333;white-space:pre-line;line-height:1.6;margin-bottom:8px">'+m.replace(/</g,'&lt;')+'</div>'+
      '<div style="display:flex;gap:6px;justify-content:flex-end">'+
        '<button class="btn btn-ghost btn-xs" onclick="copyRatingMsg('+i+')">📋 نسخ</button>'+
        '<button class="btn btn-xs" style="background:#25D366;color:#fff" onclick="sendRatingWa(\''+pt.phone.replace(/[^0-9+]/g,'')+'\','+i+')">💬 إرسال واتساب</button>'+
      '</div></div>';
  }).join('');
  html+='<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">';
  html+='<button class="btn btn-ghost" onclick="closeRatingWa()">تجاهل</button>';
  html+='</div></div></div></div>';
  // Store messages for action buttons
  window._ratingMsgs=msgs;
  // Remove any existing modal
  var ex=document.getElementById('mo-ratingWa'); if(ex)ex.remove();
  document.body.insertAdjacentHTML('beforeend',html);
}
function closeRatingWa(){var m=document.getElementById('mo-ratingWa'); if(m)m.remove();}
function copyRatingMsg(i){
  var msg=(window._ratingMsgs||[])[i]||'';
  if(navigator.clipboard) navigator.clipboard.writeText(msg).then(function(){alert('تم النسخ ✓');});
  else { var ta=document.createElement('textarea');ta.value=msg;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();alert('تم النسخ ✓'); }
}
function sendRatingWa(phone,i){
  var msg=(window._ratingMsgs||[])[i]||'';
  var p=phone.replace(/^00/,'').replace(/^0/,'964').replace(/^\+/,'');
  window.open('https://wa.me/'+p+'?text='+encodeURIComponent(msg),'_blank');
  closeRatingWa();
}

// ═══════════════════════════════════════════════════
//  IMPLANT PAYMENT
// ═══════════════════════════════════════════════════
function openImpPay(planId){document.getElementById('impPayPlanId').value=planId;document.getElementById('impPayAmt').value='';document.getElementById('impPayNote').value='';openModal('mo-impPay');}
function saveImpPay(){
  var planId=document.getElementById('impPayPlanId').value;
  var amt=parseFloat(document.getElementById('impPayAmt').value)||0;
  if(amt<=0){alert('أدخل مبلغاً صحيحاً');return;}
  var plans=G('plans',[]); var pl=plans.find(function(p){return p.id===planId;}); if(!pl)return;
  var note=document.getElementById('impPayNote').value;
  pl.paidAmount=(pl.paidAmount||0)+amt;
  if(!pl.payments)pl.payments=[];
  pl.payments.push({amount:amt,date:today(),note:note});
  S('plans',plans);addPay(pl.patientId,pl.doctorId,amt,today(),pl.description,note||'دفعة زراعة');
  closeModal('mo-impPay');renderPlansList(CPid);renderProfPays(CPid);
}

function addPay(patientId,doctorId,amount,date,service,note){
  if(!amount||amount<=0)return;
  var pays=G('payments',[]); pays.push({id:'pay'+uid(),patientId:patientId,doctorId:doctorId,amount:amount,date:date,service:service,note:note});
  S('payments',pays);
}

// ═══════════════════════════════════════════════════
//  PROFILE TABS
// ═══════════════════════════════════════════════════
function renderProfAppts(pid){
  var appts=G('appointments',[]).filter(function(a){return a.patientId===pid;});
  var smap=sm();
  var el=document.getElementById('profAppts');
  if(!appts.length){el.innerHTML=emptyState('📅','لا توجد مواعيد');return;}
  var SB={scheduled:'badge-orange',completed:'badge-green',cancelled:'badge-red'};
  var SL={scheduled:'مجدول',completed:'مكتمل',cancelled:'ملغي'};
  el.innerHTML='<div class="card"><div class="tbl-wrap"><table><thead><tr><th>التاريخ</th><th>الوقت</th><th>الطبيب</th><th>النوع</th><th>الحالة</th></tr></thead><tbody>'+appts.slice().sort(function(a,b){return b.date>a.date?1:-1;}).map(function(a){var d=smap[a.doctorId];return '<tr><td>'+a.date+'</td><td>'+(a.time||'-')+'</td><td>'+(d?d.name:'-')+'</td><td>'+(a.type||'-')+'</td><td><span class="badge '+(SB[a.status]||'badge-gray')+'">'+(SL[a.status]||a.status)+'</span></td></tr>';}).join('')+'</tbody></table></div></div>';
}
function renderProfPays(pid){
  var pays=G('payments',[]).filter(function(p){return p.patientId===pid;});
  var el=document.getElementById('profPays');
  var total=pays.reduce(function(s,p){return s+(p.amount||0);},0);
  if(!pays.length){el.innerHTML=emptyState('💳','لا توجد مدفوعات');return;}
  el.innerHTML='<div class="alert alert-info">💰 إجمالي المدفوعات: <strong>'+total.toLocaleString()+' د.ع</strong></div><div class="card"><div class="tbl-wrap"><table><thead><tr><th>التاريخ</th><th>الخدمة</th><th>المبلغ</th><th>ملاحظة</th></tr></thead><tbody>'+pays.slice().sort(function(a,b){return b.date>a.date?1:-1;}).map(function(p){return '<tr><td>'+p.date+'</td><td>'+(p.service||'-')+'</td><td class="fw-700" style="color:var(--green)">'+( p.amount||0).toLocaleString()+' د.ع</td><td class="text-muted">'+(p.note||'-')+'</td></tr>';}).join('')+'</tbody></table></div></div>';
}

// ═══════════════════════════════════════════════════
//  APPOINTMENTS
// ═══════════════════════════════════════════════════
var _apptRange = 'today';     // today | week | month | upcoming | all
var _apptMode  = 'exist';     // exist | new

function apptSetRange(r){
  _apptRange = r;
  document.querySelectorAll('#apptRangeTabs button').forEach(function(b){
    b.className = b.getAttribute('data-range')===r ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';
  });
  // When switching to a range, clear specific date filter (range overrides it)
  if (r!=='all') { var d=document.getElementById('apptFDate'); if(d) d.value=''; }
  renderAppts();
}

function apptSetMode(m){
  _apptMode = m;
  var be=document.getElementById('apptModeExist'), bn=document.getElementById('apptModeNew');
  var boxE=document.getElementById('apptModeExistBox'), boxN=document.getElementById('apptModeNewBox');
  if (m==='exist'){
    if(be) be.className='btn btn-sm btn-primary';
    if(bn) bn.className='btn btn-sm btn-ghost';
    if(boxE) boxE.style.display='';
    if(boxN) boxN.style.display='none';
  } else {
    if(be) be.className='btn btn-sm btn-ghost';
    if(bn) bn.className='btn btn-sm btn-primary';
    if(boxE) boxE.style.display='none';
    if(boxN) boxN.style.display='';
  }
}

function apptFilterPats(){
  var q=(document.getElementById('apptPatSearch').value||'').trim().toLowerCase();
  var sel=document.getElementById('apptPat');
  var hint=document.getElementById('apptPatHint');
  if (!q){ sel.style.display='none'; if(hint) hint.textContent=''; return; }
  var pts=G('patients',[]).filter(function(p){
    var n=(p.name||'').toLowerCase(), ph=(p.phone||'').toLowerCase();
    return n.indexOf(q)>=0 || ph.indexOf(q)>=0;
  }).slice(0,20);
  if (!pts.length){
    sel.style.display='none';
    if(hint) hint.innerHTML='⚠️ لا يوجد مريض بهذا الاسم/الرقم. <a href="javascript:apptSetMode(\'new\')" style="color:var(--blue2);font-weight:700">أضِف كمريض جديد سريع ←</a>';
    return;
  }
  sel.innerHTML=pts.map(function(p){return '<option value="'+p.id+'">'+p.name+(p.phone?' • '+p.phone:'')+'</option>';}).join('');
  sel.style.display='block';
  if(hint) hint.textContent='تم العثور على '+pts.length+' مريض. اختر أحدهم.';
}

function apptOnPickExisting(){
  // No special handling needed; the value is read on save
  var hint=document.getElementById('apptPatHint');
  if (hint) hint.textContent='✓ تم اختيار المريض';
}

function prepAppt(){
  // Reset mode to existing-patient (default)
  apptSetMode('exist');
  var search=document.getElementById('apptPatSearch'); if(search) search.value='';
  var sel=document.getElementById('apptPat'); if(sel){ sel.innerHTML=''; sel.style.display='none'; }
  var hint=document.getElementById('apptPatHint'); if(hint) hint.textContent='';
  var nn=document.getElementById('apptNewName'); if(nn) nn.value='';
  var np=document.getElementById('apptNewPhone'); if(np) np.value='';
  // Doctors
  var docs=G('staff',[]).filter(function(s){return s.role==='doctor'||s.role==='doctor-manager';});
  document.getElementById('apptDoc').innerHTML=docs.map(function(d){return '<option value="'+d.id+'">'+d.name+'</option>';}).join('');
  if(CU&&(CU.role==='doctor'||CU.role==='doctor-manager'))document.getElementById('apptDoc').value=CU.id;
  document.getElementById('apptDate').value=today();
  // تعبئة قائمة الأوقات (9 ص – 9 م) — كل ١٥ دقيقة
  document.getElementById('apptTime').innerHTML = buildTimeOptions('', {step:15});
  document.getElementById('apptType').value='';
  document.getElementById('apptNotes').value='';
  // Pre-fill bookedBy display (transparent — patient never sees, but staff does)
  var box=document.getElementById('apptBookedByBox');
  if (box && CU){
    var roleLbl = ROLE_LABEL[CU.role]||CU.role;
    box.innerHTML='👤 يثبَّت تلقائياً أن هذا الحجز قام به: <strong>'+CU.name+'</strong> ('+roleLbl+')';
  }
}

function saveAppt(){
  var did=document.getElementById('apptDoc').value;
  var date=document.getElementById('apptDate').value;
  var type=(document.getElementById('apptType').value||'').trim();
  var time=document.getElementById('apptTime').value;
  var notes=document.getElementById('apptNotes').value;

  if(!did||!date){ alert('الطبيب والتاريخ مطلوبان'); return; }
  if(!type){ alert('الرجاء كتابة سبب الحجز'); return; }
  if(!time){ alert('الرجاء اختيار وقت الحجز'); return; }

  // ─── تحقق من ساعات العيادة (9 ص – 9 م) ───
  if (!isWithinClinicHours(time)){
    alert('⛔ ساعات العمل من 9:00 صباحاً إلى 9:00 مساءً فقط.\nاختر وقتاً ضمن هذه الفترة.');
    return;
  }

  // ─── تحقق من الفارق الزمني (25 دقيقة على الأقل) ───
  var conflict = findApptConflict(date, time, did);
  if (conflict){
    var _ptC = pm()[conflict.patientId];
    alert('⛔ لا يمكن حجز هذا الوقت.\n\nهناك موعد آخر للطبيب نفسه يوم '+date+' الساعة '+conflict.time+
          (_ptC?(' (المريض: '+_ptC.name+')'):'')+
          '.\n\nيجب أن يكون الفارق بين أي حجزين ٢٥ دقيقة على الأقل.\nاختر وقتاً آخر.');
    return;
  }

  var pid='';
  // Resolve patient based on current mode
  if (_apptMode === 'new'){
    var n=(document.getElementById('apptNewName').value||'').trim();
    var ph=(document.getElementById('apptNewPhone').value||'').trim();
    if (!n || !ph){ alert('الاسم ورقم الهاتف مطلوبان للمريض الجديد'); return; }
    // Check if a patient with same phone already exists — reuse them instead of duplicating
    var existing = G('patients',[]).find(function(p){return p.phone && p.phone.replace(/\D/g,'') === ph.replace(/\D/g,'');});
    if (existing){
      if (!confirm('يوجد مريض مسجَّل بنفس الرقم: '+existing.name+'.\nهل تستخدمه؟')){
        return;
      }
      pid = existing.id;
    } else {
      pid = 'p'+uid();
      var pts=G('patients',[]);
      pts.push({id:pid,name:n,phone:ph,createdAt:today(),createdBy:CU?CU.id:'',createdByRole:CU?CU.role:''});
      S('patients',pts);
    }
  } else {
    pid=document.getElementById('apptPat').value;
    if(!pid){ alert('اختر المريض من القائمة أو استخدم وضع "مريض جديد سريع"'); return; }
  }

  var appts=G('appointments',[]);
  var newApptId='a'+uid();
  var bookedBy = CU ? CU.id : '';
  var bookedByRole = CU ? CU.role : '';
  appts.push({
    id:newApptId, patientId:pid, doctorId:did, date:date, time:time,
    type:type, notes:notes,
    status:'scheduled',
    bookedBy: bookedBy, bookedByRole: bookedByRole,
    createdAt:new Date().toISOString()
  });
  S('appointments',appts);
  closeModal('mo-addAppt');
  renderAppts();

  // Notify staff
  var _pt=pm()[pid], _doc=sm()[did];
  pushNotify(
    '📅 موعد جديد',
    'مريض: '+(_pt?_pt.name:'؟')+' • طبيب: '+(_doc?_doc.name:'؟')+' • '+date+(time?' '+time:''),
    {type:'appointment', patientId:pid}
  );
  addNotif('📅','موعد جديد','مريض: '+(_pt?_pt.name:'؟')+' • '+date,'navTo(\'appointments\')');
  // Notify the patient directly on their device (if they have the app)
  try {
    pushNotifyPatient(pid, '📅 موعد جديد في عيادة سوران',
      'تم حجز موعدك بتاريخ '+date+(time?' الساعة '+time:'')+(_doc?' مع '+_doc.name:''),
      {type:'appointment',date:date});
  } catch(e){}
  // Schedule automatic reminders (24h + 2h before)
  try { scheduleApptReminders(newApptId); } catch(e){}
}

// ─── Range filtering helpers ───
function apptInRange(a, range){
  if (!a || !a.date) return false;
  if (range === 'all') return true;
  var t = today();
  var d = new Date(a.date+'T00:00:00');
  var now = new Date(t+'T00:00:00');
  if (range === 'today')    return a.date === t;
  if (range === 'upcoming') return a.date >= t;
  if (range === 'week'){
    // Current week: Saturday → Friday (Iraq convention) — use Mon-Sun for simplicity, ±7 days
    var ms = d.getTime() - now.getTime();
    return ms >= -7*86400000 && ms <= 7*86400000;
  }
  if (range === 'month'){
    return a.date.substring(0,7) === t.substring(0,7);
  }
  return true;
}

function renderAppts(){
  var dfDate=document.getElementById('apptFDate')&&document.getElementById('apptFDate').value||'';
  var dfDoc =document.getElementById('apptFDoc') &&document.getElementById('apptFDoc') .value||'';
  var dfSt  =document.getElementById('apptFSt')  &&document.getElementById('apptFSt')  .value||'';
  var docs=G('staff',[]).filter(function(s){return s.role==='doctor'||s.role==='doctor-manager';});
  var docSel=document.getElementById('apptFDoc');
  if(docSel)docSel.innerHTML='<option value="">كل الأطباء</option>'+docs.map(function(d){return '<option value="'+d.id+'"'+(dfDoc===d.id?' selected':'')+'>'+d.name+'</option>';}).join('');
  var smap=sm(),pmap=pm();
  var appts=G('appointments',[]);
  if(CU&&(CU.role==='doctor'||CU.role==='doctor-manager'))appts=appts.filter(function(a){return a.doctorId===CU.id;});
  // Apply range tab first
  appts = appts.filter(function(a){ return apptInRange(a, _apptRange); });
  // Then specific filters
  if(dfDate)appts=appts.filter(function(a){return a.date===dfDate;});
  if(dfDoc) appts=appts.filter(function(a){return a.doctorId===dfDoc;});
  if(dfSt)  appts=appts.filter(function(a){return a.status===dfSt;});
  appts.sort(function(a,b){
    if (a.date===b.date) return (a.time||'')>(b.time||'')?1:-1;
    return a.date>b.date?1:-1;
  });

  // Stats for the current range
  var statsEl=document.getElementById('apptStats');
  if (statsEl){
    var sched=appts.filter(function(a){return a.status==='scheduled';}).length;
    var arr  =appts.filter(function(a){return a.status==='arrived';}).length;
    var done =appts.filter(function(a){return a.status==='completed';}).length;
    var canc =appts.filter(function(a){return a.status==='cancelled';}).length;
    var rangeLbl={today:'اليوم',week:'الأسبوع',month:'الشهر',upcoming:'القادمة',all:'الكل'}[_apptRange]||'';
    statsEl.innerHTML=
      '<div class="stat-box"><span class="s-icon">📊</span><div class="s-label">إجمالي '+rangeLbl+'</div><div class="s-val">'+appts.length+'</div></div>'+
      '<div class="stat-box"><span class="s-icon">⏳</span><div class="s-label">مجدول</div><div class="s-val" style="color:#e67e22">'+sched+'</div></div>'+
      '<div class="stat-box"><span class="s-icon">🛎️</span><div class="s-label">وصلوا</div><div class="s-val" style="color:#0d5c7a">'+arr+'</div></div>'+
      '<div class="stat-box"><span class="s-icon">✅</span><div class="s-label">مكتمل</div><div class="s-val" style="color:#16a34a">'+done+'</div></div>'+
      '<div class="stat-box"><span class="s-icon">✕</span><div class="s-label">ملغي</div><div class="s-val" style="color:#dc2626">'+canc+'</div></div>';
  }

  var SB={scheduled:'badge-orange',arrived:'badge-blue',completed:'badge-green',cancelled:'badge-red'};
  var SL={scheduled:'مجدول',arrived:'وصل ✓',completed:'مكتمل',cancelled:'ملغي'};
  var tbody=document.getElementById('apptBody');
  if(!appts.length){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--gray4)">لا توجد مواعيد في هذه الفترة</td></tr>';return;}
  tbody.innerHTML=appts.map(function(a){
    var pt=pmap[a.patientId],doc=smap[a.doctorId];
    var arrBtn = (a.status==='scheduled') ? '<button class="btn btn-xs" style="background:#0d5c7a;color:#fff" onclick="markArrived(\''+a.id+'\')" title="وصل المريض">🛎</button>' : '';
    var remBadge = (a.reminders && a.reminders.length && a.status==='scheduled') ? '<span title="تذكيرات تلقائية مجدولة" style="font-size:11px;margin-right:4px">🔔</span>' : '';
    var booker = a.bookedBy ? smap[a.bookedBy] : null;
    var bookerHtml = booker
      ? '<span style="font-size:11px;color:'+(a.bookedByRole==='marketer'?'#c2410c':'var(--gray5)')+';font-weight:'+(a.bookedByRole==='marketer'?'800':'600')+'">'+(a.bookedByRole==='marketer'?'📢 ':'')+booker.name+'</span>'
      : '<span class="text-muted" style="font-size:11px">-</span>';
    // Show who confirmed arrival on arrived rows
    var arriverInfo = '';
    if (a.status==='arrived' && a.arrivedBy){
      var ab = smap[a.arrivedBy];
      if (ab) arriverInfo = '<div style="font-size:10px;color:#0d5c7a;margin-top:2px">🛎️ أشّر دخوله: '+ab.name+'</div>';
    }
    return '<tr><td><div class="fw-600">'+(pt?pt.name:'؟')+remBadge+'</div>'+(pt&&pt.phone?'<div style="font-size:11px;color:var(--gray5)">'+pt.phone+'</div>':'')+arriverInfo+'</td><td class="text-muted">'+(doc?doc.name:'-')+'</td><td>'+a.date+(a.time?' • '+a.time:'')+'</td><td>'+(a.type||'-')+'</td><td><span class="badge '+(SB[a.status]||'badge-gray')+'">'+(SL[a.status]||a.status)+'</span></td><td>'+bookerHtml+'</td><td style="display:flex;gap:4px;flex-wrap:wrap">'+
      (a.status!=='cancelled' && (typeof openApptHub==='function') ? '<button class="btn btn-xs" style="background:linear-gradient(135deg,#0d5c7a,#083d55);color:#fff;font-weight:700" onclick="openApptHub(\''+a.id+'\')" title="إدارة الموعد — خطة وجلسة ووصفة في شاشة واحدة">🎯 إدارة</button>' : '')+
      arrBtn+(a.status==='scheduled'||a.status==='arrived'?'<button class="btn btn-success btn-xs" onclick="doneAppt(\''+a.id+'\')" title="إكمال">✔</button>':'')+(a.status!=='cancelled'&&a.status!=='completed'?'<button class="btn btn-xs" style="background:#f59e0b;color:#fff" onclick="openEditAppt(\''+a.id+'\')" title="تعديل/تأجيل الموعد">✏️</button>':'')+'<button class="btn btn-danger btn-xs" onclick="delAppt(\''+a.id+'\')" title="حذف">🗑</button></td></tr>';
  }).join('');
}
function doneAppt(id){var appts=G('appointments',[]); var a=appts.find(function(x){return x.id===id;}); if(a)a.status='completed'; S('appointments',appts); renderAppts();}

// ─── تعديل الموعد (Reschedule) ───
function openEditAppt(apptId){
  var appts = G('appointments', []);
  var a = appts.find(function(x){return x.id === apptId;});
  if (!a) return;
  document.getElementById('editApptId').value = apptId;
  var pt = pm()[a.patientId];
  var doc = sm()[a.doctorId];
  document.getElementById('editApptCurrent').innerHTML =
    '<div style="font-weight:700;margin-bottom:4px">📅 الموعد الحالي:</div>'+
    '👤 المريض: '+(pt?pt.name:'؟')+(pt&&pt.phone?' • '+pt.phone:'')+'<br>'+
    '👨‍⚕️ الطبيب: '+(doc?doc.name:'؟')+'<br>'+
    '🗓️ التاريخ والوقت: '+a.date+(a.time?' الساعة '+a.time:'')+'<br>'+
    '📝 السبب: '+(a.type||'-');
  var docs = G('staff',[]).filter(function(s){return s.role==='doctor'||s.role==='doctor-manager';});
  document.getElementById('editApptDoc').innerHTML = docs.map(function(d){
    return '<option value="'+d.id+'"'+(d.id===a.doctorId?' selected':'')+'>'+d.name+'</option>';
  }).join('');
  document.getElementById('editApptType').value = a.type||'';
  document.getElementById('editApptDate').value = a.date||today();
  document.getElementById('editApptTime').innerHTML = buildTimeOptions(a.time||'', {step:15});
  document.getElementById('editApptReason').value = '';
  document.getElementById('editApptReasonOther').value = '';
  document.getElementById('editApptReasonOtherBox').style.display = 'none';
  document.getElementById('editApptNotes').value = a.notes||'';
  openModal('mo-editAppt');
}

function onEditReasonChange(){
  var v = document.getElementById('editApptReason').value;
  document.getElementById('editApptReasonOtherBox').style.display = (v === 'other') ? 'block' : 'none';
}

function saveEditAppt(sendWA){
  var apptId = document.getElementById('editApptId').value;
  var did    = document.getElementById('editApptDoc').value;
  var date   = document.getElementById('editApptDate').value;
  var time   = document.getElementById('editApptTime').value;
  var type   = (document.getElementById('editApptType').value||'').trim();
  var notes  = (document.getElementById('editApptNotes').value||'').trim();
  var reason = document.getElementById('editApptReason').value;
  var reasonOther = (document.getElementById('editApptReasonOther').value||'').trim();

  if (!did||!date) { alert('الطبيب والتاريخ مطلوبان'); return; }
  if (!time) { alert('الرجاء اختيار الوقت الجديد'); return; }
  if (!type) { alert('الرجاء كتابة سبب الحجز'); return; }

  // ساعات العيادة (9 ص – 9 م)
  if (!isWithinClinicHours(time)){
    alert('⛔ الوقت خارج ساعات العمل (9 ص – 9 م).');
    return;
  }
  // فارق ٢٥ دقيقة (يستثني الموعد الحالي نفسه)
  var conflict = findApptConflict(date, time, did, apptId);
  if (conflict){
    var _ptC = pm()[conflict.patientId];
    alert('⛔ يوجد موعد آخر للطبيب يوم '+date+' الساعة '+conflict.time+
          (_ptC?(' (المريض: '+_ptC.name+')'):'')+
          '.\n\nيجب أن يكون الفارق ٢٥ دقيقة على الأقل.');
    return;
  }

  var finalReason = reason === 'other' ? reasonOther : reason;
  if (sendWA){
    if (!reason) { alert('اختر سبب التعديل أولاً (سيظهر للمريض في الرسالة)'); return; }
    if (reason === 'other' && !reasonOther) { alert('اكتب سبب التعديل'); return; }
  }

  var appts = G('appointments', []);
  var idx = appts.findIndex(function(x){return x.id === apptId;});
  if (idx < 0) return;
  var oldDate = appts[idx].date;
  var oldTime = appts[idx].time;
  var oldDocId = appts[idx].doctorId;
  // إلغاء التذكيرات القديمة قبل الحفظ
  try { cancelApptReminders(appts[idx]); } catch(e){}
  appts[idx].date = date;
  appts[idx].time = time;
  appts[idx].type = type;
  appts[idx].notes = notes;
  appts[idx].doctorId = did;
  appts[idx].lastEditedAt = new Date().toISOString();
  appts[idx].lastEditedBy = CU?CU.id:null;
  if (finalReason) appts[idx].lastEditReason = finalReason;
  S('appointments', appts);
  // إعادة جدولة التذكيرات
  try { scheduleApptReminders(apptId); } catch(e){}

  closeModal('mo-editAppt');
  renderAppts();

  if (sendWA){
    var pt = pm()[appts[idx].patientId];
    var doc = sm()[did];
    if (pt && pt.phone){
      var msg = 'السلام عليكم '+pt.name+' 🌿\n\n'+
                'نودّ إعلامك بتعديل موعدك في عيادة سوران:\n\n'+
                '📅 الموعد الجديد: '+date+' الساعة '+time+'\n'+
                (doc?'👨‍⚕️ الطبيب: '+doc.name+'\n':'')+
                '\nسبب التعديل: '+finalReason+
                ((oldDate&&(oldDate!==date||oldTime!==time))?
                  '\n\nالموعد السابق: '+oldDate+(oldTime?' الساعة '+oldTime:'') : '')+
                '\n\nنعتذر عن أي إزعاج، ونراك قريباً ✨';
      openWaTo(pt.phone, msg);
    } else {
      alert('✅ تم تعديل الموعد.\n\n⚠️ لا يوجد رقم هاتف للمريض، لم نستطع فتح الرسالة.');
    }
  }
}

function delAppt(id){
  if(!confirm('حذف الموعد؟'))return;
  var appts=G('appointments',[]);
  var appt=appts.find(function(a){return a.id===id;});
  // Cancel scheduled reminders if any
  if(appt && appt.reminders && appt.reminders.length){
    try{ cancelApptReminders(appt); }catch(e){}
  }
  S('appointments',appts.filter(function(a){return a.id!==id;}));
  renderAppts();
}

// ═══════════════════════════════════════════════════
//  STAFF
// ═══════════════════════════════════════════════════
var roleBadge={'doctor':'badge-blue','doctor-manager':'badge-purple','manager':'badge-purple','reception':'badge-green','marketer':'badge-orange'};
function renderStaff(){
  var staff=G('staff',[]);
  var isMgr=CU&&(CU.role==='manager'||CU.role==='doctor-manager');
  document.getElementById('staffBody').innerHTML=staff.map(function(s){
    var roleHtml = '<span class="badge '+(roleBadge[s.role]||'badge-gray')+'">'+(ROLE_LABEL[s.role]||s.role)+'</span>';
    if (s.subRole) roleHtml += ' <span class="badge badge-gray" style="font-size:10px">+ '+s.subRole+'</span>';
    return '<tr><td><div class="fw-700">'+s.name+'</div></td><td>'+roleHtml+'</td><td><code style="font-size:12px;background:var(--gray1);padding:2px 7px;border-radius:5px">'+(s.username||'-')+'</code></td><td class="text-muted">'+(s.phone||'-')+'</td><td>'+(s.comm||0)+'%</td><td>'+(isMgr?'<button class="btn btn-ghost btn-xs" onclick="editStaff(\''+s.id+'\')">✏️</button> <button class="btn btn-danger btn-xs" onclick="delStaff(\''+s.id+'\')">🗑</button>':'')+'</td></tr>';
  }).join('');
  // Manager-only: show credentials button and clinic settings
  var credsBtn = document.getElementById('staffCredsBtn');
  if (credsBtn) credsBtn.style.display = isMgr ? 'inline-block' : 'none';
  if(isMgr){
    var cs=document.getElementById('clinicSettings'); if(cs)cs.style.display='block';
    var cl=G('clinic',{}); document.getElementById('clName').value=cl.name||''; document.getElementById('clPhone').value=cl.phone||''; document.getElementById('clAddress').value=cl.address||'';
    renderSubInfo();
    try { renderBackupStats(); } catch(e){}
  }
}

// Manager-only: toggle visibility of credentials panel
function toggleStaffCreds(){
  if (!CU || (CU.role !== 'manager' && CU.role !== 'doctor-manager')) return;
  var panel = document.getElementById('staffCredsPanel');
  if (!panel) return;
  if (panel.style.display === 'none' || !panel.style.display) {
    renderStaffCredsPanel();
    panel.style.display = 'block';
  } else {
    panel.style.display = 'none';
    panel.innerHTML = '';
  }
}

function renderStaffCredsPanel(){
  if (!CU || (CU.role !== 'manager' && CU.role !== 'doctor-manager')) return;
  var panel = document.getElementById('staffCredsPanel');
  if (!panel) return;
  var staff = G('staff', []) || [];
  var ROLE_LBL = {
    'doctor-manager':'مدير/طبيب','manager':'مدير','doctor':'طبيب',
    'reception':'استقبال','marketer':'مسوّق'
  };
  var existingUsernames = new Set(staff.map(function(s){return (s.username||'').toLowerCase();}));
  var missing = DEFAULT_STAFF.filter(function(d){return !existingUsernames.has((d.username||'').toLowerCase());});
  var rows = staff.filter(function(s){return s && s.username && s.role !== 'patient';}).map(function(s){
    var roleLbl = ROLE_LBL[s.role] || s.role;
    var pass = s.pass || s.password || '';
    return '<tr>'+
      '<td><div style="font-weight:700">'+s.name+'</div><div style="font-size:11px;color:#64748b">'+roleLbl+'</div></td>'+
      '<td><code style="background:#f1f5f9;padding:3px 8px;border-radius:4px;font-size:12px;direction:ltr">'+s.username+'</code></td>'+
      '<td><code style="background:#fef3c7;padding:3px 8px;border-radius:4px;font-size:12px;direction:ltr">'+pass+'</code></td>'+
      '<td><button class="btn btn-ghost btn-xs" onclick="editStaff(\''+s.id+'\')" title="تعديل البيانات">✏️</button></td>'+
    '</tr>';
  }).join('');
  panel.innerHTML = '<div class="card" style="border-right:4px solid #f59e0b">'+
    '<div class="card-header" style="background:#fef3c7;color:#92400e"><span class="card-title">🔑 بيانات الدخول للكادر</span></div>'+
    '<div class="card-body">'+
      '<div class="alert" style="background:#fef3c7;border:1px solid #fde68a;color:#92400e;font-size:12px;margin-bottom:10px">⚠️ هذه البيانات سرّية — لا تكشفها لغير الكادر المعني. لا تأخذ صور شاشة لها.</div>'+
      '<div class="tbl-wrap"><table>'+
        '<thead><tr><th>الاسم/الدور</th><th>اسم المستخدم</th><th>كلمة المرور</th><th>تعديل</th></tr></thead>'+
        '<tbody>'+rows+'</tbody>'+
      '</table></div>'+
      (missing.length ? '<div style="margin-top:12px;padding-top:12px;border-top:1px dashed #e2e8f0">'+
        '<div style="font-size:12px;color:#64748b;margin-bottom:6px">'+missing.length+' من الكادر الافتراضي غير مضاف: '+missing.map(function(d){return d.username;}).join('، ')+'</div>'+
        '<button class="btn btn-success btn-sm" onclick="restoreDefaultStaff()">➕ إضافة الكادر الافتراضي الناقص</button>'+
      '</div>' : '')+
    '</div>'+
  '</div>';
}
function renderSubInfo(){
  var el=document.getElementById('subInfoBody'); if(!el)return;
  var clinic=G('clinic',{});
  var sub=clinic.subscription;
  if(!sub){el.innerHTML='<div class="alert alert-info">ℹ️ عيادة افتراضية — لا توجد بيانات اشتراك</div>';return;}
  var now=new Date(),exp=new Date(sub.expiresAt);
  var daysLeft=Math.ceil((exp-now)/86400000);
  var isExp=daysLeft<0;
  var color=isExp?'var(--red)':daysLeft<7?'var(--orange)':'var(--green)';
  var stLabel={trial:'تجريبي',active:'نشط',expired:'منتهي'}[sub.status]||sub.status;
  el.innerHTML='<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">'+infoRow('نوع الاشتراك',stLabel)+infoRow('تاريخ الانتهاء',sub.expiresAt)+'<div><div class="text-muted">الأيام المتبقية</div><div class="fw-700 mt-4" style="color:'+color+'">'+(isExp?'منتهي':daysLeft+' يوم')+'</div></div><div><div class="text-muted">معرّف العيادة</div><div class="fw-700 mt-4" style="font-size:10px;direction:ltr">'+(localStorage.getItem('clinicId')||'-')+'</div></div></div>'+(isExp?'<div class="alert" style="background:var(--red-lt);color:var(--red)">⚠️ الاشتراك منتهٍ</div>':daysLeft<7?'<div class="alert alert-warning">⏰ ينتهي خلال '+daysLeft+' أيام</div>':'<div class="alert alert-success">✅ الاشتراك ساري</div>')+'<a href="https://wa.me/9647801234567?text=تجديد اشتراك: '+(clinic.name||'')+'" target="_blank" class="btn btn-ghost btn-sm mt-8">💬 طلب تجديد الاشتراك</a>';
}
function saveClinic(){
  var name=(document.getElementById('clName').value||'').trim(); if(!name){alert('اسم العيادة مطلوب');return;}
  var cl=G('clinic',{});
  S('clinic',Object.assign({},cl,{name:name,phone:document.getElementById('clPhone').value.trim(),address:document.getElementById('clAddress').value.trim()}));
  alert('✅ تم حفظ معلومات العيادة'); renderSubInfo();
}
function openAddStaff(){
  ['sName','sUsername','sPhone','sPass','sSubRole'].forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('sComm').value='30'; document.getElementById('sRole').value='doctor'; document.getElementById('sEditId').value='';
  document.getElementById('staffModalTitle').textContent='➕ كادر جديد'; openModal('mo-addStaff');
}
function editStaff(id){
  var s=G('staff',[]).find(function(x){return x.id===id;}); if(!s)return;
  document.getElementById('sName').value=s.name||''; document.getElementById('sUsername').value=s.username||'';
  document.getElementById('sPhone').value=s.phone||''; document.getElementById('sComm').value=s.comm||0;
  document.getElementById('sPass').value=s.pass||s.password||''; document.getElementById('sRole').value=s.role||'doctor';
  var sr=document.getElementById('sSubRole'); if(sr)sr.value=s.subRole||'';
  document.getElementById('sEditId').value=id; document.getElementById('staffModalTitle').textContent='✏️ تعديل بيانات الكادر'; openModal('mo-addStaff');
}
function genPass(){var c='abcdefghijklmnopqrstuvwxyz0123456789';var p='';for(var i=0;i<8;i++)p+=c[Math.floor(Math.random()*c.length)];document.getElementById('sPass').value=p;}
function saveStaff(){
  var name=(document.getElementById('sName').value||'').trim();
  var username=(document.getElementById('sUsername').value||'').trim().toLowerCase();
  var pass=(document.getElementById('sPass').value||'').trim();
  var editId=document.getElementById('sEditId').value;
  if(!name)return alert('الاسم مطلوب');if(!username)return alert('اسم المستخدم مطلوب');if(!pass)return alert('كلمة المرور مطلوبة');
  var staff=G('staff',[]);
  if(staff.find(function(s){return (s.username||'').toLowerCase()===username&&s.id!==editId;}))return alert('اسم المستخدم مستخدم بالفعل');
  var sr=document.getElementById('sSubRole');
  var data={name:name,username:username,role:document.getElementById('sRole').value,phone:document.getElementById('sPhone').value.trim(),comm:parseFloat(document.getElementById('sComm').value)||0,pass:pass,subRole:(sr?sr.value:'').trim()};
  if(editId){var idx=staff.findIndex(function(s){return s.id===editId;});if(idx>=0)staff[idx]=Object.assign({},staff[idx],data);}
  else staff.push(Object.assign({id:'s'+uid()},data));
  S('staff',staff); closeModal('mo-addStaff'); renderStaff();
}
function delStaff(id){
  var s=G('staff',[]).find(function(x){return x.id===id;}); if(!s)return;
  if(s.id===CU.id)return alert('لا يمكنك حذف حسابك الخاص');
  if(!confirm('حذف "'+s.name+'" من الكادر؟'))return;
  S('staff',G('staff',[]).filter(function(x){return x.id!==id;})); renderStaff();
}

// One-time migration: apply official Soran clinic staff (preserves all patient/plan/payment refs)
function applyOfficialStaff(){
  if (!(CU && (CU.role==='manager' || CU.role==='doctor-manager'))) { alert('للمدير فقط'); return; }
  if (!confirm('سيتم تحديث أسماء الكادر إلى الأسماء الرسمية لعيادة سوران.\n\n✅ سيتم الاحتفاظ بجميع:\n• بيانات المرضى\n• خطط العلاج والجلسات\n• المدفوعات والعمولات\n• المواعيد\n\nهل تريد المتابعة؟')) return;
  var officialStaff = [
    {id:'s1',name:'د. أحمد عبيد المحمدي',          role:'doctor-manager',username:'ahmed',   phone:'',comm:30,pass:'manager123', subRole:''},
    {id:'s2',name:'د. مصطفى رياض العزاوي',         role:'doctor',        username:'mustafa', phone:'',comm:30,pass:'mustafa2026', subRole:''},
    {id:'s3',name:'د. محمد رياض الجبوري',          role:'doctor',        username:'muhammad',phone:'',comm:30,pass:'muhammad2026', subRole:''},
    {id:'s4',name:'د. بان ضاري الغريري',           role:'doctor',        username:'ban',     phone:'',comm:30,pass:'ban2026', subRole:''},
    {id:'s5',name:'إيلاف',                          role:'reception',     username:'ilaf',    phone:'',comm:0, pass:'ilaf2026', subRole:'تعقيم'},
    {id:'s6',name:'علي',                            role:'marketer',      username:'ali',     phone:'',comm:5, pass:'ali2026', subRole:''},
  ];
  var current = G('staff', []);
  var byId = {}; current.forEach(function(s){ byId[s.id] = s; });
  // Replace by ID — preserves all patient/plan/payment references intact
  var merged = officialStaff.map(function(off){
    var ex = byId[off.id];
    // Keep phone if already set (real number entered)
    return Object.assign({}, off, ex && ex.phone ? {phone: ex.phone} : {});
  });
  // Preserve any custom-added staff (id NOT in s1..s6) — except old demo s7 which we drop
  current.forEach(function(s){
    if (!s.id) return;
    if (s.id === 's7') return; // drop old demo "محمد المسوّق"
    if (!officialStaff.find(function(o){return o.id===s.id;})) {
      merged.push(s); // keep custom additions
    }
  });
  S('staff', merged);
  alert('✅ تم تطبيق كادر سوران الرسمي بنجاح.\n\n📋 بيانات الدخول:\n━━━━━━━━━━━━━━━━━\n👨‍⚕️ د. أحمد عبيد المحمدي\n   ahmed / manager123\n\n👨‍⚕️ د. مصطفى رياض العزاوي\n   mustafa / mustafa2026\n\n👨‍⚕️ د. محمد رياض الجبوري\n   muhammad / muhammad2026\n\n👩‍⚕️ د. بان ضاري الغريري\n   ban / ban2026\n\n🖥️ إيلاف (استقبال + تعقيم)\n   ilaf / ilaf2026\n\n📢 علي (مسوّق)\n   ali / ali2026\n━━━━━━━━━━━━━━━━━\n\n⚠️ غيّر كلمات المرور بعد أول دخول لكل شخص.');
  renderStaff();
}

// ═══════════════════════════════════════════════════
//  COMMISSIONS
// ═══════════════════════════════════════════════════
function renderComm(){
  var pays=G('payments',[]),staff=G('staff',[]);
  var smap=sm(),pmap=pm();
  var cSel=document.getElementById('commFStaff'),mSel=document.getElementById('commFMonth');
  var savedC=cSel.value,savedM=mSel.value;
  cSel.innerHTML='<option value="">كل الكادر</option>'+staff.map(function(s){return '<option value="'+s.id+'">'+s.name+'</option>';}).join('');
  var months=[...new Set(pays.map(function(p){return p.date&&p.date.substring(0,7);}).filter(Boolean))].sort().reverse();
  mSel.innerHTML='<option value="">كل الأشهر</option>'+months.map(function(m){return '<option value="'+m+'">'+m+'</option>';}).join('');
  if(savedC)cSel.value=savedC;if(savedM)mSel.value=savedM;
  var filtered=pays;
  if(CU&&CU.role==='doctor')filtered=filtered.filter(function(p){return p.doctorId===CU.id;});
  if(cSel.value)filtered=filtered.filter(function(p){return p.doctorId===cSel.value;});
  if(mSel.value)filtered=filtered.filter(function(p){return p.date&&p.date.startsWith(mSel.value);});
  var totalRev=filtered.reduce(function(s,p){return s+(p.amount||0);},0);
  var totalComm=filtered.reduce(function(s,p){var st=smap[p.doctorId];return s+(p.amount||0)*((st&&st.comm||0)/100);},0);
  document.getElementById('commStats').innerHTML=
    '<div class="stat-box"><span class="s-icon">💵</span><div class="s-label">الإيرادات</div><div class="s-val">'+totalRev.toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">💰</span><div class="s-label">العمولات</div><div class="s-val">'+Math.round(totalComm).toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">🏥</span><div class="s-label">صافي العيادة</div><div class="s-val">'+Math.round(totalRev-totalComm).toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📋</span><div class="s-label">المعاملات</div><div class="s-val">'+filtered.length+'</div></div>';
  var tbody=document.getElementById('commBody');
  if(!filtered.length){tbody.innerHTML='<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--gray4)">لا توجد سجلات</td></tr>';return;}
  tbody.innerHTML=filtered.slice().sort(function(a,b){return b.date>a.date?1:-1;}).map(function(p){
    var st=smap[p.doctorId],pt=pmap[p.patientId];
    var cr=st&&st.comm||0,ca=Math.round((p.amount||0)*cr/100);
    return '<tr><td class="fw-700">'+(st?st.name:'-')+'</td><td>'+(pt?pt.name:'-')+'</td><td>'+p.date+'</td><td>'+(p.service||'-')+'</td><td>'+(p.amount||0).toLocaleString()+' د.ع</td><td>'+cr+'%</td><td style="color:var(--green);font-weight:700">'+ca.toLocaleString()+' د.ع</td><td><button class="btn btn-danger btn-xs" onclick="delPay(\''+p.id+'\')">🗑</button></td></tr>';
  }).join('');
}
function delPay(id){if(!confirm('حذف هذه الدفعة؟'))return;S('payments',G('payments',[]).filter(function(p){return p.id!==id;}));renderComm();}

// ─── Commissions tab switcher ───
var _commTab = 'docs';
function commSetTab(t){
  _commTab = t;
  document.querySelectorAll('#commTabsBox button').forEach(function(b){
    b.className = b.getAttribute('data-tab')===t ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';
  });
  document.getElementById('commDocsBox').style.display = t==='docs' ? '' : 'none';
  document.getElementById('commMktBox') .style.display = t==='marketers' ? '' : 'none';
  if (t==='marketers') renderMktComm();
  else renderComm();
}

// ─── Marketer commissions: range helper ───
function mkcInRange(d, range){
  if (!d) return false;
  if (range==='all') return true;
  var t = today();
  if (range==='today') return d === t;
  if (range==='month') return d.substring(0,7) === t.substring(0,7);
  if (range==='week'){
    var dd=new Date(d+'T00:00:00').getTime(), now=new Date(t+'T00:00:00').getTime();
    return Math.abs(dd-now) <= 7*86400000;
  }
  return true;
}

function renderMktComm(){
  var entries = G('marketerCommissions',[]);
  var staff   = G('staff',[]);
  var smap    = sm(), pmap = pm();
  var marketers = staff.filter(function(s){return s.role==='marketer';});

  // Populate marketer dropdown
  var mSel = document.getElementById('mkcFMarketer');
  if (mSel){
    var saved = mSel.value;
    mSel.innerHTML = '<option value="">كل المسوّقين</option>'+
      marketers.map(function(m){return '<option value="'+m.id+'"'+(saved===m.id?' selected':'')+'>'+m.name+'</option>';}).join('');
  }

  // Apply role-based filtering: a marketer only sees their own commissions
  if (CU && CU.role==='marketer'){
    entries = entries.filter(function(e){return e.marketerId === CU.id;});
  }

  var fM = document.getElementById('mkcFMarketer').value;
  var fR = document.getElementById('mkcFRange').value || 'month';
  var fT = document.getElementById('mkcFType').value;
  var filtered = entries.filter(function(e){
    if (fM && e.marketerId !== fM) return false;
    if (fT && e.caseType !== fT) return false;
    if (!mkcInRange(e.date, fR)) return false;
    return true;
  });

  // Stats
  var total = filtered.reduce(function(s,e){return s+(e.amount||0);},0);
  var byType = {implant:0, ortho:0, smile:0, filling:0, extraction:0};
  filtered.forEach(function(e){ if(byType[e.caseType]!==undefined) byType[e.caseType]+=(e.amount||0); });
  var statsEl = document.getElementById('mkcStats');
  if (statsEl){
    statsEl.innerHTML =
      '<div class="stat-box"><span class="s-icon">💰</span><div class="s-label">إجمالي الحوافز</div><div class="s-val" style="color:#16a34a">'+total.toLocaleString()+' د.ع</div></div>'+
      '<div class="stat-box"><span class="s-icon">📋</span><div class="s-label">عدد الحالات</div><div class="s-val">'+filtered.length+'</div></div>'+
      '<div class="stat-box"><span class="s-icon">🦷</span><div class="s-label">زراعة + تقويم + ابتسامة</div><div class="s-val">'+(byType.implant+byType.ortho+byType.smile).toLocaleString()+'</div></div>'+
      '<div class="stat-box"><span class="s-icon">🪥</span><div class="s-label">حشوات + قلع</div><div class="s-val">'+(byType.filling+byType.extraction).toLocaleString()+'</div></div>';
  }

  // Per-marketer cumulative summary cards
  var byMkt = {};
  filtered.forEach(function(e){
    if (!byMkt[e.marketerId]) byMkt[e.marketerId] = {total:0, count:0, byType:{}};
    byMkt[e.marketerId].total += (e.amount||0);
    byMkt[e.marketerId].count += 1;
    byMkt[e.marketerId].byType[e.caseType] = (byMkt[e.marketerId].byType[e.caseType]||0)+1;
  });
  var summEl = document.getElementById('mkcByMarketer');
  if (summEl){
    var cards = Object.keys(byMkt).map(function(mid){
      var m = smap[mid]; var d = byMkt[mid];
      var typeBreakdown = Object.keys(d.byType).map(function(k){return (MKT_TYPE_LABEL[k]||k)+': '+d.byType[k];}).join(' • ');
      return '<div style="background:#fff;border:1.5px solid #e2e8f0;border-right:4px solid #fb923c;border-radius:10px;padding:12px">'+
        '<div style="font-weight:800;font-size:14px;color:#0d5c7a;margin-bottom:4px">📢 '+(m?m.name:'؟')+'</div>'+
        '<div style="font-size:22px;font-weight:900;color:#16a34a">'+d.total.toLocaleString()+' <span style="font-size:13px;color:var(--gray5)">د.ع</span></div>'+
        '<div style="font-size:11px;color:var(--gray5);margin-top:4px">'+d.count+' حالة • '+typeBreakdown+'</div>'+
      '</div>';
    });
    summEl.innerHTML = cards.length
      ? '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px">'+cards.join('')+'</div>'
      : '';
  }

  // Detail rows
  var tbody = document.getElementById('mkcBody');
  if (!filtered.length){
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--gray4)">لا توجد حوافز ضمن الفلتر المختار</td></tr>';
    return;
  }
  filtered.sort(function(a,b){return (b.createdAt||b.date)>(a.createdAt||a.date)?1:-1;});
  var isMgr = CU && (CU.role==='manager'||CU.role==='doctor-manager');
  tbody.innerHTML = filtered.map(function(e){
    var m=smap[e.marketerId], p=pmap[e.patientId];
    var typeBadge='<span class="badge '+(e.amount>=25000?'badge-purple':e.amount>=5000?'badge-blue':'badge-orange')+'">'+(e.caseTypeLabel||e.caseType)+'</span>';
    return '<tr><td>'+e.date+'</td><td class="fw-700">'+(m?m.name:'؟')+'</td><td>'+(p?p.name:'؟')+'</td><td>'+typeBadge+'</td><td class="fw-700" style="color:#16a34a">'+(e.amount||0).toLocaleString()+' د.ع</td><td class="text-muted" style="font-size:12px">'+(e.note||'-')+'</td><td>'+(isMgr?'<button class="btn btn-danger btn-xs" onclick="delMktComm(\''+e.id+'\')">🗑</button>':'')+'</td></tr>';
  }).join('');
}

function delMktComm(id){
  if (!confirm('حذف هذا الحافز؟ سيُخصم من الإجمالي التراكمي للمسوّق.')) return;
  S('marketerCommissions', G('marketerCommissions',[]).filter(function(e){return e.id!==id;}));
  renderMktComm();
}

// ═══════════════════════════════════════════════════
//  FINANCE
// ═══════════════════════════════════════════════════
function renderFinance(){
  var pays=G('payments',[]);
  var smap=sm(),pmap=pm(),todayStr=today();
  var totalRev=pays.reduce(function(s,p){return s+(p.amount||0);},0);
  var totalComm=pays.reduce(function(s,p){var st=smap[p.doctorId];return s+(p.amount||0)*((st&&st.comm||0)/100);},0);
  var todayRev=pays.filter(function(p){return p.date===todayStr;}).reduce(function(s,p){return s+(p.amount||0);},0);
  document.getElementById('finStats').innerHTML=
    '<div class="stat-box"><span class="s-icon">💰</span><div class="s-label">إجمالي الإيرادات</div><div class="s-val">'+totalRev.toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📅</span><div class="s-label">إيرادات اليوم</div><div class="s-val">'+todayRev.toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">👥</span><div class="s-label">العمولات الكلية</div><div class="s-val">'+Math.round(totalComm).toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">🏥</span><div class="s-label">صافي العيادة</div><div class="s-val">'+Math.round(totalRev-totalComm).toLocaleString()+'</div></div>';
  var recent=pays.slice().sort(function(a,b){return b.date>a.date?1:-1;}).slice(0,8);
  document.getElementById('finRecent').innerHTML=recent.length?recent.map(function(p){var pt=pmap[p.patientId];return '<div class="flex-between" style="padding:8px 0;border-bottom:1px solid var(--gray2)"><div><div class="fw-600 text-sm">'+(pt?pt.name:'-')+'</div><div class="text-muted">'+p.date+' • '+(p.service||'-')+'</div></div><div class="fw-700" style="color:var(--green)">'+(p.amount||0).toLocaleString()+' د.ع</div></div>';}).join(''):emptyState('💳','لا توجد مدفوعات');
  var byDoc={};pays.forEach(function(p){if(!byDoc[p.doctorId])byDoc[p.doctorId]=0;byDoc[p.doctorId]+=p.amount||0;});
  var entries=Object.entries(byDoc).sort(function(a,b){return b[1]-a[1];});
  var maxV=entries[0]&&entries[0][1]||1;
  document.getElementById('finByDoc').innerHTML=entries.length?entries.map(function(e){var doc=smap[e[0]];return '<div style="margin-bottom:12px"><div class="flex-between" style="margin-bottom:4px"><span class="text-sm fw-600">'+(doc?doc.name:'-')+'</span><span class="text-sm">'+e[1].toLocaleString()+' د.ع</span></div><div class="progress-track"><div class="progress-fill" style="width:'+Math.round(e[1]/maxV*100)+'%;background:var(--blue2)"></div></div></div>';}).join(''):emptyState('📊','لا توجد بيانات');
}

// ═══════════════════════════════════════════════════
//  DEBTORS
// ═══════════════════════════════════════════════════
function renderDebtors(){
  var plans=G('plans',[]).filter(function(p){return p.status==='completed'&&(p.debtAmount||0)>0;});
  var pmap=pm();
  var total=plans.reduce(function(s,p){return s+(p.debtAmount||0);},0);
  document.getElementById('debtStats').innerHTML=
    '<div class="stat-box"><span class="s-icon">⚠️</span><div class="s-label">عدد الديون</div><div class="s-val" style="color:var(--red)">'+plans.length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">💸</span><div class="s-label">إجمالي الديون</div><div class="s-val" style="color:var(--red)">'+total.toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">👥</span><div class="s-label">عدد المرضى</div><div class="s-val">'+[...new Set(plans.map(function(p){return p.patientId;}))].length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📅</span><div class="s-label">متوسط الدين</div><div class="s-val">'+(plans.length?Math.round(total/plans.length).toLocaleString():0)+'</div></div>';
  var tbody=document.getElementById('debtBody');
  if(!plans.length){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--gray4)"><div style="font-size:36px;margin-bottom:8px">✅</div>لا توجد ديون مستحقة</td></tr>';return;}
  tbody.innerHTML=plans.slice().sort(function(a,b){return (b.debtAmount||0)-(a.debtAmount||0);}).map(function(pl){
    var pt=pmap[pl.patientId];
    return '<tr><td><div class="fw-700">'+(pt?'<span style="cursor:pointer;color:var(--blue2)" onclick="openProfile(\''+pl.patientId+'\')">'+pt.name+'</span>':'-')+'</div><div class="text-muted">'+(pt?pt.phone:'')+'</div></td><td class="text-sm">'+pl.description+'</td><td class="text-muted">'+(pl.totalCost||0).toLocaleString()+' د.ع</td><td style="color:var(--green);font-weight:600">'+(pl.paidAmount||0).toLocaleString()+' د.ع</td><td><span class="fw-700" style="color:var(--red)">'+(pl.debtAmount||0).toLocaleString()+' د.ع</span></td><td class="text-muted">'+(pl.completedAt||'-')+'</td><td><button class="btn btn-success btn-xs" onclick="openSettleDebt(\''+pl.id+'\')">💳 تسوية</button></td></tr>';
  }).join('');
}

// ═══════════════════════════════════════════════════
//  RECALL SYSTEM (periodic patient reminders)
// ═══════════════════════════════════════════════════

// Compute recall data for all patients
function computeRecallData(){
  var patients = G('patients', []);
  var appts = G('appointments', []);
  var smap = sm();
  var todayMs = Date.now();

  // Last completed visit per patient
  var lastVisitMap = {};
  // Latest doctor seen per patient
  var lastDocMap = {};
  // Whether patient has any upcoming scheduled/arrived appointment
  var hasUpcomingMap = {};
  // Closest upcoming appointment date
  var nextApptMap = {};

  appts.forEach(function(a){
    if (!a || !a.patientId) return;
    if (a.status === 'completed') {
      var d = a.date || '';
      if (!lastVisitMap[a.patientId] || d > lastVisitMap[a.patientId]) {
        lastVisitMap[a.patientId] = d;
        lastDocMap[a.patientId] = a.doctorId;
      }
    } else if (a.status === 'scheduled' || a.status === 'arrived') {
      // Check if it's in future
      var aMs = new Date((a.date||'')+'T'+(a.time||'09:00')+':00+03:00').getTime();
      if (!isNaN(aMs) && aMs >= todayMs) {
        hasUpcomingMap[a.patientId] = true;
        if (!nextApptMap[a.patientId] || aMs < nextApptMap[a.patientId]) {
          nextApptMap[a.patientId] = aMs;
        }
      }
    }
  });

  return patients.map(function(p){
    var lastVisit = lastVisitMap[p.id] || null;
    var daysSince = lastVisit ? Math.floor((todayMs - new Date(lastVisit+'T12:00:00+03:00').getTime())/(1000*60*60*24)) : null;
    return {
      patient: p,
      lastVisit: lastVisit,
      daysSince: daysSince,
      lastDoctorId: lastDocMap[p.id] || null,
      hasUpcoming: !!hasUpcomingMap[p.id],
      nextApptMs: nextApptMap[p.id] || null
    };
  });
}

// Filter helper — used by both UI and dashboard count
function getRecallDue(months){
  var threshold = (months||6) * 30; // approximate days
  var data = computeRecallData();
  return data.filter(function(r){
    if (!r.lastVisit) return false; // never visited - separate category
    if (r.hasUpcoming) return false; // already has upcoming
    return (r.daysSince||0) >= threshold;
  });
}

function renderRecall(){
  if (!CU) return;
  // Allow only clinic-side roles
  if (!['doctor-manager','manager','reception','marketer'].includes(CU.role)) return;
  var monthsEl = document.getElementById('recallMonths');
  var months = monthsEl ? parseInt(monthsEl.value)||6 : 6;
  var threshold = months * 30;
  var filterEl = document.getElementById('recallFilter');
  var filter = filterEl ? filterEl.value : 'due';
  var data = computeRecallData();
  var smap = sm();

  // Stats
  var dueCount = 0, neverCount = 0, upcomingCount = 0, totalActive = 0;
  data.forEach(function(r){
    if (!r.patient) return;
    totalActive++;
    if (!r.lastVisit) { neverCount++; return; }
    if (r.hasUpcoming) return;
    if (r.daysSince >= threshold) dueCount++;
    else if (r.daysSince >= threshold - 30) upcomingCount++;
  });
  document.getElementById('recallStats').innerHTML=
    '<div class="stat-box"><span class="s-icon">🔔</span><div class="s-label">مستحقّ Recall</div><div class="s-val" style="color:#dc2626">'+dueCount+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">⏳</span><div class="s-label">قارب موعدهم</div><div class="s-val" style="color:#ea580c">'+upcomingCount+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">❓</span><div class="s-label">لم يأتوا أبداً</div><div class="s-val" style="color:#6b7280">'+neverCount+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">👥</span><div class="s-label">إجمالي المرضى</div><div class="s-val">'+totalActive+'</div></div>';

  // Apply filter
  var rows;
  if (filter === 'due') {
    rows = data.filter(function(r){return r.lastVisit && !r.hasUpcoming && (r.daysSince||0)>=threshold;});
  } else if (filter === 'upcoming') {
    rows = data.filter(function(r){return r.lastVisit && !r.hasUpcoming && (r.daysSince||0)>=threshold-30 && (r.daysSince||0)<threshold;});
  } else if (filter === 'never') {
    rows = data.filter(function(r){return !r.lastVisit;});
  } else {
    rows = data.slice();
  }

  // Sort: most overdue first
  rows.sort(function(a,b){
    var da = a.daysSince || 0, db = b.daysSince || 0;
    return db - da;
  });

  var tbody = document.getElementById('recallBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--gray4)"><div style="font-size:36px;margin-bottom:8px">✅</div>'+
      (filter==='due'?'لا يوجد مرضى مستحقّون للـ Recall حالياً':filter==='never'?'جميع المرضى زاروا العيادة على الأقل مرّة':filter==='upcoming'?'لا يوجد مرضى يقتربون من موعد Recall':'لا توجد سجلات')+
      '</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function(r){
    var p = r.patient;
    var doc = smap[r.lastDoctorId];
    var visitStr = r.lastVisit ? r.lastVisit : '<span style="color:#94a3b8">لم يزر بعد</span>';
    var sinceStr;
    if (r.daysSince === null) sinceStr = '<span class="badge badge-gray">جديد</span>';
    else if (r.daysSince >= threshold) sinceStr = '<span class="badge" style="background:#fee2e2;color:#991b1b">'+r.daysSince+' يوم</span>';
    else if (r.daysSince >= threshold-30) sinceStr = '<span class="badge" style="background:#ffedd5;color:#9a3412">'+r.daysSince+' يوم</span>';
    else sinceStr = '<span class="badge" style="background:#f0fdf4;color:#166534">'+r.daysSince+' يوم</span>';
    var phone = p.phone ? normalizePhoneIQ(p.phone) : '';
    var waBtn = phone ? '<button class="btn btn-success btn-xs" onclick="recallSendWA(\''+p.id+'\')" title="رسالة واتساب">💬</button>' : '';
    var pushBtn = '<button class="btn btn-xs" style="background:#0d5c7a;color:#fff;border:none" onclick="recallSendPush(\''+p.id+'\')" title="إشعار في التطبيق">🔔</button>';
    var bookBtn = '<button class="btn btn-primary btn-xs" onclick="recallQuickBook(\''+p.id+'\')" title="حجز موعد">📅</button>';
    return '<tr>'+
      '<td><div class="fw-700"><span style="cursor:pointer;color:var(--blue2)" onclick="openProfile(\''+p.id+'\')">'+p.name+'</span></div><div class="text-muted">'+(p.phone||'-')+'</div></td>'+
      '<td>'+visitStr+'</td>'+
      '<td>'+sinceStr+'</td>'+
      '<td class="text-muted">'+(doc?doc.name:'-')+'</td>'+
      '<td><div style="display:flex;gap:4px;flex-wrap:wrap">'+waBtn+pushBtn+bookBtn+'</div></td>'+
    '</tr>';
  }).join('');
}

// Build the recall WhatsApp message text (customizable later)
function recallBuildMsg(patient){
  var clinic = G('clinic', {});
  var clinicName = clinic.name || 'عيادة سوران';
  return 'السلام عليكم '+patient.name+'،\n\n'+
    'نتمنى لك دوام الصحة والعافية. مضى وقت منذ آخر زيارة لك في '+clinicName+'، ونودّ تذكيرك بأهمية الفحص الدوري وتنظيف الأسنان كل ‎6 أشهر للحفاظ على صحة فمك.\n\n'+
    'يسعدنا حجز موعد لك في الوقت المناسب.\n\n'+
    'شكراً لثقتك.';
}

// Send recall via WhatsApp for a single patient
function recallSendWA(pid){
  var p = G('patients',[]).find(function(x){return x.id===pid;});
  if (!p || !p.phone) { alert('رقم الهاتف غير متوفّر'); return; }
  var phone = normalizePhoneIQ(p.phone);
  var msg = encodeURIComponent(recallBuildMsg(p));
  window.open('https://wa.me/964'+phone+'?text='+msg, '_blank');
}

// Send recall as push notification
async function recallSendPush(pid){
  var p = G('patients',[]).find(function(x){return x.id===pid;});
  if (!p) return;
  try {
    await pushNotifyPatient(p.id, '🔔 تذكير من عيادة سوران', 'مضى وقت على آخر زيارة. ننصحك بحجز موعد للفحص الدوري وتنظيف الأسنان.', {type:'recall'});
    alert('✅ تم إرسال الإشعار للمريض (إن كان مفعّلاً Push على هاتفه)');
  } catch(e) {
    alert('❌ فشل إرسال الإشعار');
  }
}

// Quick-book modal launcher for recall list (uses existing addAppt modal)
function recallQuickBook(pid){
  CPid = pid;
  prepAppt();
  document.getElementById('apptPat').value = pid;
  openModal('mo-addAppt');
}

// Bulk send WhatsApp to all currently-displayed recall patients
function recallSendBulkWA(){
  var rows = document.querySelectorAll('#recallBody tr');
  // Re-derive list from current filter state (more reliable than parsing DOM)
  var monthsEl = document.getElementById('recallMonths');
  var months = monthsEl ? parseInt(monthsEl.value)||6 : 6;
  var threshold = months * 30;
  var filterEl = document.getElementById('recallFilter');
  var filter = filterEl ? filterEl.value : 'due';
  var data = computeRecallData();
  var list;
  if (filter === 'due') {
    list = data.filter(function(r){return r.lastVisit && !r.hasUpcoming && (r.daysSince||0)>=threshold;});
  } else if (filter === 'upcoming') {
    list = data.filter(function(r){return r.lastVisit && !r.hasUpcoming && (r.daysSince||0)>=threshold-30 && (r.daysSince||0)<threshold;});
  } else if (filter === 'never') {
    list = data.filter(function(r){return !r.lastVisit;});
  } else {
    list = data.slice();
  }
  list = list.filter(function(r){return r.patient && r.patient.phone;});
  if (!list.length) { alert('لا يوجد مرضى لإرسال الرسائل'); return; }
  if (!confirm('سيتم فتح '+list.length+' نافذة واتساب (واحدة لكل مريض). تأكّد أن المتصفح لا يحجب النوافذ المنبثقة. متابعة؟')) return;
  // Stagger to avoid browser popup blocking
  list.forEach(function(r, i){
    setTimeout(function(){
      var phone = normalizePhoneIQ(r.patient.phone);
      var msg = encodeURIComponent(recallBuildMsg(r.patient));
      window.open('https://wa.me/964'+phone+'?text='+msg, '_blank');
    }, i*900);
  });
}


// ═══════════════════════════════════════════════════
//  CLINIC DEBTS (مستحقّات على العيادة)
// ═══════════════════════════════════════════════════

function renderClinicDebts(){
  var debts = G('clinicDebts', []);
  var filterEl = document.getElementById('cdFilter');
  var catEl = document.getElementById('cdCatFilter');
  var filter = filterEl ? filterEl.value : 'open';
  var cat = catEl ? catEl.value : '';
  var todayStr = today();

  function paidOf(d){ return (d.payments||[]).reduce(function(s,p){return s+(p.amount||0);},0); }
  function remOf(d){ return Math.max(0, (d.amount||0) - paidOf(d)); }
  function isOverdue(d){ return d.dueDate && d.dueDate < todayStr && remOf(d) > 0; }

  var totalDebt = debts.reduce(function(s,d){return s + remOf(d);},0);
  var totalPaid = debts.reduce(function(s,d){return s + paidOf(d);},0);
  var overdueCount = debts.filter(isOverdue).length;
  var openCount = debts.filter(function(d){return remOf(d) > 0;}).length;
  document.getElementById('cdStats').innerHTML =
    '<div class="stat-box"><span class="s-icon">💼</span><div class="s-label">دين متبقّي</div><div class="s-val" style="color:#dc2626">'+totalDebt.toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">✅</span><div class="s-label">المدفوع</div><div class="s-val" style="color:#16a34a">'+totalPaid.toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">⏰</span><div class="s-label">متأخّرة</div><div class="s-val" style="color:#ea580c">'+overdueCount+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📋</span><div class="s-label">ديون مفتوحة</div><div class="s-val">'+openCount+'</div></div>';

  var rows = debts.slice();
  if (filter === 'open')         rows = rows.filter(function(d){return remOf(d) > 0;});
  else if (filter === 'paid')    rows = rows.filter(function(d){return remOf(d) === 0;});
  else if (filter === 'overdue') rows = rows.filter(isOverdue);
  if (cat) rows = rows.filter(function(d){return d.category === cat;});

  rows.sort(function(a,b){
    var ao = isOverdue(a), bo = isOverdue(b);
    if (ao !== bo) return ao ? -1 : 1;
    return (a.dueDate||'9999').localeCompare(b.dueDate||'9999');
  });

  var listEl = document.getElementById('cdList');
  if (!rows.length) {
    listEl.innerHTML = emptyState('💼','لا توجد ديون '+(filter==='open'?'متبقّية':filter==='paid'?'مسدّدة':filter==='overdue'?'متأخّرة':''));
    return;
  }
  var CAT_ICON = {'مختبر':'🔬','مواد':'🧪','إيجار':'🏢','كهرباء/ماء':'⚡','صيانة':'🔧','قرض':'💳','راتب':'💵','أخرى':'📌'};
  listEl.innerHTML = rows.map(function(d){
    var paid = paidOf(d), rem = remOf(d), pct = d.amount ? Math.round(paid/d.amount*100) : 0;
    var statusBadge = rem === 0 ? '<span class="badge badge-green">✓ مسدّد</span>' :
                      isOverdue(d) ? '<span class="badge badge-red">⏰ متأخّر</span>' :
                      '<span class="badge badge-orange">متبقّي</span>';
    var icon = CAT_ICON[d.category] || '📌';
    var dueInfo = d.dueDate ? ('استحقاق: ' + d.dueDate + (isOverdue(d) ? ' (متأخّر '+Math.ceil((new Date(todayStr) - new Date(d.dueDate))/86400000)+' يوم)' : '')) : '';
    return '<div class="card" style="margin-bottom:10px;'+(isOverdue(d)?'border-right:4px solid #dc2626;':'')+'"><div class="card-body">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;gap:10px">'+
        '<div style="display:flex;gap:10px;align-items:flex-start;flex:1">'+
          '<div style="font-size:28px">'+icon+'</div>'+
          '<div style="flex:1">'+
            '<div style="font-weight:800;font-size:14px;color:var(--gray6)">'+(d.creditor||'-')+'</div>'+
            '<div style="font-size:11px;color:var(--gray5);margin-top:2px">'+(d.category||'')+(d.phone?' • 📞 '+d.phone:'')+'</div>'+
            (dueInfo?'<div style="font-size:11px;color:'+(isOverdue(d)?'#dc2626':'var(--gray5)')+';margin-top:2px;font-weight:'+(isOverdue(d)?'700':'400')+'">'+dueInfo+'</div>':'')+
            (d.notes?'<div style="font-size:11px;color:var(--gray5);margin-top:4px;font-style:italic">"'+d.notes+'"</div>':'')+
          '</div>'+
        '</div>'+
        '<div style="text-align:left">'+statusBadge+'</div>'+
      '</div>'+
      '<div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:8px">'+
        '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;flex-wrap:wrap;gap:6px">'+
          '<span>الكلّي: <strong>'+(d.amount||0).toLocaleString()+'</strong></span>'+
          '<span style="color:#16a34a">المدفوع: <strong>'+paid.toLocaleString()+'</strong></span>'+
          '<span style="color:#dc2626">المتبقّي: <strong>'+rem.toLocaleString()+'</strong></span>'+
        '</div>'+
        '<div style="background:#e2e8f0;height:6px;border-radius:3px;overflow:hidden">'+
          '<div style="background:linear-gradient(90deg,#16a34a,#22c55e);height:100%;width:'+pct+'%;transition:width .3s"></div>'+
        '</div>'+
      '</div>'+
      '<div style="display:flex;gap:6px;flex-wrap:wrap">'+
        (rem>0?'<button class="btn btn-success btn-xs" onclick="openPayClinicDebt(\''+d.id+'\')">💰 تسديد دفعة</button>':'')+
        (rem>0&&d.phone?'<button class="btn btn-ghost btn-xs" onclick="cdSendReminderWA(\''+d.id+'\')">💬 تذكير عبر واتساب</button>':'')+
        ((d.payments||[]).length?'<button class="btn btn-ghost btn-xs" onclick="cdToggleHistory(\''+d.id+'\')">📋 تاريخ ('+(d.payments||[]).length+')</button>':'')+
        '<button class="btn btn-ghost btn-xs" onclick="cdEdit(\''+d.id+'\')">✏️ تعديل</button>'+
        '<button class="btn btn-danger btn-xs" onclick="cdDelete(\''+d.id+'\')">🗑️</button>'+
      '</div>'+
      '<div id="cd-history-'+d.id+'" style="display:none;margin-top:10px;padding-top:10px;border-top:1px dashed #e2e8f0">'+
        ((d.payments||[]).length ? (d.payments||[]).slice().reverse().map(function(p){
          return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:12px">'+
            '<span>📅 '+(p.date||'-')+' • '+(p.method||'نقد')+(p.notes?' • '+p.notes:'')+'</span>'+
            '<span style="font-weight:700;color:#16a34a">'+(p.amount||0).toLocaleString()+'</span>'+
          '</div>';
        }).join('') : '<div style="color:#94a3b8;font-size:12px">لا توجد دفعات بعد</div>')+
      '</div>'+
    '</div></div>';
  }).join('');
}

function cdToggleHistory(id){
  var el = document.getElementById('cd-history-'+id);
  if (el) el.style.display = (el.style.display === 'none' || !el.style.display) ? 'block' : 'none';
}

function saveClinicDebt(){
  var creditor = (document.getElementById('cdCreditor').value||'').trim();
  var amount   = parseFloat(document.getElementById('cdAmount').value)||0;
  if (!creditor) { alert('اسم الجهة الدائنة مطلوب'); return; }
  if (amount <= 0) { alert('المبلغ يجب أن يكون أكبر من صفر'); return; }
  var debts = G('clinicDebts', []);
  var modalEl = document.getElementById('mo-addClinicDebt');
  var editingId = modalEl.dataset.editingId;
  var debt = {
    id: editingId || 'cd_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,5),
    creditor: creditor,
    category: document.getElementById('cdCategory').value || 'أخرى',
    amount: amount,
    phone: (document.getElementById('cdPhone').value||'').trim(),
    dueDate: document.getElementById('cdDueDate').value || '',
    createdAt: document.getElementById('cdCreatedAt').value || today(),
    notes: (document.getElementById('cdNotes').value||'').trim(),
    payments: []
  };
  if (editingId) {
    var idx = debts.findIndex(function(x){return x.id===editingId;});
    if (idx >= 0) {
      debt.payments = debts[idx].payments || [];
      debts[idx] = debt;
    }
  } else {
    debts.push(debt);
  }
  S('clinicDebts', debts);
  modalEl.dataset.editingId = '';
  closeModal('mo-addClinicDebt');
  ['cdCreditor','cdAmount','cdPhone','cdDueDate','cdNotes'].forEach(function(id){var e=document.getElementById(id);if(e)e.value='';});
  renderClinicDebts();
}

function cdEdit(id){
  var d = G('clinicDebts',[]).find(function(x){return x.id===id;});
  if (!d) return;
  document.getElementById('cdCreditor').value = d.creditor || '';
  document.getElementById('cdCategory').value = d.category || 'أخرى';
  document.getElementById('cdAmount').value = d.amount || '';
  document.getElementById('cdPhone').value = d.phone || '';
  document.getElementById('cdDueDate').value = d.dueDate || '';
  document.getElementById('cdCreatedAt').value = d.createdAt || today();
  document.getElementById('cdNotes').value = d.notes || '';
  document.getElementById('mo-addClinicDebt').dataset.editingId = id;
  openModal('mo-addClinicDebt');
}

function cdDelete(id){
  var d = G('clinicDebts',[]).find(function(x){return x.id===id;});
  if (!d) return;
  if (!confirm('حذف الدين الخاص بـ "'+(d.creditor||'-')+'"؟\nسيُحذف معه كل تاريخ الدفعات.')) return;
  S('clinicDebts', G('clinicDebts',[]).filter(function(x){return x.id!==id;}));
  renderClinicDebts();
}

var _cdPayingId = null;
function openPayClinicDebt(id){
  var d = G('clinicDebts',[]).find(function(x){return x.id===id;});
  if (!d) return;
  _cdPayingId = id;
  var paid = (d.payments||[]).reduce(function(s,p){return s+(p.amount||0);},0);
  var rem = (d.amount||0) - paid;
  document.getElementById('cdPayInfo').innerHTML =
    '<div style="font-weight:700;margin-bottom:4px">'+(d.creditor||'-')+'</div>'+
    '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px">'+
      '<span>المتبقّي: <strong style="color:#dc2626">'+rem.toLocaleString()+' د.ع</strong></span>'+
      '<span>الكلّي: '+(d.amount||0).toLocaleString()+'</span>'+
    '</div>';
  document.getElementById('cdPayAmount').value = rem;
  document.getElementById('cdPayDate').value = today();
  document.getElementById('cdPayNotes').value = '';
  openModal('mo-payClinicDebt');
}

function saveClinicDebtPayment(){
  if (!_cdPayingId) return;
  var amount = parseFloat(document.getElementById('cdPayAmount').value)||0;
  if (amount <= 0) { alert('المبلغ يجب أن يكون أكبر من صفر'); return; }
  var debts = G('clinicDebts', []);
  var d = debts.find(function(x){return x.id===_cdPayingId;});
  if (!d) return;
  var paid = (d.payments||[]).reduce(function(s,p){return s+(p.amount||0);},0);
  var rem = (d.amount||0) - paid;
  if (amount > rem + 1) {
    if (!confirm('المبلغ المدخل ('+amount.toLocaleString()+') أكبر من المتبقّي ('+rem.toLocaleString()+'). متابعة؟')) return;
  }
  var payment = {
    id: 'p_'+Date.now().toString(36),
    amount: amount,
    date: document.getElementById('cdPayDate').value || today(),
    method: document.getElementById('cdPayMethod').value || 'نقد',
    notes: (document.getElementById('cdPayNotes').value||'').trim(),
    by: CU ? CU.id : null,
    byName: CU ? CU.name : ''
  };
  d.payments = d.payments || [];
  d.payments.push(payment);
  S('clinicDebts', debts);
  closeModal('mo-payClinicDebt');
  renderClinicDebts();
  var newPaid = paid + amount;
  var newRem = (d.amount||0) - newPaid;
  if (d.phone) {
    var clinic = G('clinic', {});
    var msg = 'السلام عليكم،\n\nتم تسديد مبلغ '+amount.toLocaleString()+' د.ع لكم من '+(clinic.name||'عيادة سوران')+'.\n\n'+
      'الفئة: '+(d.category||'-')+'\n'+
      'تاريخ الدفع: '+(payment.date)+'\n'+
      'طريقة الدفع: '+(payment.method)+'\n'+
      (newRem>0 ? 'المبلغ المتبقّي: '+newRem.toLocaleString()+' د.ع\n' : '✅ تم تسديد كامل المبلغ.\n')+
      '\nشكراً لتعاونكم.';
    if (confirm('✅ تم تسجيل الدفعة!\n\nهل تريد فتح واتساب لإرسال تأكيد للجهة الدائنة؟')) {
      var phone = normalizePhoneIQ(d.phone);
      window.open('https://wa.me/964'+phone+'?text='+encodeURIComponent(msg), '_blank');
    }
  }
  _cdPayingId = null;
}

function cdSendReminderWA(id){
  var d = G('clinicDebts',[]).find(function(x){return x.id===id;});
  if (!d || !d.phone) { alert('رقم الهاتف غير متوفّر'); return; }
  var paid = (d.payments||[]).reduce(function(s,p){return s+(p.amount||0);},0);
  var rem = (d.amount||0) - paid;
  var clinic = G('clinic', {});
  var msg = 'السلام عليكم،\n\nهذا تذكير بخصوص المبلغ المستحق لكم من '+(clinic.name||'عيادة سوران')+'.\n\n'+
    'الفئة: '+(d.category||'-')+'\n'+
    'المبلغ المتبقّي: '+rem.toLocaleString()+' د.ع\n'+
    (d.dueDate?'تاريخ الاستحقاق: '+d.dueDate+'\n':'')+
    '\nسنحرص على التسديد في أقرب وقت ممكن.\nشكراً لصبركم.';
  var phone = normalizePhoneIQ(d.phone);
  window.open('https://wa.me/964'+phone+'?text='+encodeURIComponent(msg), '_blank');
}


// ═══════════════════════════════════════════════════
//  DOCTOR SETTLEMENTS (تصفية حسابات الأطباء)
// ═══════════════════════════════════════════════════

function renderSettlements(){
  if (!CU) return;
  var fDoc = document.getElementById('settFDoc');
  var docs = G('staff', []).filter(function(s){return s.role==='doctor'||s.role==='doctor-manager';});
  if (fDoc && fDoc.options.length <= 1) {
    fDoc.innerHTML = '<option value="">كل الأطباء</option>' + docs.map(function(d){return '<option value="'+d.id+'">'+d.name+'</option>';}).join('');
  }
  var settlements = G('settlements', []);
  if (CU.role === 'doctor') {
    settlements = settlements.filter(function(s){return s.doctorId === CU.id;});
  }
  var dFilter = (fDoc && CU.role !== 'doctor') ? fDoc.value : (CU.role === 'doctor' ? CU.id : '');
  var fromDate = (document.getElementById('settFFrom')||{}).value || '';
  var toDate = (document.getElementById('settFTo')||{}).value || '';
  var rows = settlements.slice();
  if (dFilter) rows = rows.filter(function(s){return s.doctorId === dFilter;});
  if (fromDate) rows = rows.filter(function(s){return (s.date||'') >= fromDate;});
  if (toDate)   rows = rows.filter(function(s){return (s.date||'') <= toDate;});
  rows.sort(function(a,b){return (b.date||'').localeCompare(a.date||'');});

  // Aggregate stats — supporting both new (revenueHandedOver/commissionPaid) and legacy (type/amount) format
  function getHandover(s){ return s.revenueHandedOver != null ? s.revenueHandedOver : (s.type === 'received' ? (s.amount||0) : 0); }
  function getCommPaid(s){ return s.commissionPaid != null ? s.commissionPaid : (s.type === 'paid' ? (s.amount||0) : 0); }
  var totalHandover = settlements.reduce(function(s,x){return s + getHandover(x);},0);
  var totalCommPaid = settlements.reduce(function(s,x){return s + getCommPaid(x);},0);

  document.getElementById('settStats').innerHTML =
    '<div class="stat-box"><span class="s-icon">📥</span><div class="s-label">إجمالي المسلّم للعيادة</div><div class="s-val" style="color:#16a34a">'+Math.round(totalHandover).toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📤</span><div class="s-label">إجمالي المسلّم للأطباء</div><div class="s-val" style="color:#0d5c7a">'+Math.round(totalCommPaid).toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📊</span><div class="s-label">عدد التصفيات</div><div class="s-val">'+settlements.length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📅</span><div class="s-label">معروض</div><div class="s-val">'+rows.length+'</div></div>';

  // Render running balance cards (one per doctor) — manager view only
  var balContainer = document.getElementById('settBalanceCards');
  if (!balContainer) {
    balContainer = document.createElement('div');
    balContainer.id = 'settBalanceCards';
    balContainer.style.marginBottom = '14px';
    var statsEl = document.getElementById('settStats');
    if (statsEl && statsEl.parentNode) statsEl.parentNode.insertBefore(balContainer, statsEl.nextSibling);
  }
  if (CU.role === 'manager' || CU.role === 'doctor-manager') {
    var balHtml = '<div style="font-size:13px;font-weight:800;color:#475569;margin-bottom:8px;padding:0 4px">⚖️ الأرصدة الجارية للأطباء</div>'+
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">';
    docs.forEach(function(d){
      var bal = computeDoctorBalance(d.id);
      if (!bal) return;
      var color = bal.balance > 0 ? '#16a34a' : bal.balance < 0 ? '#dc2626' : '#64748b';
      var lbl = bal.balance > 0 ? 'العيادة مدينة له بـ' : bal.balance < 0 ? 'مدين للعيادة بـ' : 'الحساب صفر ✓';
      balHtml += '<div style="background:#fff;border:1.5px solid #e2e8f0;border-right:4px solid '+color+';border-radius:10px;padding:10px;cursor:pointer" onclick="quickSettleDoctor(\''+d.id+'\')">'+
        '<div style="font-weight:700;font-size:13px;margin-bottom:6px">'+d.name+'</div>'+
        '<div style="font-size:10px;color:#64748b;margin-bottom:4px">'+lbl+'</div>'+
        '<div style="font-size:18px;font-weight:800;color:'+color+'">'+(bal.balance===0?'0':Math.abs(Math.round(bal.balance)).toLocaleString())+(bal.balance===0?'':' د.ع')+'</div>'+
        '<div style="font-size:10px;color:#94a3b8;margin-top:4px">اضغط للتصفية</div>'+
      '</div>';
    });
    balHtml += '</div>';
    balContainer.innerHTML = balHtml;
    balContainer.style.display = 'block';
  } else {
    balContainer.style.display = 'none';
  }

  var smap = sm();
  var tbody = document.getElementById('settBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--gray4)">لا توجد تصفيات</td></tr>';
    return;
  }
  var canEdit = CU.role === 'manager' || CU.role === 'doctor-manager';
  tbody.innerHTML = rows.map(function(s){
    var doc = smap[s.doctorId];
    var handler = smap[s.handlerId];
    var handover = getHandover(s);
    var commPaid = getCommPaid(s);
    var summary = '';
    if (handover) summary += '<span class="badge badge-green" style="font-size:10px">📥 '+Math.round(handover).toLocaleString()+'</span>';
    if (handover && commPaid) summary += ' ';
    if (commPaid) summary += '<span class="badge badge-blue" style="font-size:10px">📤 '+Math.round(commPaid).toLocaleString()+'</span>';
    if (!handover && !commPaid) summary = '<span class="badge badge-gray">—</span>';
    var period = (s.fromDate && s.toDate) ? (s.fromDate===s.toDate ? s.fromDate : (s.fromDate+' → '+s.toDate)) : '-';
    return '<tr>'+
      '<td>'+(s.date||'-')+'</td>'+
      '<td><div class="fw-700">'+(doc?doc.name:'-')+'</div></td>'+
      '<td>'+summary+'</td>'+
      '<td><strong>'+Math.round(handover+commPaid).toLocaleString()+'</strong></td>'+
      '<td class="text-muted text-sm">'+period+'</td>'+
      '<td class="text-muted text-sm">'+(handler?handler.name:'-')+'</td>'+
      '<td>'+(canEdit?'<button class="btn btn-danger btn-xs" onclick="delSettlement(\''+s.id+'\')">🗑</button>':'')+'</td>'+
    '</tr>';
  }).join('');
}

// Quick action: open settlement modal pre-filled for a specific doctor
function quickSettleDoctor(doctorId){
  if (!CU || (CU.role !== 'manager' && CU.role !== 'doctor-manager')) return;
  openSettlementModal();
  setTimeout(function(){
    var docSel = document.getElementById('settDoc');
    if (docSel) {
      docSel.value = doctorId;
      onSettDocChange();
    }
  }, 100);
}

function openSettlementModal(){
  if (!CU || (CU.role !== 'manager' && CU.role !== 'doctor-manager')) {
    alert('فقط المدير يستطيع إنشاء تصفية');
    return;
  }
  var docs = G('staff', []).filter(function(s){return s.role==='doctor'||s.role==='doctor-manager';});
  var docSel = document.getElementById('settDoc');
  var handlerSel = document.getElementById('settHandler');
  docSel.innerHTML = '<option value="">— اختر —</option>' + docs.map(function(d){return '<option value="'+d.id+'">'+d.name+'</option>';}).join('');
  var staff = G('staff', []).filter(function(s){return s.role!=='patient';});
  // Default handler: clinic owner (Dr. Ahmed) if exists, else Dr. Diaa, else current user
  var owner = staff.find(function(s){return s.role === 'doctor-manager';});
  var diaa = staff.find(function(s){return (s.username||'')==='diaa';});
  var defaultHandler = owner || diaa || (CU ? staff.find(function(s){return s.id===CU.id;}) : null);
  handlerSel.innerHTML = staff.map(function(s){
    var label = s.name + (s.role==='doctor-manager'?' (صاحب العيادة)':s.username==='diaa'?' (إداري)':'');
    var sel = (defaultHandler && s.id === defaultHandler.id) ? ' selected' : '';
    return '<option value="'+s.id+'"'+sel+'>'+label+'</option>';
  }).join('');
  // Default to TODAY
  var t = today();
  document.getElementById('settFrom').value = t;
  document.getElementById('settTo').value = t;
  document.getElementById('settDate').value = t;
  document.getElementById('settHandover').value = '';
  document.getElementById('settCommPaid').value = '';
  document.getElementById('settNotes').value = '';
  document.getElementById('settSuggestion').style.display = 'none';
  document.getElementById('settBalanceBox').style.display = 'none';
  document.getElementById('settPreview').style.display = 'none';
  openModal('mo-settlement');
}

// Quick-period preset buttons (today / yesterday / this week / last week / this month)
function settQuickPeriod(period){
  var now = new Date();
  var fromD, toD;
  function fmt(d){ return d.toISOString().slice(0,10); }
  if (period === 'today') {
    fromD = toD = fmt(now);
  } else if (period === 'yesterday') {
    var y = new Date(now); y.setDate(y.getDate()-1);
    fromD = toD = fmt(y);
  } else if (period === 'thisWeek') {
    var dayOfWeek = now.getDay();
    var sat = new Date(now); sat.setDate(now.getDate() - ((dayOfWeek+1)%7));
    var fri = new Date(sat); fri.setDate(sat.getDate()+6);
    fromD = fmt(sat); toD = fmt(fri);
  } else if (period === 'lastWeek') {
    var dayOfWeek2 = now.getDay();
    var lastSat = new Date(now); lastSat.setDate(now.getDate() - ((dayOfWeek2+1)%7) - 7);
    var lastFri = new Date(lastSat); lastFri.setDate(lastSat.getDate()+6);
    fromD = fmt(lastSat); toD = fmt(lastFri);
  } else if (period === 'thisMonth') {
    var first = new Date(now.getFullYear(), now.getMonth(), 1);
    fromD = fmt(first); toD = fmt(now);
  }
  document.getElementById('settFrom').value = fromD;
  document.getElementById('settTo').value = toD;
  recalcSettSuggestion();
}

function onSettDocChange(){
  showSettBalance();
  recalcSettSuggestion();
}

// Compute the current running balance for a doctor BEFORE this new settlement
// Positive balance = clinic owes the doctor (commission earned but not yet paid)
// Negative balance = doctor owes the clinic
function computeDoctorBalance(doctorId, asOfDate){
  if (!doctorId) return null;
  var plans = G('plans', []);
  var smap = sm();
  var doc = smap[doctorId];
  if (!doc) return null;
  // Total commissions earned by this doctor across all sessions
  var totalEarned = 0;
  plans.forEach(function(pl){
    (pl.sessionRecords||[]).forEach(function(rec){
      var rdate = (rec.date || rec.savedAt || '').slice(0,10);
      if (asOfDate && rdate > asOfDate) return; // only sessions up to asOfDate
      var rdocId = rec.doctorId || pl.doctorId;
      if (rdocId !== doctorId) return;
      var revenue = rec.payment || 0;
      var commRate = (rec.commRate != null ? rec.commRate : (pl.doctorComm != null ? pl.doctorComm : (doc.comm||0)));
      totalEarned += revenue * commRate / 100;
    });
  });
  // Total commission already paid to this doctor
  var settlements = G('settlements', []).filter(function(s){return s.doctorId === doctorId;});
  if (asOfDate) {
    settlements = settlements.filter(function(s){return (s.date||'') <= asOfDate;});
  }
  var totalCommissionPaid = settlements.reduce(function(s,x){return s + (x.commissionPaid||0);},0);
  // Legacy: old format used 'paid' type with 'amount'
  var legacyPaid = settlements.filter(function(s){return s.type==='paid' && s.commissionPaid==null;}).reduce(function(s,x){return s+(x.amount||0);},0);
  var balance = totalEarned - totalCommissionPaid - legacyPaid;
  // Also compute revenue handed over (separate accounting, informational)
  var totalHandover = settlements.reduce(function(s,x){return s + (x.revenueHandedOver||0);},0);
  return {
    totalEarned: totalEarned,
    totalCommissionPaid: totalCommissionPaid + legacyPaid,
    balance: balance,
    totalHandover: totalHandover
  };
}

// Show running balance for selected doctor
function showSettBalance(){
  var docId = document.getElementById('settDoc').value;
  var box = document.getElementById('settBalanceBox');
  if (!docId) { box.style.display = 'none'; return; }
  var bal = computeDoctorBalance(docId);
  if (!bal) { box.style.display = 'none'; return; }
  var doc = sm()[docId];
  box.style.display = 'block';
  var balColor = bal.balance > 0 ? '#16a34a' : bal.balance < 0 ? '#dc2626' : '#64748b';
  var balLabel = bal.balance > 0 ? 'العيادة مدينة للطبيب بـ' : bal.balance < 0 ? 'الطبيب مدين للعيادة بـ' : 'الحساب صفر';
  box.innerHTML =
    '<div style="font-weight:700;color:#92400e;margin-bottom:6px">📊 الرصيد الحالي للطبيب '+(doc?doc.name:'')+'</div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px">'+
      '<div>إجمالي ما اكتسب من عمولات: <strong>'+Math.round(bal.totalEarned).toLocaleString()+' د.ع</strong></div>'+
      '<div>إجمالي ما تسلّم من عمولاته: <strong>'+Math.round(bal.totalCommissionPaid).toLocaleString()+' د.ع</strong></div>'+
    '</div>'+
    '<div style="margin-top:6px;padding-top:6px;border-top:1px dashed #fcd34d;font-weight:800;color:'+balColor+';font-size:13px">'+
      (bal.balance === 0 ? '✓ '+balLabel : balLabel+' '+Math.abs(Math.round(bal.balance)).toLocaleString()+' د.ع')+
    '</div>';
}

// Live preview: show what will happen after saving
function updateSettPreview(){
  var docId = document.getElementById('settDoc').value;
  if (!docId) return;
  var preview = document.getElementById('settPreview');
  var bal = computeDoctorBalance(docId);
  if (!bal) { preview.style.display = 'none'; return; }
  var handover = parseFloat(document.getElementById('settHandover').value)||0;
  var commPaid = parseFloat(document.getElementById('settCommPaid').value)||0;
  if (handover === 0 && commPaid === 0) { preview.style.display = 'none'; return; }
  // New balance = old earned - (old paid + this commPaid)
  // Note: handover doesn't affect doctor's balance — it's just transfer of cash from doctor's hand to clinic
  var newBalance = bal.balance - commPaid;
  preview.style.display = 'block';
  var balColor = newBalance > 0 ? '#16a34a' : newBalance < 0 ? '#dc2626' : '#64748b';
  var balLbl = newBalance > 0 ? 'العيادة ستبقى مدينة للطبيب بـ' :
               newBalance < 0 ? 'الطبيب سيصبح مديناً للعيادة بـ' :
               'الحساب سيصبح صفراً ✓';
  preview.innerHTML =
    '<div style="font-weight:700;font-size:11px;color:#475569;margin-bottom:4px">🔮 معاينة التأثير:</div>'+
    (handover>0?'<div>📥 العيادة ستستلم نقداً: <strong style="color:#16a34a">'+handover.toLocaleString()+' د.ع</strong> (من المقبوضات)</div>':'')+
    (commPaid>0?'<div>📤 الطبيب سيستلم: <strong style="color:#0d5c7a">'+commPaid.toLocaleString()+' د.ع</strong> (من عمولته)</div>':'')+
    '<div style="margin-top:4px;padding-top:4px;border-top:1px dashed #e2e8f0;font-weight:800;color:'+balColor+'">'+
      (newBalance === 0 ? balLbl : balLbl+' '+Math.abs(Math.round(newBalance)).toLocaleString()+' د.ع')+
    '</div>';
}

function recalcSettSuggestion(){
  var docId = document.getElementById('settDoc').value;
  var fromD = document.getElementById('settFrom').value;
  var toD = document.getElementById('settTo').value;
  var sugBox = document.getElementById('settSuggestion');
  if (!docId || !fromD || !toD) { sugBox.style.display = 'none'; return; }
  var doc = sm()[docId];
  if (!doc) { sugBox.style.display = 'none'; return; }
  var plans = G('plans', []);
  var totalRevenue = 0, totalCommission = 0, sessionCount = 0;
  plans.forEach(function(pl){
    (pl.sessionRecords||[]).forEach(function(rec){
      var rdate = rec.date || rec.savedAt || '';
      if (rdate >= fromD && rdate <= toD) {
        var rdocId = rec.doctorId || pl.doctorId;
        if (rdocId === docId) {
          sessionCount++;
          var sessionRevenue = rec.payment || 0;
          totalRevenue += sessionRevenue;
          var commRate = (rec.commRate != null ? rec.commRate : (pl.doctorComm != null ? pl.doctorComm : (doc.comm||0)));
          totalCommission += sessionRevenue * commRate / 100;
        }
      }
    });
  });
  var clinicShare = totalRevenue - totalCommission;
  sugBox.style.display = 'block';
  sugBox.innerHTML =
    '<div style="font-weight:700;margin-bottom:6px;color:#075985">📊 ملخّص الفترة لـ '+doc.name+'</div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;font-size:11px">'+
      '<div>عدد الجلسات: <strong>'+sessionCount+'</strong></div>'+
      '<div>إجمالي المقبوض: <strong>'+totalRevenue.toLocaleString()+'</strong></div>'+
      '<div>عمولة الطبيب: <strong style="color:#16a34a">'+Math.round(totalCommission).toLocaleString()+'</strong></div>'+
      '<div>حصة العيادة: <strong style="color:#0d5c7a">'+Math.round(clinicShare).toLocaleString()+'</strong></div>'+
    '</div>'+
    '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">'+
      '<button type="button" class="btn btn-ghost btn-xs" onclick="settUseAmounts('+totalRevenue+','+Math.round(totalCommission)+')">⚡ السيناريو الكامل (سلّم كل المقبوض + استلم كل عمولته)</button>'+
      '<button type="button" class="btn btn-ghost btn-xs" onclick="settUseAmounts('+totalRevenue+',0)">📥 سلّم كل المقبوض فقط (تأجيل العمولة)</button>'+
      '<button type="button" class="btn btn-ghost btn-xs" onclick="settUseAmounts(0,'+Math.round(totalCommission)+')">📤 استلام عمولة فقط (لا تسليم)</button>'+
    '</div>';
}

// Quick-fill both amount fields
function settUseAmounts(handover, commPaid){
  document.getElementById('settHandover').value = handover;
  document.getElementById('settCommPaid').value = commPaid;
  updateSettPreview();
}

function saveSettlement(){
  var docId = document.getElementById('settDoc').value;
  var fromD = document.getElementById('settFrom').value;
  var toD = document.getElementById('settTo').value;
  var handover = parseFloat(document.getElementById('settHandover').value)||0;
  var commPaid = parseFloat(document.getElementById('settCommPaid').value)||0;
  if (!docId) { alert('اختر الطبيب'); return; }
  if (!fromD || !toD) { alert('حدّد فترة التصفية'); return; }
  if (handover === 0 && commPaid === 0) {
    alert('أدخل قيمة واحدة على الأقل (تسليم أو استلام)');
    return;
  }
  var settlements = G('settlements', []);
  var s = {
    id: 'set_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,5),
    doctorId: docId,
    revenueHandedOver: handover,    // الطبيب سلّم للعيادة
    commissionPaid: commPaid,        // العيادة سلّمت عمولة للطبيب
    fromDate: fromD,
    toDate: toD,
    date: document.getElementById('settDate').value || today(),
    handlerId: document.getElementById('settHandler').value,
    notes: (document.getElementById('settNotes').value||'').trim(),
    createdAt: new Date().toISOString(),
    createdBy: CU ? CU.id : null
  };
  settlements.push(s);
  S('settlements', settlements);
  closeModal('mo-settlement');
  renderSettlements();
  // Notification summary
  var doc = sm()[docId];
  var msg = '';
  if (handover) msg += '📥 سلّم '+handover.toLocaleString()+' د.ع للعيادة';
  if (handover && commPaid) msg += ' • ';
  if (commPaid) msg += '📤 استلم '+commPaid.toLocaleString()+' د.ع من عمولته';
  try {
    pushNotify('💵 تصفية ' + (doc?doc.name:''), msg + ' • ' + (s.fromDate===s.toDate ? s.fromDate : s.fromDate+' → '+s.toDate), {type:'settlement'});
  } catch(e){}
}

function delSettlement(id){
  if (!CU || (CU.role !== 'manager' && CU.role !== 'doctor-manager')) return;
  if (!confirm('حذف هذه التصفية؟ سيؤثّر على رصيد الطبيب.')) return;
  S('settlements', G('settlements',[]).filter(function(x){return x.id!==id;}));
  renderSettlements();
}

// ═══ END-OF-DAY SETTLEMENT (تصفية نهاية الدوام) ═══
// One-click panel showing all doctors who worked TODAY with their day's revenue & commission ready for settlement
function openEndOfDayPanel(){
  if (!CU || (CU.role !== 'manager' && CU.role !== 'doctor-manager')) {
    alert('فقط المدير يستطيع التصفية اليومية');
    return;
  }
  var panel = document.getElementById('endOfDayPanel');
  if (!panel) return;
  // Toggle visibility
  if (panel.style.display === 'block') {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }
  renderEndOfDayPanel();
  panel.style.display = 'block';
}

var _eodDate = null;
function eodChangeDate(d){
  _eodDate = d;
  renderEndOfDayPanel();
}

function renderEndOfDayPanel(){
  var panel = document.getElementById('endOfDayPanel');
  if (!panel) return;
  var dateStr = _eodDate || today();
  // Find all doctors who had completed sessions on this date
  var plans = G('plans', []);
  var smap = sm();
  var byDoctor = {}; // doctorId -> { revenue, commission, sessions: [] }
  plans.forEach(function(pl){
    (pl.sessionRecords||[]).forEach(function(rec){
      var rdate = rec.date || rec.savedAt || '';
      if (rdate.slice(0,10) !== dateStr) return;
      var rdocId = rec.doctorId || pl.doctorId;
      if (!rdocId) return;
      var doc = smap[rdocId];
      if (!doc) return;
      if (!byDoctor[rdocId]) byDoctor[rdocId] = { doctor: doc, revenue: 0, commission: 0, sessions: [] };
      var revenue = rec.payment || 0;
      var commRate = (rec.commRate != null ? rec.commRate : (pl.doctorComm != null ? pl.doctorComm : (doc.comm||0)));
      byDoctor[rdocId].revenue += revenue;
      byDoctor[rdocId].commission += revenue * commRate / 100;
      byDoctor[rdocId].sessions.push({plan: pl, record: rec, revenue: revenue});
    });
  });

  // Find existing settlements for this date (to show what's already done)
  var existing = G('settlements', []).filter(function(s){
    return s.date === dateStr || (s.fromDate === dateStr && s.toDate === dateStr);
  });
  function getHandover(s){ return s.revenueHandedOver != null ? s.revenueHandedOver : (s.type === 'received' ? (s.amount||0) : 0); }
  function getCommPaid(s){ return s.commissionPaid != null ? s.commissionPaid : (s.type === 'paid' ? (s.amount||0) : 0); }
  var settledIds = {};
  existing.forEach(function(s){
    if (!settledIds[s.doctorId]) settledIds[s.doctorId] = {handover:0, commPaid:0};
    settledIds[s.doctorId].handover += getHandover(s);
    settledIds[s.doctorId].commPaid += getCommPaid(s);
  });

  var doctorIds = Object.keys(byDoctor);
  var totalRev = 0, totalComm = 0;
  doctorIds.forEach(function(id){ totalRev += byDoctor[id].revenue; totalComm += byDoctor[id].commission; });

  // Date picker + summary header
  var html = '<div class="card" style="border-right:4px solid #16a34a">'+
    '<div class="card-header" style="background:#f0fdf4;color:#166534;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">'+
      '<span class="card-title">🌙 تصفية نهاية الدوام</span>'+
      '<div style="display:flex;gap:6px;align-items:center">'+
        '<input type="date" id="eodDateInput" value="'+dateStr+'" onchange="eodChangeDate(this.value)" style="padding:5px 8px;border:1px solid #bbf7d0;border-radius:6px;font-size:12px">'+
        '<button class="btn btn-ghost btn-xs" onclick="openEndOfDayPanel()">✕ إغلاق</button>'+
      '</div>'+
    '</div>'+
    '<div class="card-body">';

  if (!doctorIds.length) {
    html += '<div style="text-align:center;padding:30px;color:#94a3b8">'+
      '<div style="font-size:36px;margin-bottom:8px">🏖️</div>'+
      'لا يوجد أي طبيب عمل في يوم '+dateStr+'<br>'+
      '<div style="font-size:11px;margin-top:6px">ربما لم تُحفظ جلسات بعد، أو لم يدخل الأطباء أي مبلغ مقبوض</div>'+
    '</div>';
  } else {
    html += '<div style="background:#f0fdf4;border-radius:8px;padding:10px;margin-bottom:12px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:12px;text-align:center">'+
      '<div><div style="color:#64748b;font-size:10px">الأطباء العاملون</div><div style="font-weight:800;font-size:18px;color:#166534">'+doctorIds.length+'</div></div>'+
      '<div><div style="color:#64748b;font-size:10px">إجمالي مقبوضات اليوم</div><div style="font-weight:800;font-size:18px;color:#0d5c7a">'+totalRev.toLocaleString()+'</div></div>'+
      '<div><div style="color:#64748b;font-size:10px">إجمالي العمولات</div><div style="font-weight:800;font-size:18px;color:#16a34a">'+Math.round(totalComm).toLocaleString()+'</div></div>'+
    '</div>';

    html += '<div class="alert" style="background:#fef3c7;border:1px solid #fde68a;color:#92400e;font-size:11px;margin-bottom:10px">💡 <strong>السيناريو الواقعي:</strong> الطبيب يسلّم كامل المقبوضات للعيادة، ثم تُسلَّم له عمولته (كاملة أو جزئية، أو تُؤجَّل لتتراكم).</div>';

    // Per-doctor cards with new model
    doctorIds.forEach(function(id){
      var data = byDoctor[id];
      var alreadyDone = settledIds[id];
      var bal = computeDoctorBalance(id);
      var balColor = bal.balance > 0 ? '#16a34a' : bal.balance < 0 ? '#dc2626' : '#64748b';
      var balLbl = bal.balance > 0 ? 'العيادة مدينة له بـ' : bal.balance < 0 ? 'مدين للعيادة بـ' : 'الحساب صفر';
      html += '<div style="background:#fff;border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:8px">'+
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;flex-wrap:wrap;gap:6px">'+
          '<div>'+
            '<div style="font-weight:800;color:#0f172a">👨‍⚕️ '+data.doctor.name+'</div>'+
            '<div style="font-size:10px;color:#64748b;margin-top:2px">'+data.sessions.length+' جلسة • عمولة '+(data.doctor.comm||0)+'%</div>'+
          '</div>'+
          '<div style="text-align:left">'+
            '<div style="font-size:10px;color:#64748b">'+balLbl+'</div>'+
            '<div style="font-size:14px;font-weight:800;color:'+balColor+'">'+(bal.balance===0?'0':Math.abs(Math.round(bal.balance)).toLocaleString()+' د.ع')+'</div>'+
          '</div>'+
        '</div>'+
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font-size:11px;background:#f8fafc;padding:8px;border-radius:6px;margin-bottom:8px">'+
          '<div>📥 المقبوض اليوم: <strong>'+data.revenue.toLocaleString()+'</strong></div>'+
          '<div style="color:#16a34a">عمولته اليوم: <strong>'+Math.round(data.commission).toLocaleString()+'</strong></div>'+
          '<div style="color:#0d5c7a">حصة العيادة: <strong>'+Math.round(data.revenue - data.commission).toLocaleString()+'</strong></div>'+
        '</div>'+
        (alreadyDone && (alreadyDone.handover||alreadyDone.commPaid) ? '<div style="background:#dbeafe;color:#1e40af;border-radius:6px;padding:6px 10px;font-size:11px;margin-bottom:6px">ℹ️ سبق التصفية اليوم: '+
          (alreadyDone.handover?'استلام منه '+Math.round(alreadyDone.handover).toLocaleString()+' ':'')+
          (alreadyDone.commPaid?'• تسليم له '+Math.round(alreadyDone.commPaid).toLocaleString():'')+
        '</div>' : '')+
        '<div style="display:flex;gap:6px;flex-wrap:wrap">'+
          '<button class="btn btn-success btn-xs" onclick="eodScenarioFull(\''+id+'\',\''+dateStr+'\','+data.revenue+','+Math.round(data.commission)+')">✅ سلّم كل المقبوض + استلم عمولته كاملة</button>'+
          '<button class="btn btn-xs" style="background:#f59e0b;color:#fff;border:none" onclick="eodScenarioDeferred(\''+id+'\',\''+dateStr+'\','+data.revenue+')">⏸️ سلّم كل المقبوض فقط (تأجيل العمولة)</button>'+
          '<button class="btn btn-ghost btn-xs" onclick="eodOpenDetailed(\''+id+'\',\''+dateStr+'\')">⚙️ تفصيل</button>'+
        '</div>'+
      '</div>';
    });
  }

  html += '</div></div>';
  panel.innerHTML = html;
}

// Scenario 1: doctor hands over all collected revenue AND receives his full commission
function eodScenarioFull(doctorId, dateStr, revenue, commission){
  if (!CU || (CU.role !== 'manager' && CU.role !== 'doctor-manager')) return;
  var doc = sm()[doctorId];
  if (!confirm('تأكيد التصفية الكاملة:\n\n'+
    'الطبيب: '+(doc?doc.name:'-')+'\n'+
    '📥 سيُسجَّل: سلّم '+revenue.toLocaleString()+' د.ع للعيادة\n'+
    '📤 سيُسجَّل: استلم '+commission.toLocaleString()+' د.ع من عمولته\n'+
    'التاريخ: '+dateStr+'\n\n'+
    'بعد هذه العملية: حساب اليوم سيكون متوازناً.')) return;
  saveEodSettlement(doctorId, dateStr, revenue, commission, 'تصفية كاملة لنهاية الدوام');
}

// Scenario 2: doctor hands over all revenue but doesn't take commission today (deferred)
function eodScenarioDeferred(doctorId, dateStr, revenue){
  if (!CU || (CU.role !== 'manager' && CU.role !== 'doctor-manager')) return;
  var doc = sm()[doctorId];
  if (!confirm('تأكيد التصفية مع تأجيل العمولة:\n\n'+
    'الطبيب: '+(doc?doc.name:'-')+'\n'+
    '📥 سيُسجَّل: سلّم '+revenue.toLocaleString()+' د.ع للعيادة\n'+
    '⏸️ لن يستلم عمولته اليوم\n'+
    'التاريخ: '+dateStr+'\n\n'+
    'بعد هذه العملية: العمولة ستتراكم في رصيده ويستطيع استلامها لاحقاً.')) return;
  saveEodSettlement(doctorId, dateStr, revenue, 0, 'تسليم المقبوض، تأجيل العمولة');
}

function saveEodSettlement(doctorId, dateStr, handover, commPaid, notes){
  var staff = G('staff', []);
  var owner = staff.find(function(s){return s.role === 'doctor-manager';});
  var diaa = staff.find(function(s){return (s.username||'')==='diaa';});
  var handlerId = (owner ? owner.id : (diaa ? diaa.id : (CU ? CU.id : null)));
  var settlements = G('settlements', []);
  settlements.push({
    id: 'set_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,5),
    doctorId: doctorId,
    revenueHandedOver: handover,
    commissionPaid: commPaid,
    fromDate: dateStr,
    toDate: dateStr,
    date: dateStr,
    handlerId: handlerId,
    notes: notes || 'تصفية نهاية الدوام',
    createdAt: new Date().toISOString(),
    createdBy: CU ? CU.id : null
  });
  S('settlements', settlements);
  renderEndOfDayPanel();
  renderSettlements();
  try {
    var doc = sm()[doctorId];
    var msg = '';
    if (handover) msg += '📥 '+handover.toLocaleString();
    if (handover && commPaid) msg += ' • ';
    if (commPaid) msg += '📤 '+commPaid.toLocaleString();
    pushNotify('💵 تصفية ' + (doc?doc.name:''), msg + ' • ' + dateStr, {type:'eod_settlement'});
  } catch(e){}
}

// Open the detailed settlement modal pre-filled for this doctor & date
function eodOpenDetailed(doctorId, dateStr){
  openSettlementModal();
  setTimeout(function(){
    var docSel = document.getElementById('settDoc');
    if (docSel) docSel.value = doctorId;
    document.getElementById('settFrom').value = dateStr;
    document.getElementById('settTo').value = dateStr;
    document.getElementById('settDate').value = dateStr;
    recalcSettSuggestion();
  }, 100);
}


// ═══════════════════════════════════════════════════
//  VENDORS (مختبرات، مكاتب أسنان، موردين)
// ═══════════════════════════════════════════════════

var VENDOR_TYPES = {
  'lab':           {icon:'🔬',label:'مختبر تركيبات',  color:'#7c3aed'},
  'dental_office': {icon:'🦷',label:'مكتب أسنان',      color:'#0d5c7a'},
  'supplier':      {icon:'📦',label:'مورد مواد',       color:'#16a34a'},
  'equipment':     {icon:'🛠️',label:'صيانة/أجهزة',    color:'#ea580c'},
  'radiology':     {icon:'📷',label:'أشعة',            color:'#0891b2'},
  'other':         {icon:'📌',label:'أخرى',            color:'#64748b'}
};

function renderVendors(){
  var vendors = G('vendors', []);
  var qEl = document.getElementById('venQ');
  var typeEl = document.getElementById('venTypeFilter');
  var q = qEl ? qEl.value.trim().toLowerCase() : '';
  var typeFilter = typeEl ? typeEl.value : '';
  var rows = vendors.slice();
  if (typeFilter) rows = rows.filter(function(v){return v.type === typeFilter;});
  if (q) rows = rows.filter(function(v){
    var hay = ((v.name||'')+' '+(v.contact||'')+' '+(v.specialty||'')+' '+(v.phone||'')+' '+(v.whatsapp||'')+' '+(v.address||'')+' '+(v.notes||'')).toLowerCase();
    return hay.indexOf(q) !== -1;
  });
  // Sort: by type then name
  rows.sort(function(a,b){
    if ((a.type||'')!==(b.type||'')) return (a.type||'').localeCompare(b.type||'');
    return (a.name||'').localeCompare(b.name||'');
  });
  var listEl = document.getElementById('venList');
  if (!rows.length) {
    listEl.innerHTML = emptyState('🏢', vendors.length ? 'لا توجد نتائج للبحث' : 'لم تُضف أي جهة بعد. اضغط "+ إضافة جهة" للبدء.');
    return;
  }
  // Group by type
  var byType = {};
  rows.forEach(function(v){
    var t = v.type || 'other';
    if (!byType[t]) byType[t] = [];
    byType[t].push(v);
  });
  var html = '';
  Object.keys(byType).forEach(function(t){
    var info = VENDOR_TYPES[t] || VENDOR_TYPES.other;
    html += '<div style="margin-bottom:14px">'+
      '<div style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:800;color:'+info.color+';margin-bottom:8px;padding:0 4px">'+
        info.icon+' '+info.label+' <span style="background:#f1f5f9;color:#64748b;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700">'+byType[t].length+'</span>'+
      '</div>';
    html += byType[t].map(function(v){
      var phone = v.phone ? normalizePhoneIQ(v.phone) : '';
      var wa = v.whatsapp ? normalizePhoneIQ(v.whatsapp) : phone;
      return '<div class="card" style="margin-bottom:8px;border-right:3px solid '+info.color+'"><div class="card-body" style="padding:12px 14px">'+
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">'+
          '<div style="flex:1;min-width:160px">'+
            '<div style="font-weight:800;font-size:14px;color:var(--gray6)">'+(v.name||'-')+'</div>'+
            (v.contact?'<div style="font-size:11px;color:var(--gray5);margin-top:2px">👤 '+v.contact+'</div>':'')+
            (v.specialty?'<div style="font-size:11px;color:'+info.color+';margin-top:2px;font-weight:600">🎯 '+v.specialty+'</div>':'')+
            (v.address?'<div style="font-size:11px;color:var(--gray5);margin-top:2px">📍 '+v.address+'</div>':'')+
            (v.notes?'<div style="font-size:11px;color:var(--gray5);margin-top:4px;font-style:italic;background:#f8fafc;padding:4px 8px;border-radius:4px">"'+v.notes+'"</div>':'')+
          '</div>'+
          '<div style="display:flex;gap:4px;flex-wrap:wrap">'+
            (phone?'<a href="tel:'+phone+'" class="btn btn-xs" style="background:#16a34a;color:#fff;text-decoration:none" title="اتصال">📞 اتصال</a>':'')+
            (wa?'<a href="https://wa.me/964'+wa+'" target="_blank" class="btn btn-xs" style="background:#25D366;color:#fff;text-decoration:none" title="واتساب">💬 واتساب</a>':'')+
            '<button class="btn btn-ghost btn-xs" onclick="venEdit(\''+v.id+'\')" title="تعديل">✏️</button>'+
            '<button class="btn btn-danger btn-xs" onclick="venDelete(\''+v.id+'\')" title="حذف">🗑️</button>'+
          '</div>'+
        '</div>'+
        (v.phone||v.whatsapp?'<div style="font-size:11px;color:#64748b;margin-top:8px;padding-top:8px;border-top:1px dashed #e2e8f0;direction:ltr;font-family:monospace">'+
          (v.phone?'📞 '+v.phone:'')+
          (v.phone&&v.whatsapp&&v.whatsapp!==v.phone?' • ':'')+
          (v.whatsapp&&v.whatsapp!==v.phone?'💬 '+v.whatsapp:'')+
        '</div>':'')+
      '</div></div>';
    }).join('');
    html += '</div>';
  });
  listEl.innerHTML = html;
}

function openAddVendor(){
  document.getElementById('mo-addVendor').dataset.editingId = '';
  ['venName','venPhone','venWhatsapp','venContact','venSpecialty','venAddress','venNotes'].forEach(function(id){
    var e = document.getElementById(id); if (e) e.value = '';
  });
  var t = document.getElementById('venType'); if (t) t.value = 'lab';
  openModal('mo-addVendor');
}

function venEdit(id){
  var v = G('vendors',[]).find(function(x){return x.id===id;});
  if (!v) return;
  document.getElementById('venName').value = v.name || '';
  document.getElementById('venType').value = v.type || 'other';
  document.getElementById('venPhone').value = v.phone || '';
  document.getElementById('venWhatsapp').value = v.whatsapp || '';
  document.getElementById('venContact').value = v.contact || '';
  document.getElementById('venSpecialty').value = v.specialty || '';
  document.getElementById('venAddress').value = v.address || '';
  document.getElementById('venNotes').value = v.notes || '';
  document.getElementById('mo-addVendor').dataset.editingId = id;
  openModal('mo-addVendor');
}

function saveVendor(){
  var name = (document.getElementById('venName').value||'').trim();
  if (!name) { alert('اسم الجهة مطلوب'); return; }
  var vendors = G('vendors', []);
  var modalEl = document.getElementById('mo-addVendor');
  var editingId = modalEl.dataset.editingId;
  var v = {
    id: editingId || 'v_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,5),
    name: name,
    type: document.getElementById('venType').value || 'other',
    phone: (document.getElementById('venPhone').value||'').trim(),
    whatsapp: (document.getElementById('venWhatsapp').value||'').trim(),
    contact: (document.getElementById('venContact').value||'').trim(),
    specialty: (document.getElementById('venSpecialty').value||'').trim(),
    address: (document.getElementById('venAddress').value||'').trim(),
    notes: (document.getElementById('venNotes').value||'').trim(),
    addedBy: CU ? CU.id : null,
    addedByName: CU ? CU.name : '',
    createdAt: new Date().toISOString()
  };
  if (editingId) {
    var idx = vendors.findIndex(function(x){return x.id===editingId;});
    if (idx >= 0) {
      // Preserve original creator info
      v.addedBy = vendors[idx].addedBy;
      v.addedByName = vendors[idx].addedByName;
      v.createdAt = vendors[idx].createdAt;
      v.updatedAt = new Date().toISOString();
      v.updatedBy = CU ? CU.id : null;
      vendors[idx] = v;
    }
  } else {
    vendors.push(v);
  }
  S('vendors', vendors);
  modalEl.dataset.editingId = '';
  closeModal('mo-addVendor');
  renderVendors();
}

function venDelete(id){
  var v = G('vendors',[]).find(function(x){return x.id===id;});
  if (!v) return;
  if (!confirm('حذف "'+(v.name||'-')+'"؟')) return;
  S('vendors', G('vendors',[]).filter(function(x){return x.id!==id;}));
  renderVendors();
}


function renderSearch(){
  var q=(document.getElementById('globalQ')&&document.getElementById('globalQ').value||'').trim().toLowerCase();
  var el=document.getElementById('searchResults');
  if(!q){el.innerHTML=emptyState('🔍','اكتب اسم المريض أو رقم الهاتف للبحث');return;}
  var patients=G('patients',[]).filter(function(p){return p.name.toLowerCase().includes(q)||p.phone.includes(q);});
  if(!patients.length){el.innerHTML=emptyState('😕','لا توجد نتائج لـ "'+q+'"');return;}
  var plans=G('plans',[]),plansByPt={};
  plans.forEach(function(pl){(plansByPt[pl.patientId]||(plansByPt[pl.patientId]=[])).push(pl);});
  el.innerHTML='<div style="font-size:12px;color:var(--gray5);font-weight:700;margin-bottom:10px">'+patients.length+' نتيجة</div>'+patients.map(function(p){
    var pp=plansByPt[p.id]||[];
    var active=pp.filter(function(x){return x.status!=='completed';}).length;
    var debt=pp.reduce(function(s,x){return s+(x.debtAmount||0);},0);
    return '<div class="card" style="margin-bottom:10px;cursor:pointer" onclick="openProfile(\''+p.id+'\')"><div class="card-body" style="display:flex;align-items:center;justify-content:space-between;gap:12px"><div style="display:flex;align-items:center;gap:12px"><div style="width:44px;height:44px;background:var(--blue);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px">👤</div><div><div style="font-weight:800;font-size:15px">'+p.name+'</div><div style="font-size:12px;color:var(--gray5)">📞 '+p.phone+(p.age?' • '+p.age+' سنة':'')+(p.gender?' • '+p.gender:'')+'</div><div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">'+(active?'<span class="badge badge-orange">'+active+' خطة نشطة</span>':'')+(debt>0?'<span class="badge badge-red">دين '+debt.toLocaleString()+' د.ع</span>':'')+((!active&&!debt)?'<span class="badge badge-gray">لا خطط نشطة</span>':'')+'</div></div></div><button class="btn btn-primary btn-sm">فتح الملف ←</button></div></div>';
  }).join('');
}

// ═══════════════════════════════════════════════════
//  INVENTORY
// ═══════════════════════════════════════════════════
function renderInventory(){
  var items=G('inventory',[]);
  var fCat=document.getElementById('invFCat')&&document.getElementById('invFCat').value||'';
  var filtered=fCat?items.filter(function(i){return i.cat===fCat;}):items;
  var pending=filtered.filter(function(i){return i.status!=='bought';}),bought=filtered.filter(function(i){return i.status==='bought';});
  var urgent=pending.filter(function(i){return i.priority==='urgent';});
  document.getElementById('invStats').innerHTML=
    '<div class="stat-box" style="'+(urgent.length?'border-color:var(--red);background:var(--red-lt)':'')+'"><span class="s-icon">🔴</span><div class="s-label">عاجل</div><div class="s-val" style="color:var(--red)">'+urgent.length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">⏳</span><div class="s-label">بانتظار الشراء</div><div class="s-val" style="color:var(--orange)">'+pending.length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">✅</span><div class="s-label">تم الشراء</div><div class="s-val" style="color:var(--green)">'+bought.length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📋</span><div class="s-label">إجمالي الطلبات</div><div class="s-val">'+items.length+'</div></div>';
  var smap=sm();
  function itemRow(it){
    var req=smap[it.requestedBy];
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--gray2)"><div><div class="flex gap-8"><span class="fw-700">'+(it.priority==='urgent'?'🔴 ':'')+it.name+'</span><span class="badge badge-gray text-muted">'+it.cat+'</span></div>'+(it.unit?'<div class="text-muted mt-4">الكمية: '+it.unit+'</div>':'')+(it.note?'<div class="text-muted mt-4">'+it.note+'</div>':'')+'<div class="text-muted mt-4">طلب من: '+(req?req.name:'-')+' • '+it.createdAt+'</div></div><div style="display:flex;gap:4px">'+(it.status!=='bought'?'<button class="btn btn-success btn-xs" onclick="markBought(\''+it.id+'\')">✅</button>':'<span class="badge badge-green">تم</span>')+'<button class="btn btn-danger btn-xs" onclick="delItem(\''+it.id+'\')">🗑</button></div></div>';
  }
  var ps=document.getElementById('invPendingSection');
  ps.innerHTML=pending.length?'<div class="card" style="margin-bottom:14px"><div class="card-header"><span class="card-title">⏳ بانتظار الشراء ('+pending.length+')</span></div><div class="card-body">'+pending.map(itemRow).join('')+'</div></div>':'';
  var bs=document.getElementById('invBoughtSection');
  bs.innerHTML=bought.length?'<div class="card"><div class="card-header"><span class="card-title">✅ تم الشراء ('+bought.length+')</span></div><div class="card-body">'+bought.map(itemRow).join('')+'</div></div>':'';
}
function saveItem(){
  var name=(document.getElementById('itemName').value||'').trim();
  if(!name){alert('اسم المادة مطلوب');return;}
  var items=G('inventory',[]);
  items.push({id:'inv'+uid(),name:name,cat:document.getElementById('itemCat').value,unit:document.getElementById('itemUnit').value,priority:document.getElementById('itemPriority').value,note:document.getElementById('itemNote').value,status:'pending',requestedBy:CU&&CU.id,createdAt:today()});
  S('inventory',items);closeModal('mo-addItem');
  ['itemName','itemUnit','itemNote'].forEach(function(id){document.getElementById(id).value='';});
  renderInventory();
}
function markBought(id){
  // Use the new receive flow with cash/credit choice
  if (typeof openReceivePurchase === 'function') { openReceivePurchase(id); return; }
  // Fallback (shouldn't happen if module loaded)
  var items=G('inventory',[]); var it=items.find(function(x){return x.id===id;});
  if(it)it.status='bought'; S('inventory',items); renderInventory();
}
function delItem(id){if(!confirm('حذف الطلب؟'))return;S('inventory',G('inventory',[]).filter(function(x){return x.id!==id;}));renderInventory();}
function printInventory(){
  var items=G('inventory',[]).filter(function(i){return i.status!=='bought';});
  var clinic=G('clinic',{name:'العيادة'});
  var smap=sm();
  function rows(arr){return arr.map(function(it){var req=smap[it.requestedBy];return '<tr><td>'+(it.priority==='urgent'?'🔴 ':'')+it.name+'</td><td>'+(it.unit||'-')+'</td><td>'+it.cat+'</td><td>'+(it.note||'-')+'</td><td>'+(req?req.name:'-')+'</td><td>'+it.createdAt+'</td></tr>';}).join('');}
  var urgent=items.filter(function(i){return i.priority==='urgent';}),normal=items.filter(function(i){return i.priority!=='urgent';});
  var html='<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><style>body{font-family:Tahoma,Arial;direction:rtl;padding:20px;color:#0f2030}h2{color:#083d55}table{width:100%;border-collapse:collapse;margin-top:12px}th{background:#083d55;color:white;padding:8px 10px;font-size:12px}td{padding:8px 10px;border-bottom:1px solid #ccd7df;font-size:12px}.t{font-weight:800;font-size:14px;margin:16px 0 6px;color:#083d55}@media print{button{display:none}}</style></head><body><h2>🛒 قائمة المشتريات — '+clinic.name+'</h2><div>التاريخ: '+today()+' | الإجمالي: '+items.length+'</div>'+(urgent.length?'<div class="t">🔴 عاجل ('+urgent.length+')</div><table><thead><tr><th>المادة</th><th>الكمية</th><th>الفئة</th><th>ملاحظة</th><th>طلب من</th><th>التاريخ</th></tr></thead><tbody>'+rows(urgent)+'</tbody></table>':'')+'<div class="t">📋 عادي ('+normal.length+')</div><table><thead><tr><th>المادة</th><th>الكمية</th><th>الفئة</th><th>ملاحظة</th><th>طلب من</th><th>التاريخ</th></tr></thead><tbody>'+rows(normal)+'</tbody></table><scr'+'ipt>window.print();</scr'+'ipt></body></html>';
  var w=window.open('','_blank'); if(w){w.document.write(html);w.document.close();}
}

// ═══════════════════════════════════════════════════
//  MARKETING
// ═══════════════════════════════════════════════════
var MKT_SEGS=[{id:'implant',label:'🦷 زراعة',color:'#a87c00'},{id:'ortho',label:'🔧 تقويم',color:'#6c2fa0'},{id:'crown',label:'👑 تيجان',color:'#0d5c7a'},{id:'nerve',label:'🩺 عصب',color:'#c96a00'},{id:'extract',label:'🔩 قلع',color:'#d62c1a'},{id:'filling',label:'🪥 حشوات',color:'#1a9e4e'},{id:'cleaning',label:'✨ تنظيف',color:'#1474a0'}];
var MKT_TPLS={implant:'السلام عليكم {name},\nعيادة سوران تتشرف بخدمتكم 🦷\nلدينا أحدث تقنيات زراعة الأسنان.\nللاستفسار: {phone}',ortho:'السلام عليكم {name},\nهل تفكر في تقويم الأسنان؟ 😊\nعيادة سوران توفر أفضل أجهزة التقويم.\nتواصل معنا: {phone}',checkup:'السلام عليكم {name},\nعيادة سوران تذكّركم بموعد الكشف الدوري 🌟\nللحجز: {phone}',offer:'السلام عليكم {name},\nعيادة سوران تقدم لكم عرضاً خاصاً! 🎁\n[أضف تفاصيل العرض]\nللاستفسار: {phone}'};
var _mktMode='type',_mktSegs=new Set(),_mktSelected=new Set();

function mktMatchSeg(pp,seg){
  if(seg==='implant')return pp.some(function(pl){return pl.planType==='implant';});
  if(seg==='ortho')return pp.some(function(pl){return pl.planType==='ortho';});
  if(seg==='crown')return pp.some(function(pl){return/(تاج|جسر|تلبيس)/i.test(pl.description);});
  if(seg==='nerve')return pp.some(function(pl){return/(عصب|جذر)/i.test(pl.description);});
  if(seg==='extract')return pp.some(function(pl){return/(قلع|خلع)/i.test(pl.description);});
  if(seg==='filling')return pp.some(function(pl){return/(حشو)/i.test(pl.description);});
  if(seg==='cleaning')return pp.some(function(pl){return/(تنظيف|جير)/i.test(pl.description);});
  return false;
}
function mktPlanLabel(pl){if(pl.planType==='implant')return '🦷 زراعة';if(pl.planType==='ortho')return '🔧 تقويم';var d=pl.description||'';if(/(تاج|جسر)/.test(d))return '👑 تيجان';if(/(عصب|جذر)/.test(d))return '🩺 عصب';if(/(قلع|خلع)/.test(d))return '🔩 قلع';if(/(حشو)/.test(d))return '🪥 حشوة';if(/(تنظيف|جير)/.test(d))return '✨ تنظيف';return '🔬 علاج';}
function mktGetVisible(){
  var patients=G('patients',[]),plans=G('plans',[]);
  var byPt={};plans.forEach(function(pl){(byPt[pl.patientId]||(byPt[pl.patientId]=[])).push(pl);});
  return patients.filter(function(p){
    var pp=byPt[p.id]||[];
    if(_mktMode==='type'){if(_mktSegs.size===0)return false;return [..._mktSegs].some(function(seg){return mktMatchSeg(pp,seg);});}
    if(_mktMode==='manual'){var q=(document.getElementById('mktSearch')&&document.getElementById('mktSearch').value||'').toLowerCase();if(q)return p.name.toLowerCase().includes(q)||(p.phone||'').includes(q);}
    if(_mktMode==='all')return !!p.phone;
    return true;
  });
}
function renderMarketing(){
  var patients=G('patients',[]),plans=G('plans',[]);
  var byPt={};plans.forEach(function(pl){(byPt[pl.patientId]||(byPt[pl.patientId]=[])).push(pl);});
  document.getElementById('mktSegmentTabs').innerHTML=MKT_SEGS.map(function(seg){
    var count=patients.filter(function(p){return mktMatchSeg(byPt[p.id]||[],seg.id);}).length;
    var on=_mktSegs.has(seg.id);
    return '<button onclick="mktToggleSeg(\''+seg.id+'\')" style="display:inline-flex;align-items:center;gap:5px;padding:7px 13px;border-radius:18px;border:2px solid '+(on?seg.color:'var(--border)')+';background:'+(on?seg.color:'#fff')+';color:'+(on?'#fff':seg.color)+';font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">'+seg.label+' <span style="background:'+(on?'rgba(255,255,255,.3)':'var(--gray2)')+';padding:1px 7px;border-radius:10px;font-size:10px">'+count+'</span></button>';
  }).join('');
  var visible=mktGetVisible();
  var withPhone=patients.filter(function(p){return p.phone;}).length;
  document.getElementById('mktStats').innerHTML=
    '<div class="stat-box"><span class="s-icon">👥</span><div class="s-label">إجمالي المرضى</div><div class="s-val">'+patients.length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📱</span><div class="s-label">لديهم هاتف</div><div class="s-val" style="color:var(--green)">'+withPhone+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">👁️</span><div class="s-label">يظهرون الآن</div><div class="s-val" style="color:var(--blue2)">'+visible.length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">☑️</span><div class="s-label">محدد للإرسال</div><div class="s-val" style="color:var(--orange)">'+_mktSelected.size+'</div></div>';
  var lc=document.getElementById('mktListCount'); if(lc)lc.textContent=visible.length+' مريض';
  var ca=document.getElementById('mktChkAll'); if(ca)ca.checked=visible.length>0&&visible.every(function(p){return _mktSelected.has(p.id);});
  var tbody=document.getElementById('mktBody');
  if(!visible.length){tbody.innerHTML='<tr><td colspan="6">'+emptyState('🎯','لا توجد نتائج')+'</td></tr>';return;}
  tbody.innerHTML=visible.map(function(p){
    var pp=byPt[p.id]||[];
    var types=[...new Set(pp.map(mktPlanLabel))].join('، ');
    var active=pp.filter(function(x){return x.status!=='completed';}).length;
    var debt=pp.some(function(x){return (x.debtAmount||0)>0;});
    var chk=_mktSelected.has(p.id);
    return '<tr style="'+(chk?'background:#edf8ff':'')+'"><td><input type="checkbox" '+(chk?'checked':'')+' onchange="mktToggleOne(\''+p.id+'\',this.checked)"></td><td class="fw-700">'+p.name+'</td><td>'+(p.phone?'<a href="tel:'+p.phone+'" style="color:var(--blue2);font-weight:700">'+p.phone+'</a>':'—')+'</td><td class="text-muted" style="font-size:12px">'+(types||'—')+'</td><td>'+(active?'<span class="badge badge-orange">نشط</span> ':'')+( debt?'<span class="badge badge-red">دين</span>':'')+(!active&&!debt?'<span class="badge badge-gray">منتهي</span>':'')+'</td><td>'+(p.phone?'<button class="btn btn-success btn-xs" onclick="mktSendOne(\''+p.id+'\')">💬</button>':'')+'</td></tr>';
  }).join('');
}
function mktSetMode(mode){
  _mktMode=mode;_mktSelected.clear();_mktSegs.clear();
  ['type','manual','all'].forEach(function(m){
    var btn=document.getElementById('mktModeBtn-'+m);if(btn)btn.className=m===mode?'btn btn-primary btn-sm':'btn btn-ghost btn-sm';
    var el=document.getElementById('mktMode'+m.charAt(0).toUpperCase()+m.slice(1));if(el)el.style.display=m===mode?'':'none';
  });
  if(mode==='all')G('patients',[]).filter(function(p){return p.phone;}).forEach(function(p){_mktSelected.add(p.id);});
  renderMarketing();
}
function mktToggleSeg(seg){
  if(_mktSegs.has(seg))_mktSegs.delete(seg);else _mktSegs.add(seg);
  _mktSelected.clear();mktGetVisible().forEach(function(p){_mktSelected.add(p.id);});renderMarketing();
}
function mktToggleOne(pid,chk){if(chk)_mktSelected.add(pid);else _mktSelected.delete(pid);renderMarketing();}
function mktToggleAll(chk){mktGetVisible().forEach(function(p){chk?_mktSelected.add(p.id):_mktSelected.delete(p.id);});renderMarketing();}
function mktTpl(type){var clinic=G('clinic',{phone:''});var el=document.getElementById('mktMsg');if(el)el.value=(MKT_TPLS[type]||'').replace(/\{phone\}/g,clinic.phone||'');}
function mktBuildMsg(p){var clinic=G('clinic',{phone:''});return (document.getElementById('mktMsg').value||'').replace(/\{name\}/g,p.name).replace(/\{phone\}/g,clinic.phone||'');}
function mktSendAll(){
  var msg=document.getElementById('mktMsg').value||'';if(!msg.trim()){alert('اكتب نص الرسالة أولاً');return;}
  var pts=G('patients',[]).filter(function(p){return _mktSelected.has(p.id)&&p.phone;});
  if(!pts.length){alert('حدد مرضى لديهم رقم هاتف أولاً');return;}
  if(!confirm('سيتم فتح واتساب لـ '+pts.length+' مريض. هل تريد المتابعة؟'))return;
  pts.forEach(function(p,i){setTimeout(function(){var n=p.phone.replace(/\D/g,'');window.open('https://wa.me/'+(n.startsWith('0')?'964'+n.slice(1):n)+'?text='+encodeURIComponent(mktBuildMsg(p)),'_blank');},i*700);});
}
function mktSendOne(pid){var p=G('patients',[]).find(function(x){return x.id===pid;});if(!p)return;var msg=document.getElementById('mktMsg').value||'';if(!msg.trim()){alert('اكتب نص الرسالة أولاً');return;}var n=p.phone.replace(/\D/g,'');window.open('https://wa.me/'+(n.startsWith('0')?'964'+n.slice(1):n)+'?text='+encodeURIComponent(mktBuildMsg(p)),'_blank');}
function mktCopyNums(){var pts=G('patients',[]).filter(function(p){return _mktSelected.has(p.id)&&p.phone;});navigator.clipboard.writeText(pts.map(function(p){return p.phone;}).join('\n')).then(function(){alert('✅ تم نسخ '+pts.length+' رقم');});}
function mktExportCSV(){
  var pts=G('patients',[]).filter(function(p){return _mktSelected.has(p.id);});
  if(!pts.length){alert('حدد مرضى أولاً');return;}
  var plans=G('plans',[]),byPt={};plans.forEach(function(pl){(byPt[pl.patientId]||(byPt[pl.patientId]=[])).push(pl);});
  var rows=[['الاسم','الهاتف','العمر','الجنس','أنواع العلاج']];
  pts.forEach(function(p){rows.push([p.name,p.phone||'',p.age||'',p.gender||'',[...new Set((byPt[p.id]||[]).map(mktPlanLabel))].join(' | ')]);});
  var csv=rows.map(function(r){return r.map(function(v){return '"'+v+'"';}).join(',');}).join('\n');
  var a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));a.download='soran-marketing-'+today()+'.csv';a.click();
}

// ═══════════════════════════════════════════════════
//  MY FILE (patient view)
// ═══════════════════════════════════════════════════
function renderMyFile(){
  if(!CU)return;
  var p=G('patients',[]).find(function(x){return x.id===CU.id;});
  if(!p){
    document.getElementById('myStats').innerHTML=emptyState('👤','لم يتم ربط حسابك بملف مريض');
    document.getElementById('myPlans').innerHTML='';
    var hdr=document.getElementById('myPlansHdr'); if(hdr)hdr.style.display='none';
    ['myNextAppt','myDebt','myQuickActions','myRecommendedArticles'].forEach(function(id){
      var el=document.getElementById(id); if(el)el.innerHTML='';
    });
    return;
  }
  CPid=CU.id;
  var plans=G('plans',[]).filter(function(pl){return pl.patientId===CU.id;});
  var appts=G('appointments',[]).filter(function(a){return a.patientId===CU.id;});
  var pays=G('payments',[]).filter(function(py){return py.patientId===CU.id;});
  var smap=sm();
  var clinic=G('clinic',{});

  // ── Next appointment card (prominent) ──
  var todayStr=today();
  var upcoming=appts.filter(function(a){
    return (a.status==='scheduled'||a.status==='arrived') && a.date>=todayStr;
  }).sort(function(a,b){
    var ka=a.date+' '+(a.time||'00:00');
    var kb=b.date+' '+(b.time||'00:00');
    return ka<kb?-1:1;
  });
  var nextEl=document.getElementById('myNextAppt');
  if(upcoming.length){
    var na=upcoming[0];
    var doc=smap[na.doctorId];
    var dateObj=new Date(na.date+'T'+(na.time||'09:00'));
    var daysLeft=Math.ceil((dateObj-new Date())/(1000*60*60*24));
    var dayLbl=daysLeft<=0?'اليوم':daysLeft===1?'غداً':'بعد '+daysLeft+' أيام';
    var clinicPhone=clinic.phone?normalizePhoneIQ(clinic.phone):'';
    nextEl.innerHTML='<div style="background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;border-radius:14px;padding:18px;margin-bottom:14px;box-shadow:0 4px 14px rgba(22,163,74,.25)">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">'+
        '<div><div style="font-size:11px;opacity:.85;font-weight:700">📅 موعدك القادم</div>'+
          '<div style="font-size:22px;font-weight:900;margin-top:4px">'+dayLbl+'</div></div>'+
        '<div style="background:rgba(255,255,255,.18);padding:6px 12px;border-radius:20px;font-size:11px;font-weight:700">'+na.date+'</div>'+
      '</div>'+
      '<div style="font-size:13px;opacity:.95;line-height:1.7">'+
        (na.time?'⏰ الساعة '+na.time+'<br>':'')+
        (doc?'👨‍⚕️ '+doc.name+'<br>':'')+
        (na.type?'📝 '+na.type:'')+
      '</div>'+
      (clinicPhone?'<div style="display:flex;gap:8px;margin-top:14px">'+
        '<a href="tel:'+clinicPhone+'" style="flex:1;background:rgba(255,255,255,.18);color:#fff;text-align:center;padding:10px;border-radius:8px;text-decoration:none;font-weight:700;font-size:12px">📞 اتصال</a>'+
        '<a href="https://wa.me/964'+clinicPhone+'?text=السلام عليكم، بخصوص موعدي" target="_blank" style="flex:1;background:rgba(255,255,255,.18);color:#fff;text-align:center;padding:10px;border-radius:8px;text-decoration:none;font-weight:700;font-size:12px">💬 واتساب</a>'+
      '</div>':'')+
    '</div>';
  } else {
    nextEl.innerHTML='<div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:12px;padding:14px;margin-bottom:14px;text-align:center">'+
      '<div style="font-size:13px;color:#166534;font-weight:700;margin-bottom:8px">📅 لا توجد مواعيد قادمة</div>'+
      '<button onclick="navTo(\'bookappt\')" class="btn btn-success btn-sm">+ احجز موعداً جديداً</button>'+
    '</div>';
  }

  // ── Stats ──
  document.getElementById('myStats').innerHTML=
    '<div class="stat-box"><span class="s-icon">📋</span><div class="s-label">خطط العلاج</div><div class="s-val">'+plans.length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">✅</span><div class="s-label">مكتملة</div><div class="s-val">'+plans.filter(function(x){return x.status==='completed';}).length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📅</span><div class="s-label">المواعيد</div><div class="s-val">'+appts.length+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">💳</span><div class="s-label">إجمالي المدفوع</div><div class="s-val">'+pays.reduce(function(s,py){return s+(py.amount||0);},0).toLocaleString()+'</div></div>';

  // ── Outstanding balance ──
  var totalDue=0, totalPaid=0;
  plans.forEach(function(pl){
    if(pl.status!=='completed'){
      totalDue+=(pl.totalCost||0);
      totalPaid+=(pl.paidAmount||0);
    }
  });
  var debt=Math.max(0,totalDue-totalPaid);
  var debtEl=document.getElementById('myDebt');
  if(debt>0){
    debtEl.innerHTML='<div style="background:#fef2f2;border:1.5px solid #fecaca;border-right:5px solid #dc2626;border-radius:10px;padding:12px 14px;margin-bottom:12px">'+
      '<div style="display:flex;justify-content:space-between;align-items:center">'+
        '<div><div style="font-size:11px;color:#991b1b;font-weight:700">⚠️ مبلغ متبقّي للدفع</div>'+
        '<div style="font-size:20px;font-weight:900;color:#dc2626;margin-top:2px">'+debt.toLocaleString()+' د.ع</div></div>'+
        '<div style="font-size:32px">💳</div>'+
      '</div>'+
    '</div>';
  } else { debtEl.innerHTML=''; }

  // ── Quick actions ──
  var rxCount=plans.reduce(function(s,pl){
    return s+(pl.sessionRecords||[]).reduce(function(ss,r){return ss+((r.medications&&r.medications.length)?1:0);},0);
  },0);
  var consentCount=G('consents',[]).filter(function(c){return c.patientId===CU.id;}).length;
  document.getElementById('myQuickActions').innerHTML=
    '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:14px">'+
      '<button onclick="navTo(\'myrx\')" class="btn btn-ghost" style="padding:14px 10px;display:flex;flex-direction:column;align-items:center;gap:4px;background:#fff;border:1.5px solid var(--border)">'+
        '<div style="font-size:24px">💊</div>'+
        '<div style="font-size:12px;font-weight:700">وصفاتي ('+rxCount+')</div>'+
      '</button>'+
      '<button onclick="navTo(\'myconsents\')" class="btn btn-ghost" style="padding:14px 10px;display:flex;flex-direction:column;align-items:center;gap:4px;background:#fff;border:1.5px solid var(--border)">'+
        '<div style="font-size:24px">📄</div>'+
        '<div style="font-size:12px;font-weight:700">موافقاتي ('+consentCount+')</div>'+
      '</button>'+
      '<button onclick="navTo(\'articles\')" class="btn btn-ghost" style="padding:14px 10px;display:flex;flex-direction:column;align-items:center;gap:4px;background:#fff;border:1.5px solid var(--border)">'+
        '<div style="font-size:24px">📚</div>'+
        '<div style="font-size:12px;font-weight:700">المكتبة الطبية</div>'+
      '</button>'+
      '<button onclick="navTo(\'myinquiries\')" class="btn btn-ghost" style="padding:14px 10px;display:flex;flex-direction:column;align-items:center;gap:4px;background:#fff;border:1.5px solid var(--border)">'+
        '<div style="font-size:24px">💬</div>'+
        '<div style="font-size:12px;font-weight:700">استفساراتي</div>'+
      '</button>'+
    '</div>';

  // ── Plans ──
  var plansHdr=document.getElementById('myPlansHdr');
  if(plans.length){ plansHdr.style.display='block'; }
  else { plansHdr.style.display='none'; }
  document.getElementById('myPlans').innerHTML=plans.length?plans.map(function(pl){return planCard(pl,smap);}).join(''):emptyState('📋','لا توجد خطط علاج بعد');

  // ── Recommended articles based on plan types ──
  var recEl=document.getElementById('myRecommendedArticles');
  var planTypes=new Set();
  plans.forEach(function(pl){
    if(pl.status==='completed')return;
    planTypes.add(pl.planType||'general');
    var desc=String(pl.description||'').toLowerCase();
    // Detect extractions (planType is 'general' but description mentions قلع/خلع)
    if(/قلع|خلع|extract/.test(desc)){
      planTypes.add('extraction');
      if(/عقل|ضرس العقل|wisdom/.test(desc)) planTypes.add('wisdom');
    }
    // Detect whitening
    if(/تبييض|whitening|bleach/.test(desc)) planTypes.add('whitening');
    // Detect cosmetic (veneers / Hollywood)
    if(/فينير|قشور|هوليوود|veneer|laminate|لومينير|cosmetic|تجميل/.test(desc)) planTypes.add('cosmetic');
    // Detect root canal treatment
    if(/عصب|جذر|rct|root canal|endodont|سحب العصب/.test(desc)) planTypes.add('root_canal');
    if(pl.planType==='ortho' && pl.orthoDev){
      var od=String(pl.orthoDev).toLowerCase();
      if(/aligner/.test(od))planTypes.add('aligners');
      if(/headgear|هيد|رأس/.test(od))planTypes.add('headgear');
      if(/expander|موسّع|موسع/.test(od))planTypes.add('expander');
      if(/elastic|مطاط/.test(od))planTypes.add('elastics');
      if(/retainer|مثبّت|مثبت/.test(od)){
        if(/fixed|ثابت/.test(od))planTypes.add('retainer_fixed');
        else planTypes.add('retainer_removable');
      }
    }
  });
  // Map plan types to recommended article IDs
  var TYPE_TO_ARTICLES={
    ortho:['a1'], aligners:['a2'], implant:['a3','a17'], general:['a4','a5'],
    cleaning:['a4','a5'], headgear:['a7'], expander:['a8'],
    retainer_removable:['a9'], retainer_fixed:['a10'],
    elastics:['a11'],
    extraction:['a13','a14','a15'], wisdom:['a16','a14','a15'],
    whitening:['a18'], cosmetic:['a19','a18'], root_canal:['a20']
  };
  var recIds=new Set();
  planTypes.forEach(function(t){ (TYPE_TO_ARTICLES[t]||[]).forEach(function(id){recIds.add(id);}); });
  // Default: brushing article + a recent care article
  if(!recIds.size){ recIds.add('a4'); recIds.add('a5'); }
  var recArticles=ARTICLES.filter(function(a){return recIds.has(a.id);}).slice(0,4);
  if(recArticles.length){
    recEl.innerHTML='<div style="margin-top:18px">'+
      '<div style="font-size:14px;font-weight:800;color:var(--gray6);margin-bottom:10px;padding-right:4px">📚 مقالات موصى بها لحالتك</div>'+
      recArticles.map(function(a){
        return '<div onclick="openArticle(\''+a.id+'\')" style="background:#fff;border:1.5px solid var(--border);border-right:4px solid '+a.color+';border-radius:10px;padding:12px;margin-bottom:8px;cursor:pointer;display:flex;gap:12px;align-items:center">'+
          '<div style="font-size:28px">'+a.icon+'</div>'+
          '<div style="flex:1">'+
            '<div style="font-size:9px;color:'+a.color+';font-weight:800;text-transform:uppercase;letter-spacing:.5px">'+a.category+'</div>'+
            '<div style="font-size:13px;font-weight:800;color:var(--gray6);margin-top:2px;line-height:1.4">'+a.title+'</div>'+
            '<div style="font-size:11px;color:var(--gray4);margin-top:3px">⏱️ '+a.readTime+'</div>'+
          '</div>'+
          '<div style="color:var(--gray4);font-size:18px">←</div>'+
        '</div>';
      }).join('')+
      '<button class="btn btn-ghost btn-sm btn-block" onclick="navTo(\'articles\')" style="margin-top:6px">عرض جميع المقالات →</button>'+
    '</div>';
  } else { recEl.innerHTML=''; }
}

// ═══════════════════════════════════════════════════
//  PATIENT — MY PRESCRIPTIONS
// ═══════════════════════════════════════════════════
function renderMyRx(){
  if(!CU || CU.role!=='patient')return;
  var el=document.getElementById('myRxList');
  if(!el)return;
  var plans=G('plans',[]).filter(function(pl){return pl.patientId===CU.id;});
  var smap=sm();
  // Collect all prescriptions across all sessions
  var allRx=[];
  plans.forEach(function(pl){
    (pl.sessionRecords||[]).forEach(function(rec,idx){
      if((rec.medications&&rec.medications.length) || (rec.tips&&rec.tips.length)){
        allRx.push({
          planDesc:pl.description,
          planType:pl.planType,
          sessionIdx:rec.index!=null?rec.index:idx,
          date:rec.date||rec.savedAt||'',
          doctorId:rec.doctorId||pl.doctorId,
          medications:rec.medications||[],
          tips:rec.tips||[]
        });
      }
    });
  });
  allRx.sort(function(a,b){return (b.date||'').localeCompare(a.date||'');});
  if(!allRx.length){
    el.innerHTML=emptyState('💊','لم تُصرف لك وصفات طبية بعد');
    return;
  }
  el.innerHTML=allRx.map(function(rx){
    var doc=smap[rx.doctorId];
    var typeIcon=rx.planType==='implant'?'🦷':rx.planType==='ortho'?'🔧':'🔬';
    return '<div class="card" style="margin-bottom:10px"><div class="card-body">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;padding-bottom:10px;border-bottom:1px dashed var(--border)">'+
        '<div><div style="font-size:13px;font-weight:800;color:var(--gray6)">'+typeIcon+' '+(rx.planDesc||'-')+'</div>'+
          '<div style="font-size:11px;color:var(--gray5);margin-top:3px">📅 جلسة '+(rx.sessionIdx+1)+' • '+(rx.date||'-')+(doc?' • 👨‍⚕️ '+doc.name:'')+'</div></div>'+
      '</div>'+
      (rx.medications.length?'<div style="margin-bottom:10px"><div style="font-size:11px;font-weight:700;color:var(--blue2);margin-bottom:6px">💊 الأدوية:</div>'+
        rx.medications.map(function(m){
          return '<div style="background:#f0f9ff;border-right:3px solid var(--blue2);padding:8px 10px;border-radius:6px;margin-bottom:4px">'+
            '<div style="font-weight:700;font-size:13px;color:var(--gray6)">'+(m.n||m.name||'دواء')+(m.d?' • '+m.d:'')+'</div>'+
            (m.note?'<div style="font-size:11px;color:var(--gray5);margin-top:2px">'+m.note+'</div>':'')+
            (m.dur?'<div style="font-size:10px;color:var(--gray4);margin-top:2px">⏱️ المدة: '+m.dur+'</div>':'')+
          '</div>';
        }).join('')+'</div>':'')+
      (rx.tips.length?'<div><div style="font-size:11px;font-weight:700;color:#16a34a;margin-bottom:6px">🌿 نصائح:</div>'+
        '<ul style="font-size:12px;color:var(--gray6);line-height:1.7;padding-right:18px;margin:0">'+
        rx.tips.map(function(t){return '<li>'+(typeof t==='string'?t:(t.text||''))+'</li>';}).join('')+
        '</ul></div>':'')+
    '</div></div>';
  }).join('');
}

// ═══════════════════════════════════════════════════
//  PATIENT — MY CONSENTS (read-only)
// ═══════════════════════════════════════════════════
function renderMyConsents(){
  if(!CU || CU.role!=='patient')return;
  var el=document.getElementById('myConsentsList');
  if(!el)return;
  var list=G('consents',[]).filter(function(c){return c.patientId===CU.id;});
  if(!list.length){
    el.innerHTML=emptyState('📄','لا توجد موافقات بعد');
    return;
  }
  list.sort(function(a,b){return (b.createdAt||'').localeCompare(a.createdAt||'');});
  var smap=sm();
  el.innerHTML=list.map(function(c){
    var d=new Date(c.createdAt||Date.now()).toLocaleDateString('en-GB');
    var statusBadge,signedInfo='';
    if(c.status==='signed'){
      statusBadge='<span class="badge badge-green">✓ موقّعة</span>';
      var signedDate=c.signedAt?new Date(c.signedAt).toLocaleDateString('en-GB'):'';
      signedInfo='<div style="font-size:10px;color:var(--gray4);margin-top:6px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:6px 8px">✓ وُقّعت في '+signedDate+'</div>';
    } else {
      statusBadge='<span class="badge badge-orange">⏳ بانتظار التوقيع</span>';
    }
    return '<div class="card" style="margin-bottom:10px"><div class="card-body" style="padding:12px 14px">'+
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">'+
        '<div style="font-size:24px">'+csTypeIcon(c.type)+'</div>'+
        '<div style="flex:1"><div style="font-weight:800;font-size:13px;color:var(--gray6)">'+(c.title||csTypeLabel(c.type))+'</div>'+
          '<div style="font-size:11px;color:var(--gray5);margin-top:2px">📅 '+d+' • '+csTypeLabel(c.type)+'</div></div>'+
        statusBadge+
      '</div>'+
      signedInfo+
    '</div></div>';
  }).join('');
}

// ═══════════════════════════════════════════════════
//  DENTAL CHART
// ═══════════════════════════════════════════════════
var TEETH={ur:[18,17,16,15,14,13,12,11],ul:[21,22,23,24,25,26,27,28],ll:[31,32,33,34,35,36,37,38],lr:[41,42,43,44,45,46,47,48]};
var selTeeth=new Set();
function buildChart(){
  selTeeth=new Set();
  var mkRow=function(teeth){return teeth.map(function(n){return '<button type="button" class="t-btn" id="tb-'+n+'" onclick="togTooth('+n+')"><span class="t-n">'+n+'</span><span class="t-i">🦷</span></button>';}).join('');};
  document.getElementById('dcUR').innerHTML=mkRow(TEETH.ur);
  document.getElementById('dcUL').innerHTML=mkRow(TEETH.ul);
  document.getElementById('dcLL').innerHTML=mkRow(TEETH.ll);
  document.getElementById('dcLR').innerHTML=mkRow(TEETH.lr);
}
function togTooth(n){
  if(selTeeth.has(n))selTeeth.delete(n);else selTeeth.add(n);
  document.getElementById('tb-'+n).classList.toggle('sel',selTeeth.has(n));
  dcSyncDisplay();
}

// ─── Dental chart bulk actions (used by the addPlan modal) ───
function dcSyncDisplay(){
  var sorted=[...selTeeth].sort(function(a,b){return a-b;});
  var ti=document.getElementById('tpTeeth');     if(ti) ti.value=sorted.join('، ');
  var dd=document.getElementById('dcDisplay');   if(dd) dd.textContent=sorted.length?'الأسنان المحددة: '+sorted.join('، '):'لم يتم تحديد أسنان';
}
function dcSelectAll(){
  selTeeth=new Set([].concat(TEETH.ur,TEETH.ul,TEETH.ll,TEETH.lr));
  selTeeth.forEach(function(n){var b=document.getElementById('tb-'+n);if(b)b.classList.add('sel');});
  dcSyncDisplay();
}
function dcSelectUpper(){
  // Add upper jaw, leave lower as-is (no toggle behaviour here)
  [].concat(TEETH.ur,TEETH.ul).forEach(function(n){
    selTeeth.add(n);
    var b=document.getElementById('tb-'+n); if(b) b.classList.add('sel');
  });
  dcSyncDisplay();
}
function dcSelectLower(){
  [].concat(TEETH.ll,TEETH.lr).forEach(function(n){
    selTeeth.add(n);
    var b=document.getElementById('tb-'+n); if(b) b.classList.add('sel');
  });
  dcSyncDisplay();
}
function dcClearAll(){
  selTeeth.forEach(function(n){var b=document.getElementById('tb-'+n);if(b)b.classList.remove('sel');});
  selTeeth=new Set();
  dcSyncDisplay();
}

// ═══════════════════════════════════════════════════
//  PRESCRIPTION
// ═══════════════════════════════════════════════════
var DRUGS=[
  {n:'أموكسيسيلين',d:'500mg',dur:'5 أيام',note:'3 مرات يومياً بعد الأكل',cat:'مضاد حيوي'},
  {n:'أوجمنتين',d:'625mg',dur:'7 أيام',note:'مرتين يومياً بعد الأكل',cat:'مضاد حيوي'},
  {n:'فلاجيل',d:'500mg',dur:'5 أيام',note:'3 مرات يومياً أثناء الأكل',cat:'مضاد حيوي'},
  {n:'كليندامايسين',d:'300mg',dur:'7 أيام',note:'3 مرات يومياً',cat:'مضاد حيوي'},
  {n:'إيبوبروفين',d:'400mg',dur:'3 أيام',note:'3 مرات يومياً بعد الأكل',cat:'مسكن'},
  {n:'باراسيتامول',d:'500mg',dur:'حسب الحاجة',note:'كل 6 ساعات عند الألم',cat:'مسكن'},
  {n:'ديكلوفيناك',d:'50mg',dur:'3 أيام',note:'مرتين يومياً بعد الأكل',cat:'مسكن'},
  {n:'بونستان',d:'500mg',dur:'3 أيام',note:'3 مرات يومياً بعد الأكل',cat:'مسكن'},
  {n:'ديكساميثازون',d:'4mg',dur:'3 أيام',note:'مرة واحدة صباحاً',cat:'كورتيزون'},
  {n:'هيبيتان',d:'0.12%',dur:'أسبوع',note:'مضمضة مرتين يومياً',cat:'غسول'},
  {n:'بيتادين',d:'1%',dur:'5 أيام',note:'مضمضة 3 مرات يومياً',cat:'غسول'},
  {n:'أوميبرازول',d:'20mg',dur:'مع المضاد',note:'مرة واحدة قبل الفطور',cat:'معدة'},
];
var TIPS={implant:['لا تلمس منطقة الزراعة','تناول طعاماً طرياً لأسبوع','تجنب التدخين تماماً','فرش بلطف حول منطقة الزراعة','راجع فوراً عند أي نزيف'],ortho:['تجنب الأطعمة الصلبة والعلكة','نظّف بين الأسلاك بخيط الأسنان','المثبّت الليلي إلزامي','راجع العيادة عند انكسار سلك'],extract:['عضّ على الشاش 30 دقيقة','لا تمضمض فمك 24 ساعة','ضع ثلجاً على الخد 15 دقيقة','تجنب التدخين 3 أيام'],filling:['لا تمضغ على جهة الحشوة ساعتين','قد تشعر بحساسية مؤقتة','تجنب الحلويات والمشروبات الغازية'],general:['حافظ على نظافة فمك وأسنانك','فرش مرتين يومياً','تناول الدواء في مواعيده']};

function rxGetTips(planId){
  var pl=G('plans',[]).find(function(p){return p.id===planId;});if(!pl)return TIPS.general;
  var t=pl.planType||'',d=(pl.description||'').toLowerCase();
  if(t==='implant')return TIPS.implant;if(t==='ortho')return TIPS.ortho;
  if(/(قلع|خلع)/.test(d))return TIPS.extract;if(/(حشو)/.test(d))return TIPS.filling;
  return TIPS.general;
}
function rxInit(planId){
  rxRenderDrugs(''); rxRenderTipsSugg(rxGetTips(planId)); rxRenderMeds(); rxRenderTips();
  var sb=document.getElementById('rxDrugSearch'); if(sb)sb.value='';
}
function rxE(s){return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}
function rxRenderDrugs(q){
  var el=document.getElementById('rxDrugSugg');if(!el)return;
  var list=q?DRUGS.filter(function(d){return d.n.includes(q)||d.cat.includes(q);}):DRUGS;
  el.innerHTML=list.map(function(d,i){var idx=DRUGS.indexOf(d);return '<button type="button" onclick="rxAddDrug('+idx+')" style="background:#fff;border:1px solid #86efac;border-radius:16px;padding:3px 10px;font-size:11px;color:#166534;cursor:pointer;white-space:nowrap;margin:2px">'+d.n+' <span style="color:#94a3b8;font-size:10px">'+d.d+'</span></button>';}).join('');
}
function rxAddDrug(i){var d=DRUGS[i];window._meds.push({name:d.n,dose:d.d,duration:d.dur,note:d.note});rxRenderMeds();}
function rxAddCustom(){window._meds.push({name:'',dose:'',duration:'',note:''});rxRenderMeds();setTimeout(function(){var inp=document.querySelectorAll('.rxn');if(inp.length)inp[inp.length-1].focus();},30);}
function rxDelDrug(i){window._meds.splice(i,1);rxRenderMeds();}
function rxSetDrug(i,k,v){if(window._meds[i])window._meds[i][k]=v;}
function rxRenderMeds(){
  var el=document.getElementById('rxMedsList');if(!el)return;
  if(!window._meds||!window._meds.length){el.innerHTML='<p style="text-align:center;color:#94a3b8;font-size:12px;padding:8px 0">أضف دواء من الاقتراحات أو اضغط "+ يدوي"</p>';return;}
  el.innerHTML=window._meds.map(function(m,i){return '<div style="background:#fff;border:1px solid #d1fae5;border-radius:8px;padding:8px 10px;margin-bottom:6px;position:relative"><button type="button" onclick="rxDelDrug('+i+')" style="position:absolute;top:5px;left:6px;background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;padding:0 4px">✕</button><input class="form-control rxn" value="'+rxE(m.name)+'" oninput="rxSetDrug('+i+',\'name\',this.value)" placeholder="اسم الدواء *" style="font-weight:700;font-size:13px;margin-bottom:4px"><div style="display:grid;grid-template-columns:1fr 1fr;gap:4px"><input class="form-control" value="'+rxE(m.dose)+'" oninput="rxSetDrug('+i+',\'dose\',this.value)" placeholder="الجرعة — 500mg" style="font-size:12px"><input class="form-control" value="'+rxE(m.duration)+'" oninput="rxSetDrug('+i+',\'duration\',this.value)" placeholder="المدة — 5 أيام" style="font-size:12px"></div><input class="form-control" value="'+rxE(m.note||'')+'" oninput="rxSetDrug('+i+',\'note\',this.value)" placeholder="التعليمات" style="font-size:12px;margin-top:4px"></div>';}).join('');
}
function rxRenderTipsSugg(tips){
  var el=document.getElementById('rxTipsSugg');if(!el)return;
  el.innerHTML=tips.map(function(t){return '<button type="button" onclick="rxAddTip(\''+t.replace(/'/g,"\\'")+'\')" style="background:#f0fdf4;border:1px solid #86efac;border-radius:12px;padding:3px 10px;font-size:11px;color:#166534;cursor:pointer;margin:2px">'+t+'</button>';}).join('');
}
function rxAddTip(t){if(window._tips.indexOf(t)<0)window._tips.push(t);rxRenderTips();}
function rxDelTip(i){window._tips.splice(i,1);rxRenderTips();}
function rxRenderTips(){
  var el=document.getElementById('rxTipsList');if(!el)return;
  if(!window._tips||!window._tips.length){el.innerHTML='';return;}
  el.innerHTML='<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:8px 10px">'+window._tips.map(function(t,i){return '<div style="display:flex;align-items:center;gap:6px;padding:3px 0"><span style="font-size:12px;flex:1">• '+t+'</span><button type="button" onclick="rxDelTip('+i+')" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:12px">✕</button></div>';}).join('')+'</div>';
}
function rxSyncBeforeSave(){
  document.querySelectorAll('.rxn').forEach(function(inp,i){if(window._meds[i])window._meds[i].name=inp.value;});
}

// ═══════════════════════════════════════════════════
//  PRINT PRESCRIPTION
// ═══════════════════════════════════════════════════
function rxBuildHTML(planId,work,date,nextDate,nextTime,docId,meds,tips){
  var pl=G('plans',[]).find(function(p){return p.id===planId;});
  var pt=pl?pm()[pl.patientId]:null;
  var doc=sm()[docId];
  var clinic=G('clinic',{name:'عيادة سوران',phone:'',address:''});
  var BD='#07293a';
  var h='<div style="border:2px solid #c8dde6;border-radius:12px;font-family:Tahoma,Arial,sans-serif;direction:rtl">';
  h+='<div style="background:'+BD+';color:#fff;border-radius:10px 10px 0 0;padding:18px 24px;display:flex;align-items:center;justify-content:space-between">';
  h+='<div><div style="font-size:20px;font-weight:900">'+clinic.name+'</div>'+(clinic.phone?'<div style="font-size:11px;opacity:.8">📞 '+clinic.phone+'</div>':'')+( clinic.address?'<div style="font-size:11px;opacity:.8">📍 '+clinic.address+'</div>':'')+'</div>';
  h+='<div style="font-size:40px">🦷</div></div>';
  h+='<div style="padding:14px 24px;background:#f8fbfd;border-bottom:1px solid #c8dde6;display:flex;gap:20px;flex-wrap:wrap">';
  if(pt&&pt.name)h+='<div><div style="font-size:9px;color:#5a7a8a;font-weight:800">المريض</div><div style="font-size:14px;font-weight:700;color:#0d3d52">'+pt.name+'</div></div>';
  if(pt&&pt.age)h+='<div><div style="font-size:9px;color:#5a7a8a;font-weight:800">العمر</div><div style="font-size:14px;font-weight:700;color:#0d3d52">'+pt.age+' سنة</div></div>';
  if(pl)h+='<div><div style="font-size:9px;color:#5a7a8a;font-weight:800">العلاج</div><div style="font-size:14px;font-weight:700;color:#0d3d52">'+pl.description+'</div></div>';
  h+='<div style="margin-right:auto;background:'+BD+';color:#fff;border-radius:7px;padding:4px 12px;font-size:12px;font-weight:700">📅 '+date+'</div></div>';
  h+='<div style="padding:20px 24px">';
  if(work)h+='<div style="font-size:10px;font-weight:800;color:#5a7a8a;letter-spacing:.8px;margin:0 0 8px">العمل المنجز</div><div style="background:#e8f4f8;border:2px solid #9ecfdf;border-radius:9px;padding:10px 16px;font-size:13px;color:#0c4a6e;font-weight:600">🦷 '+work+'</div>';
  if(meds.length){
    h+='<div style="font-size:10px;font-weight:800;color:#5a7a8a;letter-spacing:.8px;margin:14px 0 8px">الأدوية الموصوفة</div>';
    h+=meds.map(function(m,i){var det=[m.dose,m.duration,m.note].filter(Boolean).join(' • ');return '<div style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border:2px solid #d0e4ec;border-radius:9px;margin-bottom:8px;background:'+(i%2?'#f5fafe':'#fff')+'"><div style="background:'+BD+';color:#fff;border-radius:50%;min-width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;flex-shrink:0">'+(i+1)+'</div><span style="font-size:18px;flex-shrink:0">💊</span><div style="flex:1"><div style="font-size:15px;font-weight:900;color:#0d3d52">'+m.name+'</div>'+(det?'<div style="font-size:11px;color:#5a7a8a;margin-top:3px">'+det+'</div>':'')+'</div></div>';}).join('');
  }
  if(tips.length)h+='<div style="background:#edfaf3;border:2px solid #6dce9e;border-radius:9px;padding:13px 18px;margin-top:13px"><div style="font-size:13px;font-weight:800;color:#145a32;margin-bottom:8px">🌿 نصائح ما بعد العلاج</div>'+tips.map(function(t){return '<div style="display:flex;align-items:flex-start;gap:7px;font-size:12px;color:#1a7a40;margin-bottom:5px"><div style="width:6px;height:6px;background:#27ae60;border-radius:50%;flex-shrink:0;margin-top:4px"></div><span>'+t+'</span></div>';}).join('')+'</div>';
  if(nextDate)h+='<div style="margin-top:12px;background:#fff8e6;border:2px solid #f5c842;border-radius:9px;padding:10px 16px;display:flex;align-items:center;gap:10px"><span style="font-size:22px">📅</span><div><div style="font-size:10px;font-weight:800;color:#7d5200">موعدك القادم</div><div style="font-size:14px;font-weight:800;color:#5c3c00">'+nextDate+(nextTime?' — الساعة '+nextTime:'')+'</div></div></div>';
  h+='<div style="border-top:2px dashed #c8dde6;padding:14px 0 0;display:flex;justify-content:space-between;align-items:flex-end;margin-top:16px"><div style="font-size:10px;color:#94a3b8">تاريخ الإصدار: '+date+'</div><div style="text-align:center"><div style="width:120px;height:1.5px;background:#334155;margin:0 auto 4px"></div><div style="font-size:10px;color:#5a7a8a">توقيع الطبيب</div><div style="font-size:13px;font-weight:800;color:#0d3d52">'+(doc?doc.name:'')+'</div></div></div>';
  h+='</div></div>';
  return h;
}

function rxPrint(){
  rxSyncBeforeSave();
  var meds=(window._meds||[]).filter(function(m){return m.name&&m.name.trim();});
  var tips=window._tips||[];
  if(!meds.length&&!tips.length){alert('أضف أدوية أو نصائح أولاً');return;}
  var planId=document.getElementById('sessPlanId').value;
  var docId=document.getElementById('sessDoc').value;
  var work=document.getElementById('sessWork').value||'';
  var date=document.getElementById('sessDate').value||today();
  var nextDate=document.getElementById('sessNextDate').value||'';
  var nextTime=document.getElementById('sessNextTime').value||'';
  rxShowPrint(rxBuildHTML(planId,work,date,nextDate,nextTime,docId,meds,tips));
}
function rxPrintSaved(planId,idx){
  var plans=G('plans',[]); var pl=plans.find(function(p){return p.id===planId;});if(!pl)return;
  var rec=(pl.sessionRecords||[]).find(function(r){return r.index===idx;});if(!rec)return;
  var meds=(rec.medications||[]).map(function(m){return typeof m==='string'?{name:m,dose:'',duration:'',note:''}:m;}).filter(function(m){return m.name&&m.name.trim();});
  rxShowPrint(rxBuildHTML(planId,rec.work||'',rec.date||today(),rec.nextDate||'',rec.nextTime||'',rec.doctorId||pl.doctorId,meds,rec.tips||[]));
}
function rxShowPrint(innerHtml, filenamePrefix){
  var prefix = filenamePrefix || 'وصفة-طبية';
  var loadMsg=document.createElement('div');
  loadMsg.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center';
  loadMsg.innerHTML='<div style="background:#fff;border-radius:16px;padding:32px 40px;text-align:center;font-family:Tajawal,sans-serif"><div style="font-size:36px;margin-bottom:12px">📄</div><div style="font-size:16px;font-weight:700;color:#0d3d52">جاري إنشاء PDF...</div></div>';
  document.body.appendChild(loadMsg);
  var full='<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Tahoma,Arial,sans-serif;direction:rtl;color:#1a2332;width:794px;min-height:1123px;background:#fff;display:flex;align-items:flex-start;justify-content:center;padding:28px 0}.rx-wrap{width:740px}</style></head><body><div class="rx-wrap">'+innerHtml+'</div></body></html>';
  var frame=document.createElement('iframe');
  frame.style.cssText='position:fixed;left:-9999px;top:0;width:794px;height:1123px;border:none;background:#fff';
  document.body.appendChild(frame);
  frame.onload=function(){
    setTimeout(function(){
      html2canvas(frame.contentDocument.body,{scale:2,useCORS:true,backgroundColor:'#ffffff',width:794,height:1123,windowWidth:794,windowHeight:1123,logging:false}).then(function(canvas){
        var imgData=canvas.toDataURL('image/jpeg',0.92);
        var pdf=new jspdf.jsPDF({orientation:'portrait',unit:'mm',format:'a4'});
        var pW=pdf.internal.pageSize.getWidth(),pH=pdf.internal.pageSize.getHeight();
        var imgH=(canvas.height*pW)/canvas.width;
        var y=0;while(y<imgH){if(y>0)pdf.addPage();pdf.addImage(imgData,'JPEG',0,-y,pW,imgH);y+=pH;}
        pdf.save(prefix+'-'+new Date().toLocaleDateString('en').replace(/\//g,'-')+'.pdf');
        frame.remove();loadMsg.remove();
      }).catch(function(){frame.remove();loadMsg.remove();var w=window.open('','_blank');if(w){w.document.write(full);w.document.close();}});
    },800);
  };
  frame.srcdoc=full;
}

// ═══════════════════════════════════════════════════
//  PATIENT CONSENT SYSTEM
// ═══════════════════════════════════════════════════
var DEFAULT_CONSENT_TPLS = {
  general: {
    title: 'موافقة على العلاج العام للأسنان',
    body: 'أنا الموقّع أدناه {اسم_المريض}، أقرّ وأوافق على إجراء العلاج اللازم في {اسم_العيادة} تحت إشراف الطبيب المختص.\n\nأقرّ بأنه قد تم شرح ما يلي لي:\n\n• طبيعة المشكلة الصحية في الأسنان واللثة.\n• الإجراءات العلاجية المطلوبة وعدد الجلسات المتوقّعة.\n• المخاطر المحتملة والمضاعفات (التهاب، ألم، حساسية، إمكانية الحاجة لإجراء إضافي).\n• البدائل العلاجية المتاحة عند توفّرها.\n• التكلفة التقديرية للعلاج.\n\nبنود الالتزام:\n١. الالتزام بمواعيد الجلسات وعدم التغيب من دون إشعار مسبق.\n٢. اتّباع تعليمات الطبيب بدقّة في النظافة الفموية بعد كل جلسة.\n٣. تناول الأدوية الموصوفة في مواعيدها.\n٤. إبلاغ الطبيب فوراً عند ظهور أي عَرَض غير طبيعي.\n٥. الامتناع عن التدخين والمأكولات الصلبة بعد الإجراءات.\n٦. سداد المستحقات المالية حسب الاتفاق.\n\nأقرّ بأنني قرأت هذه الموافقة وفهمت محتواها بكامل وعيي وموافقتي.'
  },
  cleaning: {
    title: 'موافقة على تنظيف الأسنان (إزالة الجير والتلميع)',
    body: 'أنا الموقّع أدناه {اسم_المريض}، أوافق على إجراء تنظيف الأسنان (إزالة الجير وتلميع الأسنان) في {اسم_العيادة}.\n\nتم شرح ما يلي لي:\n\n• الإجراء يتضمّن إزالة طبقة الجير المتراكمة فوق وتحت اللثة باستخدام جهاز الموجات فوق الصوتية، يتبعها تلميع الأسنان.\n• قد أشعر بحساسية مؤقتة في الأسنان لمدة ٢٤–٤٨ ساعة بعد الإجراء.\n• قد يحدث نزيف بسيط من اللثة، وهو طبيعي ويزول تدريجياً.\n• قد تظهر فراغات بين الأسنان كانت مغطّاة بالجير، وهذه الفراغات كانت موجودة أصلاً.\n\nبنود الالتزام:\n١. الفرشاة مرتين يومياً باستخدام معجون الفلورايد.\n٢. استخدام الخيط الطبي يومياً.\n٣. تجنّب الأطعمة والمشروبات الملوّنة (الشاي، القهوة، الصلصات الداكنة) لمدة ٢٤ ساعة.\n٤. تجنّب التدخين بعد الجلسة لمدة ٢٤ ساعة على الأقل.\n٥. مراجعة العيادة كل ٦ أشهر للتنظيف الدوري.\n\nأقرّ بأنني قرأت هذه الموافقة وفهمت محتواها بكامل وعيي وموافقتي.'
  },
  implant: {
    title: 'موافقة على زراعة الأسنان',
    body: 'أنا الموقّع أدناه {اسم_المريض}، أوافق على إجراء عملية زراعة الأسنان في {اسم_العيادة} تحت إشراف الطبيب المختص.\n\nتم شرحُ ما يلي لي بشكل وافٍ:\n\n• مراحل العملية: زرع الجذر المعدني (Implant) ثم فترة الالتئام (٣–٦ أشهر) ثم تركيب التاج النهائي.\n• قد أحتاج إلى ترقيع عظمي أو ترقيع للّثة في حال نقصان السمك.\n• المخاطر المحتملة: التهاب موضع الزرع، فشل التحام الزرعة بالعظم، ألم وتورّم بعد العملية، تأثّر العصب أو الجيب الأنفي في حالات نادرة.\n• معدل نجاح زراعة الأسنان مرتفع (٩٥٪+) لكنه ليس مضموناً ١٠٠٪، وقد تحتاج الزرعة إلى استبدال في حالات نادرة.\n• مدّة المعالجة الكلّية قد تمتدّ من ٤ إلى ٩ أشهر حسب الحالة.\n\nبنود الالتزام:\n١. الامتناع التام عن التدخين قبل وبعد العملية لمدة لا تقل عن ٣ أشهر — التدخين أهم سبب لفشل الزرعة.\n٢. تناول المضادات الحيوية والمسكّنات الموصوفة بانتظام.\n٣. تجنّب لمس منطقة الزرع وتجنّب الأطعمة الصلبة لمدة أسبوعين.\n٤. الفرشاة بلطف حول منطقة الزرع باستخدام فرشاة طرية.\n٥. الالتزام بمواعيد المتابعة لتقييم الالتئام.\n٦. مراجعة العيادة فوراً عند أي نزيف، تورّم شديد، أو ألم لا يستجيب للمسكّنات.\n٧. سداد الدفعات حسب الاتفاق المالي المتفق عليه.\n\nأقرّ بأنني قرأت وفهمت كل ما سبق، وأن طبيب الأسنان قد أجاب عن أسئلتي بوضوح، وأوافق طوعاً على إجراء الزراعة.'
  },
  ortho: {
    title: 'موافقة على علاج تقويم الأسنان',
    body: 'أنا الموقّع أدناه {اسم_المريض}، أوافق على البدء بعلاج تقويم الأسنان في {اسم_العيادة} تحت إشراف الطبيب المختص.\n\nتم شرح ما يلي لي:\n\n• مدّة العلاج التقريبية: ١٢–٣٠ شهراً حسب درجة تعقيد الحالة، وقد تطول أو تقصر.\n• قد أحتاج إلى قلع أسنان لإيجاد مساحة كافية، وقد أحتاج إلى أجهزة مساعدة (مطّاطات، Headgear، موسّعة، أجهزة وظيفية).\n• المخاطر المحتملة: ألم بسيط بعد كل شدّ، تقرّحات في الفم، تسوّس الأسنان أو التهاب اللثة في حال إهمال النظافة، ارتشاف بسيط في جذور الأسنان.\n• بعد إزالة الجهاز يكون استخدام المثبّت (Retainer) إلزامياً مدى الحياة لمنع رجوع الأسنان.\n\nبنود الالتزام:\n١. الالتزام التام بمواعيد المراجعة كل ٣–٤ أسابيع — تخلّف الجلسات يطيل العلاج.\n٢. تنظيف الأسنان والجهاز بعد كل وجبة باستخدام فرشاة التقويم وخيط التقويم.\n٣. تجنّب الأطعمة الصلبة (المكسّرات، الثلج، التفاح الكامل) واللزجة (العلكة، الحلويات اللزجة).\n٤. ارتداء المطاطات (Elastics) بحسب التعليمات — عدم ارتدائها يطيل العلاج.\n٥. مراجعة العيادة فوراً عند انكسار سلك أو سقوط براكيت.\n٦. الالتزام بارتداء المثبّت بعد انتهاء العلاج بحسب التعليمات (ثابت أو متحرّك أو ليلي).\n٧. سداد الدفعات الشهرية بانتظام حسب الاتفاق.\n\nأقرّ بأنني فهمت أن نتائج التقويم تعتمد بشكل كبير على التزامي بالتعليمات أعلاه، وأوافق على بدء العلاج.'
  }
};
function csTpls(){ return G('consentTpls', JSON.parse(JSON.stringify(DEFAULT_CONSENT_TPLS))); }
function csTplFor(type){ var t=csTpls(); return t[type]||DEFAULT_CONSENT_TPLS[type]||DEFAULT_CONSENT_TPLS.general; }
function csFillVars(text, vars){
  if(!text) return '';
  var out=text;
  Object.keys(vars).forEach(function(k){
    out=out.split('{'+k+'}').join(vars[k]||'');
  });
  return out;
}
function csTypeLabel(t){ return ({general:'علاج عام',cleaning:'تنظيف الأسنان',implant:'زراعة الأسنان',ortho:'تقويم الأسنان'})[t]||t; }
function csTypeIcon(t){ return ({general:'🦷',cleaning:'✨',implant:'🔩',ortho:'😬'})[t]||'📄'; }

function openNewConsent(){
  if(!CPid){ alert('افتح ملف المريض أولاً'); return; }
  var pl=G('plans',[]).filter(function(x){return x.patientId===CPid;});
  var sel=document.getElementById('csPlanId');
  sel.innerHTML='<option value="">-- لا شيء --</option>'+pl.map(function(p){return '<option value="'+p.id+'" data-type="'+(p.planType||'general')+'">'+(p.description||'خطة')+' — '+csTypeLabel(p.planType||'general')+'</option>';}).join('');
  // If patient has a plan, default to that type
  if(pl.length){
    document.getElementById('csType').value=pl[0].planType||'general';
    sel.value=pl[0].id;
  } else {
    document.getElementById('csType').value='general';
  }
  csOnTypeChange();
  openModal('mo-newConsent');
}
function csOnTypeChange(){
  var type=document.getElementById('csType').value;
  var p=G('patients',[]).find(function(x){return x.id===CPid;});
  var clinic=G('clinic',{name:'عيادة سوران'});
  var tpl=csTplFor(type);
  var vars={
    'اسم_المريض': p?p.name:'',
    'اسم_العيادة': clinic.name||'عيادة سوران',
    'التاريخ': new Date().toLocaleDateString('en-GB'),
    'اسم_الطبيب': CU?CU.name:'',
    'نوع_العلاج': csTypeLabel(type),
    'رقم_الهاتف': p?p.phone:'',
    'العنوان': p?(p.address||''):''
  };
  document.getElementById('csPreview').textContent=csFillVars(tpl.body, vars);
  // If currently linked plan has different type, unlink it (user changed type intentionally)
  var sel=document.getElementById('csPlanId');
  if(sel.value){
    var opt=sel.options[sel.selectedIndex];
    if(opt && opt.dataset.type && opt.dataset.type!==type){
      sel.value='';
    }
  }
}
function csOnPlanChange(){
  // When user picks a plan, sync the consent type to match it
  var sel=document.getElementById('csPlanId');
  if(!sel.value) return;
  var opt=sel.options[sel.selectedIndex];
  var planType=opt&&opt.dataset.type;
  if(planType && planType!==document.getElementById('csType').value){
    document.getElementById('csType').value=planType;
  }
  csOnTypeChange();
}

function csBuildHTML(type, planId){
  var p=G('patients',[]).find(function(x){return x.id===CPid;});
  var clinic=G('clinic',{name:'عيادة سوران',phone:'',address:''});
  var pl=planId?G('plans',[]).find(function(x){return x.id===planId;}):null;
  var tpl=csTplFor(type);
  var BD='#07293a';
  var dateStr=new Date().toLocaleDateString('en-GB');
  var vars={
    'اسم_المريض': p?p.name:'',
    'اسم_العيادة': clinic.name||'عيادة سوران',
    'التاريخ': dateStr,
    'اسم_الطبيب': CU?CU.name:'',
    'نوع_العلاج': csTypeLabel(type),
    'رقم_الهاتف': p?p.phone:'',
    'العنوان': p?(p.address||''):''
  };
  var bodyText=csFillVars(tpl.body, vars);
  var bodyHtml=bodyText.split('\n').map(function(line){
    if(!line.trim()) return '<div style="height:6px"></div>';
    return '<div style="margin-bottom:5px">'+line.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</div>';
  }).join('');
  var h='<div style="border:2px solid #c8dde6;border-radius:12px;font-family:Tahoma,Arial,sans-serif;direction:rtl">';
  // Header
  h+='<div style="background:'+BD+';color:#fff;border-radius:10px 10px 0 0;padding:18px 24px;display:flex;align-items:center;justify-content:space-between">';
  h+='<div><div style="font-size:20px;font-weight:900">'+clinic.name+'</div>'+(clinic.phone?'<div style="font-size:11px;opacity:.85">📞 '+clinic.phone+'</div>':'')+(clinic.address?'<div style="font-size:11px;opacity:.85">📍 '+clinic.address+'</div>':'')+'</div>';
  h+='<div style="font-size:40px">'+csTypeIcon(type)+'</div></div>';
  // Title bar
  h+='<div style="background:#f8fbfd;border-bottom:1px solid #c8dde6;padding:12px 24px;text-align:center"><div style="font-size:18px;font-weight:900;color:'+BD+'">'+tpl.title+'</div></div>';
  // Patient info
  h+='<div style="padding:14px 24px;background:#fff;border-bottom:1px solid #e2eaf0;display:flex;gap:18px;flex-wrap:wrap">';
  if(p&&p.name) h+='<div><div style="font-size:9px;color:#5a7a8a;font-weight:800">المريض</div><div style="font-size:13px;font-weight:700;color:#0d3d52">'+p.name+'</div></div>';
  if(p&&p.age) h+='<div><div style="font-size:9px;color:#5a7a8a;font-weight:800">العمر</div><div style="font-size:13px;font-weight:700;color:#0d3d52">'+p.age+' سنة</div></div>';
  if(p&&p.phone) h+='<div><div style="font-size:9px;color:#5a7a8a;font-weight:800">الهاتف</div><div style="font-size:13px;font-weight:700;color:#0d3d52">'+p.phone+'</div></div>';
  if(pl) h+='<div><div style="font-size:9px;color:#5a7a8a;font-weight:800">العلاج</div><div style="font-size:13px;font-weight:700;color:#0d3d52">'+pl.description+'</div></div>';
  h+='<div style="margin-right:auto;background:'+BD+';color:#fff;border-radius:7px;padding:4px 12px;font-size:12px;font-weight:700">📅 '+dateStr+'</div></div>';
  // Body
  h+='<div style="padding:18px 24px;font-size:12px;line-height:1.85;color:#1a2332">'+bodyHtml+'</div>';
  // Signature area
  h+='<div style="padding:18px 24px;border-top:2px dashed #c8dde6;display:flex;justify-content:space-between;align-items:flex-end;gap:30px">';
  h+='<div style="flex:1;text-align:center"><div style="height:50px;border-bottom:1.5px solid #334155;margin-bottom:6px"></div><div style="font-size:10px;color:#5a7a8a">توقيع المريض / ولي الأمر</div></div>';
  h+='<div style="flex:1;text-align:center"><div style="height:50px;border-bottom:1.5px solid #334155;margin-bottom:6px"></div><div style="font-size:10px;color:#5a7a8a">توقيع الطبيب</div><div style="font-size:12px;font-weight:800;color:#0d3d52">'+(CU?CU.name:'')+'</div></div>';
  h+='</div>';
  // Footer
  h+='<div style="padding:8px 24px 14px;text-align:center;font-size:10px;color:#94a3b8">رقم الموافقة: '+Date.now().toString(36).toUpperCase()+' • تاريخ الإصدار: '+dateStr+'</div>';
  h+='</div>';
  return h;
}

function csPrint(){
  var type=document.getElementById('csType').value;
  var planId=document.getElementById('csPlanId').value;
  var p=G('patients',[]).find(function(x){return x.id===CPid;});
  // Save consent record (status: pending signature)
  var consent={
    id: uid(),
    patientId: CPid,
    type: type,
    planId: planId||null,
    title: csTplFor(type).title,
    createdAt: new Date().toISOString(),
    createdBy: CU?CU.id:null,
    status: 'pending', // pending | signed
    signedImage: null
  };
  var consents=G('consents',[]);
  consents.push(consent);
  S('consents', consents);
  // Render PDF using existing rxShowPrint flow with consent filename
  var fname='موافقة-'+csTypeLabel(type)+(p?'-'+(p.name||'').replace(/\s+/g,'_'):'');
  rxShowPrint(csBuildHTML(type, planId), fname);
  closeModal('mo-newConsent');
  renderConsents(CPid);
}

function renderConsents(pid){
  var el=document.getElementById('consentsList');
  if(!el) return;
  var list=G('consents',[]).filter(function(c){return c.patientId===pid;});
  if(!list.length){ el.innerHTML=emptyState('📄','لا توجد موافقات بعد. اضغط "+ موافقة جديدة" للبدء.'); return; }
  list.sort(function(a,b){return (b.createdAt||'').localeCompare(a.createdAt||'');});
  var smap=sm();
  el.innerHTML=list.map(function(c){
    var d=new Date(c.createdAt||Date.now()).toLocaleDateString('en-GB');
    var statusBadge;
    var signedInfo='';
    if(c.status==='signed'){
      statusBadge='<span class="badge badge-green">✓ موقّعة</span>';
      var signedDate=c.signedAt?new Date(c.signedAt).toLocaleDateString('en-GB'):'';
      var signedByName=c.signedByName || (smap[c.signedBy]?smap[c.signedBy].name:'');
      signedInfo='<div style="font-size:10px;color:var(--gray4);margin-top:6px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:6px 8px">✓ سُجّل التوقيع في '+signedDate+(signedByName?' بواسطة '+signedByName:'')+(c.fileLocation?' • 📁 '+c.fileLocation:'')+'</div>';
    } else {
      statusBadge='<span class="badge badge-orange">⏳ بانتظار التوقيع</span>';
    }
    var actions='<button class="btn btn-ghost btn-xs" onclick="csReprint(\''+c.id+'\')">📄 إعادة طباعة</button>';
    if(c.status==='pending'){
      actions+='<button class="btn btn-xs" style="background:#16a34a;color:#fff" onclick="csOpenUpload(\''+c.id+'\')">✅ تأكيد التوقيع</button>';
    } else {
      actions+='<button class="btn btn-ghost btn-xs" onclick="csOpenUpload(\''+c.id+'\')">✏️ تعديل بيانات التوقيع</button>';
    }
    actions+='<button class="btn btn-ghost btn-xs" onclick="csDelete(\''+c.id+'\')" style="color:var(--red);margin-right:auto">🗑️ حذف</button>';
    return '<div class="card" style="margin-bottom:10px"><div class="card-body" style="padding:12px 14px">'+
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">'+
      '<div style="font-size:24px">'+csTypeIcon(c.type)+'</div>'+
      '<div style="flex:1"><div style="font-weight:800;font-size:13px;color:var(--gray6)">'+(c.title||csTypeLabel(c.type))+'</div><div style="font-size:11px;color:var(--gray5);margin-top:2px">📅 '+d+' • '+csTypeLabel(c.type)+'</div></div>'+
      statusBadge+
      '</div>'+
      signedInfo+
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">'+actions+'</div>'+
      '</div></div>';
  }).join('');
}

function csReprint(cid){
  var c=G('consents',[]).find(function(x){return x.id===cid;});
  if(!c) return;
  var p=G('patients',[]).find(function(x){return x.id===c.patientId;});
  var fname='موافقة-'+csTypeLabel(c.type)+(p?'-'+(p.name||'').replace(/\s+/g,'_'):'');
  rxShowPrint(csBuildHTML(c.type, c.planId), fname);
}

function csDelete(cid){
  if(!confirm('حذف هذه الموافقة؟ لا يمكن التراجع.')) return;
  var consents=G('consents',[]).filter(function(x){return x.id!==cid;});
  S('consents', consents);
  try{ localStorage.removeItem('consent_img_'+cid); }catch(e){}
  renderConsents(CPid);
}

function csOpenUpload(cid){
  document.getElementById('csUpId').value=cid;
  var noteEl=document.getElementById('csUpNote'); if(noteEl)noteEl.value='';
  openModal('mo-uploadConsent');
}

function csUpSave(){
  var cid=document.getElementById('csUpId').value;
  if(!cid){ alert('خطأ: لم يحدد معرف الموافقة'); return; }
  var note=(document.getElementById('csUpNote').value||'').trim();
  var consents=G('consents',[]);
  var c=consents.find(function(x){return x.id===cid;});
  if(c){
    c.status='signed';
    c.signedAt=new Date().toISOString();
    c.signedBy=CU?CU.id:null;
    c.signedByName=CU?CU.name:'';
    if(note) c.fileLocation=note;
    // Clean up any old image data from old version
    delete c.imageStored;
    try{ localStorage.removeItem('consent_img_'+cid); }catch(e){}
    S('consents', consents);
  }
  closeModal('mo-uploadConsent');
  renderConsents(CPid);
  if(typeof addNotif==='function') addNotif('📄','موافقة موقّعة','تم تسجيل توقيع موافقة '+(c?csTypeLabel(c.type):''));
}

// Template editor (manager only)
function openConsentTplEditor(){
  if(!(CU&&(CU.role==='manager'||CU.role==='doctor-manager'))){ alert('للمدير فقط'); return; }
  document.getElementById('cstSel').value='general';
  csTplLoad();
  openModal('mo-editConsentTpl');
}
function csTplLoad(){
  var type=document.getElementById('cstSel').value;
  var t=csTplFor(type);
  document.getElementById('cstTitle').value=t.title||'';
  document.getElementById('cstBody').value=t.body||'';
}
function csTplSave(){
  var type=document.getElementById('cstSel').value;
  var title=document.getElementById('cstTitle').value.trim();
  var body=document.getElementById('cstBody').value.trim();
  if(!title||!body){ alert('العنوان والنص إلزاميان'); return; }
  var all=csTpls();
  all[type]={title:title, body:body};
  S('consentTpls', all);
  alert('✅ تم حفظ القالب');
  closeModal('mo-editConsentTpl');
}
function csTplResetOne(){
  if(!confirm('إعادة هذا القالب إلى الافتراضي؟')) return;
  var type=document.getElementById('cstSel').value;
  var all=csTpls();
  all[type]=JSON.parse(JSON.stringify(DEFAULT_CONSENT_TPLS[type]));
  S('consentTpls', all);
  csTplLoad();
}

// ═══════════════════════════════════════════════════
//  ORTHO DEVICE MESSAGE TEMPLATES (8 appliances)
// ═══════════════════════════════════════════════════
var DEFAULT_ORTHO_DEV_TPLS = {
  fixed: {
    icon: '🔧',
    label: 'جهاز ثابت',
    title: 'تركيب جهاز التقويم الثابت',
    body: 'السلام عليكم {اسم_المريض} 🦷\n\nتم تركيب جهاز التقويم الثابت اليوم بنجاح.\n\n⚠️ خلال الأيام الأولى:\n• قد تشعر بألم خفيف لـ 3-5 أيام (طبيعي تماماً)\n• استخدم باراسيتامول عند الحاجة\n• تناول طعاماً طرياً (شوربة، أرز، يوغرت)\n• تجنّب: المكسّرات، الثلج، التفاح الكامل، اللبان\n\n🪥 النظافة:\n• فرشاة بعد كل وجبة باستخدام فرشاة التقويم الخاصة\n• استخدم خيط التقويم يومياً\n• المضمضة بالماء الدافئ والملح عند الحاجة\n\n📍 إذا انكسر سلك أو سقطت براكيت، اتصل بالعيادة فوراً.\n\nموعدك القادم: {موعد_القادم}\n\nد. {اسم_الطبيب}\n{اسم_العيادة}'
  },
  wireChange: {
    icon: '🪛',
    label: 'تغيير سلك',
    title: 'تغيير سلك التقويم',
    body: 'مرحباً {اسم_المريض} 🦷\n\nتم تغيير السلك في جلسة اليوم.\n\n⚠️ ما تتوقعه:\n• ألم خفيف لـ 2-3 أيام (طبيعي مع كل تغيير سلك)\n• استخدم مسكّن (باراسيتامول/إيبوبروفين) عند الحاجة\n• تناول طعاماً طرياً لمدة 48 ساعة\n• تجنّب القضم بالأسنان الأمامية\n\n🪥 استمر بالنظافة الجيدة بعد كل وجبة.\n\n📍 الجلسة القادمة مهمة لمتابعة الحركة. لا تتأخر.\n\nموعدك القادم: {موعد_القادم}\n\nد. {اسم_الطبيب}\n{اسم_العيادة}'
  },
  elastics: {
    icon: '⚪',
    label: 'المطّاطات',
    title: 'تعليمات المطّاطات (Elastics)',
    body: 'السلام عليكم {اسم_المريض} ⚪\n\nتم البدء بالمطّاطات اليوم.\n\n🔑 قاعدة ذهبية: التزامك بالمطّاطات يحدد سرعة العلاج.\n\n⏰ التعليمات:\n• ارتديها ٢٠–٢٢ ساعة يومياً (طوال اليوم والليل)\n• اخلعها فقط أثناء الأكل والتنظيف\n• غيّرها مرتين يومياً (صباحاً ومساءً) بمطّاطات جديدة\n• احمل معك أكياس احتياطية دائماً\n\n⚠️ تنبيه:\nعدم الالتزام بالمطّاطات = إطالة مدة العلاج بأشهر إضافية.\n\n📍 إذا نفدت لديك، راجع العيادة لاستلام المزيد.\n\nموعدك القادم: {موعد_القادم}\n\nد. {اسم_الطبيب}\n{اسم_العيادة}'
  },
  expander: {
    icon: '↔️',
    label: 'الموسّعة',
    title: 'تعليمات جهاز التوسعة (Expander)',
    body: 'مرحباً {اسم_المريض} ↔️\n\nتم تركيب جهاز التوسعة اليوم.\n\n🔧 طريقة الاستعمال:\n• أدر المفتاح كما أُريت لك (عادةً مرة في اليوم)\n• في نفس الوقت من كل يوم — لا تنسَ\n• قد تشعر بضغط بسيط بعد كل دورة (طبيعي)\n• قد تظهر فجوة بين الثنيتين الأماميتين خلال أسبوع — هذه علامة نجاح ممتازة!\n\n🍽️ الأكل:\n• تجنّب الأطعمة اللزجة والصلبة\n• اشرب الماء بكثرة\n• قد يتجمّع الطعام تحت الجهاز — استخدم سرنجة الماء للشطف\n\n🪥 نظافة إضافية ضرورية تحت الجهاز.\n\n📍 إذا انفصل الجهاز أو شعرت بألم شديد، اتصل فوراً.\n\nموعدك القادم: {موعد_القادم}\n\nد. {اسم_الطبيب}\n{اسم_العيادة}'
  },
  aligners: {
    icon: '✨',
    label: 'Aligners (شفاف)',
    title: 'تعليمات Aligners الشفافة',
    body: 'السلام عليكم {اسم_المريض} ✨\n\nتم تسليمك مجموعة Aligners اليوم.\n\n⏰ القاعدة الأهم:\n• ارتدِها ٢٢ ساعة يومياً\n• اخلعها فقط للأكل والتنظيف\n• كل مجموعة تُلبس أسبوعين (أو حسب التعليمات)\n\n✅ التعليمات:\n• اشرب الماء فقط أثناء ارتدائها\n• لا تأكل أو تشرب الشاي/القهوة معها (تتلوّن)\n• نظّف أسنانك قبل إعادة وضعها\n• اغسلها بالماء الفاتر — لا الساخن (تتشوّه)\n• احفظها في علبتها دائماً عند الخلع\n\n⚠️ ضياع Aligner = تأخير العلاج. لا تلفّها بمنديل!\n\nموعدك القادم لاستلام المجموعة التالية: {موعد_القادم}\n\nد. {اسم_الطبيب}\n{اسم_العيادة}'
  },
  removableRetainer: {
    icon: '🦷',
    label: 'مثبّت متحرّك',
    title: 'تعليمات المثبّت المتحرّك',
    body: 'مبروك {اسم_المريض} 🌟\n\nاليوم انتهى علاج التقويم وتم تسليمك المثبّت المتحرّك.\n\n🔑 المثبّت يحمي ابتسامتك من الرجوع — التزامك أهم من قبل!\n\n⏰ جدول الارتداء:\n• الأشهر الـ 6 الأولى: ٢٠–٢٢ ساعة يومياً\n• بعد ذلك: ليلاً فقط (مدى الحياة)\n• أي توقف لأيام = رجوع الأسنان للوراء\n\n🧼 العناية:\n• اغسلها بفرشاة وصابون يومياً\n• ماء فاتر فقط (الساخن يشوّهها)\n• احفظها في علبتها دائماً\n\n⚠️ أخطاء شائعة تجنّبها:\n• لفّها بمنديل ← غالباً تُرمى بالخطأ\n• تركها في السيارة الحارّة ← تتشوّه\n• الكلاب تحبّها — احفظها بعيداً!\n\nموعد المتابعة: {موعد_القادم}\n\nد. {اسم_الطبيب}\n{اسم_العيادة}'
  },
  fixedRetainer: {
    icon: '🔗',
    label: 'مثبّت ثابت',
    title: 'تعليمات المثبّت الثابت',
    body: 'مبروك {اسم_المريض} 🌟\n\nاليوم تم تثبيت المثبّت الثابت خلف أسنانك. ابتسامتك الجديدة محمية!\n\n📌 ما هو؟\nسلك رفيع ملصوق خلف الأسنان — لا يُرى ولا يُحسّ به بعد فترة.\n\n🪥 العناية اليومية ضرورية:\n• فرشاة بعناية حول السلك\n• استخدم خيط Superfloss أو خيط التقويم لتنظيف ما بين الأسنان\n• إهمال التنظيف = تراكم جير + التهاب لثة\n\n⚠️ تنبيهات:\n• تجنّب قضم الأطعمة الصلبة بالأسنان الأمامية\n• إذا شعرت بانفصال أو حركة غير طبيعية للسلك → اتصل بالعيادة فوراً\n• لا تحاول إصلاحه بنفسك\n\n📍 المتابعة كل ٦ أشهر للتأكد من سلامته.\n\nموعدك القادم: {موعد_القادم}\n\nد. {اسم_الطبيب}\n{اسم_العيادة}'
  },
  headgear: {
    icon: '🎯',
    label: 'Headgear',
    title: 'تعليمات جهاز Headgear',
    body: 'مرحباً {اسم_المريض} 🎯\n\nتم تسليمك جهاز Headgear اليوم.\n\n⏰ الالتزام يصنع الفرق:\n• ارتدِه ١٢–١٤ ساعة يومياً (المساء + الليل)\n• إذا لم تلتزم = الجهاز عديم الفائدة + طول العلاج\n\n🛡️ السلامة أولاً:\n• لا تركض أو تلعب رياضة وأنت ترتديه\n• اخلعه بحذر — لا تشدّه بقوّة\n• إذا انفصل بحركة سريعة قد يُؤذي العين — كن حذراً جداً\n• لا تنزعه أو تضعه أمام الآخرين بقوّة\n\n🌙 أفضل وقت: بعد العشاء حتى الصباح.\n\n📓 سجّل عدد ساعات الارتداء يومياً — سنراجعه معك في الجلسة القادمة.\n\nموعدك القادم: {موعد_القادم}\n\nد. {اسم_الطبيب}\n{اسم_العيادة}'
  }
};

var ORTHO_DEV_ORDER = ['fixed','wireChange','elastics','expander','aligners','removableRetainer','fixedRetainer','headgear'];

function odTpls(){ return G('orthoDevTpls', JSON.parse(JSON.stringify(DEFAULT_ORTHO_DEV_TPLS))); }
function odTplFor(type){ var t=odTpls(); return t[type] || DEFAULT_ORTHO_DEV_TPLS[type] || DEFAULT_ORTHO_DEV_TPLS.fixed; }

function odVarsFor(planId){
  var pl = planId ? G('plans',[]).find(function(p){return p.id===planId;}) : null;
  var pt = pl ? pm()[pl.patientId] : (CPid ? pm()[CPid] : null);
  var clinic = G('clinic',{name:'عيادة سوران'});
  // Try to grab next appointment from session form if open, else from upcoming appts
  var nextStr = '';
  var nd = document.getElementById('sessNextDate');
  var nt = document.getElementById('sessNextTime');
  if (nd && nd.value) nextStr = nd.value + (nt && nt.value ? ' الساعة ' + nt.value : '');
  if (!nextStr && pt) {
    var todayStr = today();
    var upcoming = G('appointments',[]).filter(function(a){return a.patientId===pt.id && a.date>=todayStr && a.status!=='cancelled';}).sort(function(a,b){return a.date>b.date?1:-1;});
    if (upcoming.length) nextStr = upcoming[0].date + (upcoming[0].time?' الساعة '+upcoming[0].time:'');
  }
  if (!nextStr) nextStr = 'سيتم تحديده لاحقاً';
  var docName = '';
  if (pl && pl.doctorId) { var d = sm()[pl.doctorId]; if (d) docName = d.name; }
  if (!docName && CU) docName = CU.name || '';
  return {
    'اسم_المريض': pt ? pt.name : '',
    'اسم_الطبيب': docName,
    'موعد_القادم': nextStr,
    'نوع_الجهاز': pl && pl.orthoDev ? pl.orthoDev : '',
    'اسم_العيادة': clinic.name || 'عيادة سوران'
  };
}

function odBuildMsg(type, planId){
  var tpl = odTplFor(type);
  var vars = odVarsFor(planId);
  var out = tpl.body || '';
  Object.keys(vars).forEach(function(k){ out = out.split('{'+k+'}').join(vars[k]||''); });
  return out;
}

// Open picker from session modal (uses the ortho plan being edited)
function odOpenPickerFromSession(){
  var planId = document.getElementById('sessPlanId') && document.getElementById('sessPlanId').value;
  if (!planId) { alert('افتح جلسة أولاً'); return; }
  odOpenPicker(planId);
}

// Generic opener — can be called with any ortho plan id
function odOpenPicker(planId){
  var pl = G('plans',[]).find(function(p){return p.id===planId;});
  if (!pl) { alert('الخطة غير موجودة'); return; }
  if (pl.planType !== 'ortho') { alert('هذه الميزة لخطط التقويم فقط'); return; }
  var pt = pm()[pl.patientId];
  if (!pt) { alert('المريض غير موجود'); return; }
  document.getElementById('odPickPlanId').value = planId;
  document.getElementById('odPickInfo').textContent = '👤 ' + pt.name + (pt.phone ? ' • 📞 ' + pt.phone : '') + (pl.orthoDev ? ' • 🦷 ' + pl.orthoDev : '');
  // Show edit button only for managers
  var editBtn = document.getElementById('odPickEditBtn');
  if (editBtn) editBtn.style.display = (CU && (CU.role==='manager' || CU.role==='doctor-manager')) ? 'inline-block' : 'none';
  // Render appliance cards
  var tpls = odTpls();
  // Suggest one appliance type based on plan.orthoDev (fuzzy match)
  var dev = (pl.orthoDev||'').toLowerCase();
  var suggested = '';
  if (/aligner|شفاف/.test(dev)) suggested = 'aligners';
  else if (/براكيت|ثابت|metal|ceramic|لساني/.test(dev)) suggested = 'fixed';
  var html = ORTHO_DEV_ORDER.map(function(key){
    var t = tpls[key] || DEFAULT_ORTHO_DEV_TPLS[key];
    var preview = (t.body || '').replace(/\n/g,' ').slice(0, 90) + '...';
    var isSug = (key === suggested);
    return '<div style="border:'+(isSug?'2px solid #6c2fa0':'1.5px solid var(--border)')+';border-radius:var(--r);padding:10px 12px;background:'+(isSug?'#faf5ff':'#fff')+';position:relative">'+
      (isSug?'<span style="position:absolute;top:-8px;right:10px;background:#6c2fa0;color:#fff;border-radius:10px;padding:2px 8px;font-size:9px;font-weight:700">مقترح للمريض</span>':'')+
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'+
        '<div style="font-size:22px">'+(t.icon||'📱')+'</div>'+
        '<div style="flex:1"><div style="font-weight:800;font-size:13px;color:var(--gray6)">'+(t.label||key)+'</div><div style="font-size:10px;color:var(--gray5)">'+(t.title||'')+'</div></div>'+
      '</div>'+
      '<div style="font-size:11px;color:#666;line-height:1.5;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+preview+'</div>'+
      '<div style="display:flex;gap:5px;flex-wrap:wrap">'+
        '<button class="btn btn-ghost btn-xs" onclick="odPreviewMsg(\''+key+'\')">👁️ معاينة</button>'+
        '<button class="btn btn-ghost btn-xs" onclick="odCopyMsg(\''+key+'\')">📋 نسخ</button>'+
        (pt.phone ? '<button class="btn btn-xs" style="background:#25D366;color:#fff;border:none;margin-right:auto;font-weight:700" onclick="odSendWa(\''+key+'\')">💬 إرسال واتساب</button>' : '<span style="color:var(--red);font-size:10px;margin-right:auto">لا يوجد رقم هاتف</span>')+
      '</div></div>';
  }).join('');
  document.getElementById('odPickList').innerHTML = html;
  openModal('mo-orthoDevPicker');
}

function odPreviewMsg(type){
  var planId = document.getElementById('odPickPlanId').value;
  var msg = odBuildMsg(type, planId);
  var tpl = odTplFor(type);
  var ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
  ov.onclick = function(e){ if(e.target===ov) ov.remove(); };
  ov.innerHTML = '<div style="background:#fff;border-radius:14px;max-width:520px;width:100%;max-height:85vh;overflow:auto;direction:rtl">'+
    '<div style="background:#6c2fa0;color:#fff;padding:14px 18px;border-radius:14px 14px 0 0;display:flex;justify-content:space-between;align-items:center">'+
      '<div><div style="font-weight:800;font-size:14px">'+(tpl.icon||'📱')+' '+(tpl.label||'')+'</div><div style="font-size:11px;opacity:.85">معاينة الرسالة</div></div>'+
      '<button onclick="this.closest(\'div[style*=fixed]\').remove()" style="background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:13px">✕</button>'+
    '</div>'+
    '<div style="padding:18px;font-size:13px;line-height:1.8;white-space:pre-line;color:#1a2332">'+msg.replace(/</g,'&lt;')+'</div>'+
    '</div>';
  document.body.appendChild(ov);
}

function odCopyMsg(type){
  var planId = document.getElementById('odPickPlanId').value;
  var msg = odBuildMsg(type, planId);
  if (navigator.clipboard) navigator.clipboard.writeText(msg).then(function(){ alert('✅ تم نسخ الرسالة'); });
  else { var ta=document.createElement('textarea'); ta.value=msg; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); alert('✅ تم نسخ الرسالة'); }
}

function odSendWa(type){
  var planId = document.getElementById('odPickPlanId').value;
  var pl = G('plans',[]).find(function(p){return p.id===planId;});
  var pt = pl ? pm()[pl.patientId] : null;
  if (!pt || !pt.phone) { alert('لا يوجد رقم هاتف للمريض'); return; }
  var msg = odBuildMsg(type, planId);
  var n = pt.phone.replace(/\D/g,'');
  var fullN = n.startsWith('0') ? '964' + n.slice(1) : n;
  window.open('https://wa.me/' + fullN + '?text=' + encodeURIComponent(msg), '_blank');
  // Log it
  try {
    var log = G('orthoMsgLog', []);
    log.unshift({ id: uid(), patientId: pt.id, planId: planId, type: type, sentAt: new Date().toISOString(), sentBy: CU?CU.id:null });
    if (log.length > 200) log = log.slice(0, 200);
    S('orthoMsgLog', log);
  } catch(e) {}
  closeModal('mo-orthoDevPicker');
  if (typeof addNotif === 'function') addNotif('📱', 'رسالة جهاز أُرسلت', 'إلى ' + pt.name + ' (' + (odTplFor(type).label||type) + ')');
}

// ─── Editor (manager only) ───
function openOrthoDevTplEditor(){
  if (!(CU && (CU.role==='manager' || CU.role==='doctor-manager'))) { alert('للمدير فقط'); return; }
  document.getElementById('odtSel').value = 'fixed';
  odTplLoad();
  openModal('mo-editOrthoDevTpl');
}

function odTplLoad(){
  var type = document.getElementById('odtSel').value;
  var t = odTplFor(type);
  document.getElementById('odtTitle').value = t.title || '';
  document.getElementById('odtBody').value = t.body || '';
}

function odTplSave(){
  var type = document.getElementById('odtSel').value;
  var title = (document.getElementById('odtTitle').value || '').trim();
  var body = (document.getElementById('odtBody').value || '').trim();
  if (!title || !body) { alert('العنوان والنص إلزاميان'); return; }
  var all = odTpls();
  // Preserve icon and label from defaults
  var def = DEFAULT_ORTHO_DEV_TPLS[type] || {};
  all[type] = { icon: def.icon || '📱', label: def.label || type, title: title, body: body };
  S('orthoDevTpls', all);
  alert('✅ تم حفظ القالب');
}

function odTplResetOne(){
  if (!confirm('إعادة هذا القالب إلى الافتراضي؟')) return;
  var type = document.getElementById('odtSel').value;
  var all = odTpls();
  all[type] = JSON.parse(JSON.stringify(DEFAULT_ORTHO_DEV_TPLS[type]));
  S('orthoDevTpls', all);
  odTplLoad();
}

// ═══════════════════════════════════════════════════
//  SOUNDS (Web Audio API — no external files needed)
// ═══════════════════════════════════════════════════
function playSound(type){
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    function tone(freq, start, dur, vol){
      var osc = ctx.createOscillator(); var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(vol||0.35, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.05);
    }
    if (type === 'arrival') {
      // Doorbell-style chime: ding-dong (high → low → high) — clearly audible
      tone(880, 0.00, 0.35, 0.45);  // ding
      tone(659, 0.30, 0.45, 0.45);  // dong
      tone(880, 0.65, 0.55, 0.40);  // ding (echo)
    } else if (type === 'urgent_ring') {
      // Loud, urgent staff-call bell — repeating BRRRRING-BRRRRING (~2.5s)
      // First ring burst (alternating high-low rapid)
      tone(1000, 0.00, 0.10, 0.50);
      tone(800,  0.10, 0.10, 0.50);
      tone(1000, 0.20, 0.10, 0.50);
      tone(800,  0.30, 0.10, 0.50);
      tone(1000, 0.40, 0.10, 0.50);
      tone(800,  0.50, 0.10, 0.50);
      tone(1000, 0.60, 0.15, 0.50);
      // pause 0.25s
      // Second ring burst
      tone(1000, 1.00, 0.10, 0.50);
      tone(800,  1.10, 0.10, 0.50);
      tone(1000, 1.20, 0.10, 0.50);
      tone(800,  1.30, 0.10, 0.50);
      tone(1000, 1.40, 0.10, 0.50);
      tone(800,  1.50, 0.10, 0.50);
      tone(1000, 1.60, 0.20, 0.50);
    } else if (type === 'task') {
      // Two-tone ascending notification
      tone(523, 0.00, 0.18, 0.30);  // C5
      tone(784, 0.18, 0.28, 0.30);  // G5
    } else if (type === 'message') {
      // Soft single ping
      tone(1047, 0.00, 0.18, 0.25); // C6
    } else {
      // Default: simple beep (matches old addNotif sound)
      tone(880, 0.00, 0.40, 0.30);
    }
  } catch(e){ console.warn('sound err', e); }
}

// ═══════════════════════════════════════════════════
//  ARRIVAL ALERT (Reception)
// ═══════════════════════════════════════════════════
function markArrived(apptId){
  var appts = G('appointments',[]);
  var a = appts.find(function(x){return x.id===apptId;});
  if (!a) return;
  if (a.status === 'arrived') { alert('✓ سبق وأشّرت قدوم هذا المريض'); return; }
  a.status = 'arrived';
  a.arrivedAt = new Date().toISOString();
  a.arrivedBy = CU ? CU.id : '';
  a.arrivedByRole = CU ? CU.role : '';
  S('appointments', appts);
  var pt = pm()[a.patientId];
  var doc = sm()[a.doctorId];
  var ptName = pt ? pt.name : 'مريض';
  var docName = doc ? doc.name : '';
  // Loud, clear chime locally
  playSound('arrival');
  // In-app notification with arrival sound
  addNotifSilent('🛎️','قَدِم مريض','وصل '+ptName+(docName?' • للدكتور '+docName:''),'navTo(\'appointments\')');
  // Push alert to all reception staff devices
  try { pushNotifyRole('🛎️ قَدِم مريض', 'وصل '+ptName+(docName?' • '+docName:''), 'reception'); } catch(e){}
  // Also alert the doctor
  try { 
    if (doc && doc.id) {
      pushNotify('👤 قَدِم مريضك', 'وصل '+ptName+' وهو بانتظارك', {type:'arrival', apptId:apptId});
    }
  } catch(e){}
  // Re-render current page
  var act = document.querySelector('.page.active');
  if (act) renderPage(act.id.replace('pg-',''));
}

// addNotif variant that doesn't double-play sound (we already played arrival chime)
function addNotifSilent(icon, title, body, action) {
  if (typeof _notifs === 'undefined') return;
  var n = { id: uid(), icon: icon, title: title, body: body, action: action, time: new Date().toISOString(), read: false };
  _notifs.unshift(n);
  if (_notifs.length > 50) _notifs = _notifs.slice(0, 50);
  Sl('notifs', _notifs);
  renderNotifBadge();
  renderNotifList();
}

// ═══════════════════════════════════════════════════
//  TASKS
// ═══════════════════════════════════════════════════
var _tkTab = 'my';
var PRIORITY_LABEL = {low:'🟢 منخفضة', medium:'🟡 متوسطة', high:'🟠 عالية', urgent:'🔴 عاجلة'};
var PRIORITY_COLOR = {low:'#16a34a', medium:'#ca8a04', high:'#ea580c', urgent:'#dc2626'};
var TASK_STATUS_LABEL = {pending:'⏳ قيد الانتظار', in_progress:'🔄 قيد التنفيذ', done:'✅ منجزة', cancelled:'❌ ملغاة'};

function setTaskTab(tab, btn){
  _tkTab = tab;
  document.querySelectorAll('.tk-tab').forEach(function(b){
    b.className = 'btn btn-ghost btn-sm tk-tab';
  });
  if (btn) btn.className = 'btn btn-primary btn-sm tk-tab active';
  renderTasks();
}

function canAssignTasks(){
  return CU && (CU.role==='doctor-manager' || CU.role==='manager' || CU.role==='doctor');
}

function renderTasks(){
  if (!CU) return;
  // Show "+ مهمة جديدة", "Assigned by me", "All" only for assigners
  var btn = document.getElementById('newTaskBtn');
  if (btn) btn.style.display = canAssignTasks() ? 'inline-flex' : 'none';
  document.getElementById('tkTabAssigned').style.display = canAssignTasks() ? 'inline-flex' : 'none';
  document.getElementById('tkTabAll').style.display = (CU.role==='doctor-manager'||CU.role==='manager') ? 'inline-flex' : 'none';

  var tasks = G('tasks', []);
  var smap = sm();
  var filtered = tasks.slice();
  if (_tkTab === 'my') {
    filtered = tasks.filter(function(t){ return t.assigneeId===CU.id && t.status!=='done' && t.status!=='cancelled'; });
  } else if (_tkTab === 'assigned') {
    filtered = tasks.filter(function(t){ return t.assignerId===CU.id && t.status!=='done' && t.status!=='cancelled'; });
  } else if (_tkTab === 'done') {
    filtered = tasks.filter(function(t){ return (t.status==='done' || t.status==='cancelled') && (t.assigneeId===CU.id || t.assignerId===CU.id || CU.role==='doctor-manager' || CU.role==='manager'); });
  } else if (_tkTab === 'all') {
    filtered = tasks.filter(function(t){ return t.status!=='done' && t.status!=='cancelled'; });
  }
  // Sort: urgent first, then by due date, then by created
  filtered.sort(function(a,b){
    var pOrder = {urgent:0, high:1, medium:2, low:3};
    var pa = pOrder[a.priority]||2, pb = pOrder[b.priority]||2;
    if (pa !== pb) return pa - pb;
    if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return (b.createdAt||'') < (a.createdAt||'') ? -1 : 1;
  });

  var el = document.getElementById('tasksList');
  if (!filtered.length) {
    el.innerHTML = emptyState('📋','لا توجد مهام');
    return;
  }
  el.innerHTML = filtered.map(function(t){
    var ass = smap[t.assigneeId];
    var by = smap[t.assignerId];
    var pColor = PRIORITY_COLOR[t.priority] || '#666';
    var todayStr = today();
    var overdue = t.dueDate && t.dueDate < todayStr && t.status!=='done' && t.status!=='cancelled';
    var canEdit = CU && (CU.id===t.assignerId || CU.role==='doctor-manager' || CU.role==='manager');
    var canMarkDone = CU && (CU.id===t.assigneeId || canEdit) && t.status!=='done' && t.status!=='cancelled';
    var canStart = canMarkDone && t.status==='pending';
    return '<div class="card" style="margin-bottom:10px;border-right:4px solid '+pColor+'"><div class="card-body">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">'+
        '<div style="flex:1;min-width:200px">'+
          '<div style="font-weight:800;font-size:14px;color:var(--gray6)">'+(t.title||'')+'</div>'+
          (t.description?'<div style="font-size:12px;color:var(--gray5);margin-top:4px;white-space:pre-line">'+t.description+'</div>':'')+
        '</div>'+
        '<div style="font-size:11px;color:'+pColor+';font-weight:700;white-space:nowrap">'+(PRIORITY_LABEL[t.priority]||'')+'</div>'+
      '</div>'+
      '<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--gray5);margin-top:10px;font-weight:600">'+
        '<span>👤 <strong>'+(ass?ass.name:'?')+'</strong></span>'+
        (by?'<span>📤 من '+by.name+'</span>':'')+
        (t.dueDate?'<span style="color:'+(overdue?'var(--red)':'inherit')+'">📅 '+t.dueDate+(overdue?' (متأخر)':'')+'</span>':'')+
        '<span>'+(TASK_STATUS_LABEL[t.status]||t.status)+'</span>'+
      '</div>'+
      '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap">'+
        (canStart?'<button class="btn btn-ghost btn-xs" onclick="setTaskStatus(\''+t.id+'\',\'in_progress\')">▶️ بدء</button>':'')+
        (canMarkDone?'<button class="btn btn-success btn-xs" onclick="setTaskStatus(\''+t.id+'\',\'done\')">✅ إنجاز</button>':'')+
        (canEdit && t.status!=='done' && t.status!=='cancelled'?'<button class="btn btn-ghost btn-xs" onclick="editTask(\''+t.id+'\')">✏️</button>':'')+
        (canEdit?'<button class="btn btn-danger btn-xs" onclick="deleteTask(\''+t.id+'\')">🗑</button>':'')+
      '</div>'+
    '</div></div>';
  }).join('');
}

function openNewTask(){
  if (!canAssignTasks()) { alert('فقط المدير أو الطبيب يقدر يضيف مهمة'); return; }
  document.getElementById('taskEditId').value = '';
  document.getElementById('taskTitle').value = '';
  document.getElementById('taskDesc').value = '';
  document.getElementById('taskPriority').value = 'medium';
  document.getElementById('taskDueDate').value = '';
  // Populate assignee dropdown
  var sel = document.getElementById('taskAssignee');
  var staff = G('staff',[]).filter(function(s){return s.role!=='patient';});
  sel.innerHTML = staff.map(function(s){
    return '<option value="'+s.id+'">'+s.name+(s.subRole?' ('+s.subRole+')':'')+' — '+(ROLE_LABEL[s.role]||s.role)+'</option>';
  }).join('');
  document.getElementById('newTaskTitle').textContent = '➕ مهمة جديدة';
  openModal('mo-newTask');
}

function editTask(id){
  var t = G('tasks',[]).find(function(x){return x.id===id;});
  if (!t) return;
  document.getElementById('taskEditId').value = id;
  document.getElementById('taskTitle').value = t.title || '';
  document.getElementById('taskDesc').value = t.description || '';
  document.getElementById('taskPriority').value = t.priority || 'medium';
  document.getElementById('taskDueDate').value = t.dueDate || '';
  var sel = document.getElementById('taskAssignee');
  var staff = G('staff',[]).filter(function(s){return s.role!=='patient';});
  sel.innerHTML = staff.map(function(s){
    return '<option value="'+s.id+'"'+(s.id===t.assigneeId?' selected':'')+'>'+s.name+(s.subRole?' ('+s.subRole+')':'')+' — '+(ROLE_LABEL[s.role]||s.role)+'</option>';
  }).join('');
  document.getElementById('newTaskTitle').textContent = '✏️ تعديل مهمة';
  openModal('mo-newTask');
}

function saveTask(){
  var title = (document.getElementById('taskTitle').value||'').trim();
  var desc = (document.getElementById('taskDesc').value||'').trim();
  var assigneeId = document.getElementById('taskAssignee').value;
  var priority = document.getElementById('taskPriority').value;
  var dueDate = document.getElementById('taskDueDate').value;
  var editId = document.getElementById('taskEditId').value;
  if (!title) return alert('عنوان المهمة مطلوب');
  if (!assigneeId) return alert('اختر شخص لإسناد المهمة إليه');
  var tasks = G('tasks',[]);
  var ass = sm()[assigneeId];
  if (editId) {
    var idx = tasks.findIndex(function(t){return t.id===editId;});
    if (idx>=0) {
      tasks[idx] = Object.assign({}, tasks[idx], {title:title, description:desc, assigneeId:assigneeId, priority:priority, dueDate:dueDate, updatedAt:new Date().toISOString()});
    }
  } else {
    tasks.unshift({
      id: 't'+uid(),
      title: title,
      description: desc,
      assigneeId: assigneeId,
      assignerId: CU.id,
      priority: priority,
      dueDate: dueDate,
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    // Push notification to assignee
    try {
      pushNotify('📋 مهمة جديدة', title + (ass?' • مكلّف: '+ass.name:''), {type:'task'});
    } catch(e){}
    // In-app notification (only show to current user if they're the assignee, otherwise skip — but other devices see it via polling)
    if (assigneeId === CU.id) {
      addNotif('📋','تمت إضافة مهمة لك','من: '+CU.name+' • '+title,'navTo(\'tasks\')');
    } else {
      addNotif('📤','أسندت مهمة','إلى: '+(ass?ass.name:'?')+' • '+title,'navTo(\'tasks\')');
    }
  }
  S('tasks', tasks);
  closeModal('mo-newTask');
  renderTasks();
}

function setTaskStatus(id, status){
  var tasks = G('tasks',[]);
  var t = tasks.find(function(x){return x.id===id;});
  if (!t) return;
  t.status = status;
  if (status==='done') t.completedAt = new Date().toISOString();
  if (status==='in_progress') t.startedAt = new Date().toISOString();
  S('tasks', tasks);
  // Notify assigner if task done by someone else
  if (status==='done' && t.assignerId && t.assignerId !== CU.id) {
    var assigner = sm()[t.assignerId];
    if (assigner) {
      try { pushNotify('✅ مهمة منجزة', t.title+' • أنجزها: '+(CU?CU.name:''), {type:'task'}); } catch(e){}
    }
  }
  renderTasks();
}

function deleteTask(id){
  if (!confirm('حذف هذه المهمة؟')) return;
  S('tasks', G('tasks',[]).filter(function(t){return t.id!==id;}));
  renderTasks();
}

// ═══════════════════════════════════════════════════
//  CHAT — Group channel + Private DMs
// ═══════════════════════════════════════════════════
// chatMessages structure: [{id, senderId, channel, text, createdAt, readBy:[]}]
// channel = 'group' for everyone, or 'dm:<id1>:<id2>' (sorted) for private
var _chatLastSeen = 0;
var _activeChannel = null;  // null = list view; 'group' or 'dm:...' = inside conversation
var _chatTab = 'all';

// Build a deterministic DM channel id between two users (sorted)
function dmChannelId(idA, idB){
  var a = String(idA||''), b = String(idB||'');
  return 'dm:' + (a < b ? a + ':' + b : b + ':' + a);
}

// Get the "other" user id from a DM channel (relative to current user)
function dmOtherUser(channel){
  if (!channel || channel.indexOf('dm:') !== 0) return null;
  var parts = channel.split(':');
  if (parts.length !== 3) return null;
  return parts[1] === CU.id ? parts[2] : parts[1];
}

// Get all messages in a specific channel
function getChannelMessages(channel){
  var msgs = G('chatMessages', []);
  return msgs.filter(function(m){
    var ch = m.channel || 'group';  // legacy messages without channel default to group
    return ch === channel;
  });
}

// Find which channels current user is part of
function getMyChannels(){
  var msgs = G('chatMessages', []);
  var channels = {};
  // Always include group channel for everyone
  channels['group'] = { id:'group', type:'group', lastMsg:null, unread:0 };
  msgs.forEach(function(m){
    var ch = m.channel || 'group';
    if (ch === 'group') {
      // Track last message and unread for group
      if (!channels.group.lastMsg || m.createdAt > channels.group.lastMsg.createdAt) channels.group.lastMsg = m;
    } else if (ch.indexOf('dm:') === 0) {
      // Only show DM if current user is part of it
      var parts = ch.split(':');
      if (parts.length !== 3) return;
      if (parts[1] !== CU.id && parts[2] !== CU.id) return;
      if (!channels[ch]) channels[ch] = { id:ch, type:'dm', lastMsg:null, unread:0 };
      if (!channels[ch].lastMsg || m.createdAt > channels[ch].lastMsg.createdAt) channels[ch].lastMsg = m;
    }
  });
  // Compute unread per channel
  var readMap = G('chatReadMap', {});
  Object.keys(channels).forEach(function(ch){
    var lastRead = readMap[ch] || '';
    var chMsgs = msgs.filter(function(m){ return (m.channel||'group') === ch; });
    channels[ch].unread = chMsgs.filter(function(m){
      return m.senderId !== CU.id && m.createdAt > lastRead;
    }).length;
  });
  return channels;
}

function setChatTab(tab, btn){
  _chatTab = tab;
  document.querySelectorAll('.chat-tab').forEach(function(b){
    b.style.borderBottom = ''; b.classList.remove('active');
  });
  if (btn) { btn.style.borderBottom = '3px solid var(--blue2)'; btn.classList.add('active'); }
  renderChannelsList();
}

function renderChannelsList(){
  var channels = getMyChannels();
  var smap = sm();
  var list = Object.values(channels);
  // Filter by tab
  if (_chatTab === 'dm') list = list.filter(function(c){ return c.type === 'dm'; });
  // Sort by unread first, then by last message time
  list.sort(function(a,b){
    if ((b.unread>0?1:0) !== (a.unread>0?1:0)) return (b.unread>0?1:0) - (a.unread>0?1:0);
    var at = a.lastMsg ? a.lastMsg.createdAt : '';
    var bt = b.lastMsg ? b.lastMsg.createdAt : '';
    return bt < at ? -1 : 1;
  });
  var el = document.getElementById('chatChannelsList');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--gray4);padding:40px 20px;font-size:13px">💬 لا توجد محادثات بعد</div>';
    return;
  }
  el.innerHTML = list.map(function(c){
    var icon, name, sub;
    if (c.type === 'group') {
      icon = '<div style="width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#0d5c7a,#0a7a8c);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">👥</div>';
      name = 'محادثة الكادر العامة';
      sub = 'كل أعضاء العيادة';
    } else {
      var otherId = dmOtherUser(c.id);
      var other = smap[otherId];
      var initial = (other?other.name:'?').replace('د.','').trim().charAt(0);
      icon = '<div style="width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#6c2fa0,#9333ea);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;flex-shrink:0">'+initial+'</div>';
      name = other ? other.name : 'مستخدم محذوف';
      sub = other ? (ROLE_LABEL[other.role]||'') + (other.subRole?' • '+other.subRole:'') : '';
    }
    var preview = '';
    if (c.lastMsg) {
      var lastSender = smap[c.lastMsg.senderId];
      var prefix = c.lastMsg.senderId === CU.id ? 'أنت: ' : (c.type==='group' && lastSender ? lastSender.name+': ' : '');
      preview = prefix + (c.lastMsg.text||'').slice(0,50);
    } else {
      preview = '<em style="color:var(--gray4)">لا توجد رسائل بعد</em>';
    }
    var timeStr = c.lastMsg ? new Date(c.lastMsg.createdAt).toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'}) : '';
    var unreadBadge = c.unread > 0 ? '<div style="background:#ef4444;color:#fff;border-radius:10px;min-width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;padding:0 6px;flex-shrink:0">'+(c.unread>9?'9+':c.unread)+'</div>' : '';
    return '<div onclick="openChannel(\''+c.id+'\')" style="display:flex;align-items:center;gap:10px;padding:12px;border-bottom:1px solid var(--gray2);cursor:pointer;transition:background .15s" onmouseover="this.style.background=\'#f8fbfd\'" onmouseout="this.style.background=\'\'">'+
      icon+
      '<div style="flex:1;min-width:0">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div style="font-weight:800;font-size:14px;color:var(--gray6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+name+'</div><div style="font-size:10px;color:var(--gray4);white-space:nowrap">'+timeStr+'</div></div>'+
        (sub?'<div style="font-size:10px;color:var(--gray4)">'+sub+'</div>':'')+
        '<div style="font-size:12px;color:var(--gray5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px">'+preview+'</div>'+
      '</div>'+
      unreadBadge+
    '</div>';
  }).join('');
}

function openChannel(channelId){
  _activeChannel = channelId;
  document.getElementById('chatListView').style.display = 'none';
  document.getElementById('chatConvView').style.display = 'block';
  document.getElementById('chatBackBtn').style.display = 'inline-flex';
  // Header
  var hdr = document.getElementById('chatConvHeader');
  if (channelId === 'group') {
    hdr.innerHTML = '<div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#0d5c7a,#0a7a8c);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px">👥</div><div><div>محادثة الكادر العامة</div><div style="font-size:10px;color:var(--gray4);font-weight:500">كل أعضاء العيادة</div></div>';
  } else {
    var otherId = dmOtherUser(channelId);
    var other = sm()[otherId];
    var initial = (other?other.name:'?').replace('د.','').trim().charAt(0);
    hdr.innerHTML = '<div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6c2fa0,#9333ea);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800">'+initial+'</div><div><div>'+(other?other.name:'مستخدم محذوف')+'</div><div style="font-size:10px;color:var(--gray4);font-weight:500">'+(other?(ROLE_LABEL[other.role]||''):'')+'</div></div>';
  }
  renderChat();
  setTimeout(function(){ var inp=document.getElementById('chatInput'); if(inp)inp.focus(); }, 100);
}

function showChatList(){
  _activeChannel = null;
  document.getElementById('chatListView').style.display = 'block';
  document.getElementById('chatConvView').style.display = 'none';
  document.getElementById('chatBackBtn').style.display = 'none';
  renderChannelsList();
}

// Master entry called by renderPage
function renderChatPage(){
  if (_activeChannel) {
    // Refresh current conversation
    document.getElementById('chatListView').style.display = 'none';
    document.getElementById('chatConvView').style.display = 'block';
    document.getElementById('chatBackBtn').style.display = 'inline-flex';
    renderChat();
  } else {
    showChatList();
  }
}

// Render the messages of the active channel
function renderChat(){
  if (!CU) return;
  var box = document.getElementById('chatBox');
  if (!box) return;
  if (!_activeChannel) { showChatList(); return; }
  var msgs = getChannelMessages(_activeChannel);
  var smap = sm();
  if (!msgs.length) {
    box.innerHTML = '<div style="text-align:center;color:var(--gray4);padding:40px 20px;font-size:13px">💬 لا توجد رسائل بعد. ابدأ المحادثة!</div>';
  } else {
    box.innerHTML = msgs.slice(-200).map(function(m){
      var sender = smap[m.senderId];
      var isMine = m.senderId === CU.id;
      var senderName = sender ? sender.name : 'مستخدم محذوف';
      var t = new Date(m.createdAt);
      var timeStr = t.toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'}) + ' • ' + t.toLocaleDateString('ar-IQ',{day:'numeric',month:'short'});
      var bg = isMine ? '#0d5c7a' : '#fff';
      var color = isMine ? '#fff' : 'var(--gray6)';
      var border = isMine ? 'none' : '1.5px solid var(--border)';
      var align = isMine ? 'flex-end' : 'flex-start';
      var nameColor = isMine ? 'rgba(255,255,255,.85)' : 'var(--blue2)';
      // Show sender name only in group chat (not needed in DM)
      var showName = !isMine && _activeChannel === 'group';
      return '<div style="display:flex;justify-content:'+align+'">'+
        '<div style="max-width:75%;background:'+bg+';color:'+color+';border:'+border+';border-radius:14px;padding:8px 12px;box-shadow:0 1px 2px rgba(0,0,0,.06)">'+
          (showName?'<div style="font-size:10px;font-weight:800;color:'+nameColor+';margin-bottom:2px">'+senderName+'</div>':'')+
          '<div style="font-size:13px;white-space:pre-line;line-height:1.5">'+(m.text||'').replace(/</g,'&lt;')+'</div>'+
          '<div style="font-size:9px;opacity:.65;margin-top:3px;text-align:left">'+timeStr+'</div>'+
        '</div>'+
      '</div>';
    }).join('');
    setTimeout(function(){ box.scrollTop = box.scrollHeight; }, 50);
  }
  // Mark this channel as read
  if (msgs.length) {
    var readMap = G('chatReadMap', {});
    readMap[_activeChannel] = msgs[msgs.length-1].createdAt;
    Sl('chatReadMap', readMap);
  }
  renderChatBadge();
}

function sendChat(){
  var inp = document.getElementById('chatInput');
  if (!inp || !_activeChannel) return;
  var text = (inp.value||'').trim();
  if (!text) return;
  var msgs = G('chatMessages', []);
  msgs.push({
    id: 'm'+uid(),
    senderId: CU.id,
    channel: _activeChannel,
    text: text,
    createdAt: new Date().toISOString()
  });
  // Cap at 1000 messages globally
  if (msgs.length > 1000) msgs = msgs.slice(-1000);
  S('chatMessages', msgs);
  inp.value = '';
  renderChat();
  // Push notification
  try {
    if (_activeChannel === 'group') {
      pushNotify('💬 '+CU.name+' • محادثة الكادر', text.length>60?text.slice(0,60)+'...':text, {type:'chat',channel:'group'});
    } else {
      var otherId = dmOtherUser(_activeChannel);
      var other = sm()[otherId];
      pushNotify('💬 '+CU.name+' (رسالة خاصة)', text.length>60?text.slice(0,60)+'...':text, {type:'chat',channel:_activeChannel});
    }
  } catch(e){}
}

function openNewDM(){
  var staff = G('staff', []).filter(function(s){ return s.role !== 'patient' && s.id !== CU.id; });
  if (!staff.length) { alert('لا يوجد كادر آخر للمراسلة'); return; }
  var roleColor = {'doctor':'#0d5c7a','doctor-manager':'#6c2fa0','manager':'#6c2fa0','reception':'#16a34a','marketer':'#c96a00'};
  document.getElementById('dmStaffList').innerHTML = staff.map(function(s){
    var bg = roleColor[s.role] || '#6e8fa3';
    var initial = (s.name||'?').replace('د.','').trim().charAt(0);
    return '<button type="button" onclick="startDM(\''+s.id+'\')" style="display:flex;align-items:center;gap:10px;padding:10px;border:1.5px solid var(--border);border-radius:10px;background:#fff;cursor:pointer;font-family:Tajawal,sans-serif;text-align:right;width:100%">'+
      '<div style="width:36px;height:36px;border-radius:50%;background:'+bg+';color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;flex-shrink:0">'+initial+'</div>'+
      '<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:var(--gray6)">'+s.name+'</div><div style="font-size:11px;color:var(--gray4)">'+(ROLE_LABEL[s.role]||s.role)+(s.subRole?' • '+s.subRole:'')+'</div></div>'+
    '</button>';
  }).join('');
  openModal('mo-newDM');
}

function startDM(otherId){
  closeModal('mo-newDM');
  var ch = dmChannelId(CU.id, otherId);
  openChannel(ch);
}

function renderChatBadge(){
  // Total unread across all channels for current user
  var msgs = G('chatMessages', []);
  var readMap = G('chatReadMap', {});
  var total = 0;
  // Group by channel
  var byChannel = {};
  msgs.forEach(function(m){
    var ch = m.channel || 'group';
    if (ch !== 'group' && ch.indexOf('dm:') === 0) {
      var parts = ch.split(':');
      if (parts.length !== 3) return;
      if (parts[1] !== (CU?CU.id:'') && parts[2] !== (CU?CU.id:'')) return;
    }
    if (!byChannel[ch]) byChannel[ch] = [];
    byChannel[ch].push(m);
  });
  Object.keys(byChannel).forEach(function(ch){
    var lastRead = readMap[ch] || '';
    byChannel[ch].forEach(function(m){
      if (m.senderId !== (CU?CU.id:'') && m.createdAt > lastRead) total++;
    });
  });
  // Badge on sidebar item
  var sb = document.getElementById('sb-chat');
  if (sb) {
    var existing = sb.querySelector('.chat-badge');
    if (existing) existing.remove();
    if (total > 0) {
      var b = document.createElement('span');
      b.className = 'chat-badge';
      b.style.cssText = 'background:#ef4444;color:#fff;border-radius:10px;min-width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;padding:0 5px;margin-right:auto';
      b.textContent = total > 9 ? '9+' : total;
      sb.appendChild(b);
    }
  }
  var bn = document.getElementById('bn-chat');
  if (bn) {
    var existing2 = bn.querySelector('.chat-badge');
    if (existing2) existing2.remove();
    if (total > 0) {
      var b2 = document.createElement('span');
      b2.className = 'chat-badge';
      b2.style.cssText = 'position:absolute;top:2px;left:8px;background:#ef4444;color:#fff;border-radius:10px;min-width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;padding:0 4px';
      b2.textContent = total > 9 ? '9+' : total;
      bn.style.position = 'relative';
      bn.appendChild(b2);
    }
  }
}

// Poll for new messages — alert if window is open elsewhere
var _chatLastNotifiedId = '';
var _chatPollInterval = setInterval(function(){
  if (!CU) return;
  var msgs = G('chatMessages', []);
  if (!msgs.length) return;
  // Find newest message addressed to me (in group OR in a DM I'm part of) that I haven't notified about
  var relevantMsgs = msgs.filter(function(m){
    if (m.senderId === CU.id) return false;
    var ch = m.channel || 'group';
    if (ch === 'group') return true;
    if (ch.indexOf('dm:') !== 0) return false;
    var parts = ch.split(':');
    return parts.length === 3 && (parts[1] === CU.id || parts[2] === CU.id);
  });
  if (!relevantMsgs.length) { renderChatBadge(); return; }
  var last = relevantMsgs[relevantMsgs.length - 1];
  if (last.id === _chatLastNotifiedId) { renderChatBadge(); return; }
  // Skip if message is older than 2 minutes (avoid replay on app open)
  if ((Date.now() - new Date(last.createdAt).getTime()) > 120000) { _chatLastNotifiedId = last.id; renderChatBadge(); return; }
  // Skip if user is currently viewing the same channel
  var pgChat = document.getElementById('pg-chat');
  var isViewingSame = pgChat && pgChat.classList.contains('active') && _activeChannel === (last.channel||'group');
  if (isViewingSame) { _chatLastNotifiedId = last.id; renderChatBadge(); return; }
  // Play sound + add in-app notif
  try { playSound('message'); } catch(e){}
  var sender = sm()[last.senderId];
  var isDM = (last.channel||'').indexOf('dm:') === 0;
  var title = isDM ? '💬 رسالة خاصة' : '💬 رسالة جديدة';
  var body = (sender?sender.name:'')+': '+(last.text||'').slice(0,80);
  addNotifSilent('💬', title, body, 'navTo(\'chat\')');
  // إشعار المتصفح إذا كان التبويب خلفي
  try { showBrowserNotif('💬', title, body, 'navTo(\'chat\')'); } catch(e){}
  // وميض جرس الإشعارات
  try {
    var bell2 = document.getElementById('notifBell');
    if (bell2){ bell2.classList.remove('notif-flash'); void bell2.offsetWidth; bell2.classList.add('notif-flash'); }
  } catch(e){}
  _chatLastNotifiedId = last.id;
  renderChatBadge();
}, 8000);

// ═══════════════════════════════════════════════════
//  STAFF CALL / BELL SYSTEM (Internal "intercom")
// ═══════════════════════════════════════════════════
var QUICK_REASONS = ['أحتاجك في الغرفة','تعقيم أدوات','مريض جاهز','مساعدة الآن','جلب أداة','استلام دفعة','مكالمة مهمة'];
var _activeIncomingCall = null;
var _ringInterval = null;

function showBellFab(){
  // Show the bell to all logged-in staff except patients
  if (!CU || CU.role === 'patient') {
    var fab = document.getElementById('bellFab');
    if (fab) fab.style.display = 'none';
    return;
  }
  var fab = document.getElementById('bellFab');
  if (fab) fab.style.display = 'flex';
}

function openCallStaff(){
  if (!CU) return;
  var staff = G('staff', []).filter(function(s){
    return s.role !== 'patient' && s.id !== CU.id;
  });
  if (!staff.length) {
    alert('لا يوجد كادر آخر متاح للاستدعاء');
    return;
  }
  // Build staff grid
  var roleColor = {'doctor':'#0d5c7a','doctor-manager':'#6c2fa0','manager':'#6c2fa0','reception':'#16a34a','marketer':'#c96a00'};
  document.getElementById('callStaffList').innerHTML = staff.map(function(s){
    var bg = roleColor[s.role] || '#6e8fa3';
    var sub = s.subRole ? ' • '+s.subRole : '';
    var initials = (s.name||'?').replace('د.','').trim().charAt(0);
    return '<button type="button" onclick="selectCallTarget(\''+s.id+'\',this)" data-id="'+s.id+'" class="call-staff-btn" style="background:#fff;border:2px solid var(--border);border-radius:10px;padding:10px;text-align:right;cursor:pointer;font-family:Tajawal,sans-serif;display:flex;align-items:center;gap:8px;transition:all .15s">'+
      '<div style="width:36px;height:36px;border-radius:50%;background:'+bg+';color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;flex-shrink:0">'+initials+'</div>'+
      '<div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:700;color:var(--gray6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+s.name+'</div>'+
      '<div style="font-size:10px;color:var(--gray4)">'+(ROLE_LABEL[s.role]||s.role)+sub+'</div></div>'+
      '</button>';
  }).join('');
  // Build quick reasons
  document.getElementById('callReasons').innerHTML = QUICK_REASONS.map(function(r){
    return '<button type="button" onclick="pickReason(\''+r.replace(/'/g,"\\'")+'\',this)" class="call-reason-btn" style="background:#fef2f2;border:1.5px solid #fecaca;color:#991b1b;border-radius:14px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:Tajawal,sans-serif">'+r+'</button>';
  }).join('');
  document.getElementById('callCustomReason').value = '';
  document.getElementById('callTargetId').value = '';
  document.getElementById('callTargetInfo').style.display = 'none';
  document.getElementById('callSendBtn').disabled = true;
  openModal('mo-callStaff');
}

function selectCallTarget(staffId, btn){
  document.getElementById('callTargetId').value = staffId;
  // Highlight selected
  document.querySelectorAll('.call-staff-btn').forEach(function(b){
    b.style.borderColor = 'var(--border)';
    b.style.background = '#fff';
  });
  if (btn) {
    btn.style.borderColor = '#dc2626';
    btn.style.background = '#fef2f2';
  }
  var s = sm()[staffId];
  if (s) {
    var info = document.getElementById('callTargetInfo');
    info.innerHTML = '🔔 سترسل استدعاءً إلى <strong>'+s.name+'</strong>'+(s.subRole?' ('+s.subRole+')':'');
    info.style.display = 'block';
  }
  document.getElementById('callSendBtn').disabled = false;
}

function pickReason(reason, btn){
  document.getElementById('callCustomReason').value = reason;
  document.querySelectorAll('.call-reason-btn').forEach(function(b){
    b.style.background = '#fef2f2'; b.style.color = '#991b1b';
  });
  if (btn) {
    btn.style.background = '#dc2626'; btn.style.color = '#fff';
  }
}

function sendCall(){
  var toId = document.getElementById('callTargetId').value;
  if (!toId) { alert('اختر شخصاً أولاً'); return; }
  var reason = (document.getElementById('callCustomReason').value||'').trim();
  var target = sm()[toId];
  var calls = G('staffCalls', []);
  // Drop calls older than 24h to keep array small
  var dayAgo = Date.now() - 86400000;
  calls = calls.filter(function(c){ return new Date(c.sentAt).getTime() > dayAgo; });
  var newCall = {
    id: 'c' + uid(),
    fromId: CU.id,
    toId: toId,
    reason: reason,
    sentAt: new Date().toISOString(),
    acknowledged: false
  };
  calls.push(newCall);
  S('staffCalls', calls);
  // Send push notification
  try {
    pushNotify('🔔 استدعاء عاجل', 'من ' + CU.name + (reason?' • '+reason:''), {type:'call', callId:newCall.id});
  } catch(e){}
  closeModal('mo-callStaff');
  // Confirmation toast
  showCallSentToast(target ? target.name : 'الكادر');
}

function showCallSentToast(targetName){
  var t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:140px;left:50%;transform:translateX(-50%);background:#16a34a;color:#fff;padding:12px 22px;border-radius:24px;font-size:13px;font-weight:700;z-index:9998;box-shadow:0 4px 20px rgba(0,0,0,.2);font-family:Tajawal,sans-serif';
  t.textContent = '✓ تم إرسال الاستدعاء إلى ' + targetName;
  document.body.appendChild(t);
  setTimeout(function(){ t.style.transition='opacity .4s'; t.style.opacity='0'; setTimeout(function(){t.remove();},400); }, 2500);
}

// Check for incoming calls — runs on poll cycle
function checkIncomingCalls(){
  if (!CU || _activeIncomingCall) return;
  var calls = G('staffCalls', []);
  var now = Date.now();
  // Find newest unacked call addressed to me, within last 2 minutes (avoid stale on first login)
  var relevant = calls.filter(function(c){
    if (c.toId !== CU.id) return false;
    if (c.acknowledged) return false;
    var age = now - new Date(c.sentAt).getTime();
    return age < 120000; // 2 minutes max
  }).sort(function(a,b){ return new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime(); });
  if (!relevant.length) return;
  var call = relevant[0];
  // Make sure we haven't already shown this one (use localStorage to track shown calls)
  var shownIds = JSON.parse(localStorage.getItem('shownCallIds') || '[]');
  if (shownIds.indexOf(call.id) >= 0) return;
  shownIds.push(call.id);
  if (shownIds.length > 50) shownIds = shownIds.slice(-50);
  localStorage.setItem('shownCallIds', JSON.stringify(shownIds));
  showIncomingCall(call);
}

function showIncomingCall(call){
  _activeIncomingCall = call;
  var from = sm()[call.fromId];
  document.getElementById('incCallFrom').textContent = from ? from.name : 'مستخدم';
  if (call.reason) {
    document.getElementById('incCallReason').textContent = call.reason;
    document.getElementById('incCallReasonWrap').style.display = 'block';
  } else {
    document.getElementById('incCallReasonWrap').style.display = 'none';
  }
  var t = new Date(call.sentAt);
  document.getElementById('incCallTime').textContent = '🕐 ' + t.toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'});
  document.getElementById('mo-incomingCall').classList.add('open');
  // Vibrate (if supported)
  try { if (navigator.vibrate) navigator.vibrate([400,200,400,200,400,200,400]); } catch(e){}
  // Play urgent ring repeatedly until acknowledged (max 3 cycles to avoid annoying)
  var rings = 0;
  playSound('urgent_ring');
  if (_ringInterval) clearInterval(_ringInterval);
  _ringInterval = setInterval(function(){
    rings++;
    if (rings >= 3 || !_activeIncomingCall) { clearInterval(_ringInterval); _ringInterval = null; return; }
    playSound('urgent_ring');
    try { if (navigator.vibrate) navigator.vibrate([400,200,400]); } catch(e){}
  }, 3000);
  // Also add to in-app notification log
  addNotifSilent('🔔','استدعاء عاجل', (from?from.name:'مستخدم')+(call.reason?' • '+call.reason:''), '');
}

function ackIncomingCall(){
  if (!_activeIncomingCall) {
    document.getElementById('mo-incomingCall').classList.remove('open');
    return;
  }
  if (_ringInterval) { clearInterval(_ringInterval); _ringInterval = null; }
  var calls = G('staffCalls', []);
  var c = calls.find(function(x){ return x.id === _activeIncomingCall.id; });
  if (c) {
    c.acknowledged = true;
    c.ackAt = new Date().toISOString();
    S('staffCalls', calls);
    // Notify caller that it was received
    try {
      var caller = sm()[c.fromId];
      if (caller) {
        pushNotify('✓ '+CU.name+' قادم/قادمة', (c.reason?c.reason+' — ':'') + 'استلم الاستدعاء', {type:'callAck'});
      }
    } catch(e){}
  }
  _activeIncomingCall = null;
  document.getElementById('mo-incomingCall').classList.remove('open');
}

// Poll for incoming calls every 8 seconds (alongside chat polling)
setInterval(function(){
  if (!CU || !navigator.onLine) return;
  // Force-fetch latest staffCalls quickly (the regular 30s poll is too slow for a bell)
  CLOUD.fetchData('staffCalls').then(function(v){
    if (v !== null) {
      Sl('staffCalls', v);
      checkIncomingCalls();
    }
  }).catch(function(){});
}, 8000);

// Also check immediately when something updates locally (e.g., right after polling cycle)
function pollCheckCalls(){ try { checkIncomingCalls(); } catch(e){} }

// ═══════════════════════════════════════════════════
//  BACKUP / RESTORE — JSON export & import
// ═══════════════════════════════════════════════════
var BACKUP_KEYS = ['staff','patients','appointments','plans','payments','clinic','inventory','consents','consentTpls','orthoDevTpls','tasks','chatMessages','staffCalls','purchases','marketingCampaigns','encourageTpls','warningTpls'];

function renderBackupStats(){
  var el = document.getElementById('backupStats');
  if (!el) return;
  var stats = {
    'مرضى': G('patients',[]).length,
    'مواعيد': G('appointments',[]).length,
    'خطط علاج': G('plans',[]).length,
    'مدفوعات': G('payments',[]).length,
    'أعضاء كادر': G('staff',[]).length,
    'موافقات': G('consents',[]).length,
    'مهام': G('tasks',[]).length,
    'رسائل': G('chatMessages',[]).length,
  };
  el.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px">' +
    Object.keys(stats).map(function(k){
      return '<div style="display:flex;justify-content:space-between"><span>'+k+':</span><strong style="color:var(--gray6)">'+stats[k]+'</strong></div>';
    }).join('') + '</div>';
}

// ─── إعادة مزامنة يدوية من السحابة ───
async function manualResync(){
  var statusEl = document.getElementById('syncStatus');
  if (statusEl) {
    statusEl.style.background = '#fef3c7';
    statusEl.style.borderColor = '#fde047';
    statusEl.style.color = '#854d0e';
    statusEl.innerHTML = '🔄 جلب البيانات من فايربيز... قد تستغرق ٥-١٥ ثانية حسب الشبكة';
  }
  try {
    if (typeof loadCloud !== 'function') {
      if (statusEl) {
        statusEl.style.background = '#fef2f2'; statusEl.style.borderColor = '#fecaca'; statusEl.style.color = '#991b1b';
        statusEl.innerHTML = '⚠️ دالة المزامنة غير متوفرة. أعد تحميل الصفحة (F5).';
      }
      return;
    }
    var startedAt = Date.now();
    await loadCloud();
    var elapsed = Math.round((Date.now()-startedAt)/100)/10;
    // أعد رسم الصفحة الحالية لإظهار البيانات الجديدة فوراً
    try {
      var active = document.querySelector('.page.active');
      if (active && typeof renderPage === 'function') {
        var pgId = (active.id||'').replace(/^pg-/,'');
        if (pgId) renderPage(pgId);
      }
    } catch(e){}
    // أحصِ ما عاد لنا
    var counts = {
      مرضى: G('patients',[]).length,
      مواعيد: G('appointments',[]).length,
      خطط: G('plans',[]).length,
      مدفوعات: G('payments',[]).length,
    };
    if (statusEl) {
      statusEl.style.background = '#dcfce7';
      statusEl.style.borderColor = '#86efac';
      statusEl.style.color = '#166534';
      statusEl.innerHTML = '✅ تمت المزامنة في '+elapsed+'ث — '+
        '<strong>'+counts.مرضى+'</strong> مريض • '+
        '<strong>'+counts.مواعيد+'</strong> موعد • '+
        '<strong>'+counts.خطط+'</strong> خطة • '+
        '<strong>'+counts.مدفوعات+'</strong> دفعة';
    }
    try { renderBackupStats && renderBackupStats(); } catch(e){}
  } catch(e) {
    if (statusEl) {
      statusEl.style.background = '#fef2f2';
      statusEl.style.borderColor = '#fecaca';
      statusEl.style.color = '#991b1b';
      statusEl.innerHTML = '❌ فشلت المزامنة: '+(e&&e.message||'خطأ غير معروف')+
        '<br><span style="font-size:10px;opacity:.8">تأكد من اتصال الإنترنت وحاول مرة أخرى</span>';
    }
  }
}

function exportBackup(){
  try {
    var data = {
      _meta: {
        app: 'Soran Dental Care',
        version: 'v6',
        exportedAt: new Date().toISOString(),
        exportedBy: CU ? CU.name : 'unknown',
        exportedByUsername: CU ? CU.username : ''
      }
    };
    BACKUP_KEYS.forEach(function(k){
      var v = G(k, null);
      if (v !== null && v !== undefined) data[k] = v;
    });
    var json = JSON.stringify(data, null, 2);
    var bytes = new Blob([json], {type:'application/json'}).size;
    var sizeKB = (bytes / 1024).toFixed(1);
    var blob = new Blob([json], {type:'application/json;charset=utf-8'});
    var url = URL.createObjectURL(blob);
    var d = new Date();
    var pad = function(n){return n<10?'0'+n:n;};
    var stamp = d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'_'+pad(d.getHours())+pad(d.getMinutes());
    var a = document.createElement('a');
    a.href = url;
    a.download = 'soran_backup_'+stamp+'.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 100);
    showToast('✅ تم تصدير النسخة الاحتياطية ('+sizeKB+' KB)', 'success');
  } catch(e) {
    alert('❌ فشل التصدير: ' + (e.message||e));
  }
}

function showToast(msg, type){
  var bg = type === 'success' ? '#16a34a' : (type === 'error' ? '#dc2626' : '#0d5c7a');
  var t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:140px;left:50%;transform:translateX(-50%);background:'+bg+';color:#fff;padding:12px 22px;border-radius:24px;font-size:13px;font-weight:700;z-index:9998;box-shadow:0 4px 20px rgba(0,0,0,.2);font-family:Tajawal,sans-serif;max-width:90%;text-align:center';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function(){ t.style.transition='opacity .4s'; t.style.opacity='0'; setTimeout(function(){t.remove();},400); }, 3500);
}

function onRestoreFile(event){
  var f = event.target.files && event.target.files[0];
  if (!f) return;
  var reader = new FileReader();
  reader.onload = function(e){
    try {
      var data = JSON.parse(e.target.result);
      if (!data || typeof data !== 'object') throw new Error('ملف غير صالح');
      // Verify it's a Soran backup
      if (!data._meta || data._meta.app !== 'Soran Dental Care') {
        if (!confirm('⚠️ هذا الملف لا يبدو كنسخة احتياطية أصلية لسوران.\n\nهل تريد المتابعة على أي حال؟')) {
          event.target.value = '';
          return;
        }
      }
      // Show what's in the file
      var summary = [];
      BACKUP_KEYS.forEach(function(k){
        if (Array.isArray(data[k])) summary.push(k + ': ' + data[k].length);
      });
      var meta = data._meta || {};
      var when = meta.exportedAt ? new Date(meta.exportedAt).toLocaleString('ar-IQ') : 'غير معروف';
      var by = meta.exportedBy || 'غير معروف';
      var msg = '⚠️ تأكيد الاستعادة\n\n' +
                '📅 تاريخ النسخة: ' + when + '\n' +
                '👤 صدّرها: ' + by + '\n\n' +
                '📊 المحتويات:\n' + summary.join(' • ') + '\n\n' +
                '⚠️ تحذير: استعادة هذه النسخة ستستبدل بياناتك الحالية بالكامل.\n\n' +
                'هل أنت متأكد؟';
      if (!confirm(msg)) {
        event.target.value = '';
        return;
      }
      // Second confirmation for destructive action
      if (!confirm('🔴 آخر تأكيد:\n\nستفقد:\n• جميع المرضى الحاليين غير الموجودين في النسخة\n• جميع المواعيد والمدفوعات والمهام التي تمت بعد تاريخ النسخة\n\nالمتابعة؟')) {
        event.target.value = '';
        return;
      }
      // Restore
      var restored = 0;
      BACKUP_KEYS.forEach(function(k){
        if (data[k] !== undefined && data[k] !== null) {
          S(k, data[k]);
          restored++;
        }
      });
      event.target.value = '';
      alert('✅ تمت الاستعادة بنجاح!\n\nتم استعادة ' + restored + ' من أنواع البيانات.\n\nسيعاد تحميل الصفحة الآن لتطبيق التغييرات.');
      setTimeout(function(){ location.reload(); }, 500);
    } catch(err) {
      alert('❌ فشل قراءة الملف: ' + (err.message||err));
      event.target.value = '';
    }
  };
  reader.onerror = function(){ alert('❌ خطأ في قراءة الملف'); };
  reader.readAsText(f);
}

// ═══════════════════════════════════════════════════
//  PATIENT PORTAL — OTP, Booking, Inquiries, Articles
// ═══════════════════════════════════════════════════

// Generate 6-digit numeric OTP
function genOTP6(){
  var s='';
  for(var i=0;i<6;i++) s += Math.floor(Math.random()*10);
  return s;
}

// Normalize Iraqi phone number (07xx → 9647xx for WhatsApp)
function normalizePhoneIQ(phone){
  var p = String(phone||'').replace(/[^\d]/g,'');
  if (p.indexOf('00964') === 0) p = p.substring(5);
  if (p.indexOf('964') === 0) p = p.substring(3);
  if (p.indexOf('0') === 0) p = p.substring(1);
  return p;
}

// ═══════════════════════════════════════════════════
//  CLINIC WHATSAPP HELPERS
// ═══════════════════════════════════════════════════
// رقم العيادة الرسمي للتذييل (يُقرأ من الإعدادات؛ افتراضي 07810151042)
function clinicPhoneLocal(){
  var c = G('clinic', {});
  return c.phone || '07810151042';
}
// التذييل الموحّد لرسائل الواتساب — يحوي اسم العيادة ورقم التواصل
function clinicSignature(){
  var c = G('clinic', {});
  var name = c.name || 'عيادة سوران';
  return '\n\n📞 للتواصل: ' + clinicPhoneLocal() + '\n' + name;
}
// يفتح واتساب على جهاز الموظف برقم المريض ورسالة جاهزة (اقتراح يحرر/يرسل يدوياً)
function openWaTo(patientPhoneOrId, message){
  var phone = patientPhoneOrId;
  // إن كان معرّف مريض، استخرج رقمه
  if (typeof patientPhoneOrId === 'string' && patientPhoneOrId.indexOf('p') === 0){
    var pt = pm()[patientPhoneOrId];
    if (!pt || !pt.phone) { alert('⚠️ لا يوجد رقم هاتف لهذا المريض'); return false; }
    phone = pt.phone;
  }
  var n = normalizePhoneIQ(phone);
  if (!n) { alert('⚠️ رقم غير صالح'); return false; }
  var fullMsg = (message||'') + clinicSignature();
  window.open('https://wa.me/964'+n+'?text='+encodeURIComponent(fullMsg), '_blank');
  return true;
}

function ptRequestOTP(){
  var rawPhone = (document.getElementById('ptPhone').value||'').trim();
  var err = document.getElementById('ptErr1');
  err.style.display = 'none';
  if (!rawPhone) { err.textContent = '❌ أدخل رقم هاتفك'; err.style.display = 'block'; return; }
  var normalized = normalizePhoneIQ(rawPhone);
  if (normalized.length < 9 || normalized.length > 11) {
    err.textContent = '❌ رقم الهاتف غير صالح. أدخل رقم عراقي صحيح (مثل 07xxxxxxxxx)';
    err.style.display = 'block';
    return;
  }
  // Find patient by phone (compare normalized)
  var patients = G('patients', []);
  var matchedPatient = null;
  for (var i = 0; i < patients.length; i++) {
    var pp = normalizePhoneIQ(patients[i].phone || '');
    if (pp && pp === normalized) { matchedPatient = patients[i]; break; }
  }
  if (!matchedPatient) {
    err.textContent = '❌ هذا الرقم غير مسجّل في العيادة. يرجى مراجعة الاستقبال أولاً.';
    err.style.display = 'block';
    return;
  }
  // Generate OTP and store request
  var otp = genOTP6();
  var clinic = G('clinic', {});
  var clinicPhoneRaw = clinic.phone || '';
  var clinicPhone = normalizePhoneIQ(clinicPhoneRaw);
  if (!clinicPhone || clinicPhone.length < 9) {
    err.textContent = '⚠️ رقم العيادة غير محدد. اتصل بالعيادة مباشرة.';
    err.style.display = 'block';
    return;
  }
  // Store OTP request
  var otpReqs = G('otpRequests', []);
  // Drop expired (older than 10 min)
  var tenMinAgo = Date.now() - 600000;
  otpReqs = otpReqs.filter(function(r){ return new Date(r.createdAt).getTime() > tenMinAgo; });
  // Drop any prior pending requests for this phone
  otpReqs = otpReqs.filter(function(r){ return normalizePhoneIQ(r.phone) !== normalized || r.status === 'used'; });
  var newReq = {
    id: 'otp' + uid(),
    phone: rawPhone,
    normalizedPhone: normalized,
    otp: otp,
    patientId: matchedPatient.id,
    patientName: matchedPatient.name,
    status: 'pending', // pending | approved | rejected | used
    createdAt: new Date().toISOString()
  };
  otpReqs.push(newReq);
  S('otpRequests', otpReqs);
  // Save active request id locally for polling
  localStorage.setItem('ptActiveOTPId', newReq.id);
  // Show step 2
  document.getElementById('ptOTPDisplay').textContent = otp;
  document.getElementById('ptStep1').style.display = 'none';
  document.getElementById('ptStep2').style.display = 'block';
  // Build WhatsApp link
  var msg = encodeURIComponent('مرحباً، أرغب بتسجيل الدخول لبوابة المرضى.\nرقمي: ' + rawPhone + '\nاسمي: ' + matchedPatient.name + '\nالرمز: ' + otp);
  var waLink = 'https://wa.me/964' + clinicPhone + '?text=' + msg;
  document.getElementById('ptWhatsappBtn').href = waLink;
  // Notify clinic via push
  try { pushNotifyRole('🔐 طلب دخول مريض', matchedPatient.name + ' • الرمز: ' + otp, 'reception'); } catch(e){}
  try { pushNotifyRole('🔐 طلب دخول مريض', matchedPatient.name + ' • الرمز: ' + otp, 'manager'); } catch(e){}
  try { pushNotifyRole('🔐 طلب دخول مريض', matchedPatient.name + ' • الرمز: ' + otp, 'doctor-manager'); } catch(e){}
  // Start polling for approval
  ptStartOTPPoll();
}

var _ptOTPPollInt = null;
function ptStartOTPPoll(){
  if (_ptOTPPollInt) clearInterval(_ptOTPPollInt);
  var reqId = localStorage.getItem('ptActiveOTPId');
  if (!reqId) return;
  var startTime = Date.now();
  _ptOTPPollInt = setInterval(function(){
    // Force fresh fetch
    CLOUD.fetchData('otpRequests').then(function(v){
      if (v !== null) Sl('otpRequests', v);
      var reqs = G('otpRequests', []);
      var r = reqs.find(function(x){ return x.id === reqId; });
      if (!r) {
        clearInterval(_ptOTPPollInt); _ptOTPPollInt = null;
        return;
      }
      if (r.status === 'approved' && r.status !== 'used') {
        // Login as patient
        clearInterval(_ptOTPPollInt); _ptOTPPollInt = null;
        // Mark as used
        r.status = 'used';
        r.usedAt = new Date().toISOString();
        S('otpRequests', reqs);
        // Set CU as patient
        var patients = G('patients', []);
        var pt = patients.find(function(p){ return p.id === r.patientId; });
        if (!pt) {
          alert('خطأ: لم يتم العثور على ملفك. اتصل بالعيادة.');
          showScreen('patientLogin');
          return;
        }
        CU = {
          id: pt.id,
          name: pt.name,
          role: 'patient',
          patientId: pt.id,
          phone: pt.phone
        };
        CPid = pt.id;
        // Save autoLogin (24 hours for patients)
        Sl('autoLogin', { userId: pt.id, expiry: Date.now() + 24*3600*1000, role: 'patient' });
        localStorage.removeItem('ptActiveOTPId');
        startApp();
      } else if (r.status === 'rejected') {
        clearInterval(_ptOTPPollInt); _ptOTPPollInt = null;
        alert('❌ تم رفض طلب الدخول من قبل العيادة.\nيرجى مراجعة الاستقبال.');
        ptCancelOTP();
      }
      // Timeout after 10 minutes
      if (Date.now() - startTime > 600000) {
        clearInterval(_ptOTPPollInt); _ptOTPPollInt = null;
        var msgEl = document.getElementById('ptWaitingMsg');
        if (msgEl) msgEl.innerHTML = '⏰ انتهت صلاحية الرمز. يرجى البدء من جديد.';
      }
    }).catch(function(){});
  }, 5000);
}

function ptCancelOTP(){
  if (_ptOTPPollInt) { clearInterval(_ptOTPPollInt); _ptOTPPollInt = null; }
  localStorage.removeItem('ptActiveOTPId');
  showScreen('patientLogin');
}

// ─── Clinic-side: handle OTP requests ───
var _reqTab = 'otp';
function setReqTab(tab, btn){
  _reqTab = tab;
  document.querySelectorAll('.rq-tab').forEach(function(b){ b.classList.remove('active'); b.style.borderBottom = ''; b.style.background=''; });
  if (btn) { btn.classList.add('active'); btn.style.background='#0d5c7a'; btn.style.color='#fff'; }
  renderRequests();
}

function renderRequests(){
  if (!CU) return;
  var el = document.getElementById('requestsList');
  if (!el) return;
  // Update badges
  var otpReqs = G('otpRequests', []).filter(function(r){
    return r.status === 'pending' && (Date.now() - new Date(r.createdAt).getTime()) < 600000;
  });
  var bookings = G('bookingRequests', []).filter(function(b){ return b.status === 'pending'; });
  var inquiries = G('patientInquiries', []).filter(function(q){ return q.status === 'open' || (q.replies && q.replies.some(function(r){return r.fromPatient && !r.read;})); });
  document.getElementById('rqBadgeOtp').innerHTML = otpReqs.length > 0 ? '<span style="background:#ef4444;color:#fff;border-radius:10px;padding:1px 6px;font-size:10px;margin-right:4px">'+otpReqs.length+'</span>' : '';
  document.getElementById('rqBadgeBookings').innerHTML = bookings.length > 0 ? '<span style="background:#ef4444;color:#fff;border-radius:10px;padding:1px 6px;font-size:10px;margin-right:4px">'+bookings.length+'</span>' : '';
  document.getElementById('rqBadgeInquiries').innerHTML = inquiries.length > 0 ? '<span style="background:#ef4444;color:#fff;border-radius:10px;padding:1px 6px;font-size:10px;margin-right:4px">'+inquiries.length+'</span>' : '';

  if (_reqTab === 'otp') {
    if (!otpReqs.length) { el.innerHTML = emptyState('🔐','لا توجد طلبات دخول معلّقة'); return; }
    otpReqs.sort(function(a,b){return new Date(b.createdAt) - new Date(a.createdAt);});
    el.innerHTML = otpReqs.map(function(r){
      var ageMin = Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 60000);
      var ageStr = ageMin < 1 ? 'الآن' : (ageMin + ' دقيقة');
      var expiresMin = 10 - ageMin;
      return '<div class="card" style="margin-bottom:10px;border-right:4px solid #f59e0b"><div class="card-body">'+
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">'+
          '<div style="flex:1;min-width:200px">'+
            '<div style="font-weight:800;font-size:14px;color:var(--gray6)">👤 '+r.patientName+'</div>'+
            '<div style="font-size:12px;color:var(--gray5);margin-top:4px">📞 '+r.phone+' • منذ '+ageStr+'</div>'+
            '<div style="background:#fef3c7;border:1.5px solid #fde047;border-radius:8px;padding:8px 12px;margin-top:8px;display:inline-block">'+
              '<span style="font-size:11px;color:#854d0e;margin-left:6px">الرمز:</span>'+
              '<span style="font-size:18px;font-weight:900;color:#854d0e;letter-spacing:3px;font-family:monospace">'+r.otp+'</span>'+
            '</div>'+
            '<div style="font-size:10px;color:var(--gray4);margin-top:6px">⏰ ينتهي خلال '+expiresMin+' دقيقة</div>'+
          '</div>'+
          '<div style="display:flex;gap:6px;flex-wrap:wrap">'+
            '<button class="btn btn-success btn-sm" onclick="approveOTP(\''+r.id+'\')">✅ تأكيد الدخول</button>'+
            '<button class="btn btn-danger btn-sm" onclick="rejectOTP(\''+r.id+'\')">❌ رفض</button>'+
          '</div>'+
        '</div>'+
      '</div></div>';
    }).join('');
  } else if (_reqTab === 'bookings') {
    if (!bookings.length) { el.innerHTML = emptyState('📅','لا توجد طلبات حجز جديدة'); return; }
    bookings.sort(function(a,b){return new Date(b.createdAt) - new Date(a.createdAt);});
    el.innerHTML = bookings.map(function(b){
      var pt = pm()[b.patientId];
      var ageH = Math.floor((Date.now() - new Date(b.createdAt).getTime()) / 3600000);
      var ageStr = ageH < 1 ? 'الآن' : (ageH < 24 ? ageH+' ساعة' : Math.floor(ageH/24)+' يوم');
      return '<div class="card" style="margin-bottom:10px;border-right:4px solid #3b82f6;cursor:pointer" onclick="openBookingDetail(\''+b.id+'\')"><div class="card-body">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">'+
          '<div style="flex:1;min-width:200px">'+
            '<div style="font-weight:800;font-size:14px;color:var(--gray6)">👤 '+(pt?pt.name:'مريض')+'</div>'+
            '<div style="font-size:12px;color:var(--blue2);margin-top:4px;font-weight:700">📋 '+(b.reason||'-')+'</div>'+
            '<div style="font-size:11px;color:var(--gray5);margin-top:4px">⭐ خيار أول: '+(b.slot1?fmtSlot(b.slot1):'-')+'</div>'+
            '<div style="font-size:10px;color:var(--gray4);margin-top:4px">منذ '+ageStr+'</div>'+
          '</div>'+
          '<div style="font-size:18px">←</div>'+
        '</div>'+
      '</div></div>';
    }).join('');
  } else if (_reqTab === 'inquiries') {
    if (!inquiries.length) { el.innerHTML = emptyState('💬','لا توجد استفسارات جديدة'); return; }
    inquiries.sort(function(a,b){return new Date(b.lastUpdate||b.createdAt) - new Date(a.lastUpdate||a.createdAt);});
    el.innerHTML = inquiries.map(function(q){
      var pt = pm()[q.patientId];
      var lastMsg = (q.replies && q.replies.length) ? q.replies[q.replies.length-1] : null;
      var preview = lastMsg ? (lastMsg.fromPatient?'المريض: ':'العيادة: ') + (lastMsg.text||'').slice(0,60) : (q.text||'').slice(0,60);
      var hasUnread = (q.replies||[]).some(function(r){return r.fromPatient && !r.read;});
      return '<div class="card" style="margin-bottom:10px;border-right:4px solid '+(hasUnread?'#ef4444':'#10b981')+';cursor:pointer" onclick="openInquiryDetail(\''+q.id+'\')"><div class="card-body">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">'+
          '<div style="flex:1;min-width:200px">'+
            '<div style="font-weight:800;font-size:14px;color:var(--gray6)">👤 '+(pt?pt.name:'مريض')+(hasUnread?' <span style="color:#ef4444">●</span>':'')+'</div>'+
            '<div style="font-size:12px;color:var(--gray5);margin-top:4px">'+preview+'</div>'+
          '</div>'+
          '<div style="font-size:18px">←</div>'+
        '</div>'+
      '</div></div>';
    }).join('');
  }
}

function fmtSlot(iso){
  if (!iso) return '-';
  var d = new Date(iso);
  return d.toLocaleDateString('ar-IQ',{weekday:'short',day:'numeric',month:'short'}) + ' • ' + d.toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'});
}

function approveOTP(reqId){
  var reqs = G('otpRequests', []);
  var r = reqs.find(function(x){return x.id === reqId;});
  if (!r) return;
  r.status = 'approved';
  r.approvedAt = new Date().toISOString();
  r.approvedBy = CU?CU.id:null;
  S('otpRequests', reqs);
  showToast('✅ تم تأكيد دخول '+r.patientName, 'success');
  renderRequests();
}

function rejectOTP(reqId){
  if (!confirm('رفض طلب الدخول؟')) return;
  var reqs = G('otpRequests', []);
  var r = reqs.find(function(x){return x.id === reqId;});
  if (!r) return;
  r.status = 'rejected';
  r.rejectedAt = new Date().toISOString();
  S('otpRequests', reqs);
  renderRequests();
}

function openBookingDetail(bid){
  var b = G('bookingRequests', []).find(function(x){return x.id === bid;});
  if (!b) return;
  var pt = pm()[b.patientId];
  var smap = sm();
  var doctors = G('staff',[]).filter(function(s){return s.role === 'doctor' || s.role === 'doctor-manager';});
  var dt = new Date(b.createdAt);
  var html = '<div style="margin-bottom:14px">'+
    '<div style="font-weight:800;font-size:16px;color:var(--gray6)">👤 '+(pt?pt.name:'-')+'</div>'+
    '<div style="font-size:12px;color:var(--gray5);margin-top:4px">📞 '+(pt?pt.phone:'-')+'</div>'+
    '<div style="font-size:11px;color:var(--gray4);margin-top:4px">قُدّم في: '+dt.toLocaleString('ar-IQ')+'</div>'+
  '</div>'+
  '<div style="background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:10px;padding:12px;margin-bottom:14px">'+
    '<div style="font-weight:700;color:#1e40af;font-size:13px;margin-bottom:6px">📋 سبب الزيارة:</div>'+
    '<div style="color:#1e3a8a;font-size:14px">'+(b.reason||'-')+'</div>'+
    (b.notes?'<div style="margin-top:8px;font-size:12px;color:var(--gray5);background:#fff;padding:8px;border-radius:6px"><strong>ملاحظات:</strong> '+b.notes+'</div>':'')+
  '</div>'+
  '<div style="background:#fef3c7;border:1.5px solid #fde047;border-radius:10px;padding:12px;margin-bottom:14px">'+
    '<div style="font-weight:700;color:#854d0e;font-size:13px;margin-bottom:8px">⏰ الأوقات المفضّلة:</div>'+
    '<div style="display:flex;flex-direction:column;gap:6px">';
  ['slot1','slot2','slot3'].forEach(function(k,i){
    if (b[k]) {
      var labels = ['⭐ الأول','الثاني','الثالث'];
      html += '<label style="display:flex;align-items:center;gap:8px;background:#fff;padding:8px;border-radius:6px;cursor:pointer">'+
        '<input type="radio" name="bookingSlot" value="'+b[k]+'" '+(i===0?'checked':'')+'>'+
        '<div><div style="font-weight:700;font-size:12px;color:#854d0e">'+labels[i]+'</div>'+
        '<div style="font-size:13px;color:var(--gray6)">'+fmtSlot(b[k])+'</div></div>'+
      '</label>';
    }
  });
  html += '</div></div>'+
  '<div class="form-group"><label>تعيين الطبيب</label><select class="form-control" id="bdDocSel">'+
    doctors.map(function(d){return '<option value="'+d.id+'">'+d.name+'</option>';}).join('')+
  '</select></div>'+
  '<div class="form-actions">'+
    '<button class="btn btn-danger" onclick="rejectBooking(\''+b.id+'\')">❌ رفض</button>'+
    '<button class="btn btn-ghost" onclick="closeModal(\'mo-bookingDetail\')">إغلاق</button>'+
    '<button class="btn btn-success" onclick="approveBooking(\''+b.id+'\')">✅ موافقة وحجز</button>'+
  '</div>';
  document.getElementById('bookingDetailBody').innerHTML = html;
  openModal('mo-bookingDetail');
}

function approveBooking(bid){
  var bookings = G('bookingRequests', []);
  var b = bookings.find(function(x){return x.id === bid;});
  if (!b) return;
  var slotEl = document.querySelector('input[name="bookingSlot"]:checked');
  if (!slotEl) { alert('اختر موعداً أولاً'); return; }
  var slotIso = slotEl.value;
  var docId = document.getElementById('bdDocSel').value;
  if (!docId) { alert('اختر الطبيب أولاً'); return; }
  // Create appointment
  var slotDate = new Date(slotIso);
  var dateStr = slotDate.getFullYear()+'-'+String(slotDate.getMonth()+1).padStart(2,'0')+'-'+String(slotDate.getDate()).padStart(2,'0');
  var timeStr = String(slotDate.getHours()).padStart(2,'0')+':'+String(slotDate.getMinutes()).padStart(2,'0');

  // ─── تحقق من ساعات العيادة (9 ص – 9 م) ───
  if (!isWithinClinicHours(timeStr)){
    alert('⛔ الوقت المختار خارج ساعات العمل (9 ص – 9 م).\nاطلب من المريض اختيار وقت ضمن هذه الفترة، أو حدّد موعداً يدوياً.');
    return;
  }
  // ─── تحقق من الفارق الزمني (25 دقيقة على الأقل) ───
  var conflict = findApptConflict(dateStr, timeStr, docId);
  if (conflict){
    var _ptC = pm()[conflict.patientId];
    if (!confirm('⚠️ يوجد موعد آخر للطبيب يوم '+dateStr+' الساعة '+conflict.time+
                 (_ptC?(' (المريض: '+_ptC.name+')'):'')+
                 '.\n\nالفارق أقل من ٢٥ دقيقة. هل تريد المتابعة على أي حال؟')){
      return;
    }
  }

  var appts = G('appointments', []);
  var newApptId = 'a' + uid();
  appts.push({
    id: newApptId,
    patientId: b.patientId,
    doctorId: docId,
    date: dateStr,
    time: timeStr,
    type: b.reason || 'كشف',
    notes: b.notes || '',
    status: 'scheduled',
    createdAt: new Date().toISOString(),
    fromBookingRequest: bid
  });
  S('appointments', appts);
  // Update booking status
  b.status = 'approved';
  b.approvedAt = new Date().toISOString();
  b.approvedBy = CU?CU.id:null;
  b.confirmedSlot = slotIso;
  b.assignedDoctorId = docId;
  S('bookingRequests', bookings);
  // Notify patient via push notification
  try {
    var _doc2 = sm()[docId];
    pushNotifyPatient(b.patientId, '✅ تم تأكيد موعدك', 'موعدك بتاريخ '+slotDate.toLocaleDateString('ar-IQ')+' الساعة '+timeStr+(_doc2?' مع '+_doc2.name:''), {type:'booking_approved'});
  } catch(e){}
  // Schedule automatic reminders (24h + 2h before)
  try { scheduleApptReminders(newApptId); } catch(e){}
  // Notify patient via WhatsApp link (clinic must send)
  var pt = pm()[b.patientId];
  if (pt && pt.phone) {
    var phone = normalizePhoneIQ(pt.phone);
    var doc = sm()[docId];
    var msg = encodeURIComponent('عزيزي '+pt.name+'،\nتم تأكيد موعدك في عيادة سوران.\nالتاريخ: '+slotDate.toLocaleDateString('ar-IQ')+'\nالوقت: '+timeStr+'\nالطبيب: '+(doc?doc.name:'-')+'\nنراك قريباً ✨');
    if (confirm('✅ تم تأكيد الموعد!\n\nهل تريد فتح واتساب لإرسال تأكيد للمريض؟')) {
      window.open('https://wa.me/964'+phone+'?text='+msg, '_blank');
    }
  }
  closeModal('mo-bookingDetail');
  renderRequests();
}

function rejectBooking(bid){
  var reason = prompt('سبب الرفض (اختياري — سيُرسل للمريض):');
  if (reason === null) return;
  var bookings = G('bookingRequests', []);
  var b = bookings.find(function(x){return x.id === bid;});
  if (!b) return;
  b.status = 'rejected';
  b.rejectedAt = new Date().toISOString();
  b.rejectedBy = CU?CU.id:null;
  b.rejectionReason = reason;
  S('bookingRequests', bookings);
  closeModal('mo-bookingDetail');
  renderRequests();
}

function openInquiryDetail(qid){
  var q = G('patientInquiries', []).find(function(x){return x.id === qid;});
  if (!q) return;
  // Mark patient replies as read
  var inquiries = G('patientInquiries', []);
  var qq = inquiries.find(function(x){return x.id === qid;});
  if (qq && qq.replies) {
    qq.replies.forEach(function(r){ if (r.fromPatient) r.read = true; });
    S('patientInquiries', inquiries);
  }
  var pt = pm()[q.patientId];
  var html = '<div style="margin-bottom:14px">'+
    '<div style="font-weight:800;font-size:16px;color:var(--gray6)">👤 '+(pt?pt.name:'-')+'</div>'+
    '<div style="font-size:12px;color:var(--gray5);margin-top:4px">📞 '+(pt?pt.phone:'-')+'</div>'+
  '</div>';
  // Conversation
  html += '<div style="background:#f8fafc;border-radius:10px;padding:12px;max-height:300px;overflow-y:auto;margin-bottom:14px">';
  // Original inquiry (from patient)
  html += '<div style="display:flex;justify-content:flex-end;margin-bottom:8px">'+
    '<div style="background:#fff;border:1.5px solid var(--border);border-radius:10px;padding:8px 12px;max-width:80%">'+
      '<div style="font-size:10px;font-weight:700;color:var(--blue2);margin-bottom:2px">المريض</div>'+
      '<div style="font-size:13px;color:var(--gray6);white-space:pre-line">'+(q.text||'').replace(/</g,'&lt;')+'</div>'+
      '<div style="font-size:9px;color:var(--gray4);margin-top:3px">'+new Date(q.createdAt).toLocaleString('ar-IQ')+'</div>'+
    '</div>'+
  '</div>';
  // Replies
  (q.replies||[]).forEach(function(r){
    var isFromPatient = r.fromPatient;
    var bg = isFromPatient ? '#fff' : '#0d5c7a';
    var color = isFromPatient ? 'var(--gray6)' : '#fff';
    var border = isFromPatient ? '1.5px solid var(--border)' : 'none';
    var align = isFromPatient ? 'flex-end' : 'flex-start';
    var nameColor = isFromPatient ? 'var(--blue2)' : 'rgba(255,255,255,.85)';
    var name = isFromPatient ? 'المريض' : (r.byName || 'العيادة');
    html += '<div style="display:flex;justify-content:'+align+';margin-bottom:8px">'+
      '<div style="background:'+bg+';color:'+color+';border:'+border+';border-radius:10px;padding:8px 12px;max-width:80%">'+
        '<div style="font-size:10px;font-weight:700;color:'+nameColor+';margin-bottom:2px">'+name+'</div>'+
        '<div style="font-size:13px;white-space:pre-line">'+(r.text||'').replace(/</g,'&lt;')+'</div>'+
        '<div style="font-size:9px;opacity:.65;margin-top:3px">'+new Date(r.at).toLocaleString('ar-IQ')+'</div>'+
      '</div>'+
    '</div>';
  });
  html += '</div>';
  // Reply form
  html += '<div class="form-group"><label>الرد على المريض</label><textarea class="form-control" id="inqReplyText" rows="3" placeholder="اكتب ردك هنا..."></textarea></div>'+
    '<div class="form-actions">'+
      '<button class="btn btn-ghost" onclick="closeInquiry(\''+q.id+'\')">إغلاق الاستفسار</button>'+
      '<button class="btn btn-ghost" onclick="closeModal(\'mo-inquiryDetail\')">رجوع</button>'+
      '<button class="btn btn-primary" onclick="sendInquiryReply(\''+q.id+'\')">📤 إرسال الرد</button>'+
    '</div>';
  document.getElementById('inquiryDetailBody').innerHTML = html;
  openModal('mo-inquiryDetail');
}

function sendInquiryReply(qid){
  var text = (document.getElementById('inqReplyText').value||'').trim();
  if (!text) { alert('اكتب الرد أولاً'); return; }
  var inquiries = G('patientInquiries', []);
  var q = inquiries.find(function(x){return x.id === qid;});
  if (!q) return;
  if (!q.replies) q.replies = [];
  q.replies.push({
    text: text,
    fromPatient: false,
    by: CU?CU.id:null,
    byName: CU?CU.name:'',
    at: new Date().toISOString(),
    read: false
  });
  q.lastUpdate = new Date().toISOString();
  q.status = 'replied';
  S('patientInquiries', inquiries);
  // Notify the specific patient who asked
  try { pushNotifyPatient(q.patientId, '💬 رد جديد من العيادة', text.slice(0,80), {type:'inquiry_reply'}); } catch(e){}
  closeModal('mo-inquiryDetail');
  renderRequests();
}

function closeInquiry(qid){
  if (!confirm('إغلاق هذا الاستفسار؟')) return;
  var inquiries = G('patientInquiries', []);
  var q = inquiries.find(function(x){return x.id === qid;});
  if (!q) return;
  q.status = 'closed';
  q.closedAt = new Date().toISOString();
  S('patientInquiries', inquiries);
  closeModal('mo-inquiryDetail');
  renderRequests();
}

// ─── Patient-side: Booking ───
function renderBookAppt(){
  if (!CU || CU.role !== 'patient') return;
  // تعبئة قوائم الأوقات (9 ص – 9 م) — كل ٣٠ دقيقة لسهولة الاختيار على الهاتف
  ['baTime1','baTime2','baTime3'].forEach(function(id){
    var el = document.getElementById(id);
    if (el && !el.options.length) el.innerHTML = buildTimeOptions('', {step:30});
  });
  // ضبط الحد الأدنى للتاريخ (اليوم) لمنع اختيار تاريخ في الماضي
  var todayStr = today();
  ['baDate1','baDate2','baDate3'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.min = todayStr;
  });
  // Show "other" textarea when "other" selected
  var sel = document.getElementById('baReason');
  if (sel) {
    sel.onchange = function(){
      document.getElementById('baOtherReasonGroup').style.display = (this.value === 'other') ? 'block' : 'none';
    };
  }
  // Render past bookings for this patient
  var myBookings = G('bookingRequests', []).filter(function(b){return b.patientId === CU.id;});
  myBookings.sort(function(a,b){return new Date(b.createdAt) - new Date(a.createdAt);});
  var el = document.getElementById('myPastBookings');
  if (!myBookings.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<h3 style="font-size:14px;font-weight:800;color:var(--gray6);margin:14px 0 10px">📋 طلباتي السابقة</h3>' +
    myBookings.map(function(b){
      var statusBadge = '';
      if (b.status === 'pending') statusBadge = '<span class="badge badge-orange">⏳ بانتظار الموافقة</span>';
      else if (b.status === 'approved') statusBadge = '<span class="badge badge-green">✅ تمت الموافقة</span>';
      else if (b.status === 'rejected') statusBadge = '<span class="badge badge-red">❌ مرفوض</span>';
      var d = new Date(b.createdAt).toLocaleDateString('ar-IQ');
      var confirmedInfo = '';
      if (b.confirmedSlot) {
        confirmedInfo = '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:8px;margin-top:8px;font-size:12px;color:#166534">✅ الموعد المؤكد: '+fmtSlot(b.confirmedSlot)+'</div>';
      }
      if (b.rejectionReason) {
        confirmedInfo = '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px;margin-top:8px;font-size:12px;color:#991b1b">السبب: '+b.rejectionReason+'</div>';
      }
      return '<div class="card" style="margin-bottom:8px"><div class="card-body" style="padding:10px 14px">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">'+
          '<div><div style="font-weight:700;font-size:13px;color:var(--gray6)">'+(b.reason||'-')+'</div>'+
          '<div style="font-size:11px;color:var(--gray5);margin-top:2px">📅 '+d+'</div></div>'+
          statusBadge+
        '</div>'+
        confirmedInfo+
      '</div></div>';
    }).join('');
}

function submitBookingRequest(){
  var reason = document.getElementById('baReason').value;
  var otherReason = (document.getElementById('baOtherReason').value||'').trim();
  var notes = (document.getElementById('baNotes').value||'').trim();
  var d1 = document.getElementById('baDate1').value;
  var t1 = document.getElementById('baTime1').value;
  var d2 = document.getElementById('baDate2').value;
  var t2 = document.getElementById('baTime2').value;
  var d3 = document.getElementById('baDate3').value;
  var t3 = document.getElementById('baTime3').value;
  if (!reason) { alert('اختر سبب الزيارة'); return; }
  if (reason === 'other' && !otherReason) { alert('اكتب تفاصيل سبب الزيارة'); return; }
  if (!d1 || !t1 || !d2 || !t2 || !d3 || !t3) { alert('اختر 3 أوقات مفضلة (تاريخ + وقت لكل منها)'); return; }

  // ─── تحقق من ساعات العيادة لكل خيار ───
  if (!isWithinClinicHours(t1) || !isWithinClinicHours(t2) || !isWithinClinicHours(t3)){
    alert('⛔ جميع الأوقات يجب أن تكون بين 9:00 صباحاً و 9:00 مساءً.');
    return;
  }

  // ─── تحقق من أن التواريخ ليست في الماضي ───
  var todayStr = today();
  if (d1 < todayStr || d2 < todayStr || d3 < todayStr){
    alert('⛔ لا يمكن اختيار تاريخ في الماضي.');
    return;
  }

  // بناء ISO strings
  var slot1Iso = new Date(d1+'T'+t1+':00').toISOString();
  var slot2Iso = new Date(d2+'T'+t2+':00').toISOString();
  var slot3Iso = new Date(d3+'T'+t3+':00').toISOString();

  var finalReason = reason === 'other' ? otherReason : reason;
  var bookings = G('bookingRequests', []);
  var newBooking = {
    id: 'br' + uid(),
    patientId: CU.id,
    patientName: CU.name,
    reason: finalReason,
    notes: notes,
    slot1: slot1Iso,
    slot2: slot2Iso,
    slot3: slot3Iso,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  bookings.push(newBooking);
  S('bookingRequests', bookings);
  // Push notif to clinic
  try { pushNotifyRole('📅 طلب حجز جديد', CU.name + ' • ' + finalReason, 'reception'); } catch(e){}
  try { pushNotifyRole('📅 طلب حجز جديد', CU.name + ' • ' + finalReason, 'doctor-manager'); } catch(e){}
  // Reset form
  document.getElementById('baReason').value = '';
  document.getElementById('baOtherReason').value = '';
  document.getElementById('baNotes').value = '';
  document.getElementById('baDate1').value = '';
  document.getElementById('baTime1').value = '';
  document.getElementById('baDate2').value = '';
  document.getElementById('baTime2').value = '';
  document.getElementById('baDate3').value = '';
  document.getElementById('baTime3').value = '';
  document.getElementById('baOtherReasonGroup').style.display = 'none';
  alert('✅ تم إرسال طلب الحجز بنجاح!\n\nستراجعه العيادة وتتواصل معك لتأكيد الموعد المناسب.');
  renderBookAppt();
}

// ─── Patient-side: Inquiries ───
function renderMyInquiries(){
  if (!CU || CU.role !== 'patient') return;
  var myInquiries = G('patientInquiries', []).filter(function(q){return q.patientId === CU.id;});
  myInquiries.sort(function(a,b){return new Date(b.lastUpdate||b.createdAt) - new Date(a.lastUpdate||a.createdAt);});
  // Mark clinic replies as read
  var inquiries = G('patientInquiries', []);
  var changed = false;
  inquiries.forEach(function(q){
    if (q.patientId !== CU.id) return;
    (q.replies||[]).forEach(function(r){
      if (!r.fromPatient && !r.read) { r.read = true; changed = true; }
    });
  });
  if (changed) Sl('patientInquiries', inquiries);

  var el = document.getElementById('inquiriesList');
  if (!myInquiries.length) { el.innerHTML = emptyState('💬','لا توجد استفسارات سابقة. اكتب استفسارك الأول أعلاه.'); return; }
  el.innerHTML = myInquiries.map(function(q){
    var d = new Date(q.createdAt).toLocaleDateString('ar-IQ');
    var statusBadge = '';
    if (q.status === 'closed') statusBadge = '<span class="badge badge-gray">مُغلق</span>';
    else if (q.replies && q.replies.length) statusBadge = '<span class="badge badge-green">✓ تم الرد</span>';
    else statusBadge = '<span class="badge badge-orange">⏳ بانتظار الرد</span>';
    var html = '<div class="card" style="margin-bottom:10px"><div class="card-body" style="padding:12px 14px">'+
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap">'+
        '<div style="font-size:11px;color:var(--gray5)">📅 '+d+'</div>'+
        statusBadge+
      '</div>'+
      '<div style="background:#f8fafc;border-radius:8px;padding:10px;font-size:13px;color:var(--gray6);white-space:pre-line">'+(q.text||'').replace(/</g,'&lt;')+'</div>';
    if (q.replies && q.replies.length) {
      html += '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--gray2)">';
      q.replies.forEach(function(r){
        var isMine = r.fromPatient;
        var bg = isMine ? '#0d5c7a' : '#f0fdf4';
        var color = isMine ? '#fff' : 'var(--gray6)';
        var label = isMine ? 'أنت' : (r.byName || 'العيادة');
        html += '<div style="background:'+bg+';color:'+color+';border-radius:8px;padding:8px 10px;margin-bottom:6px">'+
          '<div style="font-size:10px;opacity:.7;margin-bottom:2px">'+label+' • '+new Date(r.at).toLocaleString('ar-IQ')+'</div>'+
          '<div style="font-size:13px;white-space:pre-line">'+(r.text||'').replace(/</g,'&lt;')+'</div>'+
        '</div>';
      });
      html += '</div>';
    }
    if (q.status !== 'closed') {
      html += '<div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="ptReplyToInquiry(\''+q.id+'\')">💬 إضافة رد</button></div>';
    }
    html += '</div></div>';
    return html;
  }).join('');
}

function submitInquiry(){
  var text = (document.getElementById('newInquiryText').value||'').trim();
  if (!text) { alert('اكتب استفسارك أولاً'); return; }
  var inquiries = G('patientInquiries', []);
  inquiries.push({
    id: 'inq' + uid(),
    patientId: CU.id,
    patientName: CU.name,
    text: text,
    status: 'open',
    replies: [],
    createdAt: new Date().toISOString(),
    lastUpdate: new Date().toISOString()
  });
  S('patientInquiries', inquiries);
  try { pushNotifyRole('💬 استفسار جديد', CU.name + ': ' + text.slice(0,60), 'reception'); } catch(e){}
  try { pushNotifyRole('💬 استفسار جديد', CU.name + ': ' + text.slice(0,60), 'doctor-manager'); } catch(e){}
  document.getElementById('newInquiryText').value = '';
  alert('✅ تم إرسال استفسارك. ستتلقى الرد قريباً.');
  renderMyInquiries();
}

function ptReplyToInquiry(qid){
  var text = prompt('اكتب ردك:');
  if (!text || !text.trim()) return;
  var inquiries = G('patientInquiries', []);
  var q = inquiries.find(function(x){return x.id === qid;});
  if (!q) return;
  if (!q.replies) q.replies = [];
  q.replies.push({
    text: text.trim(),
    fromPatient: true,
    at: new Date().toISOString(),
    read: false
  });
  q.lastUpdate = new Date().toISOString();
  q.status = 'open';
  S('patientInquiries', inquiries);
  try { pushNotifyRole('💬 رد على استفسار', CU.name + ': ' + text.slice(0,60), 'reception'); } catch(e){}
  renderMyInquiries();
}

// ═══════════════════════════════════════════════════
//  ARTICLES LIBRARY (6 comprehensive articles)
// ═══════════════════════════════════════════════════
var ARTICLES = [
  {
    id: 'a1',
    icon: '🦷',
    color: '#6c2fa0',
    category: 'تقويم الأسنان',
    title: 'العناية بتقويم الأسنان الثابت',
    summary: 'دليلك الشامل للحفاظ على نظافة وصحة فمك خلال فترة التقويم',
    readTime: '5 دقائق',
    content: '<h2>لماذا تختلف العناية بأسنانك خلال التقويم؟</h2>'+
      '<p>الأقواس والأسلاك المعدنية تخلق أماكن صغيرة يصعب وصول الفرشاة إليها، مما يؤدي إلى تراكم بقايا الطعام والبكتيريا. إذا أُهملت، تظهر بقع بيضاء دائمة على الأسنان بعد إزالة التقويم، وقد تلتهب اللثة وتتعرض الأسنان للتسوس.</p>'+
      '<h3>1. الفرشاة الصحيحة</h3>'+
      '<ul>'+
        '<li><strong>اغسل أسنانك بعد كل وجبة</strong> — حتى الوجبات الخفيفة. هذا غير قابل للنقاش خلال التقويم.</li>'+
        '<li>استخدم <strong>فرشاة ذات شعيرات ناعمة</strong> أو فرشاة تقويم خاصة (V-shaped).</li>'+
        '<li>نظّف بحركات دائرية صغيرة <strong>فوق وتحت كل قوس</strong>، وليس فقط على سطح السن.</li>'+
        '<li>خصّص <strong>دقيقتين على الأقل</strong> لكل عملية تنظيف.</li>'+
      '</ul>'+
      '<h3>2. أدوات لا غنى عنها</h3>'+
      '<ul>'+
        '<li><strong>فرشاة بين الأسنان (Interdental brush):</strong> تدخل بين الأقواس وتنظف ما لا تستطيع الفرشاة العادية الوصول إليه.</li>'+
        '<li><strong>الخيط الطبي مع أداة التمرير (Floss threader):</strong> تمرّر الخيط أسفل السلك لتنظيف ما بين الأسنان.</li>'+
        '<li><strong>غسول الفم بالفلورايد:</strong> يقوي المينا ويقلل التسوس بنسبة 30% مع الاستخدام اليومي.</li>'+
      '</ul>'+
      '<h3>3. أطعمة يجب تجنبها</h3>'+
      '<p>خلال فترة التقويم، تجنّب:</p>'+
      '<ul>'+
        '<li><strong>الأطعمة الصلبة:</strong> الجوز، الثلج، الفشار، التفاح كاملاً (قطّعه أولاً)</li>'+
        '<li><strong>الأطعمة اللزجة:</strong> العلكة، الكراميل، التوفي — تلتصق بالأقواس وقد تكسرها</li>'+
        '<li><strong>الأطعمة المسببة للتسوس:</strong> الحلويات، المشروبات الغازية، العصائر المُحلّاة</li>'+
      '</ul>'+
      '<h3>4. كيف تتعامل مع الإزعاج؟</h3>'+
      '<p>بعد كل تعديل، قد تشعر بألم خفيف لمدة 2-3 أيام. هذا طبيعي تماماً. ينصح بـ:</p>'+
      '<ul>'+
        '<li>تناول أطعمة طرية: الشوربات، البطاطا المهروسة، الزبادي، البيض</li>'+
        '<li>المضمضة بالماء الدافئ مع الملح (نصف ملعقة في كوب)</li>'+
        '<li>وضع <strong>شمع التقويم</strong> على القوس إذا كان يجرح الخد أو الشفة</li>'+
      '</ul>'+
      '<h3>5. متى تتصل بالعيادة فوراً؟</h3>'+
      '<ul>'+
        '<li>كسر سلك أو خروجه من القوس</li>'+
        '<li>سقوط قوس عن السن</li>'+
        '<li>ألم شديد لا يهدأ بعد 5 أيام من التعديل</li>'+
        '<li>تورم أو نزيف غير طبيعي في اللثة</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>نصيحة الدكتور أحمد:</strong> العناية الجيدة تختصر مدة التقويم. مرضاي الذين يلتزمون بالتعليمات ينهون علاجهم في 18-24 شهراً، بينما من يهملون قد يستغرقون 3 سنوات أو أكثر.</div>'
  },
  {
    id: 'a2',
    icon: '✨',
    color: '#0891b2',
    category: 'تقويم شفاف',
    title: 'الاعتناء بقوالب Aligners الشفافة',
    summary: 'كل ما تحتاج معرفته للحصول على أفضل النتائج من تقويمك الشفاف',
    readTime: '4 دقائق',
    content: '<h2>تقويم Aligners ليس بدون التزام</h2>'+
      '<p>كثير من المرضى يعتقدون أن الـ Aligners أسهل من التقويم الثابت. الحقيقة: نتيجتها ممتازة <strong>فقط</strong> إذا التزمت بالقواعد. الإهمال يعني فشل العلاج وضياع المال.</p>'+
      '<h3>1. القاعدة الذهبية: 22 ساعة يومياً</h3>'+
      '<p>يجب أن تلبس القوالب <strong>22 ساعة في اليوم على الأقل</strong>. تخلعها فقط لـ:</p>'+
      '<ul>'+
        '<li>الأكل والشرب (ما عدا الماء)</li>'+
        '<li>تنظيف الأسنان</li>'+
      '</ul>'+
      '<p><strong>تحذير:</strong> إذا لبستها أقل من 20 ساعة بانتظام، الأسنان لن تتحرك وقد تتراجع مرة أخرى. ستحتاج قوالب جديدة وتأخير في العلاج.</p>'+
      '<h3>2. كيف تنظّف القوالب؟</h3>'+
      '<ul>'+
        '<li><strong>اشطفها بالماء البارد</strong> في كل مرة تخلعها</li>'+
        '<li>نظّفها <strong>مرتين يومياً</strong> بفرشاة ناعمة وصابون شفاف (ليس معجون أسنان — يخدشها)</li>'+
        '<li>استخدم <strong>أقراص تنظيف Aligners</strong> مرة كل أسبوع لتعقيم عميق</li>'+
        '<li>لا تستخدم الماء الساخن أبداً — يشوّه شكلها ويتلفها</li>'+
      '</ul>'+
      '<h3>3. قواعد الأكل والشرب</h3>'+
      '<ul>'+
        '<li><strong>اخلعها قبل أي طعام أو شراب</strong> ما عدا الماء</li>'+
        '<li>لا تشرب الشاي، القهوة، أو العصائر الملوّنة وأنت لابسها — تصبغ القوالب وتجعلها مرئية</li>'+
        '<li>اغسل أسنانك قبل إعادة اللبس — الطعام المحبوس داخل القالب يسبب تسوساً سريعاً</li>'+
      '</ul>'+
      '<h3>4. التبديل بين القوالب</h3>'+
      '<p>كل قالب يُلبس عادة <strong>1-2 أسبوع</strong> ثم يُستبدل بالتالي. تعليمات مهمة:</p>'+
      '<ul>'+
        '<li>غيّر القالب <strong>قبل النوم</strong> — القالب الجديد يضغط على الأسنان وقد يكون مزعجاً، النوم خلال هذه الفترة أسهل</li>'+
        '<li><strong>احتفظ بالقالب السابق</strong> — إن فقدت الجديد، يمكنك استخدام السابق مؤقتاً</li>'+
        '<li>استخدم <strong>chewies</strong> (أسطوانة سيليكون) لـ 5-10 دقائق بعد كل تبديل لضمان جلوس القالب جيداً</li>'+
      '</ul>'+
      '<h3>5. إذا فقدت أو كسرت قالباً</h3>'+
      '<ol>'+
        '<li>ارجع للقالب السابق فوراً (لذلك نحتفظ به)</li>'+
        '<li>اتصل بالعيادة في نفس اليوم</li>'+
        '<li>لا تتجاوز إلى القالب التالي بدون استشارة الطبيب</li>'+
      '</ol>'+
      '<h3>6. علبة الحفظ — صديقك الوفي</h3>'+
      '<p>السبب الأول لفقدان الـ Aligners: لفّها بمنديل ووضعها على الطاولة في مطعم. <strong>دائماً</strong> ضعها في علبتها الخاصة. اشترِ علبة احتياطية لشنطتك أو سيارتك.</p>'+
      '<div class="art-tip">💡 <strong>نصيحة:</strong> ضع تذكيراً يومياً في هاتفك بعدد ساعات اللبس. أبسط طريقة: اخلعها وقت الأكل فقط. لو خلعتها أكثر من ذلك، النتيجة لن تكون كما تتوقع.</div>'
  },
  {
    id: 'a3',
    icon: '🦷',
    color: '#dc2626',
    category: 'زراعة الأسنان',
    title: 'دليل ما بعد زراعة الأسنان',
    summary: 'كيف تضمن نجاح زراعتك وتسريع التئام العظم',
    readTime: '6 دقائق',
    content: '<h2>الزراعة استثمار يستحق العناية</h2>'+
      '<p>زراعة السن تستغرق 3-6 أشهر للالتئام الكامل (osseointegration). أول شهرين هما الأهم — أي إهمال خلالها قد يفشل الزراعة كلياً.</p>'+
      '<h3>أول 24 ساعة بعد العملية</h3>'+
      '<ul>'+
        '<li><strong>اعضّ على الشاش</strong> الذي وضعه الطبيب لمدة ساعة كاملة (لا أقل) لإيقاف النزيف</li>'+
        '<li><strong>ضع كمادات ثلج</strong> على الخد من الخارج (15 دقيقة، ثم 15 دقيقة استراحة) لتقليل التورم</li>'+
        '<li><strong>لا تبصق</strong> ولا تشطف فمك بقوة — قد تُزيح الجلطة الدموية الواقية</li>'+
        '<li><strong>لا تشرب بالشليمو</strong> (straw) — الضغط يُزيح الجلطة</li>'+
        '<li><strong>تجنب الأكل والشرب الساخن</strong> لـ 24 ساعة</li>'+
        '<li>نم على وسادة عالية لتقليل التورم</li>'+
      '</ul>'+
      '<h3>أول أسبوع</h3>'+
      '<ul>'+
        '<li>التزم بـ <strong>المضادات الحيوية</strong> التي وصفها الطبيب (كاملة، حتى لو شعرت بتحسن)</li>'+
        '<li>تناول <strong>مسكنات الألم</strong> حسب التعليمات</li>'+
        '<li>تناول <strong>أطعمة طرية وباردة:</strong> الزبادي، البطاطا المهروسة، الشوربات الفاترة، البيض المسلوق</li>'+
        '<li>تجنب الأطعمة الصلبة، الحارة، أو التي تحتوي على بذور (قد تدخل مكان الزراعة)</li>'+
        '<li>تجنب التدخين تماماً — النيكوتين يُقلل تدفق الدم ويُفشل الزراعة بنسبة عالية</li>'+
      '</ul>'+
      '<h3>التنظيف بعد الزراعة</h3>'+
      '<ul>'+
        '<li><strong>اليومان الأول والثاني:</strong> لا تنظف منطقة الزراعة بالفرشاة. اغسل بقية الأسنان بحذر.</li>'+
        '<li><strong>من اليوم الثالث:</strong> ابدأ بمضمضة لطيفة بمحلول ملحي دافئ (نصف ملعقة ملح في كوب ماء) بعد كل وجبة</li>'+
        '<li><strong>من الأسبوع الثاني:</strong> ابدأ بتنظيف منطقة الزراعة بفرشاة ناعمة جداً وحركات لطيفة</li>'+
        '<li>استخدم <strong>غسول كلورهيكسيدين</strong> (اسمه التجاري Hexidine) إذا وصفه الطبيب — مرتين يومياً لمدة أسبوعين</li>'+
      '</ul>'+
      '<h3>متى تتصل بالطبيب فوراً؟</h3>'+
      '<ul>'+
        '<li>نزيف لا يتوقف بعد 24 ساعة</li>'+
        '<li>تورم يزيد بعد اليوم الثالث (التورم الطبيعي يبدأ بالتراجع من اليوم 3)</li>'+
        '<li>ألم شديد لا يستجيب للمسكنات</li>'+
        '<li>حمى أعلى من 38°C</li>'+
        '<li>إفرازات صديدية أو رائحة كريهة</li>'+
        '<li>تخدّر دائم في الشفة أو الذقن (قد يدل على إصابة عصب)</li>'+
      '</ul>'+
      '<h3>عناية طويلة المدى بالزراعة</h3>'+
      '<p>الزراعة الناجحة تستمر 20-30 سنة بشرط:</p>'+
      '<ul>'+
        '<li><strong>تنظيف يومي ممتاز</strong> — الزراعة لا تتسوس لكن العظم حولها يلتهب (peri-implantitis) إذا أُهملت</li>'+
        '<li><strong>فحص دوري كل 6 أشهر</strong> — تنظيف احترافي مهم</li>'+
        '<li><strong>تجنب التدخين</strong> — الزراعات عند المدخنين تفشل بمعدل 3 أضعاف</li>'+
        '<li><strong>السيطرة على السكري</strong> إن كنت مصاباً — السكر العالي يضعف العظم</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>تنبيه مهم:</strong> الزراعة لا تشعر بالألم كالسن الطبيعي. لذلك قد لا تعرف إن كانت ملتهبة. الفحص الدوري ضروري.</div>'
  },
  {
    id: 'a4',
    icon: '🪥',
    color: '#16a34a',
    category: 'العناية اليومية',
    title: 'الفرشاة والمعجون: ما لا تعرفه',
    summary: 'حقائق صادمة عن طريقة تنظيف أسنانك التي تمارسها يومياً',
    readTime: '4 دقائق',
    content: '<h2>أكثر من 70% من الناس يغسلون أسنانهم بطريقة خاطئة</h2>'+
      '<p>قد تظن أنك تنظف أسنانك جيداً، لكن دراسات عديدة تُثبت أن معظم البالغين يرتكبون أخطاء أساسية تُسبب مشاكل اللثة وتآكل المينا.</p>'+
      '<h3>الأخطاء الخمسة الأكثر شيوعاً</h3>'+
      '<h4>الخطأ 1: الضغط بقوة</h4>'+
      '<p>كثير من الناس يضغطون بشدة ظناً أن ذلك ينظف أكثر. الواقع: <strong>الضغط الزائد يُتلف اللثة ويُكشف جذور الأسنان</strong> ويسبب حساسية مزمنة. الفرشاة يجب أن تكون <strong>لمسة ناعمة</strong> — كأنك تكتب باليد.</p>'+
      '<h4>الخطأ 2: الفرشاة الخشنة</h4>'+
      '<p>"الخشنة تنظف أكثر" — أسطورة. <strong>اختر دائماً Soft</strong>. الشعيرات الخشنة تُتلف اللثة وطبقة المينا.</p>'+
      '<h4>الخطأ 3: الغسل مباشرة بعد الأكل</h4>'+
      '<p>إذا أكلت شيئاً حامضاً (برتقال، ليمون، طماطم، كولا)، <strong>انتظر 30 دقيقة</strong> قبل تنظيف الأسنان. الحمض يُليّن المينا، والفرشاة عليه تُتلفها. اشطف فمك بالماء فقط في تلك الـ 30 دقيقة.</p>'+
      '<h4>الخطأ 4: 30 ثانية فقط</h4>'+
      '<p>الحد الأدنى للتنظيف الصحيح هو <strong>دقيقتان</strong>. قسّم فمك إلى 4 أجزاء (علوي يمين، علوي يسار، سفلي يمين، سفلي يسار) ونظّف كلاً منها 30 ثانية.</p>'+
      '<h4>الخطأ 5: الشطف بعد المعجون</h4>'+
      '<p>الفلورايد في المعجون يحتاج <strong>30 ثانية على الأقل</strong> ليعمل. إذا شطفت فمك بالماء فوراً، تخسر معظم الفائدة. <strong>الأفضل:</strong> ابصق المعجون فقط وامتنع عن الشطف لـ 30 دقيقة.</p>'+
      '<h3>الطريقة الصحيحة (Bass technique)</h3>'+
      '<ol>'+
        '<li>وجّه الفرشاة بزاوية <strong>45 درجة</strong> إلى خط اللثة</li>'+
        '<li>حركها بحركات <strong>دائرية صغيرة</strong> (وليس أفقية)</li>'+
        '<li>نظّف <strong>كل سن من 3 جهات:</strong> الخارجية، الداخلية، السطح العلوي للمضغ</li>'+
        '<li>لا تنسَ <strong>اللسان</strong> — موطن لمليارات البكتيريا المسببة لرائحة الفم</li>'+
      '</ol>'+
      '<h3>اختيار المعجون</h3>'+
      '<ul>'+
        '<li><strong>للبالغين:</strong> 1450ppm من الفلورايد (المُذكور على العلبة)</li>'+
        '<li><strong>للأطفال 3-6 سنوات:</strong> بحجم حبة بازلاء، 1000ppm فلورايد</li>'+
        '<li><strong>للأطفال أقل من 3 سنوات:</strong> طبقة رقيقة جداً (smear)</li>'+
        '<li>معاجين التبييض القوية تُستخدم <strong>بحذر</strong> — قد تُسبب حساسية</li>'+
      '</ul>'+
      '<h3>متى تغيّر الفرشاة؟</h3>'+
      '<p>كل <strong>3 أشهر</strong>، أو فوراً بعد أي مرض (إنفلونزا، التهاب حلق) لتجنب إعادة العدوى. الشعيرات المنحنية لا تنظف، تُتلف.</p>'+
      '<div class="art-tip">💡 <strong>نصيحة احترافية:</strong> الفرشاة الكهربائية أفضل من اليدوية بحوالي 21%. إن كان ميزانيتك يسمح، اختر فرشاة كهربائية بحركة <strong>دورانية مذبذبة</strong> (Oscillating-rotating).</div>'
  },
  {
    id: 'a5',
    icon: '🩺',
    color: '#c2410c',
    category: 'صحة اللثة',
    title: 'نزيف اللثة: الإشارة التي تتجاهلها',
    summary: 'لماذا "اللثة الصحية لا تنزف" — ومتى يجب القلق فعلاً',
    readTime: '4 دقائق',
    content: '<h2>"نزيف بسيط، طبيعي" — هذا أكثر اعتقاد خاطئ شائع</h2>'+
      '<p>إذا نزفت لثتك أثناء الفرشاة أو الخيط، فهذا <strong>ليس طبيعياً</strong> ولا يجب تجاهله. اللثة الصحية صلبة، وردية، ولا تنزف. النزيف هو الإشارة الأولى لالتهاب اللثة.</p>'+
      '<h3>مراحل أمراض اللثة</h3>'+
      '<h4>المرحلة 1: التهاب اللثة (Gingivitis)</h4>'+
      '<ul>'+
        '<li>اللثة حمراء، منتفخة قليلاً</li>'+
        '<li>تنزف عند التنظيف أو الخيط</li>'+
        '<li>رائحة فم كريهة</li>'+
        '<li><strong>قابلة للعلاج 100%</strong> بتنظيف عميق وعناية يومية</li>'+
      '</ul>'+
      '<h4>المرحلة 2: التهاب دواعم السن (Periodontitis)</h4>'+
      '<ul>'+
        '<li>اللثة تتراجع وتظهر جذور الأسنان</li>'+
        '<li>"جيوب" بين السن واللثة تتراكم فيها البكتيريا</li>'+
        '<li>العظم حول السن يبدأ بالذوبان</li>'+
        '<li>قابلة للعلاج لكن <strong>الأضرار لا تعود</strong>: ما خسرته من عظم لن يعود</li>'+
      '</ul>'+
      '<h4>المرحلة 3: المتقدمة</h4>'+
      '<ul>'+
        '<li>الأسنان تتحرك وتتباعد</li>'+
        '<li>صديد بين الأسنان واللثة</li>'+
        '<li>الأسنان تسقط أو تُقتلع</li>'+
        '<li>قد تحتاج جراحة أو زراعة</li>'+
      '</ul>'+
      '<h3>أسباب أمراض اللثة</h3>'+
      '<ol>'+
        '<li><strong>تراكم الجير (calculus):</strong> طبقة صلبة تحت اللثة لا تُزال إلا بالتنظيف الاحترافي</li>'+
        '<li><strong>التدخين:</strong> يُضاعف الخطر 5 مرات</li>'+
        '<li><strong>السكري غير المضبوط:</strong> يُضعف اللثة ويُسرّع الالتهاب</li>'+
        '<li><strong>التوتر:</strong> يُضعف المناعة</li>'+
        '<li><strong>الحمل والتغيرات الهرمونية</strong></li>'+
        '<li><strong>الوراثة:</strong> 30% من الحالات لها عامل وراثي</li>'+
      '</ol>'+
      '<h3>كيف توقف التدهور؟</h3>'+
      '<ul>'+
        '<li><strong>تنظيف احترافي عند طبيب الأسنان كل 6 أشهر</strong> — هذا غير قابل للنقاش</li>'+
        '<li>تنظيف يومي بالخيط الطبي — بدون استثناء</li>'+
        '<li>غسول مضاد للبكتيريا (ينصح به طبيبك إن لزم)</li>'+
        '<li>الإقلاع عن التدخين</li>'+
        '<li>السيطرة على السكري</li>'+
      '</ul>'+
      '<h3>الخيط الطبي: ضروري وليس اختيارياً</h3>'+
      '<p>40% من سطح أسنانك بين الأسنان — لا تصلها الفرشاة. <strong>الخيط ينظف هذه الـ 40%</strong>. بدونه، أنت تنظف 60% فقط من أسنانك مهما كانت فرشاتك ممتازة.</p>'+
      '<p><strong>الطريقة الصحيحة:</strong></p>'+
      '<ul>'+
        '<li>استخدم 45 سم من الخيط</li>'+
        '<li>حرّكه بلطف لأعلى وأسفل بشكل C على كل سن</li>'+
        '<li>لا تشدّه بقوة — قد يجرح اللثة</li>'+
        '<li>إن كان الخيط صعباً، استخدم <strong>Water flosser</strong> (جهاز ماء) — فعّال جداً</li>'+
      '</ul>'+
      '<div class="art-tip">⚠️ <strong>تحذير:</strong> أمراض اللثة المتقدمة مرتبطة بأمراض القلب، السكتة الدماغية، والولادة المبكرة عند الحوامل. صحة فمك مرآة لصحة جسمك كله.</div>'
  },
  {
    id: 'a6',
    icon: '👶',
    color: '#db2777',
    category: 'الأطفال',
    title: 'صحة أسنان الأطفال: من الولادة إلى المراهقة',
    summary: 'الأخطاء الأبوية الشائعة وكيف تبني عادات سليمة لأبنائك',
    readTime: '5 دقائق',
    content: '<h2>صحة الفم تبدأ قبل أول سن</h2>'+
      '<p>كثير من الآباء يعتقدون أن العناية بأسنان الأطفال تبدأ عند ظهور الأسنان. الحقيقة: <strong>تبدأ من اليوم الأول</strong>.</p>'+
      '<h3>قبل ظهور الأسنان (0-6 أشهر)</h3>'+
      '<ul>'+
        '<li>امسح لثة الطفل <strong>بقطعة شاش مبللة</strong> بعد كل رضعة</li>'+
        '<li>هذا يزيل بقايا الحليب ويعوّد الطفل على نظافة الفم</li>'+
        '<li>لا تترك الطفل ينام والحلمة في فمه — يُسبب "تسوس الرضّاعة"</li>'+
      '</ul>'+
      '<h3>عند ظهور الأسنان (6-12 شهر)</h3>'+
      '<ul>'+
        '<li>أول زيارة للطبيب: <strong>عند ظهور أول سن أو عند عمر السنة (أيهما أسبق)</strong></li>'+
        '<li>استخدم فرشاة سيليكون ناعمة (تُلبس على الإصبع) ومعجون <strong>بحجم حبة أرز</strong> فلورايد 1000ppm</li>'+
        '<li>نظّف مرتين يومياً</li>'+
      '</ul>'+
      '<h3>الطفل الصغير (1-3 سنوات)</h3>'+
      '<ul>'+
        '<li>فرشاة أسنان أطفال صغيرة، بمعجون <strong>بحجم حبة أرز</strong></li>'+
        '<li>الطفل يحب أن يفعل بنفسه — اتركه يحاول، ثم نظّف أنت بعدها</li>'+
        '<li>لا تتركه يبتلع المعجون — علّمه أن يبصق</li>'+
        '<li>زيارة الطبيب كل 6 أشهر</li>'+
      '</ul>'+
      '<h3>الطفل (3-6 سنوات)</h3>'+
      '<ul>'+
        '<li>معجون <strong>بحجم حبة بازلاء</strong></li>'+
        '<li>الطفل لا يستطيع تنظيف أسنانه جيداً حتى عمر 7 سنوات — <strong>أنت تنظفها</strong> له (مع مساعدته)</li>'+
        '<li>ابدأ بالخيط الطبي عند تلامس الأسنان</li>'+
        '<li>سدّاد الشقوق (Sealants) للأسنان الخلفية الدائمة عند ظهورها — يحمي من التسوس بنسبة 80%</li>'+
      '</ul>'+
      '<h3>الأسنان الدائمة (6-12 سنة)</h3>'+
      '<ul>'+
        '<li>أول سن دائم يظهر <strong>خلف الأسنان اللبنية</strong> عند عمر 6 — كثير من الآباء لا ينتبهون له</li>'+
        '<li>هذا السن مهم جداً — يحدد شكل الفك ومكان باقي الأسنان</li>'+
        '<li>استشارة تقويم عند عمر <strong>7 سنوات</strong> — يكتشف المشاكل مبكراً</li>'+
        '<li>الإصابات الرياضية شائعة — <strong>واقي الفم</strong> ضروري</li>'+
      '</ul>'+
      '<h3>المراهقة (12-18 سنة)</h3>'+
      '<ul>'+
        '<li>أكبر فترة خطر للتسوس وأمراض اللثة بسبب الإهمال</li>'+
        '<li>المشروبات الغازية والوجبات السريعة عدو رقم 1</li>'+
        '<li>التقويم في هذه المرحلة أسهل وأسرع</li>'+
        '<li>أضراس العقل تبدأ بالظهور — متابعتها مهمة</li>'+
      '</ul>'+
      '<h3>أخطاء أبوية شائعة</h3>'+
      '<ol>'+
        '<li><strong>"الأسنان اللبنية ستسقط، لا داعي للعناية":</strong> خاطئ تماماً. تسوس الأسنان اللبنية يُتلف الأسنان الدائمة تحتها.</li>'+
        '<li><strong>إعطاء الحلويات والعصائر بكثرة:</strong> أخطر من تجنبها كلياً</li>'+
        '<li><strong>تأخير أول زيارة للطبيب:</strong> الزيارة المبكرة تكتشف المشاكل قبل تفاقمها</li>'+
        '<li><strong>التهديد بالطبيب:</strong> "لو ما سمعت الكلام أوديك للطبيب" — يخلق رعباً مزمناً</li>'+
        '<li><strong>عدم تنظيف اللسان:</strong> 90% من رائحة الفم الكريهة عند الأطفال من اللسان</li>'+
      '</ol>'+
      '<h3>كيف تجعل أبناءك يحبون التنظيف؟</h3>'+
      '<ul>'+
        '<li>اجعلها لعبة (مؤقت 2 دقيقة، فرشاة بشخصياتهم المفضلة)</li>'+
        '<li>نظّف أسنانك أمامهم — التقليد أقوى من التعليم</li>'+
        '<li>كافئهم بنجمة على روزنامة، وليس بحلوى</li>'+
        '<li>اقرأ لهم قصصاً عن نظافة الأسنان</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>للأمهات:</strong> صحة فمك خلال الحمل تؤثر على أسنان طفلك. التهاب اللثة أثناء الحمل مرتبط بالولادة المبكرة. اعتنِ بنفسك أولاً.</div>'
  },
  {
    id: 'a7',
    icon: '🔧',
    color: '#7c3aed',
    category: 'تقويم الأسنان',
    title: 'العناية بجهاز الـ Headgear (الجهاز الخارجي)',
    summary: 'كيف تستخدم الـ Headgear بشكل صحيح وتحقّق أفضل نتائج بأقصر وقت',
    readTime: '4 دقائق',
    content: '<h2>ما هو الـ Headgear ولماذا تحتاجه؟</h2>'+
      '<p>الـ Headgear جهاز تقويمي خارجي يُستخدم لتصحيح بروز الفك العلوي أو لخلق مساحة للأسنان المزدحمة عند المرضى الصغار. يعمل بقوّة شدّ خارجية تُطبَّق من الرأس أو الرقبة.</p>'+
      '<h3>1. كم ساعة يومياً يجب ارتداؤه؟</h3>'+
      '<ul>'+
        '<li><strong>‎12-14 ساعة يومياً</strong> هو الحد الأدنى لتحقيق نتائج فعّالة</li>'+
        '<li>الأفضل: ارتداؤه أثناء النوم + ‎4-6 ساعات في المنزل بعد المدرسة</li>'+
        '<li>أقل من ‎10 ساعات يومياً = نتائج بطيئة جداً وقد لا تظهر</li>'+
        '<li>الالتزام يختصر مدة العلاج من سنة إلى ‎6 أشهر</li>'+
      '</ul>'+
      '<h3>2. كيف تضعه بشكل صحيح؟</h3>'+
      '<ol>'+
        '<li>اغسل يديك جيداً قبل التركيب</li>'+
        '<li>أدخل القوس الداخلي (Inner bow) في أنابيب الأقواس الخلفية في فمك</li>'+
        '<li>تأكد من ثباته جيداً قبل توصيل الجزء الخارجي</li>'+
        '<li>اربط الشدّاد (Strap) خلف الرأس أو الرقبة حسب نوع الجهاز</li>'+
        '<li>القوة المثلى = شعور بشدّ خفيف، وليس ألم</li>'+
      '</ol>'+
      '<h3>3. تحذيرات السلامة المهمّة</h3>'+
      '<ul>'+
        '<li><strong>لا ترتدِه أثناء اللعب أو الرياضة أبداً</strong> — قد ينفلت ويُصيب العين</li>'+
        '<li>لا تنزعه بشدّ مباشر — افتح الشدّاد أولاً</li>'+
        '<li>إذا انفلت وأنت نائم، استيقظ وضعه مرة أخرى</li>'+
        '<li>الأطفال الصغار لا يرتدونه دون إشراف الوالدين</li>'+
      '</ul>'+
      '<h3>4. كيف تتعامل مع الانزعاج الأولي؟</h3>'+
      '<p>الأيام الـ ‎3-5 الأولى صعبة. توقع:</p>'+
      '<ul>'+
        '<li>ألم خفيف في الأسنان الخلفية → باراسيتامول حسب الحاجة</li>'+
        '<li>صعوبة في النوم → ابدأ بـ ‎4 ساعات وزد تدريجياً</li>'+
        '<li>أثر خفيف على الجلد من الشدّاد → ضع وسادة أو قطعة قماش ناعمة</li>'+
        '<li>صعوبة بالكلام → طبيعي، يتحسن خلال أيام</li>'+
      '</ul>'+
      '<h3>5. النظافة اليومية</h3>'+
      '<ul>'+
        '<li>اغسل الجهاز بفرشاة وماء وصابون يومياً</li>'+
        '<li>الجزء المعدني — جفّفه جيداً ليتجنب الصدأ</li>'+
        '<li>الشدّاد القماشي — اغسله بالماء البارد أسبوعياً</li>'+
        '<li>احفظه في علبته الخاصة دائماً عند عدم الاستخدام</li>'+
      '</ul>'+
      '<h3>متى تتصل بالعيادة فوراً؟</h3>'+
      '<ul>'+
        '<li>انكسار أي جزء من الجهاز</li>'+
        '<li>إصابة في العين أو الوجه</li>'+
        '<li>ألم شديد لا يهدأ بعد ‎5 أيام</li>'+
        '<li>تخفّفه عن الأسنان (لا يبقى ثابتاً)</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>سرّ النجاح:</strong> سجّل ساعات الاستخدام في تطبيق على هاتفك. مرضاي الذين يستخدمون عدّاد ساعات ينتهي علاجهم أسرع بـ ‎40% من غيرهم.</div>'
  },
  {
    id: 'a8',
    icon: '🔩',
    color: '#0891b2',
    category: 'تقويم الأسنان',
    title: 'الموسّع (Expander): كل ما تحتاج معرفته',
    summary: 'كيف يعمل موسّع الفك، طريقة تدوير المفتاح، والتعامل مع التغييرات الأولى',
    readTime: '5 دقائق',
    content: '<h2>ما هو الموسّع ولماذا يُستخدم؟</h2>'+
      '<p>الموسّع جهاز تقويمي يُلصق على سقف الفم ويعمل على <strong>توسيع الفك العلوي تدريجياً</strong>. يُستخدم لحل مشاكل ضيق الفك، والعضّة المتقاطعة (crossbite)، وخلق مساحة للأسنان المزدحمة دون الحاجة لقلع.</p>'+
      '<h3>1. كيف يعمل؟</h3>'+
      '<p>الموسّع يحتوي على برغي مركزي (Expansion screw) في المنتصف. كل تدوير للمفتاح يُحرّك الجزأين بمقدار <strong>‎0.25 ملم</strong>. على مدى ‎2-4 أسابيع، يتسع الفك من ‎5 إلى ‎10 ملم.</p>'+
      '<h3>2. طريقة تدوير المفتاح (الأهم!)</h3>'+
      '<ol>'+
        '<li><strong>الوقت الأمثل:</strong> قبل النوم (للسماح للفك بالتكيّف ليلاً)</li>'+
        '<li>اطلب من المريض الاستلقاء على الظهر، ورأسه مرفوع قليلاً</li>'+
        '<li>أضئ الفم جيداً (مصباح يدوي أو مصباح الهاتف)</li>'+
        '<li>أدخل المفتاح في الفتحة الأمامية للبرغي</li>'+
        '<li>ادفعه <strong>للخلف نحو الحلق</strong> حتى تشعر بالتوقف (تدوير كامل)</li>'+
        '<li>ستظهر الفتحة التالية في المقدمة — هذا دليل التدوير الصحيح</li>'+
        '<li>اسحب المفتاح للخارج بحذر</li>'+
      '</ol>'+
      '<h3>3. عدد التدويرات اليومية</h3>'+
      '<ul>'+
        '<li><strong>الأسبوع الأول:</strong> تدويرة واحدة يومياً (حسب توجيه الطبيب)</li>'+
        '<li>قد يصف الطبيب تدويرتين يومياً (صباحاً ومساءً) في حالات خاصة</li>'+
        '<li>لا تتجاوز التعليمات أبداً — التوسيع السريع يُسبب ألماً شديداً</li>'+
        '<li>سجّل كل تدوير في دفتر صغير لتتبّع التقدم</li>'+
      '</ul>'+
      '<h3>4. ما الذي ستلاحظه؟</h3>'+
      '<ul>'+
        '<li><strong>أول ‎3-5 أيام:</strong> ضغط في وسط الوجه، صداع خفيف، صعوبة في البلع</li>'+
        '<li><strong>بعد أسبوع:</strong> ظهور <strong>فجوة بين الثنيتين الأماميتين</strong> — هذا <strong>دليل على نجاح التوسيع</strong>، لا تقلق منها!</li>'+
        '<li>الفجوة ستُغلق خلال ‎4-6 أسابيع بعد توقف التدوير</li>'+
        '<li>تغيّر بسيط في النطق (مؤقت)</li>'+
      '</ul>'+
      '<h3>5. الأكل والشرب</h3>'+
      '<ul>'+
        '<li>تجنّب الأطعمة الصلبة جداً (مكسرات، ثلج، خبز قاسٍ)</li>'+
        '<li>تجنّب الأطعمة اللزجة (علكة، توفي، كراميل) — تلتصق بالجهاز</li>'+
        '<li>قطّع الطعام إلى قطع صغيرة في الأسبوع الأول</li>'+
        '<li>تجنب المشروبات شديدة البرودة أو الحرارة في البداية</li>'+
      '</ul>'+
      '<h3>6. النظافة</h3>'+
      '<ul>'+
        '<li>الطعام يتجمّع تحت الجهاز — اغسل بعد كل وجبة</li>'+
        '<li>استخدم مَحقن ماء (Water flosser) لإزالة بقايا الطعام</li>'+
        '<li>غسول الفم بالفلورايد يومياً</li>'+
      '</ul>'+
      '<h3>متى تتصل بالعيادة فوراً؟</h3>'+
      '<ul>'+
        '<li>المفتاح ضاع أو انكسر</li>'+
        '<li>الجهاز تخلخل عن الأسنان</li>'+
        '<li>ألم شديد جداً بعد التدوير لا يهدأ خلال ‎24 ساعة</li>'+
        '<li>عدم القدرة على التدوير (المفتاح لا يدخل أو لا يدور)</li>'+
        '<li>نزيف أو تورم في سقف الفم</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>نصيحة:</strong> الفجوة بين الثنيتين <strong>دليل نجاح</strong>، وليس مشكلة. كثير من المرضى يخافون منها ويطلبون إيقاف التدوير — هذا خطأ. استمر حسب التعليمات.</div>'
  },
  {
    id: 'a9',
    icon: '🦷',
    color: '#0d9488',
    category: 'تقويم الأسنان',
    title: 'المثبّت المتحرك: لا تخسر نتيجة سنوات في أسابيع',
    summary: 'لماذا المثبّت أهم من التقويم نفسه، وكيف تعتني به ليدوم',
    readTime: '4 دقائق',
    content: '<h2>التقويم انتهى... لكن الرحلة لم تنتهِ</h2>'+
      '<p>أكبر خطأ يرتكبه المرضى بعد إزالة التقويم: <strong>إهمال المثبّت</strong>. الأسنان لها "ذاكرة" — تحاول العودة لمكانها الأصلي. المثبّت هو الوحيد الذي يمنع ذلك.</p>'+
      '<h3>1. كم ساعة يومياً؟</h3>'+
      '<ul>'+
        '<li><strong>أول ‎3-6 أشهر:</strong> ‎22 ساعة يومياً (طوال الوقت ما عدا الأكل والتنظيف)</li>'+
        '<li><strong>الأشهر ‎6-12:</strong> ‎12 ساعة يومياً (أثناء النوم فقط + بضع ساعات نهاراً)</li>'+
        '<li><strong>بعد سنة:</strong> ‎8 ساعات يومياً (أثناء النوم فقط) — <strong>للأبد</strong></li>'+
        '<li>نعم، للأبد. الأسنان تتحرك حتى في الستينيات.</li>'+
      '</ul>'+
      '<h3>2. الخطأ القاتل: تركه أسبوعاً</h3>'+
      '<p>إذا تركت المثبّت لأسبوع كامل، قد لا يدخل ثانية لأن الأسنان عادت قليلاً. النتيجة: <strong>تبدأ التقويم من الصفر</strong>. لا تجرّب هذا الخطأ.</p>'+
      '<p>إذا انكسر أو ضاع — اتصل بالعيادة <strong>فوراً</strong> (نفس اليوم).</p>'+
      '<h3>3. كيف تضعه وتنزعه؟</h3>'+
      '<ul>'+
        '<li><strong>التركيب:</strong> ضعه على الأسنان الأمامية ثم اضغط برفق على الأطراف</li>'+
        '<li><strong>النزع:</strong> أمسك الجزء المعدني (Wire) بكلتا اليدين واسحب للأسفل بحركة متساوية</li>'+
        '<li>لا تنزعه بلسانك — يُسبب انحناء السلك</li>'+
        '<li>لا تستخدم أصابعك من جهة واحدة فقط — يكسر البلاستيك</li>'+
      '</ul>'+
      '<h3>4. النظافة اليومية</h3>'+
      '<ul>'+
        '<li>اغسله بـ <strong>فرشاة أسنان وصابون</strong> (وليس معجون أسنان — يخدش البلاستيك)</li>'+
        '<li>مرة أسبوعياً: انقعه في حبة منظفة لطقم الأسنان (Polident أو Steradent) لـ ‎15 دقيقة</li>'+
        '<li>لا تستخدم ماء ساخناً أبداً — يُشوّه البلاستيك</li>'+
        '<li>لا تنقعه في غسول فم ملوّن — يصبغه</li>'+
      '</ul>'+
      '<h3>5. الحفظ الآمن</h3>'+
      '<ul>'+
        '<li>دائماً في <strong>علبته الخاصة</strong> عند نزعه</li>'+
        '<li>السبب الأول لضياعه: <strong>لفّه في منديل ورقي</strong> ثم رميه بالخطأ</li>'+
        '<li>السبب الثاني: تركه على المنضدة فيأكله الكلب أو القطة (يحدث حقاً!)</li>'+
        '<li>عند السفر: ضعه في حقيبة اليد، ليس في الحقيبة الكبيرة</li>'+
      '</ul>'+
      '<h3>6. أعراض غير طبيعية</h3>'+
      '<ul>'+
        '<li>إذا أصبح لا يدخل بسهولة → <strong>اتصل فوراً</strong>، لا تجبره</li>'+
        '<li>تخلخل أو شقوق في البلاستيك → موعد عاجل</li>'+
        '<li>بقع بيضاء أو رائحة كريهة → نظّفه بعمق وزُر الطبيب</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>الحقيقة المرّة:</strong> ‎70% من المرضى يخسرون جزءاً من النتيجة بسبب إهمال المثبّت. لا تكن منهم. ‎8 ساعات ليلاً مدى الحياة = استثمار صغير لحماية سنوات من العلاج.</div>'
  },
  {
    id: 'a10',
    icon: '🔗',
    color: '#9333ea',
    category: 'تقويم الأسنان',
    title: 'المثبّت الثابت: السلك المخفي خلف أسنانك',
    summary: 'كيف تنظّف السلك الخلفي، وما الذي يجب تجنّبه لتلافي كسره',
    readTime: '4 دقائق',
    content: '<h2>المثبّت الثابت — صديقك الصامت</h2>'+
      '<p>المثبّت الثابت (Fixed retainer) سلك معدني رفيع يُلصق على <strong>الجهة الداخلية للأسنان الأمامية السفلية</strong> (وأحياناً العلوية). يبقى مدى الحياة ولا يحتاج خلعه يومياً — ولكنه يتطلب اهتماماً خاصاً بالنظافة.</p>'+
      '<h3>1. لماذا الثابت بدل المتحرك؟</h3>'+
      '<ul>'+
        '<li><strong>لا يعتمد على التزامك</strong> — يعمل ‎24/7 تلقائياً</li>'+
        '<li>غير مرئي تماماً — لا أحد يعرف أنك ترتديه</li>'+
        '<li>لا يؤثر على النطق</li>'+
        '<li>أكثر فعالية في منع عودة الأسنان الأمامية للتزاحم</li>'+
      '</ul>'+
      '<h3>2. التحدي الأكبر: التنظيف بين الأسنان</h3>'+
      '<p>الفرشاة العادية تنظّف السطح، لكن <strong>السلك يمنع وصول الخيط بطريقة عادية</strong>. الحل:</p>'+
      '<ul>'+
        '<li><strong>أداة Floss Threader:</strong> أداة بلاستيكية صغيرة كالإبرة — تمرّر الخيط من فوق السلك ثم تستخدمه بين الأسنان عادياً</li>'+
        '<li><strong>Superfloss:</strong> خيط طبي بطرف صلب يدخل تحت السلك مباشرة (الأسهل والأسرع)</li>'+
        '<li><strong>Water Flosser (مَحقن الماء):</strong> الأكثر فعالية — يُنظّف بقوة الماء بدون عناء</li>'+
        '<li>على الأقل <strong>مرة واحدة يومياً</strong>، وأفضل بعد الأكل</li>'+
      '</ul>'+
      '<h3>3. أطعمة يجب تجنّبها</h3>'+
      '<ul>'+
        '<li><strong>الأطعمة الصلبة جداً:</strong> الجوز، الفستق، الثلج — قد تكسر الإلصاق</li>'+
        '<li><strong>الأطعمة اللزجة:</strong> العلكة، التوفي، الكراميل — تشدّ السلك</li>'+
        '<li><strong>قضم الأطعمة الكبيرة بالأمام:</strong> التفاح، الجزر، الذرة — قطّعهم أولاً واستخدم الأضراس</li>'+
      '</ul>'+
      '<h3>4. كيف تكتشف إذا انكسر؟</h3>'+
      '<p>قد ينفصل السلك عن سن واحد دون أن تلاحظ. علامات:</p>'+
      '<ul>'+
        '<li>إحساس بشيء حادّ بلسانك</li>'+
        '<li>سن واحد تتحرك قليلاً (الأسنان الأخرى ما زالت ثابتة)</li>'+
        '<li>السلك يبدو منثنياً أو معوجّاً عند نظرك في المرآة</li>'+
        '<li>ألم خفيف عند المضغ</li>'+
      '</ul>'+
      '<p><strong>إذا حدث أيٌّ من هذا — موعد عاجل خلال ‎48 ساعة</strong>. الانتظار يعني عودة الأسنان للتزاحم.</p>'+
      '<h3>5. الفحص الذاتي الشهري</h3>'+
      '<ul>'+
        '<li>مرّر لسانك على السلك من جانب لآخر</li>'+
        '<li>تأكد أنه ملتصق على <strong>كل سن</strong> (عادة ‎4-6 أسنان)</li>'+
        '<li>افحص في المرآة بإضاءة جيدة</li>'+
      '</ul>'+
      '<h3>6. زيارات المتابعة</h3>'+
      '<ul>'+
        '<li>كل ‎6 أشهر زيارة فحص للمثبّت الثابت</li>'+
        '<li>تنظيف احترافي (سكيلنج) أكثر أهمية لك من غيرك بسبب تجمع الجير حول السلك</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>الأكثر شيوعاً:</strong> المثبّت الثابت يدوم ‎10-20 سنة بعناية جيدة. الأشخاص الذين يهملون تنظيفه يعانون من تكوّن الجير بسرعة، مما يؤدي إلى التهاب اللثة. استثمر في Water Flosser — أفضل ‎150,000 د.ع تنفقها.</div>'
  },
  {
    id: 'a11',
    icon: '🟡',
    color: '#ea580c',
    category: 'تقويم الأسنان',
    title: 'المطاطات التقويمية: السرّ الذي يُسرّع علاجك',
    summary: 'كيف تستخدم المطاطات بشكل صحيح ولماذا الالتزام بها يقصّر فترة التقويم',
    readTime: '4 دقائق',
    content: '<h2>المطاطات الصغيرة... النتائج الكبيرة</h2>'+
      '<p>المطاطات (Elastics) قطع مطاطية صغيرة تُربط بين الأسنان العلوية والسفلية لتصحيح <strong>علاقة الفكين</strong> — وهي المرحلة الأخيرة والأهم في علاج التقويم. الالتزام بها يحدد إذا كان علاجك سينتهي في ‎18 شهراً أم ‎36 شهراً.</p>'+
      '<h3>1. كم ساعة يومياً؟</h3>'+
      '<ul>'+
        '<li><strong>‎20-22 ساعة يومياً</strong> — تُنزع فقط أثناء الأكل وتنظيف الأسنان</li>'+
        '<li>تُغيَّر <strong>كل ‎12 ساعة</strong> (مرتين يومياً)</li>'+
        '<li>المطاطة تفقد قوتها بسرعة بعد ‎12 ساعة — لذا الجديدة دائماً أقوى</li>'+
        '<li>‎4 ساعات ارتداء يومياً = صفر تقدّم. لا تخدع نفسك.</li>'+
      '</ul>'+
      '<h3>2. كيف تركّبها؟</h3>'+
      '<ol>'+
        '<li>اغسل يديك جيداً</li>'+
        '<li>استخدم <strong>أداة المطاطات (Elastic placer)</strong> — قطعة بلاستيكية صغيرة تُبسّط العملية كثيراً</li>'+
        '<li>أمسك المطاطة بالأداة، علّقها أولاً على الخطّاف العلوي</li>'+
        '<li>اشدّها للأسفل وعلّقها على الخطّاف السفلي</li>'+
        '<li>إذا فشلت بالأداة — استخدم إصبع السبابة من كلتا اليدين</li>'+
      '</ol>'+
      '<h3>3. الإحساس الطبيعي</h3>'+
      '<ul>'+
        '<li><strong>أول ‎3-5 أيام:</strong> ألم في الفكين، صداع، صعوبة في فتح الفم → باراسيتامول حسب الحاجة</li>'+
        '<li><strong>بعد أسبوع:</strong> تتعوّد عليها تماماً، تنساها أحياناً</li>'+
        '<li>إذا كنت تشعر بألم بعد <strong>أسبوعين</strong> — أخبر الطبيب</li>'+
      '</ul>'+
      '<h3>4. تحذيرات الاستخدام</h3>'+
      '<ul>'+
        '<li><strong>لا تضع مطاطتين بدلاً من واحدة</strong> — لن تُسرّع العلاج، بل ستُتلف جذور الأسنان</li>'+
        '<li>إذا انفلتت إحدى المطاطتين — ضع جديدة فوراً، حتى لو كنت ستعود للنوم</li>'+
        '<li>لا تفتح فمك بشكل مفرط — قد تنفلت أو تنفلق</li>'+
        '<li>عند الضحك بقوة — حاول إغلاق فمك قليلاً للأمان</li>'+
      '</ul>'+
      '<h3>5. الأكل والشرب</h3>'+
      '<ul>'+
        '<li>اخلع المطاطات قبل الأكل (تتسخ بسهولة)</li>'+
        '<li>ضع مطاطات جديدة بعد كل وجبة وتنظيف</li>'+
        '<li>لا تأكل بها — قد تنفلت داخل الطعام وتبتلعها (غير ضارّة لكن مزعجة)</li>'+
      '</ul>'+
      '<h3>6. كم تأخذ معك؟</h3>'+
      '<ul>'+
        '<li>دائماً <strong>كيس صغير في جيبك</strong> فيه ‎10 مطاطات على الأقل</li>'+
        '<li>كيس آخر في حقيبة الظهر / السيارة / المكتب</li>'+
        '<li>الطبيب يعطيك كميات كافية لشهر — لا تنفد!</li>'+
        '<li>عند انتهاء الكمية — اتصل بالعيادة لاستلام جديدة</li>'+
      '</ul>'+
      '<h3>7. علامات التقدّم</h3>'+
      '<ul>'+
        '<li>بعد ‎4-6 أسابيع: العضّة تبدأ بالتحسن</li>'+
        '<li>بعد ‎3 أشهر: تغيّر واضح في علاقة الفكين</li>'+
        '<li>بعد ‎6 أشهر: الطبيب قد يقلّل القوة (مطاطة أخفّ)</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>الحقيقة:</strong> أكثر من ‎60% من تأخّر علاج التقويم سببه إهمال المطاطات. مرضاي الذين يلتزمون ينهون علاجهم في ‎18 شهراً، والذين يهملون قد يصلون إلى ‎36 شهراً. ‎18 شهراً من حياتك تستحق الالتزام.</div>'
  },
  {
    id: 'a12',
    icon: '🔄',
    color: '#ca8a04',
    category: 'تقويم الأسنان',
    title: 'تغيير الأسلاك التقويمية: ماذا تتوقع في كل مرحلة؟',
    summary: 'لماذا تتغيّر الأسلاك في كل زيارة، وكيف تتعامل مع الألم بعد كل تعديل',
    readTime: '3 دقائق',
    content: '<h2>الأسلاك تتغيّر... وأسنانك تتحرك</h2>'+
      '<p>كل ‎4-6 أسابيع يغيّر الطبيب السلك التقويمي. هذا ليس عشوائياً — هو خطة دقيقة لتحريك أسنانك تدريجياً من الأقل قوّة إلى الأكثر صرامة.</p>'+
      '<h3>1. لماذا تتغيّر الأسلاك؟</h3>'+
      '<ul>'+
        '<li>كل سلك له <strong>قوة وسماكة معيّنة</strong> — كلما تقدمت، السلك أقوى</li>'+
        '<li>الأسلاك الأولى مرنة (NiTi) — تُلوي مع شكل الفم</li>'+
        '<li>الأسلاك المتقدمة مستقيمة (Stainless Steel) — تُجبر الأسنان على الانتظام</li>'+
        '<li>السلك الأخير سميك ومستطيل — ينقل القوة بدقة</li>'+
      '</ul>'+
      '<h3>2. مراحل الأسلاك (بشكل عام)</h3>'+
      '<ol>'+
        '<li><strong>‎0.014 NiTi:</strong> السلك الأول، رفيع جداً ومرن — لتحريك الأسنان الفوضوية</li>'+
        '<li><strong>‎0.016 NiTi:</strong> أكثر قوة قليلاً — لانتظام أكثر</li>'+
        '<li><strong>‎0.018x0.025 NiTi:</strong> سلك مستطيل مرن</li>'+
        '<li><strong>‎0.019x0.025 SS:</strong> الأقوى، لإغلاق الفجوات وتنسيق العضّة</li>'+
        '<li>أسلاك خاصة (Closing loops، Power chains) لإغلاق فجوات معيّنة</li>'+
      '</ol>'+
      '<h3>3. الألم بعد كل تعديل</h3>'+
      '<ul>'+
        '<li><strong>أول ‎24 ساعة:</strong> ألم خفيف إلى متوسط — طبيعي تماماً</li>'+
        '<li><strong>اليوم ‎2-3:</strong> الذروة — صعوبة في المضغ، حساسية للبارد والساخن</li>'+
        '<li><strong>اليوم ‎4-7:</strong> تحسن تدريجي</li>'+
        '<li><strong>بعد أسبوع:</strong> الألم يختفي تماماً</li>'+
      '</ul>'+
      '<h3>4. كيف تتعامل مع الألم؟</h3>'+
      '<ul>'+
        '<li><strong>أطعمة طرية في أول ‎48 ساعة:</strong> شوربة، زبادي، بيض، بطاطا مهروسة، عجة</li>'+
        '<li><strong>تجنب الأطعمة الباردة جداً أو الحارة جداً</strong></li>'+
        '<li>باراسيتامول ‎500mg كل ‎6 ساعات حسب الحاجة (تجنّب الإيبوبروفين — قد يُبطئ حركة الأسنان)</li>'+
        '<li>المضمضة بالماء الدافئ والملح (نصف ملعقة في كوب)</li>'+
        '<li>كمادة باردة على الخدّ من الخارج لمدة ‎15 دقيقة</li>'+
      '</ul>'+
      '<h3>5. شمع التقويم — صديقك المفضل</h3>'+
      '<p>السلك الجديد قد يجرح الخدّ أو الشفة:</p>'+
      '<ul>'+
        '<li>اغسل يديك وجفّف المنطقة بمنديل</li>'+
        '<li>خذ قطعة بحجم حبة عدس من الشمع</li>'+
        '<li>أكوّرها بأصابعك ثم اضغطها على القوس المؤذي</li>'+
        '<li>تبقى ‎2-3 ساعات ثم تسقط — استبدلها</li>'+
      '</ul>'+
      '<h3>6. حالات الطوارئ</h3>'+
      '<ul>'+
        '<li><strong>سلك بارز يجرح الخدّ:</strong> اقصصه بمقلام أظافر معقّم بالكحول، ثم ضع شمعاً</li>'+
        '<li><strong>سلك خرج من القوس الخلفي:</strong> أعِده بقلم رصاص ممحاة، ثم اتصل بالعيادة</li>'+
        '<li><strong>قوس انفصل عن السن:</strong> احتفظ به في كيس واتصل بالعيادة خلال ‎24 ساعة</li>'+
        '<li><strong>كسر سلك:</strong> موعد عاجل في غضون ‎48 ساعة</li>'+
      '</ul>'+
      '<h3>7. علامة التقدّم</h3>'+
      '<p>بعد كل تعديل، الألم يكون <strong>أقل من المرة السابقة</strong>. هذه إشارة جيدة — أسنانك تتحرك أسرع كلما تقدّم العلاج. الزيارة الأخيرة عادة بدون ألم تقريباً.</p>'+
      '<div class="art-tip">💡 <strong>سرّ التحضير:</strong> قبل أي زيارة لتغيير سلك، تناول طعاماً مغذياً جيّداً. ستضطر لأكل طعام طري ‎2-3 أيام بعدها. التحضير يجعل التجربة أسهل.</div>'
  },
  {
    id: 'a13',
    icon: '🦷',
    color: '#dc2626',
    category: 'القلع',
    title: 'قبل قلع الأسنان: التحضير الكامل',
    summary: 'كل ما تحتاج معرفته قبل جلسة القلع — من الطعام إلى الأدوية',
    readTime: '4 دقائق',
    content: '<h2>متى يصبح القلع ضرورياً؟</h2>'+
      '<p>الطبيب لا يلجأ للقلع إلا بعد استنفاد الخيارات الأخرى. الأسباب الرئيسية:</p>'+
      '<ul>'+
        '<li><strong>تسوس عميق وصل العصب</strong> ولا يمكن إنقاذه بحشو العصب</li>'+
        '<li><strong>كسر السن تحت خط اللثة</strong> — لا توجد منطقة كافية للترميم</li>'+
        '<li><strong>أمراض اللثة المتقدمة</strong> التي أدت لفقدان العظم حول السن</li>'+
        '<li><strong>قبل التقويم</strong> — لخلق مساحة للأسنان المزدحمة</li>'+
        '<li><strong>ضرس العقل المنطمر</strong> أو المسبّب لمشاكل</li>'+
        '<li><strong>أسنان لبنية متأخّرة</strong> تمنع نزول الأسنان الدائمة</li>'+
      '</ul>'+
      '<h3>1. ‎24 ساعة قبل القلع</h3>'+
      '<ul>'+
        '<li><strong>أبلغ الطبيب بكل ما تتناوله من أدوية</strong> — خصوصاً مميّعات الدم (Aspirin, Plavix, Warfarin)</li>'+
        '<li>أبلغه بأي مرض مزمن: سكري، ضغط، قلب، أمراض الكلى، حمل</li>'+
        '<li>نَم جيداً ليلة القلع — التوتّر والتعب يزيدان النزيف</li>'+
        '<li>تجنّب الكحول والتدخين تماماً</li>'+
        '<li>إذا كان لديك التهاب نشط (تورّم، صديد) — قد يطلب الطبيب مضاداً حيوياً قبل القلع</li>'+
      '</ul>'+
      '<h3>2. صباح يوم القلع</h3>'+
      '<ul>'+
        '<li><strong>تناول وجبة مشبعة</strong> قبل الموعد بـ ‎2-3 ساعات (لن تستطيع الأكل بعدها لساعات)</li>'+
        '<li>اشرب الماء بكمية كافية</li>'+
        '<li>نظّف أسنانك جيداً — فم نظيف يقلّل خطر العدوى</li>'+
        '<li>ارتدِ ملابس مريحة — الأكمام القصيرة تسهّل قياس الضغط</li>'+
        '<li>إذا كان قلعاً جراحياً (ضرس العقل مثلاً) — اصطحب شخصاً معك للقيادة</li>'+
      '</ul>'+
      '<h3>3. ماذا يحدث أثناء القلع؟</h3>'+
      '<ol>'+
        '<li><strong>التخدير الموضعي:</strong> حقنة في اللثة — ستشعر بوخزة لثوانٍ، ثم خدر تام خلال ‎3-5 دقائق</li>'+
        '<li><strong>اختبار الخدر:</strong> الطبيب سيتأكد أن المنطقة مخدّرة قبل البدء</li>'+
        '<li><strong>تخلخل السن:</strong> الطبيب يستخدم أدوات لتفكيك ارتباط السن مع العظم — تشعر بضغط فقط، لا ألم</li>'+
        '<li><strong>الإخراج:</strong> القلع نفسه يستغرق غالباً أقل من ‎5 دقائق للأسنان البسيطة</li>'+
        '<li><strong>الشاش:</strong> الطبيب يضع شاشاً مضغوطاً على المكان لإيقاف النزيف</li>'+
      '</ol>'+
      '<h3>4. خرافات شائعة عن القلع</h3>'+
      '<ul>'+
        '<li><strong>"القلع يضعف النظر":</strong> خرافة كاملة — لا علاقة طبية</li>'+
        '<li><strong>"تحت الخنجرية لا يُقلع":</strong> غير دقيق — يُقلع بأمان مع تحضير مناسب</li>'+
        '<li><strong>"الحامل لا تستطيع القلع":</strong> الثلث الثاني من الحمل آمن للقلع الطارئ</li>'+
        '<li><strong>"البخور والأعشاب تغني عن القلع":</strong> لا تؤجّل علاجاً ضرورياً</li>'+
      '</ul>'+
      '<h3>5. أسئلة يجب أن تسألها للطبيب</h3>'+
      '<ul>'+
        '<li>هل القلع جراحي أم بسيط؟</li>'+
        '<li>كم سيستغرق الإجراء؟</li>'+
        '<li>هل أحتاج لغرز؟</li>'+
        '<li>متى يمكنني العودة للعمل؟</li>'+
        '<li>ما خيارات استبدال السن المقلوع؟ (زراعة، جسر، طقم متحرك)</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>قاعدة ذهبية:</strong> فكّر <strong>قبل القلع</strong> في كيفية تعويض السن. الفجوة في الفم تؤدي إلى انحراف الأسنان المجاورة وفقدان عظم الفك مع الوقت. ناقش مع طبيبك خيار الزراعة <strong>قبل القلع</strong> — أحياناً يمكن وضع الزرعة مباشرة.</div>'
  },
  {
    id: 'a14',
    icon: '🩸',
    color: '#b91c1c',
    category: 'القلع',
    title: 'بعد قلع الأسنان: ‎72 ساعة الذهبية',
    summary: 'دليل دقيق ساعة بساعة للعناية بفمك بعد القلع وتجنب المضاعفات',
    readTime: '5 دقائق',
    content: '<h2>الجلطة الدموية = صديقك الأهم</h2>'+
      '<p>بعد القلع، يتشكّل في مكان السن <strong>جلطة دموية</strong> تشبه الكرة الحمراء الداكنة. هذه الجلطة هي الأساس الذي ينمو فوقه العظم الجديد. <strong>حماية هذه الجلطة في الـ ‎72 ساعة الأولى</strong> هي أهم مهمة لك.</p>'+
      '<h3>أول ساعة بعد القلع</h3>'+
      '<ul>'+
        '<li><strong>اعضّ على الشاش بقوة معتدلة لـ ‎30-45 دقيقة</strong></li>'+
        '<li>لا تتكلم كثيراً — الحركة تطيل النزيف</li>'+
        '<li>اجلس منتصباً، لا تستلقي تماماً</li>'+
        '<li>إذا استمر النزيف بعد ‎45 دقيقة — استبدل الشاش وعضّ ‎30 دقيقة أخرى</li>'+
        '<li>اللعاب الممزوج بدم خفيف <strong>طبيعي ‎24 ساعة</strong> — ليس نزيفاً</li>'+
      '</ul>'+
      '<h3>أول ‎24 ساعة — الممنوعات المطلقة</h3>'+
      '<ul>'+
        '<li><strong>❌ لا تشطف فمك</strong> (يفكّك الجلطة)</li>'+
        '<li><strong>❌ لا تبصق بقوة</strong> (الضغط السلبي يسحب الجلطة)</li>'+
        '<li><strong>❌ لا تشرب من ماصّة (Straw)</strong> — أكثر سبب للسنخ الجاف</li>'+
        '<li><strong>❌ لا تدخّن</strong> — التدخين أسوأ شيء على الإطلاق (يزيد خطر السنخ الجاف ‎12 مرة)</li>'+
        '<li><strong>❌ لا تلمس المنطقة بلسانك أو إصبعك</strong></li>'+
        '<li><strong>❌ لا تأكل من جهة القلع</strong></li>'+
        '<li><strong>❌ لا تأكل أطعمة ساخنة جداً</strong> — تذيب الجلطة</li>'+
        '<li><strong>❌ لا تمارس رياضة عنيفة</strong></li>'+
      '</ul>'+
      '<h3>ماذا تأكل في أول ‎48 ساعة؟</h3>'+
      '<ul>'+
        '<li><strong>اليوم الأول:</strong> سوائل وأطعمة باردة فقط</li>'+
        '<ul>'+
          '<li>زبادي بارد، آيس كريم (يقلّل النزيف والتورّم)</li>'+
          '<li>عصير بارد (بدون ماصّة!)</li>'+
          '<li>حليب بارد، جيلي</li>'+
        '</ul>'+
        '<li><strong>اليوم الثاني:</strong> أطعمة طرية فاترة</li>'+
        '<ul>'+
          '<li>بطاطا مهروسة، بيض مسلوق طري</li>'+
          '<li>شوربة فاترة (ليست ساخنة!)</li>'+
          '<li>أرز ناعم، معكرونة طرية</li>'+
        '</ul>'+
        '<li><strong>اليوم الثالث وما بعد:</strong> عودة تدريجية للأكل العادي من الجهة الأخرى</li>'+
      '</ul>'+
      '<h3>التحكم في التورّم</h3>'+
      '<ul>'+
        '<li><strong>كمادة باردة على الخدّ من الخارج</strong> — ‎15 دقيقة كل ساعة في أول ‎24 ساعة</li>'+
        '<li>التورّم يصل ذروته في اليوم ‎2-3 ثم يتراجع</li>'+
        '<li>كدمة زرقاء على الخدّ ممكنة — تختفي خلال أسبوع</li>'+
        '<li>نَم برأس مرفوع (وسادتين) في الليالي الأولى</li>'+
      '</ul>'+
      '<h3>الأدوية</h3>'+
      '<ul>'+
        '<li><strong>المسكّن:</strong> باراسيتامول ‎500-1000mg كل ‎6 ساعات (الأفضل) أو إيبوبروفين ‎400mg</li>'+
        '<li><strong>المضاد الحيوي:</strong> فقط إذا وصفه الطبيب — أكمل الكورس كاملاً حتى لو شعرت بتحسّن</li>'+
        '<li><strong>غسول الكلورهكسيدين:</strong> يبدأ من اليوم الثاني فقط، مرتين يومياً</li>'+
      '</ul>'+
      '<h3>المضمضة بالماء والملح (اليوم الثاني فقط)</h3>'+
      '<ol>'+
        '<li>نصف ملعقة ملح في كوب ماء دافئ</li>'+
        '<li>مضمضة <strong>لطيفة جداً</strong> — لا تلوي الفم بقوة</li>'+
        '<li>دع الماء يخرج بنفسه، لا تبصقه بقوة</li>'+
        '<li>‎3-4 مرات يومياً، خصوصاً بعد الأكل</li>'+
      '</ol>'+
      '<h3>الغرز (إن وُجدت)</h3>'+
      '<ul>'+
        '<li><strong>الغرز الذائبة:</strong> تذوب من تلقاء نفسها خلال ‎7-14 يوماً</li>'+
        '<li><strong>الغرز العادية:</strong> تُزال في موعد بعد ‎7-10 أيام</li>'+
        '<li>إذا انفلتت الغرزة باكراً — اتصل بالعيادة، لا تقلق</li>'+
      '</ul>'+
      '<h3>متى تتصل بالعيادة فوراً؟</h3>'+
      '<ul>'+
        '<li>نزيف غزير لا يتوقف بعد ‎4 ساعات</li>'+
        '<li>ألم شديد بعد اليوم الثالث (قد يكون سنخاً جافاً)</li>'+
        '<li>حرارة ‎38.5°+ مع رعشة</li>'+
        '<li>تورّم يزيد بعد اليوم الثالث (طبيعياً يجب أن يقلّ)</li>'+
        '<li>صديد أو رائحة كريهة جداً من المكان</li>'+
        '<li>صعوبة بالبلع أو التنفّس (طارئ)</li>'+
        '<li>خَدر دائم في الشفة أو اللسان لا يزول بعد ‎24 ساعة</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>القاعدة الأهم:</strong> إذا كنت مدخّناً، توقف <strong>‎72 ساعة على الأقل</strong> بعد القلع. هذا ليس ترفاً — التدخين يقلّل الأكسجين الواصل للمنطقة بنسبة ‎50%، ويزيد خطر السنخ الجاف بشكل كارثي، ويبطّئ الشفاء أسبوعاً كاملاً.</div>'
  },
  {
    id: 'a15',
    icon: '⚠️',
    color: '#991b1b',
    category: 'القلع',
    title: 'السنخ الجاف: الكابوس الذي يمكن تجنّبه',
    summary: 'لماذا يحدث، علاماته، وكيف تتعرف عليه قبل أن يتفاقم',
    readTime: '3 دقائق',
    content: '<h2>السنخ الجاف — ما هو؟</h2>'+
      '<p>السنخ الجاف (Dry Socket / Alveolar Osteitis) من أكثر مضاعفات القلع إيلاماً. يحدث عندما <strong>تنفصل الجلطة الدموية مبكراً</strong> من مكان القلع، فيُكشف العظم والأعصاب للهواء واللعاب. الألم يكون <strong>شديداً جداً</strong> ويبدأ عادة بعد ‎3-5 أيام من القلع.</p>'+
      '<h3>كيف تعرف أنه سنخ جاف؟</h3>'+
      '<p>الفرق بين الألم الطبيعي والسنخ الجاف:</p>'+
      '<ul>'+
        '<li><strong>الألم الطبيعي بعد القلع:</strong> يقلّ تدريجياً يوماً بعد يوم</li>'+
        '<li><strong>السنخ الجاف:</strong> الألم <strong>يبدأ متأخراً</strong> ‎(3-5 أيام بعد القلع) ويكون <strong>أقوى من الأول</strong></li>'+
      '</ul>'+
      '<h3>الأعراض المميّزة</h3>'+
      '<ol>'+
        '<li><strong>ألم نابض شديد</strong> ينتشر إلى الأذن والصدغ والرقبة</li>'+
        '<li><strong>المسكّنات لا تنفع</strong> أو تخفّف بالكاد</li>'+
        '<li><strong>رائحة كريهة جداً</strong> من الفم لا تزول بالغسيل</li>'+
        '<li><strong>طعم مرّ كريه</strong> في الفم</li>'+
        '<li><strong>عند النظر في المرآة:</strong> مكان القلع <strong>فارغ</strong>، لا توجد جلطة حمراء، تظهر منطقة بيضاء (العظم العاري)</li>'+
        '<li>عقد ليمفاوية متضخّمة في الرقبة</li>'+
      '</ol>'+
      '<h3>لماذا يحدث؟ (عوامل الخطر)</h3>'+
      '<ul>'+
        '<li><strong>التدخين</strong> — السبب رقم 1 (يزيد الخطر ‎12 مرة)</li>'+
        '<li><strong>الشرب من ماصّة</strong> أو البصق بقوة</li>'+
        '<li><strong>المضمضة بقوة</strong> في أول ‎24 ساعة</li>'+
        '<li><strong>القلع الصعب أو الجراحي</strong> (ضرس العقل خصوصاً)</li>'+
        '<li><strong>سوء النظافة الفموية</strong> قبل القلع</li>'+
        '<li><strong>حبوب منع الحمل</strong> (الإستروجين العالي يقلّل التجلط) — يفضّل القلع في أيام معيّنة من الدورة</li>'+
        '<li><strong>التهاب نشط</strong> في المنطقة قبل القلع</li>'+
        '<li>سن سُبق له خمج (Cyst أو خراج)</li>'+
      '</ul>'+
      '<h3>كيف يُعالج؟</h3>'+
      '<p>السنخ الجاف <strong>لا يُعالج في المنزل</strong> — يجب زيارة الطبيب فوراً:</p>'+
      '<ol>'+
        '<li>الطبيب يغسل المنطقة جيداً ليُزيل بقايا الطعام والبكتيريا</li>'+
        '<li>يضع <strong>ضمادة طبية بمادة مهدّئة</strong> (Eugenol عادة) داخل التجويف</li>'+
        '<li>الألم يهدأ <strong>خلال ‎5-10 دقائق</strong> بعد وضع الضمادة (تحسّن ملحوظ)</li>'+
        '<li>تُغيَّر الضمادة كل ‎2-3 أيام</li>'+
        '<li>قد تحتاج ‎3-5 جلسات حتى الشفاء الكامل</li>'+
        '<li>مضاد حيوي إذا كان هناك عدوى</li>'+
      '</ol>'+
      '<p>الشفاء التام عادة <strong>‎7-14 يوماً</strong> بعد بدء العلاج.</p>'+
      '<h3>الوقاية الذهبية</h3>'+
      '<ol>'+
        '<li><strong>توقف عن التدخين</strong> ‎72 ساعة قبل و‎72 ساعة بعد القلع (المثالي: ‎7 أيام)</li>'+
        '<li><strong>لا ماصّات</strong> — اشرب من الكوب مباشرة</li>'+
        '<li><strong>لا مضمضة</strong> في أول ‎24 ساعة</li>'+
        '<li>إذا كنتِ على حبوب منع الحمل — أخبري الطبيب</li>'+
        '<li>اتبع تعليمات الطبيب <strong>حرفياً</strong> في أول ‎72 ساعة</li>'+
        '<li>تناول طعاماً غنياً بفيتامين C وزنك (يساعدان الالتئام)</li>'+
      '</ol>'+
      '<h3>السنخ الجاف وضرس العقل</h3>'+
      '<p>قلع ضرس العقل السفلي له خطر أعلى للسنخ الجاف (‎15-30%) مقارنة بالأسنان الأخرى (‎2-5%). إذا قلعت ضرس عقل، كن أكثر حرصاً.</p>'+
      '<div class="art-tip">💡 <strong>لا تتأخّر:</strong> إذا شعرت بألم شديد بعد اليوم الثالث من القلع، لا تنتظر. اتصل بالعيادة في نفس اليوم. العلاج المبكر يخفّف معاناتك أياماً.</div>'
  },
  {
    id: 'a16',
    icon: '🦷',
    color: '#7c2d12',
    category: 'القلع',
    title: 'قلع ضرس العقل: الحالة الخاصة',
    summary: 'متى يُقلع ضرس العقل، ومتى لا يُحتاج، وكيف تتعامل مع القلع الجراحي',
    readTime: '5 دقائق',
    content: '<h2>ضرس العقل — لماذا يُسبّب مشاكل؟</h2>'+
      '<p>أضراس العقل (Wisdom teeth / Third molars) آخر أسنان تظهر في الفم، عادة بين عمر <strong>‎17 و‎25 سنة</strong>. مشكلتها: الفك البشري تطوّر ليصبح أصغر، فلم يبقَ مكان كافٍ لها. النتيجة: انطمار، التهاب، وألم.</p>'+
      '<h3>متى يجب قلع ضرس العقل؟</h3>'+
      '<ul>'+
        '<li><strong>منطمر (Impacted)</strong> ولا يستطيع الخروج كاملاً</li>'+
        '<li><strong>التهابات متكررة</strong> في اللثة حوله (Pericoronitis)</li>'+
        '<li><strong>تسوس</strong> في الضرس أو الضرس المجاور (صعب التنظيف)</li>'+
        '<li><strong>ألم متكرر</strong> أو تورّم</li>'+
        '<li><strong>تكيّس (Cyst)</strong> حول جذر الضرس على الأشعة</li>'+
        '<li><strong>قبل التقويم</strong> — لمنع تحريك الأسنان الأخرى</li>'+
        '<li><strong>نمو منحرف</strong> يؤذي الضرس المجاور</li>'+
      '</ul>'+
      '<h3>متى لا يُحتاج للقلع؟</h3>'+
      '<ul>'+
        '<li>خرج كاملاً وبوضع سليم</li>'+
        '<li>تُنظَّف بسهولة وبدون تسوس</li>'+
        '<li>لا توجد التهابات متكررة</li>'+
        '<li>لا يضغط على الأسنان الأخرى</li>'+
        '<li>الأشعة لا تظهر تكيّسات</li>'+
      '</ul>'+
      '<p><strong>القاعدة:</strong> ضرس العقل السليم لا يُقلع وقائياً.</p>'+
      '<h3>أنواع الانطمار</h3>'+
      '<ol>'+
        '<li><strong>عمودي (Vertical):</strong> منتصب بشكل صحيح، الأسهل للقلع</li>'+
        '<li><strong>أفقي (Horizontal):</strong> مستلقٍ على جنبه، الأصعب — يحتاج جراحة</li>'+
        '<li><strong>منحرف للأمام (Mesial):</strong> الأكثر شيوعاً</li>'+
        '<li><strong>منحرف للخلف (Distal):</strong> أصعب من الأمامي</li>'+
      '</ol>'+
      '<h3>التحضير الخاص</h3>'+
      '<ul>'+
        '<li><strong>أشعة بانورامية</strong> ضرورية لمعرفة وضع الضرس</li>'+
        '<li><strong>أحياناً CBCT (مقطعية ثلاثية الأبعاد)</strong> — خصوصاً للضروس السفلية القريبة من العصب</li>'+
        '<li>يجب معرفة <strong>قُرب الضرس من العصب الفكّي السفلي</strong> (Inferior alveolar nerve)</li>'+
        '<li>الفحص قبل ‎2-3 أيام من الموعد</li>'+
      '</ul>'+
      '<h3>القلع الجراحي — ماذا يحدث؟</h3>'+
      '<ol>'+
        '<li><strong>التخدير:</strong> موضعي عادة — أحياناً تخدير عام للحالات الصعبة جداً</li>'+
        '<li><strong>شقّ اللثة:</strong> الطبيب يفتح اللثة للوصول للضرس</li>'+
        '<li><strong>إزالة قطعة من العظم</strong> فوق الضرس (إذا كان منطمراً)</li>'+
        '<li><strong>تقسيم الضرس:</strong> غالباً يُقسّم إلى ‎2-3 قطع لتسهيل الإخراج</li>'+
        '<li><strong>الإخراج:</strong> قطعة قطعة</li>'+
        '<li><strong>التنظيف والغسيل</strong> داخل التجويف</li>'+
        '<li><strong>الغرز:</strong> ‎2-4 غرز عادة (ذائبة أو عادية)</li>'+
        '<li><strong>الشاش</strong> للضغط</li>'+
      '</ol>'+
      '<p><strong>المدة الكلية:</strong> ‎20-60 دقيقة حسب الصعوبة.</p>'+
      '<h3>التعافي — أصعب من القلع العادي</h3>'+
      '<ul>'+
        '<li><strong>التورّم:</strong> أكبر بكثير، يصل ذروته اليوم ‎2-3</li>'+
        '<li><strong>الكدمات:</strong> ممكن أن تظهر على الخدّ — تختفي خلال أسبوعين</li>'+
        '<li><strong>صعوبة فتح الفم (Trismus):</strong> طبيعية، تتحسن خلال ‎5-7 أيام</li>'+
        '<li><strong>الألم:</strong> أعلى، قد يحتاج مسكّنات أقوى</li>'+
        '<li><strong>الإجازة:</strong> ‎2-3 أيام عمل/دراسة</li>'+
        '<li><strong>الشفاء الكامل:</strong> ‎2-4 أسابيع</li>'+
      '</ul>'+
      '<h3>متى تقلع كل أضراس العقل دفعة واحدة؟</h3>'+
      '<ul>'+
        '<li><strong>المزايا:</strong> فترة تعافي واحدة، تخدير عام واحد، تكلفة أقل</li>'+
        '<li><strong>العيوب:</strong> صعوبة الأكل (لا يوجد جانب سليم للمضغ)، تورّم في كلا الخدّين</li>'+
        '<li><strong>الأفضل عادة:</strong> الضروس الأربعة في جلسة واحدة بتخدير عام</li>'+
      '</ul>'+
      '<h3>المضاعفات النادرة لكن المهمة</h3>'+
      '<ul>'+
        '<li><strong>تنميل دائم في الشفة السفلية أو اللسان</strong> (إصابة العصب الفكّي السفلي) — نادر (‎1%)</li>'+
        '<li><strong>كسر الفك السفلي</strong> — نادر جداً</li>'+
        '<li><strong>اتصال مع الجيب الفكّي العلوي (Sinus communication)</strong> — للضروس العلوية</li>'+
        '<li><strong>السنخ الجاف</strong> — أكثر شيوعاً مع ضرس العقل (‎15-30%)</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>السن المثالي للقلع:</strong> ‎18-25 سنة. الجذور لم تكتمل بعد، العظم أكثر مرونة، والشفاء أسرع. كلما تأخّر القلع، كلما أصبح أصعب — لذا يفضّل قلعه باكراً إذا كان سيُقلع حتماً.</div>'
  },
  {
    id: 'a17',
    icon: '⚙️',
    color: '#854d0e',
    category: 'الزراعة',
    title: 'زراعة الأسنان من البداية للنهاية: المراحل الكاملة',
    summary: 'دليلك الشامل لرحلة الزراعة — من التقييم الأول حتى التاج النهائي',
    readTime: '6 دقائق',
    content: '<h2>الزراعة — ليست عملية واحدة</h2>'+
      '<p>الزراعة عملية متدرّجة على مدى <strong>‎4-9 أشهر</strong>. الفهم الكامل لكل مرحلة يساعدك على التحضير الصحيح وتقدير الصبر المطلوب.</p>'+
      '<h3>المرحلة 1: التقييم والتخطيط (‎1-2 أسبوع)</h3>'+
      '<p>قبل أي إجراء، الطبيب يحتاج معلومات كاملة:</p>'+
      '<ul>'+
        '<li><strong>الأشعة المقطعية CBCT</strong> — تظهر كثافة العظم، ارتفاعه، وقربه من الأعصاب والجيوب</li>'+
        '<li><strong>قياس عرض اللثة</strong> وكمية النسيج المتاح</li>'+
        '<li><strong>تحاليل الدم</strong> — خصوصاً للسكري وأمراض الدم</li>'+
        '<li><strong>تقييم الأسنان المجاورة</strong> — صحتها مهمة لنجاح الزراعة</li>'+
      '</ul>'+
      '<p><strong>عوامل قد تستبعدك:</strong></p>'+
      '<ul>'+
        '<li>سكري غير متحكّم به (HbA1c > 8)</li>'+
        '<li>تدخين شديد (يقلّل النجاح بنسبة ‎15-20%)</li>'+
        '<li>أمراض المناعة الذاتية الشديدة</li>'+
        '<li>علاج إشعاعي حديث في منطقة الفك</li>'+
        '<li>أدوية البيسفوسفونات الوريدية (Bisphosphonates)</li>'+
        '<li>عمر أقل من ‎18 سنة (الفك لم يكتمل نموه)</li>'+
      '</ul>'+
      '<h3>المرحلة 2: تحضير العظم (إن لزم) — ‎4-6 أشهر</h3>'+
      '<p>إذا كان عظم الفك غير كافٍ، يحتاج لـ <strong>تطعيم عظمي (Bone graft)</strong> قبل الزراعة:</p>'+
      '<ul>'+
        '<li><strong>تطعيم بسيط:</strong> ‎2-4 أشهر شفاء</li>'+
        '<li><strong>رفع جيب فكّي علوي (Sinus lift):</strong> ‎4-6 أشهر</li>'+
        '<li><strong>تطعيم كبير ثلاثي الأبعاد:</strong> ‎6-9 أشهر</li>'+
      '</ul>'+
      '<p>أحياناً يمكن وضع الزرعة <strong>في نفس الوقت</strong> مع التطعيم البسيط. الطبيب يقرّر حسب الحالة.</p>'+
      '<h3>المرحلة 3: جراحة وضع الزرعة (يوم واحد)</h3>'+
      '<ol>'+
        '<li><strong>التخدير:</strong> موضعي عادة، أحياناً مع تخدير وريدي خفيف</li>'+
        '<li><strong>شقّ اللثة</strong> فوق العظم</li>'+
        '<li><strong>حفر العظم</strong> بأقطار متدرّجة (تبدأ صغيرة وتكبر تدريجياً)</li>'+
        '<li><strong>وضع الزرعة</strong> (مسمار التيتانيوم) في العظم</li>'+
        '<li><strong>غطاء الشفاء (Healing cap):</strong> غطاء صغير يبرز من اللثة لتشكيل النسيج، أو خياطة كاملة (تبقى الزرعة تحت اللثة)</li>'+
        '<li><strong>الغرز</strong> — تُزال بعد ‎10-14 يوماً</li>'+
      '</ol>'+
      '<p><strong>المدة:</strong> ‎30-60 دقيقة لزرعة واحدة. التورّم والألم أقل بكثير من قلع ضرس العقل عادة.</p>'+
      '<h3>المرحلة 4: فترة الالتصاق العظمي (‎3-6 أشهر)</h3>'+
      '<p>هذه الفترة الأطول والأهم. خلالها يحدث <strong>الالتصاق العظمي (Osseointegration)</strong> — العظم ينمو ويلتصق مباشرة بسطح الزرعة.</p>'+
      '<ul>'+
        '<li><strong>الفك السفلي:</strong> ‎3 أشهر عادة (عظم أكثف)</li>'+
        '<li><strong>الفك العلوي:</strong> ‎4-6 أشهر (عظم أقل كثافة)</li>'+
        '<li><strong>بعد تطعيم عظمي:</strong> ‎6 أشهر</li>'+
      '</ul>'+
      '<p>خلال هذه الفترة:</p>'+
      '<ul>'+
        '<li>لا تأكل من جهة الزرعة في الأسبوعين الأولين</li>'+
        '<li>نظافة فموية ممتازة جداً</li>'+
        '<li>زيارة الطبيب كل ‎4-6 أسابيع للمتابعة</li>'+
        '<li>قد يضع الطبيب <strong>طقماً مؤقتاً</strong> لتعويض الجمالية إذا كانت الزرعة في المنطقة الأمامية</li>'+
        '<li>توقف عن التدخين تماماً — أهم عامل لنجاح الزراعة</li>'+
      '</ul>'+
      '<h3>المرحلة 5: تركيب الدعامة (Abutment) — ‎15 دقيقة</h3>'+
      '<p>بعد التأكد من الالتصاق التام:</p>'+
      '<ol>'+
        '<li>إذا كانت الزرعة مغطّاة بلثة — شقّ صغير لكشف رأس الزرعة</li>'+
        '<li>إزالة غطاء الشفاء</li>'+
        '<li>تركيب <strong>الدعامة (Abutment)</strong> — قطعة معدنية تمتد من الزرعة وتبرز من اللثة</li>'+
        '<li>انتظار ‎2-3 أسابيع لاكتمال شفاء اللثة حول الدعامة</li>'+
      '</ol>'+
      '<h3>المرحلة 6: التاج النهائي (‎2-3 جلسات)</h3>'+
      '<ol>'+
        '<li><strong>الجلسة الأولى:</strong> أخذ طبعة (مادة ناعمة أو مسح ثلاثي الأبعاد)</li>'+
        '<li><strong>المختبر:</strong> صناعة التاج — عادة ‎1-2 أسبوع</li>'+
        '<li><strong>الجلسة الثانية:</strong> تجربة التاج، التأكد من اللون والشكل والإطباق</li>'+
        '<li><strong>الجلسة الثالثة:</strong> تثبيت التاج النهائي (بمسمار أو لاصق طبي)</li>'+
      '</ol>'+
      '<h3>المتابعة مدى الحياة</h3>'+
      '<ul>'+
        '<li><strong>زيارة كل ‎6 أشهر</strong> للتنظيف الاحترافي</li>'+
        '<li><strong>تنظيف يومي</strong> بفرشاة ومعجون كأي سن، + خيط طبي خاص للزرعات (Superfloss)</li>'+
        '<li><strong>أشعة سنوية</strong> للتأكد من سلامة العظم حول الزرعة</li>'+
        '<li><strong>الزراعة الناجحة تدوم ‎25+ سنة</strong> مع العناية المناسبة</li>'+
      '</ul>'+
      '<h3>نسبة النجاح والمضاعفات</h3>'+
      '<ul>'+
        '<li><strong>نسبة نجاح الزراعة:</strong> ‎95-98% للحالات المثالية</li>'+
        '<li><strong>التهاب حول الزرعة (Peri-implantitis):</strong> أهم مضاعفة طويلة الأمد — يؤدي لفقدان الزرعة إن لم يُعالج</li>'+
        '<li><strong>كسر التاج:</strong> نادر، يمكن إصلاحه</li>'+
        '<li><strong>ارتخاء المسمار:</strong> يُشدّ في زيارة بسيطة</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>الحقيقة الاقتصادية:</strong> الزراعة استثمار طويل الأمد. التكلفة الأولية أعلى من البدائل (جسر/طقم متحرك)، لكن إذا قسمتها على ‎25 سنة من العمر، تصبح الأرخص. والأهم: لا تحتاج لبرد الأسنان المجاورة كما في الجسر.</div>'
  },
  {
    id: 'a18',
    icon: '✨',
    color: '#0284c7',
    category: 'التبييض',
    title: 'تبييض الأسنان: الحقائق والخرافات',
    summary: 'كل أنواع التبييض، الفروقات بينها، ومن يصلح له',
    readTime: '5 دقائق',
    content: '<h2>لماذا تتغيّر ألوان الأسنان؟</h2>'+
      '<p>اللون الطبيعي للأسنان ليس "أبيض ناصع" — بل أبيض مائل قليلاً للصفرة (لون العاج تحت طبقة المينا). تتغيّر الألوان بسبب:</p>'+
      '<ul>'+
        '<li><strong>اصفرار طبيعي مع العمر</strong> (المينا تترقّق وتظهر العاج تحتها)</li>'+
        '<li><strong>الشاي والقهوة والكولا</strong> — أكثر مسبّبات التصبّغ</li>'+
        '<li><strong>التدخين</strong> — تصبغ بنّي يستحيل إزالته بالفرشاة</li>'+
        '<li><strong>التتراسيكلين في الطفولة</strong> — تصبّغ داخلي صعب التبييض</li>'+
        '<li><strong>الفلوريد الزائد</strong> — بقع بيضاء أو بنّية</li>'+
        '<li><strong>إصابات سابقة</strong> — قد تموت العصب فيتحوّل السن للرمادي</li>'+
        '<li><strong>حشوات معدنية قديمة</strong> — تجعل السن مزرقّاً</li>'+
      '</ul>'+
      '<h3>أنواع التبييض</h3>'+
      '<h4>1. التبييض في العيادة (Office Bleaching)</h4>'+
      '<ul>'+
        '<li>تركيز عالٍ من بيروكسيد الهيدروجين (‎25-40%)</li>'+
        '<li>جلسة واحدة: ‎60-90 دقيقة</li>'+
        '<li>قد تُستخدم أشعة LED أو ليزر لتسريع التفاعل</li>'+
        '<li>النتيجة: تفتيح ‎4-8 درجات في جلسة واحدة</li>'+
        '<li>الطبيب يحمي اللثة بحاجز خاص قبل وضع المادة</li>'+
        '<li>التكلفة الأعلى لكن النتيجة الأسرع</li>'+
      '</ul>'+
      '<h4>2. التبييض المنزلي بقوالب (Home Bleaching)</h4>'+
      '<ul>'+
        '<li>قوالب مخصّصة لأسنانك + جل بتركيز ‎10-22%</li>'+
        '<li>الاستخدام: ‎2-4 ساعات يومياً أو ليلاً، لمدة ‎2-3 أسابيع</li>'+
        '<li>نتائج تدريجية لكنها أكثر استقراراً</li>'+
        '<li>تكلفة متوسطة</li>'+
        '<li>الأنسب للمرضى المنضبطين</li>'+
      '</ul>'+
      '<h4>3. التبييض المختلط (الأفضل عادة)</h4>'+
      '<ul>'+
        '<li>جلسة في العيادة + متابعة منزلية لأسبوعين</li>'+
        '<li>أفضل النتائج وأكثرها استقراراً</li>'+
        '<li>الأنسب للحالات الصعبة (أسنان داكنة جداً، تتراسيكلين)</li>'+
      '</ul>'+
      '<h4>4. تبييض السن الميت (Internal Bleaching)</h4>'+
      '<ul>'+
        '<li>للأسنان التي تغيّر لونها بعد علاج العصب</li>'+
        '<li>يوضع الجل <strong>داخل</strong> السن من فتحة صغيرة</li>'+
        '<li>يُغلق بحشوة مؤقتة لـ ‎3-5 أيام</li>'+
        '<li>عدة جلسات حتى الوصول للون المطلوب</li>'+
      '</ul>'+
      '<h4>5. منتجات الصيدلية والسوبر ماركت</h4>'+
      '<ul>'+
        '<li>شرائط التبييض (Whitestrips) — تأثير ضعيف، مفيدة للصيانة فقط</li>'+
        '<li>معاجين التبييض — تنظف فقط ولا تبيّض حقاً</li>'+
        '<li>غسولات التبييض — تأثير محدود جداً</li>'+
      '</ul>'+
      '<h3>الخرافات الشائعة</h3>'+
      '<ul>'+
        '<li><strong>"الليمون والبيكربونات يبيّضان":</strong> يُتلفان المينا — كارثي على المدى الطويل</li>'+
        '<li><strong>"كلما زاد التركيز، أفضل":</strong> يزيد الحساسية فقط ولا يحسّن النتيجة</li>'+
        '<li><strong>"الفحم المنشّط طبيعي وآمن":</strong> الجزيئات الخشنة تخدش المينا</li>'+
        '<li><strong>"التبييض يُتلف الأسنان":</strong> الإجراء الطبي الصحيح آمن تماماً</li>'+
        '<li><strong>"النتيجة دائمة":</strong> تحتاج صيانة كل ‎6-12 شهر</li>'+
        '<li><strong>"الأسنان كلها ستصبح بنفس اللون":</strong> الحشوات والتيجان لن تتأثر</li>'+
      '</ul>'+
      '<h3>من لا يصلح للتبييض؟</h3>'+
      '<ul>'+
        '<li>الحوامل والمرضعات (تأجيل احترازي)</li>'+
        '<li>الأطفال أقل من ‎16 سنة (المينا لم تنضج بعد)</li>'+
        '<li>حساسية شديدة في الأسنان</li>'+
        '<li>التهاب لثة نشط</li>'+
        '<li>تسوس غير معالج</li>'+
        '<li>أسنان ذات حشوات أمامية كبيرة (ستظهر بلون مختلف)</li>'+
        '<li>توقّعات غير واقعية (لا يمكن جعل أسنانك ناصعة كالطباشير)</li>'+
      '</ul>'+
      '<h3>الأعراض الجانبية المحتملة</h3>'+
      '<ul>'+
        '<li><strong>حساسية للبارد والساخن:</strong> شائعة (‎30-60% من الحالات)، مؤقتة وتزول خلال أيام</li>'+
        '<li><strong>التهاب لثة خفيف:</strong> إذا تسرّبت المادة لللثة</li>'+
        '<li><strong>نتائج غير متساوية:</strong> الأنياب عادة أصفر من الثنايا — لن تتساوى تماماً</li>'+
      '</ul>'+
      '<h3>قبل التبييض — تحضير ضروري</h3>'+
      '<ol>'+
        '<li><strong>تنظيف احترافي (Scaling):</strong> أحياناً يكون كافياً وحده! كثير من المرضى ينبهرون من النتيجة</li>'+
        '<li><strong>معالجة أي تسوس</strong> أولاً</li>'+
        '<li><strong>التأكد من سلامة اللثة</strong></li>'+
        '<li><strong>معجون أسنان للحساسية</strong> (مثل Sensodyne) لمدة ‎2 أسبوع قبل البدء</li>'+
        '<li><strong>توقّعات واقعية:</strong> صورة قبل/بعد للحالات المماثلة</li>'+
      '</ol>'+
      '<h3>بعد التبييض — قاعدة الـ ‎48 ساعة</h3>'+
      '<p>المسامات في المينا تكون مفتوحة، فالتلوّث يتسلّل بسهولة. تجنّب لمدة ‎48 ساعة:</p>'+
      '<ul>'+
        '<li>الشاي، القهوة، النسكافيه</li>'+
        '<li>الكولا، العصائر الملوّنة</li>'+
        '<li>النبيذ الأحمر</li>'+
        '<li>الكاري والصلصات الملوّنة</li>'+
        '<li>التوت، الكرز، البنجر</li>'+
        '<li>التدخين كلياً (يلوّن فوراً)</li>'+
        '<li>أحمر الشفاه — يصبغ الأسنان</li>'+
      '</ul>'+
      '<h3>الحفاظ على النتائج</h3>'+
      '<ul>'+
        '<li>اشرب القهوة والشاي بماصّة (تتجنّب الأمام)</li>'+
        '<li>اشطف فمك بالماء بعد كل قهوة/شاي</li>'+
        '<li>تنظيف احترافي كل ‎6 أشهر</li>'+
        '<li>جلسة "صيانة" في البيت كل ‎6-12 شهر (ساعة في القوالب)</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>قبل أن تتفاجأ:</strong> التبييض <strong>لا يبيّض</strong> الحشوات والتيجان والقشور الخزفية. إذا كان لديك حشوات أمامية، خطّط بشكل صحيح: <strong>بيّض أولاً</strong>، انتظر ‎2 أسبوع لاستقرار اللون، ثم استبدل الحشوات بلون مطابق للجديد.</div>'
  },
  {
    id: 'a19',
    icon: '😁',
    color: '#be185d',
    category: 'التجميل',
    title: 'ابتسامة هوليوود والفينير: قبل أن تقرّر',
    summary: 'الفرق بين الفينير واللومينير، متى تختاره، ومتى لا',
    readTime: '5 دقائق',
    content: '<h2>"ابتسامة هوليوود" — اسم تسويقي</h2>'+
      '<p>المصطلح ليس طبياً — هو مفهوم جمالي ظهر مع نجوم هوليوود في الأربعينات. تقنياً، تعني تحسين شكل ولون الأسنان الأمامية بشكل جذري، عادة باستخدام <strong>القشور التجميلية (Veneers)</strong>.</p>'+
      '<h3>أنواع القشور التجميلية</h3>'+
      '<h4>1. الفينير الخزفي (Porcelain Veneers)</h4>'+
      '<ul>'+
        '<li><strong>المادة:</strong> خزف عالي الجودة بسماكة ‎0.5-0.7 ملم</li>'+
        '<li><strong>التحضير:</strong> يحتاج برد ‎0.3-0.5 ملم من السن (لا رجعة)</li>'+
        '<li><strong>المدّة:</strong> ‎2-3 جلسات خلال أسبوعين</li>'+
        '<li><strong>الحياة:</strong> ‎10-15 سنة بعناية جيدة</li>'+
        '<li><strong>المظهر:</strong> طبيعي جداً، يحاكي شفافية المينا الحقيقية</li>'+
        '<li><strong>المتانة:</strong> أكثر مقاومة للتلوّن من الكومبوزيت</li>'+
      '</ul>'+
      '<h4>2. اللومينير (Lumineers / No-prep veneers)</h4>'+
      '<ul>'+
        '<li><strong>المادة:</strong> خزف رقيق جداً (‎0.2-0.3 ملم)</li>'+
        '<li><strong>التحضير:</strong> لا يحتاج برد للسن (أو قليل جداً)</li>'+
        '<li><strong>المزايا:</strong> قابل للإزالة، السن الأصلي محفوظ</li>'+
        '<li><strong>العيوب:</strong> النتائج الجمالية أقل قوة من الفينير، لا يصلح لتغطية بقع داكنة جداً</li>'+
        '<li><strong>التكلفة:</strong> أعلى من الفينير عادة</li>'+
      '</ul>'+
      '<h4>3. الفينير المركّب (Composite Veneers)</h4>'+
      '<ul>'+
        '<li><strong>المادة:</strong> الكومبوزيت (نفس مادة الحشوات الأمامية)</li>'+
        '<li><strong>التحضير:</strong> يُصنع في الفم مباشرة في جلسة واحدة</li>'+
        '<li><strong>المدّة:</strong> ‎2-3 ساعات لكل جلسة</li>'+
        '<li><strong>الحياة:</strong> ‎5-7 سنوات</li>'+
        '<li><strong>المزايا:</strong> تكلفة أقل بـ ‎50-70% من الخزفي، قابل للإصلاح</li>'+
        '<li><strong>العيوب:</strong> يتلوّن مع الوقت، أقل لمعاناً، يحتاج تلميعاً منتظماً</li>'+
      '</ul>'+
      '<h4>4. التيجان الخزفية الكاملة (Full Crowns)</h4>'+
      '<ul>'+
        '<li>تغطّي السن من جميع الجهات</li>'+
        '<li>تحتاج برد كبير من السن (‎1.5-2 ملم)</li>'+
        '<li>للأسنان الضعيفة جداً أو ذات الترميمات الكبيرة</li>'+
        '<li>أمتن من الفينير لكن تحتاج تحضيراً جذرياً للسن</li>'+
      '</ul>'+
      '<h3>متى تختار الفينير؟</h3>'+
      '<ul>'+
        '<li>بقع داكنة <strong>لا تستجيب للتبييض</strong> (تتراسيكلين، فلورُسس)</li>'+
        '<li>كسر صغير في الزاوية</li>'+
        '<li>فجوات بين الأسنان (Diastema) — حل سريع للفجوات الصغيرة</li>'+
        '<li>أسنان قصيرة جداً (تآكل من صرّ الأسنان)</li>'+
        '<li>شكل غير منتظم لسن أو سنين</li>'+
        '<li>سن مائل قليلاً (للحالات البسيطة فقط)</li>'+
      '</ul>'+
      '<h3>متى لا تختار الفينير؟</h3>'+
      '<ul>'+
        '<li><strong>تسوس عميق</strong> — يُعالج أولاً</li>'+
        '<li><strong>التهاب لثة نشط</strong></li>'+
        '<li><strong>صرّ الأسنان (Bruxism)</strong> — يكسر الفينير، يحتاج جهاز ليلي إجباري</li>'+
        '<li><strong>اعوجاج شديد</strong> — التقويم أولاً ثم الفينير عند الحاجة</li>'+
        '<li><strong>مينا ضعيفة جداً</strong> — التصاق ضعيف</li>'+
        '<li><strong>توقّعات غير واقعية</strong> — الفينير لا يبدو كأسنان طبيعية ناصعة البياض</li>'+
        '<li><strong>أسنان لبنية</strong> — انتظر الأسنان الدائمة</li>'+
      '</ul>'+
      '<h3>المراحل الكاملة</h3>'+
      '<h4>الجلسة 1: التخطيط الجمالي</h4>'+
      '<ul>'+
        '<li>تحليل الابتسامة والوجه</li>'+
        '<li>تصوير ‎2D و‎3D</li>'+
        '<li>اختيار الشكل واللون والحجم</li>'+
        '<li><strong>Digital Smile Design (DSD)</strong> — معاينة شكل الابتسامة على الكمبيوتر</li>'+
        '<li><strong>Mock-up:</strong> وضع نموذج بلاستيكي على أسنانك لمعاينة النتيجة قبل البرد!</li>'+
      '</ul>'+
      '<h4>الجلسة 2: البرد والطبعة</h4>'+
      '<ul>'+
        '<li>تخدير موضعي</li>'+
        '<li>برد الأسنان حسب التخطيط</li>'+
        '<li>أخذ طبعة دقيقة (مادة ناعمة أو مسح ‎3D)</li>'+
        '<li>تركيب فينير مؤقت بلاستيكي</li>'+
        '<li>اختيار اللون النهائي مع المريض</li>'+
      '</ul>'+
      '<h4>الجلسة 3: التركيب النهائي (بعد ‎1-2 أسبوع)</h4>'+
      '<ul>'+
        '<li>إزالة المؤقت</li>'+
        '<li>تجربة الفينير الخزفي للتأكد من الشكل واللون والإطباق</li>'+
        '<li>تنظيف السطح وتحضيره للّصق</li>'+
        '<li>اللصق الدائم بمادة طبية</li>'+
        '<li>إزالة الزوائد والتلميع</li>'+
      '</ul>'+
      '<h3>العناية بالفينير — لتدوم سنوات</h3>'+
      '<ul>'+
        '<li><strong>لا تقضم بالأسنان الأمامية:</strong> تفّاحات كاملة، جزر، ثلج، عظام دجاج</li>'+
        '<li><strong>لا تستخدم أسنانك "كأداة":</strong> فتح الزجاجات، قطع الخيوط، فتح الأكياس</li>'+
        '<li><strong>الفرشاة الناعمة:</strong> الخشنة قد تُتلف اللاصق عند خط اللثة</li>'+
        '<li><strong>الخيط الطبي:</strong> يومياً، بحذر شديد عند خط اللثة</li>'+
        '<li><strong>تجنّب التبييض:</strong> الفينير لن يتغيّر لونه</li>'+
        '<li><strong>إذا كنت تصرّ ليلاً:</strong> جهاز ليلي إجباري</li>'+
        '<li><strong>زيارات كل ‎6 أشهر</strong> للفحص والتنظيف</li>'+
      '</ul>'+
      '<h3>المشاكل المحتملة</h3>'+
      '<ul>'+
        '<li><strong>سقوط الفينير:</strong> نادر — يُعاد لصقه مباشرة (احتفظ بالقطعة!)</li>'+
        '<li><strong>كسر الفينير:</strong> يحتاج تبديلاً كاملاً</li>'+
        '<li><strong>حساسية مؤقتة:</strong> أسبوع إلى شهر</li>'+
        '<li><strong>تغيّر لون اللاصق:</strong> عند خط اللثة بعد سنوات</li>'+
        '<li><strong>التهاب لثة:</strong> إن كان حدّ الفينير غير مصقول جيداً</li>'+
      '</ul>'+
      '<h3>ابتسامة هوليوود — كم سن تحتاج؟</h3>'+
      '<ul>'+
        '<li><strong>‎4 أسنان:</strong> الثنيتان الأماميتان فقط (أبسط حل)</li>'+
        '<li><strong>‎6 أسنان:</strong> الأكثر شيوعاً (تظهر في الابتسامة العادية)</li>'+
        '<li><strong>‎8 أسنان:</strong> ابتسامة عريضة</li>'+
        '<li><strong>‎10-12 سن:</strong> "ابتسامة هوليوود الكاملة" — تظهر في الضحك العريض</li>'+
      '</ul>'+
      '<h3>التحذيرات الصريحة</h3>'+
      '<ul>'+
        '<li><strong>لا رجعة:</strong> البرد للأسنان لا يمكن التراجع عنه أبداً</li>'+
        '<li><strong>صيانة مدى الحياة:</strong> كل ‎10-15 سنة تحتاج تبديلاً (تكلفة متكررة)</li>'+
        '<li><strong>ليس بديلاً عن التقويم:</strong> الأسنان المعوجّة جداً تحتاج تقويماً أولاً</li>'+
        '<li><strong>اختر طبيباً متخصصاً</strong> — هذا ليس مجال للتجريب</li>'+
        '<li><strong>اطلب صور قبل/بعد</strong> لحالات مشابهة</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>قبل أن تقرّر:</strong> جرّب التبييض الاحترافي أولاً + تنظيف عميق. كثير من المرضى يحصلون على نتائج تكفيهم بثلث التكلفة. إذا لم تكن النتيجة كافية، حينها فكّر بالفينير. كذلك، اطلب من الطبيب صنع <strong>Mock-up مؤقت</strong> لمعاينة الشكل النهائي قبل البرد — هذه خطوة لا يفعلها كثير من الأطباء لكنها ستحميك من ندم.</div>'
  },
  {
    id: 'a20',
    icon: '🩹',
    color: '#a16207',
    category: 'علاج العصب',
    title: 'علاج العصب: لماذا، متى، وكيف',
    summary: 'دليلك الكامل لفهم علاج الجذور وما يجب توقّعه',
    readTime: '5 دقائق',
    content: '<h2>متى يحتاج السن لعلاج عصب؟</h2>'+
      '<p>داخل كل سن قناة (أو عدة قنوات) تحوي <strong>اللب السنّي (Pulp)</strong> — نسيج رخو فيه أعصاب وأوعية دموية. عندما يلتهب اللب أو يموت، يصبح علاج العصب (Root Canal Treatment / RCT) ضرورياً لإنقاذ السن.</p>'+
      '<h3>أسباب احتياج العصب للعلاج</h3>'+
      '<ul>'+
        '<li><strong>تسوس عميق</strong> وصل اللب — السبب الأشيع</li>'+
        '<li><strong>كسر السن</strong> وانكشاف اللب</li>'+
        '<li><strong>صدمة قوية</strong> على السن (حادث، رياضة) قد تقتل العصب حتى بدون كسر</li>'+
        '<li><strong>حشوات متكرّرة على نفس السن</strong> أنهكت اللب</li>'+
        '<li><strong>تشقّقات دقيقة</strong> غير مرئية</li>'+
        '<li><strong>أمراض اللثة المتقدمة</strong> وصلت لجذر السن</li>'+
        '<li><strong>تآكل شديد</strong> من صرّ الأسنان</li>'+
      '</ul>'+
      '<h3>علامات الحاجة لعلاج عصب</h3>'+
      '<ul>'+
        '<li><strong>ألم شديد ينبض ليلاً</strong> ويوقظك من النوم</li>'+
        '<li><strong>حساسية شديدة للبارد والساخن</strong> تستمر <strong>أكثر من ‎30 ثانية</strong> بعد إزالة المنبّه</li>'+
        '<li><strong>ألم عند الضغط على السن</strong> أو المضغ عليه</li>'+
        '<li><strong>تورّم في اللثة</strong> حول السن</li>'+
        '<li><strong>بثرة (Fistula) على اللثة</strong> فوق جذر السن — تخرج منها صديد أحياناً</li>'+
        '<li><strong>تغيّر لون السن</strong> إلى الرمادي أو البنّي (السن مات)</li>'+
        '<li><strong>سن متخلخل</strong> بسبب التهاب حول الجذر</li>'+
        '<li><strong>طعم سيء</strong> أو رائحة كريهة من المنطقة</li>'+
      '</ul>'+
      '<p>أحياناً <strong>لا توجد أعراض</strong> ويُكتشف الالتهاب صدفة في الأشعة — هذا أيضاً يحتاج علاج عصب.</p>'+
      '<h3>الفحص قبل العلاج</h3>'+
      '<ul>'+
        '<li><strong>أشعة محيطية (Periapical X-ray):</strong> تظهر الجذور والعظم المحيط</li>'+
        '<li><strong>أحياناً CBCT (مقطعية):</strong> للحالات المعقدة وتشخيص الكسور والقنوات الإضافية</li>'+
        '<li><strong>اختبار حيوية اللب:</strong> بقطعة قطن باردة أو جهاز كهربائي لتحديد إن كان العصب حياً أم ميتاً</li>'+
        '<li><strong>اختبار الإيلام عند الضغط</strong> لمعرفة شدة الالتهاب</li>'+
      '</ul>'+
      '<h3>مراحل علاج العصب</h3>'+
      '<h4>الجلسة 1: التنظيف والتطهير (‎60-90 دقيقة)</h4>'+
      '<ol>'+
        '<li><strong>التخدير الموضعي</strong> — هام جداً للراحة</li>'+
        '<li><strong>عزل السن بحاجز مطّاطي (Rubber Dam):</strong> يبقي السن نظيفاً وجافاً</li>'+
        '<li><strong>إزالة التسوس والحشوة القديمة</strong></li>'+
        '<li><strong>فتح حجرة العصب</strong> من سطح السن العلوي</li>'+
        '<li><strong>إخراج اللب الملتهب أو الميت</strong></li>'+
        '<li><strong>قياس طول كل قناة</strong> بجهاز خاص (Apex locator) أو بأشعة</li>'+
        '<li><strong>توسيع وتنظيف القنوات</strong> بإبر دقيقة (يدوية أو دوّارة)</li>'+
        '<li><strong>الغسيل بمحاليل مطهّرة</strong> (هيبوكلوريت الصوديوم) لقتل البكتيريا</li>'+
        '<li><strong>تجفيف القنوات</strong> بفتائل ورقية</li>'+
        '<li><strong>وضع دواء داخل القنوات</strong> (هيدروكسيد الكالسيوم)</li>'+
        '<li><strong>حشوة مؤقتة</strong> فوق السن</li>'+
      '</ol>'+
      '<h4>الجلسة 2 (بعد ‎1-2 أسبوع): الحشو النهائي للقنوات</h4>'+
      '<ol>'+
        '<li>التخدير الموضعي مرة أخرى</li>'+
        '<li>إزالة الحشوة المؤقتة</li>'+
        '<li>التأكد من نظافة وجفاف القنوات</li>'+
        '<li><strong>حشو القنوات بمادة Gutta-percha</strong> + معجون لاصق (Sealer)</li>'+
        '<li>أشعة للتأكد من الحشو الكامل حتى نهاية الجذر</li>'+
        '<li>حشوة دائمة فوق السن (أو حشوة قوية مؤقتة استعداداً للتاج)</li>'+
      '</ol>'+
      '<h3>متى تحتاج جلسات أكثر؟</h3>'+
      '<ul>'+
        '<li><strong>التهاب شديد جداً أو خرّاج كبير</strong> — قد تحتاج ‎3-4 جلسات</li>'+
        '<li><strong>قنوات معقّدة أو ملتوية</strong></li>'+
        '<li><strong>سن سبق له علاج عصب فاشل</strong> (إعادة علاج العصب — Re-RCT)</li>'+
        '<li><strong>كسور جذرية</strong> تحتاج تقييم متعدّد</li>'+
      '</ul>'+
      '<h3>هل علاج العصب مؤلم؟</h3>'+
      '<p><strong>الحقيقة:</strong> مع التخدير الحديث، علاج العصب <strong>أقل ألماً من حشوة عميقة</strong>. الألم الذي يخشاه الناس هو من السن المريض نفسه قبل العلاج، وليس من العلاج.</p>'+
      '<ul>'+
        '<li><strong>أثناء العلاج:</strong> صفر ألم بفضل التخدير</li>'+
        '<li><strong>بعد العلاج (‎2-3 أيام):</strong> ألم خفيف عند الضغط — طبيعي تماماً، يُسكَّن بالباراسيتامول</li>'+
        '<li><strong>بعد ‎5-7 أيام:</strong> الألم يجب أن يختفي تماماً</li>'+
        '<li><strong>ألم شديد متواصل بعد أسبوع:</strong> راجع الطبيب — قد تحتاج جلسة إضافية</li>'+
      '</ul>'+
      '<h3>التاج بعد علاج العصب — ضروري وليس اختيارياً!</h3>'+
      '<p>هذا أكثر سؤال يُهمَل: <strong>"هل أحتاج تاجاً بعد علاج العصب؟"</strong></p>'+
      '<p><strong>الإجابة:</strong> نعم تقريباً دائماً للأسنان الخلفية، لأن:</p>'+
      '<ul>'+
        '<li>السن بعد علاج العصب يصبح <strong>هشّاً وأكثر عرضة للكسر</strong></li>'+
        '<li>‎50% احتمال كسر السن خلال ‎5 سنوات بدون تاج</li>'+
        '<li>كسر السن قد يصل تحت اللثة → قلع لا مفرّ منه</li>'+
        '<li>يُوضع التاج عادة بعد ‎2-4 أسابيع من إكمال علاج العصب</li>'+
        '<li>للأسنان الأمامية، أحياناً تكفي حشوة كومبوزيت كبيرة</li>'+
      '</ul>'+
      '<h3>نسبة النجاح</h3>'+
      '<ul>'+
        '<li><strong>‎90-95%</strong> للحالات البسيطة</li>'+
        '<li><strong>‎70-80%</strong> للحالات المعقّدة (إعادة علاج، خرّاج كبير)</li>'+
        '<li>السن المُعالج بنجاح يدوم <strong>‎10-20+ سنة</strong></li>'+
      '</ul>'+
      '<h3>متى تحتاج لإعادة علاج العصب (Re-RCT)؟</h3>'+
      '<ul>'+
        '<li>ألم متكرر في سن سبق علاجه</li>'+
        '<li>أشعة تظهر التهاباً جديداً حول الجذر</li>'+
        '<li>خرّاج جديد</li>'+
        '<li>كسر التاج وتسرّب البكتيريا</li>'+
      '</ul>'+
      '<p>إعادة العلاج أصعب من العلاج الأولي وأقل نسبة نجاح، لكنه يبقى أفضل من القلع.</p>'+
      '<h3>البديل: قلع السن وزراعة بديلة</h3>'+
      '<p>أحياناً يقترح الطبيب القلع بدل علاج العصب. متى يكون هذا منطقياً؟</p>'+
      '<ul>'+
        '<li>كسر شديد للسن لا يمكن ترميمه</li>'+
        '<li>كسر جذري عمودي</li>'+
        '<li>عظم محيطي مفقود بشدة</li>'+
        '<li>فشل علاج العصب المتكرّر</li>'+
      '</ul>'+
      '<p><strong>القاعدة:</strong> لا تتسرّع للقلع. سنّك الطبيعي دائماً أفضل من أي بديل صناعي.</p>'+
      '<h3>خرّاج الأسنان — حالة طارئة</h3>'+
      '<p>إذا ظهرت هذه العلامات، اذهب للعيادة في <strong>نفس اليوم</strong>:</p>'+
      '<ul>'+
        '<li>تورّم شديد في الوجه أو تحت العين</li>'+
        '<li>ألم نابض شديد لا يهدأ بالمسكّنات</li>'+
        '<li>حرارة ‎38°+ مع رعشة</li>'+
        '<li>صعوبة بالبلع أو التنفّس (طارئ مستشفى)</li>'+
        '<li>خروج صديد من بثرة على اللثة</li>'+
      '</ul>'+
      '<p>إهمال الخرّاج قد يؤدي إلى <strong>تسمّم الدم (Sepsis)</strong> — حالة قاتلة. لا تستهن بألم الأسنان الشديد.</p>'+
      '<h3>علاج العصب للأسنان اللبنية</h3>'+
      '<p>ممكن وضروري أحياناً:</p>'+
      '<ul>'+
        '<li><strong>Pulpotomy:</strong> إزالة الجزء العلوي فقط من اللب (إن كان الالتهاب خفيفاً)</li>'+
        '<li><strong>Pulpectomy:</strong> إزالة كامل اللب (مثل البالغين)</li>'+
        '<li>الهدف: حفظ السن اللبني حتى يسقط طبيعياً (يحجز مكان السن الدائم)</li>'+
      '</ul>'+
      '<h3>خرافات شائعة</h3>'+
      '<ul>'+
        '<li><strong>"علاج العصب مؤلم جداً":</strong> العكس — يخلّصك من الألم</li>'+
        '<li><strong>"السن سيموت":</strong> السن وظيفي تماماً بعد العلاج، فقط بدون عصب</li>'+
        '<li><strong>"بعد علاج العصب لن أستطيع المضغ":</strong> ستمضغ عادي مع التاج</li>'+
        '<li><strong>"علاج العصب يُسبّب أمراضاً جسدية":</strong> دراسات حديثة دحضت هذه الخرافة تماماً</li>'+
        '<li><strong>"أفضل نقلع بدل أن نعالج العصب":</strong> الزراعة أغلى بكثير وأكثر تعقيداً</li>'+
      '</ul>'+
      '<h3>كيف تحمي سنّك من الحاجة لعلاج عصب؟</h3>'+
      '<ul>'+
        '<li>عالج التسوس <strong>مبكراً</strong> — قبل أن يصل العصب</li>'+
        '<li>زيارة فحص دورية كل ‎6 أشهر</li>'+
        '<li>أشعة سنوية لاكتشاف التسوس بين الأسنان</li>'+
        '<li>الجهاز الليلي إن كنت تصرّ على أسنانك</li>'+
        '<li>واقي فم رياضي للرياضات العنيفة</li>'+
        '<li>عناية فموية ممتازة (فرشاة + خيط)</li>'+
      '</ul>'+
      '<div class="art-tip">💡 <strong>الإشارة المبكرة الحاسمة:</strong> إذا شربت ماءً بارداً وبقي الألم في السن <strong>أكثر من ‎30 ثانية</strong> بعد إبعاد الكوب — هذه إشارة أن العصب التهب التهاباً غير قابل للعكس. لا تنتظر، لا تُسكِّن بالمسكّنات لأسابيع. زر الطبيب فوراً. التشخيص المبكر يعني علاجاً أبسط ونجاحاً أكبر.</div>'
  }
];

var _artCatFilter = 'all';
function setArtCat(cat){
  _artCatFilter = cat;
  renderArticles();
}

function renderArticles(){
  var el = document.getElementById('articlesList');
  if (!el) return;
  // Build category chip filter
  var catFilterEl = document.getElementById('artCatFilter');
  if (catFilterEl) {
    var allCats = {};
    ARTICLES.forEach(function(a){ allCats[a.category] = a.color; });
    var chips = '<button class="btn btn-ghost btn-xs" onclick="setArtCat(\'all\')" style="background:'+(_artCatFilter==='all'?'#0d5c7a':'#fff')+';color:'+(_artCatFilter==='all'?'#fff':'#0d5c7a')+';border:1.5px solid #0d5c7a;font-weight:700">📚 الكل</button>';
    chips += Object.keys(allCats).map(function(cat){
      var active = _artCatFilter===cat;
      return '<button class="btn btn-ghost btn-xs" onclick="setArtCat(\''+cat.replace(/'/g,"\\'")+'\')" style="background:'+(active?allCats[cat]:'#fff')+';color:'+(active?'#fff':allCats[cat])+';border:1.5px solid '+allCats[cat]+';font-weight:700">'+cat+'</button>';
    }).join('');
    catFilterEl.innerHTML = chips;
  }
  // Apply filters
  var query = ((document.getElementById('artSearch')||{}).value||'').trim().toLowerCase();
  var filtered = ARTICLES.filter(function(a){
    if (_artCatFilter !== 'all' && a.category !== _artCatFilter) return false;
    if (query) {
      var hay = (a.title+' '+a.summary+' '+a.category+' '+(a.content||'')).toLowerCase();
      if (hay.indexOf(query) === -1) return false;
    }
    return true;
  });
  if (!filtered.length) {
    el.innerHTML = emptyState('🔍','لا توجد مقالات تطابق بحثك');
    return;
  }
  el.innerHTML = filtered.map(function(a){
    return '<div onclick="openArticle(\''+a.id+'\')" style="background:#fff;border:1.5px solid var(--border);border-right:5px solid '+a.color+';border-radius:12px;padding:14px;margin-bottom:10px;cursor:pointer;transition:all .2s" onmouseover="this.style.boxShadow=\'0 4px 12px rgba(0,0,0,.08)\'" onmouseout="this.style.boxShadow=\'\'">'+
      '<div style="display:flex;gap:12px;align-items:flex-start">'+
        '<div style="font-size:36px;line-height:1">'+a.icon+'</div>'+
        '<div style="flex:1">'+
          '<div style="font-size:10px;color:'+a.color+';font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">'+a.category+'</div>'+
          '<div style="font-size:15px;font-weight:800;color:var(--gray6);margin-bottom:6px;line-height:1.4">'+a.title+'</div>'+
          '<div style="font-size:12px;color:var(--gray5);line-height:1.6;margin-bottom:8px">'+a.summary+'</div>'+
          '<div style="font-size:10px;color:var(--gray4)">⏱️ '+a.readTime+' للقراءة</div>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');
}

var _currentArticleId = null;
function openArticle(aid){
  _currentArticleId = aid;
  navTo('article');
}

function renderArticle(){
  var a = ARTICLES.find(function(x){return x.id === _currentArticleId;});
  if (!a) { navTo('articles'); return; }
  var el = document.getElementById('articleContent');
  if (!el) return;
  el.innerHTML = '<style>'+
    '.art-tip{background:#fef3c7;border:1.5px solid #fde047;border-radius:10px;padding:12px;margin:14px 0;font-size:13px;color:#854d0e;line-height:1.7}'+
    '#articleContent h2{font-size:18px;color:'+a.color+';margin:18px 0 10px;font-weight:800;line-height:1.5}'+
    '#articleContent h3{font-size:15px;color:var(--gray6);margin:16px 0 8px;font-weight:800}'+
    '#articleContent h4{font-size:13px;color:var(--gray6);margin:12px 0 6px;font-weight:800}'+
    '#articleContent p{font-size:13px;line-height:1.9;color:var(--gray6);margin:8px 0}'+
    '#articleContent ul,#articleContent ol{font-size:13px;line-height:1.9;color:var(--gray6);padding-right:22px;margin:8px 0}'+
    '#articleContent li{margin:5px 0}'+
    '#articleContent strong{color:'+a.color+'}'+
    '</style>'+
    '<div style="background:linear-gradient(135deg,'+a.color+',#000);color:#fff;border-radius:14px;padding:24px;margin-bottom:16px">'+
      '<div style="font-size:54px;margin-bottom:8px">'+a.icon+'</div>'+
      '<div style="font-size:11px;opacity:.85;font-weight:800;text-transform:uppercase;letter-spacing:1px">'+a.category+'</div>'+
      '<h1 style="font-size:22px;font-weight:900;margin:8px 0 6px;line-height:1.4">'+a.title+'</h1>'+
      '<div style="font-size:13px;opacity:.9">'+a.summary+'</div>'+
      '<div style="font-size:11px;opacity:.7;margin-top:12px">⏱️ '+a.readTime+' للقراءة</div>'+
    '</div>'+
    '<div style="background:#fff;border-radius:12px;padding:18px">'+a.content+'</div>'+
    '<div style="text-align:center;margin:20px 0;padding:14px;background:#f8fbfd;border-radius:10px">'+
      '<div style="font-size:12px;color:var(--gray5);margin-bottom:8px">هل لديك سؤال حول هذا المقال؟</div>'+
      (CU && CU.role === 'patient' ? '<button class="btn btn-primary btn-sm" onclick="navTo(\'myinquiries\')">💬 أرسل استفسار للعيادة</button>' : '')+
    '</div>';
}

// ═══════════════════════════════════════════════════
//  BACKUP REMINDER (weekly)
// ═══════════════════════════════════════════════════
function checkBackupReminder(){
  if (!CU) return;
  if (CU.role !== 'manager' && CU.role !== 'doctor-manager') return;
  var lastBackup = localStorage.getItem('lastBackupReminder');
  var weekMs = 7 * 24 * 3600 * 1000;
  var now = Date.now();
  if (lastBackup && (now - parseInt(lastBackup)) < weekMs) return;
  // Show reminder once per week
  setTimeout(function(){
    if (confirm('💾 تذكير النسخ الاحتياطي\n\nمضى أسبوع منذ آخر تذكير. يُنصح بحفظ نسخة احتياطية كاملة من بيانات العيادة.\n\nهل تريد تصدير نسخة احتياطية الآن؟')) {
      try { exportBackup(); } catch(e){ alert('خطأ في التصدير'); }
    }
    localStorage.setItem('lastBackupReminder', String(now));
  }, 3000);
}

// ═══════════════════════════════════════════════════
//  PWA
// ═══════════════════════════════════════════════════
var _pwaPrompt=null;
window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();_pwaPrompt=e;});
window.addEventListener('online', function(){var b=document.getElementById('offlineBar');if(b)b.style.display='none';});
window.addEventListener('offline',function(){var b=document.getElementById('offlineBar');if(b)b.style.display='block';});

// Offline bar
var offBar=document.createElement('div');
offBar.id='offlineBar';
offBar.style.cssText='display:none;position:fixed;top:52px;left:0;right:0;z-index:9999;background:#c96a00;color:#fff;text-align:center;font-size:12px;font-weight:700;padding:6px;font-family:Tajawal,sans-serif';
offBar.textContent='⚡ وضع عدم الاتصال — البيانات محفوظة محلياً';
document.body.appendChild(offBar);
if(!navigator.onLine)offBar.style.display='block';

// ═══════════════════════════════════════════════════════════════════
//  SORAN v2.5 — UNIFIED MODULE
//  Permissions • Audit Log • Expenses • Unified Appt Hub
//  Detailed EOD • Simple Patient Login • Purchase↔Debt↔Expense Linking
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
//  1) PERMISSIONS SYSTEM
//  ───────────────────────────────────────────────────────────────────
//  Each permission key represents a sensitive view or action.
//  Roles get explicit positive grants; absent = denied.
// ═══════════════════════════════════════════════════════════════════
var PERMS = {
  'doctor-manager': ['*'],                       // owner / boss
  'manager':        ['*'],
  'doctor': [
    'patients_view','appointments_view','plans_edit','sessions_edit',
    'commissions_view_own','settlements_view_own','tasks_view',
    'chat','vendors_view','expenses_view','expenses_add','purchases_view'
  ],
  'reception': [
    'patients_view','patients_edit','appointments_view','appointments_edit',
    'tasks_view','chat','vendors_view','recall_view','requests_view',
    'expenses_view','expenses_add','purchases_view','purchases_edit',
    'debtors_view'
    // NOTE: no revenue_view, no commissions_view, no finance_view
  ],
  'marketer': [
    'patients_view','appointments_view','tasks_view','chat',
    'recall_view','marketing','expenses_view'
    // NOTE: no revenue_view
  ],
  'patient': [
    'myfile','myrx','myconsents','bookappt','myinquiries','articles'
  ]
};

function can(perm){
  if (!CU || !CU.role) return false;
  var grants = PERMS[CU.role] || [];
  if (grants.indexOf('*') >= 0) return true;
  return grants.indexOf(perm) >= 0;
}

// Hide DOM elements user doesn't have permission for
function applyPermsToDOM(){
  document.querySelectorAll('[data-perm]').forEach(function(el){
    var p = el.getAttribute('data-perm');
    el.style.display = can(p) ? '' : 'none';
  });
}


// ═══════════════════════════════════════════════════════════════════
//  2) AUDIT LOG SYSTEM
//  ───────────────────────────────────────────────────────────────────
//  Every sensitive change is logged with: who, when, what, why.
// ═══════════════════════════════════════════════════════════════════
function audit(entity, entityId, field, oldVal, newVal, reason){
  try {
    var log = G('auditLog', []);
    log.push({
      id: 'al_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
      ts: new Date().toISOString(),
      userId: CU ? CU.id : null,
      userName: CU ? CU.name : 'system',
      userRole: CU ? CU.role : '',
      entity: entity,           // 'session', 'plan', 'expense', 'debt', 'eod', etc.
      entityId: entityId,
      field: field,
      oldValue: oldVal == null ? null : String(oldVal),
      newValue: newVal == null ? null : String(newVal),
      reason: reason || ''
    });
    // Keep most recent 5000 entries to avoid bloat
    if (log.length > 5000) log = log.slice(-5000);
    S('auditLog', log);
  } catch(e){ console.warn('audit fail', e); }
}

// Render the audit log viewer (manager-only)
function renderAuditLog(){
  if (!can('*')) { alert('فقط المدير يستطيع الاطلاع على سجل التدقيق'); return; }
  var log = G('auditLog', []).slice().reverse();
  var fEntity = (document.getElementById('alFEntity')||{}).value || '';
  var fUser   = (document.getElementById('alFUser')||{}).value   || '';
  var fDate   = (document.getElementById('alFDate')||{}).value   || '';
  if (fEntity) log = log.filter(function(x){ return x.entity===fEntity; });
  if (fUser)   log = log.filter(function(x){ return x.userId===fUser; });
  if (fDate)   log = log.filter(function(x){ return (x.ts||'').slice(0,10)===fDate; });

  var ENTITY_LBL = {
    session:'📝 جلسة', plan:'📋 خطة', expense:'💸 صرفية',
    debt:'💼 دين', eod:'🌙 تصفية يوم', appt:'📅 موعد',
    purchase:'🛒 مشتريات', settlement:'💵 تصفية طبيب'
  };

  var staffOpts = '<option value="">كل الكادر</option>' +
    G('staff',[]).map(function(s){
      return '<option value="'+s.id+'"'+(fUser===s.id?' selected':'')+'>'+s.name+'</option>';
    }).join('');

  var rows = log.length ? log.slice(0, 500).map(function(e){
    var dt = new Date(e.ts);
    var dStr = dt.toLocaleString('ar', { dateStyle:'short', timeStyle:'short' });
    return '<tr>'+
      '<td style="font-size:11px;color:#64748b">'+dStr+'</td>'+
      '<td style="font-size:12px"><strong>'+(e.userName||'-')+'</strong></td>'+
      '<td>'+(ENTITY_LBL[e.entity]||e.entity)+'</td>'+
      '<td style="font-size:12px">'+(e.field||'-')+'</td>'+
      '<td style="font-size:11px;color:#dc2626">'+(e.oldValue==null?'-':e.oldValue)+'</td>'+
      '<td style="font-size:11px;color:#16a34a">'+(e.newValue==null?'-':e.newValue)+'</td>'+
      '<td style="font-size:11px;font-style:italic;color:#64748b;max-width:200px">'+(e.reason||'-')+'</td>'+
    '</tr>';
  }).join('') : '<tr><td colspan="7" style="text-align:center;padding:30px;color:#94a3b8">لا توجد إدخالات</td></tr>';

  var pnl = document.getElementById('auditLogPanel');
  if (!pnl) return;
  pnl.innerHTML =
    '<div class="card" style="border-right:4px solid #6366f1">'+
      '<div class="card-header" style="background:#eef2ff;color:#3730a3">'+
        '<span class="card-title">📜 سجل التدقيق ('+log.length+' إدخال)</span>'+
        '<button class="btn btn-ghost btn-xs" onclick="document.getElementById(\'auditLogPanel\').style.display=\'none\'">✕ إغلاق</button>'+
      '</div>'+
      '<div class="card-body">'+
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">'+
          '<select id="alFEntity" onchange="renderAuditLog()" style="padding:6px;border-radius:6px;border:1px solid #e2e8f0;font-size:12px">'+
            '<option value="">كل الأنواع</option>'+
            Object.keys(ENTITY_LBL).map(function(k){return '<option value="'+k+'"'+(fEntity===k?' selected':'')+'>'+ENTITY_LBL[k]+'</option>';}).join('')+
          '</select>'+
          '<select id="alFUser" onchange="renderAuditLog()" style="padding:6px;border-radius:6px;border:1px solid #e2e8f0;font-size:12px">'+staffOpts+'</select>'+
          '<input type="date" id="alFDate" value="'+fDate+'" onchange="renderAuditLog()" style="padding:6px;border-radius:6px;border:1px solid #e2e8f0;font-size:12px">'+
          (fEntity||fUser||fDate ? '<button class="btn btn-ghost btn-xs" onclick="document.getElementById(\'alFEntity\').value=\'\';document.getElementById(\'alFUser\').value=\'\';document.getElementById(\'alFDate\').value=\'\';renderAuditLog()">✕ مسح</button>':'')+
        '</div>'+
        '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:#f8fafc;font-weight:700">'+
          '<th style="padding:8px;text-align:right">الوقت</th>'+
          '<th style="padding:8px;text-align:right">المستخدم</th>'+
          '<th style="padding:8px;text-align:right">النوع</th>'+
          '<th style="padding:8px;text-align:right">الحقل</th>'+
          '<th style="padding:8px;text-align:right">القديم</th>'+
          '<th style="padding:8px;text-align:right">الجديد</th>'+
          '<th style="padding:8px;text-align:right">السبب</th>'+
        '</tr></thead><tbody>'+rows+'</tbody></table></div>'+
      '</div>'+
    '</div>';
  pnl.style.display = 'block';
}

function openAuditLog(){
  if (!can('*')) { alert('فقط المدير يستطيع الاطلاع على سجل التدقيق'); return; }
  var pnl = document.getElementById('auditLogPanel');
  if (pnl && pnl.style.display === 'block') { pnl.style.display='none'; return; }
  renderAuditLog();
}

// Generic "edit with reason" modal
var _editReasonCb = null;
function openEditReason(opts){
  // opts: { title, label, oldValue, type ('number'|'text'|'date'), onSave(newVal, reason) }
  _editReasonCb = opts.onSave;
  document.getElementById('erTitle').textContent = opts.title || 'تعديل القيمة';
  document.getElementById('erLabel').textContent = opts.label || 'القيمة الجديدة';
  var inp = document.getElementById('erValue');
  inp.type = opts.type || 'text';
  inp.value = opts.oldValue == null ? '' : opts.oldValue;
  document.getElementById('erOldDisplay').textContent = opts.oldValue == null ? '-' : opts.oldValue;
  document.getElementById('erReason').value = '';
  openModal('mo-editReason');
  setTimeout(function(){ inp.focus(); inp.select(); }, 100);
}
function confirmEditReason(){
  var newV = document.getElementById('erValue').value;
  var reason = (document.getElementById('erReason').value||'').trim();
  if (!reason) { alert('يجب ذكر سبب التعديل'); return; }
  if (reason.length < 4) { alert('السبب قصير جداً — اكتب توضيحاً أوضح'); return; }
  closeModal('mo-editReason');
  if (_editReasonCb) _editReasonCb(newV, reason);
  _editReasonCb = null;
}


// ═══════════════════════════════════════════════════════════════════
//  3) EXPENSES MODULE
//  ───────────────────────────────────────────────────────────────────
//  Single source of truth for all money LEAVING the clinic.
//  Sources: 'manual', 'debt_payment' (auto), 'purchase_cash' (auto).
//  Categories unified across purchases/debts/expenses.
// ═══════════════════════════════════════════════════════════════════
var EXP_CATEGORIES = [
  {id:'lab',       lbl:'🔬 مختبر'},
  {id:'materials', lbl:'🧪 مواد ومستهلكات'},
  {id:'rent',      lbl:'🏢 إيجار'},
  {id:'utility',   lbl:'⚡ كهرباء/ماء'},
  {id:'maintenance',lbl:'🔧 صيانة'},
  {id:'salary',    lbl:'💵 راتب'},
  {id:'loan',      lbl:'💳 قرض'},
  {id:'marketing', lbl:'📢 تسويق'},
  {id:'other',     lbl:'📌 أخرى'}
];
function expCatLbl(id){
  var c = EXP_CATEGORIES.find(function(x){return x.id===id;});
  return c ? c.lbl : id;
}
function expCatOptions(selected){
  return EXP_CATEGORIES.map(function(c){
    return '<option value="'+c.id+'"'+(selected===c.id?' selected':'')+'>'+c.lbl+'</option>';
  }).join('');
}

// Add an expense entry. source can be 'manual', 'debt_payment', 'purchase_cash'.
function addExpense(opts){
  var list = G('expenses', []);
  var entry = {
    id: 'exp_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
    amount: parseFloat(opts.amount)||0,
    date: opts.date || today(),
    category: opts.category || 'other',
    description: opts.description || '',
    notes: opts.notes || '',
    source: opts.source || 'manual',     // manual | debt_payment | purchase_cash
    sourceId: opts.sourceId || null,     // id of debt or purchase if applicable
    method: opts.method || 'نقد',
    by: CU ? CU.id : null,
    byName: CU ? CU.name : '',
    createdAt: new Date().toISOString()
  };
  list.push(entry);
  S('expenses', list);
  audit('expense', entry.id, 'created', null, entry.amount, 'إضافة صرفية: '+(opts.description||'-'));
  return entry;
}

function renderExpenses(){
  var list = G('expenses', []);
  var fCat  = (document.getElementById('expFCat')||{}).value || '';
  var fFrom = (document.getElementById('expFFrom')||{}).value || '';
  var fTo   = (document.getElementById('expFTo')||{}).value   || '';
  var fSrc  = (document.getElementById('expFSrc')||{}).value  || '';
  var rows = list.slice();
  if (fCat)  rows = rows.filter(function(e){return e.category===fCat;});
  if (fSrc)  rows = rows.filter(function(e){return e.source===fSrc;});
  if (fFrom) rows = rows.filter(function(e){return e.date>=fFrom;});
  if (fTo)   rows = rows.filter(function(e){return e.date<=fTo;});
  rows.sort(function(a,b){return b.date.localeCompare(a.date);});
  var total = rows.reduce(function(s,e){return s+(e.amount||0);},0);
  var todayStr = today();
  var todayTotal = list.filter(function(e){return e.date===todayStr;}).reduce(function(s,e){return s+(e.amount||0);},0);
  var monthStr = todayStr.slice(0,7);
  var monthTotal = list.filter(function(e){return (e.date||'').slice(0,7)===monthStr;}).reduce(function(s,e){return s+(e.amount||0);},0);

  var SRC_LBL = {manual:'يدوي', debt_payment:'تسديد دين', purchase_cash:'شراء نقدي'};
  var SRC_COLOR = {manual:'#64748b', debt_payment:'#f59e0b', purchase_cash:'#0ea5e9'};

  var stats = document.getElementById('expStats');
  if (stats) stats.innerHTML =
    '<div class="stat-box"><span class="s-icon">💸</span><div class="s-label">صرفيات اليوم</div><div class="s-val" style="color:#dc2626">'+todayTotal.toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📅</span><div class="s-label">صرفيات الشهر</div><div class="s-val" style="color:#ea580c">'+monthTotal.toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📊</span><div class="s-label">المعروض</div><div class="s-val">'+total.toLocaleString()+'</div></div>'+
    '<div class="stat-box"><span class="s-icon">📋</span><div class="s-label">عدد الصرفيات</div><div class="s-val">'+rows.length+'</div></div>';

  var listEl = document.getElementById('expList');
  if (!listEl) return;
  if (!rows.length) {
    listEl.innerHTML = emptyState('💸','لا توجد صرفيات بهذه الفلاتر');
    return;
  }
  listEl.innerHTML = '<div class="card"><div class="card-body" style="padding:0"><table style="width:100%;border-collapse:collapse;font-size:13px">'+
    '<thead><tr style="background:#f8fafc"><th style="padding:10px;text-align:right">التاريخ</th><th style="padding:10px;text-align:right">الفئة</th><th style="padding:10px;text-align:right">الوصف</th><th style="padding:10px;text-align:right">المصدر</th><th style="padding:10px;text-align:right">المبلغ</th><th style="padding:10px"></th></tr></thead><tbody>'+
    rows.map(function(e){
      var canEdit = can('*') || e.source === 'manual';
      return '<tr style="border-top:1px solid #f1f5f9">'+
        '<td style="padding:10px">'+e.date+'</td>'+
        '<td style="padding:10px">'+expCatLbl(e.category)+'</td>'+
        '<td style="padding:10px">'+(e.description||'-')+(e.notes?'<div style="font-size:11px;color:#64748b;font-style:italic">'+e.notes+'</div>':'')+'</td>'+
        '<td style="padding:10px"><span style="font-size:11px;padding:2px 8px;border-radius:10px;background:'+SRC_COLOR[e.source]+'22;color:'+SRC_COLOR[e.source]+'">'+(SRC_LBL[e.source]||e.source)+'</span></td>'+
        '<td style="padding:10px;font-weight:700;color:#dc2626">'+(e.amount||0).toLocaleString()+'</td>'+
        '<td style="padding:10px;text-align:left">'+
          (canEdit && can('*') ? '<button class="btn btn-ghost btn-xs" onclick="expEditAmount(\''+e.id+'\')">✏️</button>':'')+
          (e.source==='manual' && can('*') ? '<button class="btn btn-danger btn-xs" onclick="expDelete(\''+e.id+'\')">🗑</button>':'')+
        '</td>'+
      '</tr>';
    }).join('')+'</tbody><tfoot><tr style="background:#fef2f2;font-weight:800"><td colspan="4" style="padding:10px;text-align:left">الإجمالي:</td><td colspan="2" style="padding:10px;color:#dc2626;font-size:15px">'+total.toLocaleString()+' د.ع</td></tr></tfoot></table></div></div>';
}

function openAddExpense(){
  if (!can('expenses_add')) { alert('ليس لديك صلاحية لإضافة صرفيات'); return; }
  document.getElementById('expDate').value = today();
  document.getElementById('expAmount').value = '';
  document.getElementById('expDesc').value = '';
  document.getElementById('expNotes').value = '';
  document.getElementById('expCat').innerHTML = expCatOptions('materials');
  document.getElementById('expMethod').value = 'نقد';
  openModal('mo-addExpense');
}

function saveExpense(){
  var amount = parseFloat(document.getElementById('expAmount').value)||0;
  if (amount <= 0) { alert('المبلغ يجب أن يكون أكبر من صفر'); return; }
  var desc = (document.getElementById('expDesc').value||'').trim();
  if (!desc) { alert('وصف الصرفية مطلوب'); return; }
  addExpense({
    amount: amount,
    date: document.getElementById('expDate').value || today(),
    category: document.getElementById('expCat').value || 'other',
    description: desc,
    notes: document.getElementById('expNotes').value || '',
    method: document.getElementById('expMethod').value || 'نقد',
    source: 'manual'
  });
  closeModal('mo-addExpense');
  renderExpenses();
  showToast('✅ تم تسجيل الصرفية', 'success');
}

function expEditAmount(id){
  var list = G('expenses', []);
  var e = list.find(function(x){return x.id===id;});
  if (!e) return;
  openEditReason({
    title: 'تعديل مبلغ الصرفية',
    label: 'المبلغ الجديد (د.ع)',
    oldValue: e.amount,
    type: 'number',
    onSave: function(newVal, reason){
      var nv = parseFloat(newVal)||0;
      if (nv <= 0) { alert('قيمة غير صالحة'); return; }
      var old = e.amount;
      e.amount = nv;
      e.lastEditAt = new Date().toISOString();
      e.lastEditBy = CU ? CU.id : null;
      S('expenses', list);
      audit('expense', id, 'amount', old, nv, reason);
      renderExpenses();
      showToast('✅ تم التعديل', 'success');
    }
  });
}

function expDelete(id){
  if (!can('*')) return;
  var list = G('expenses', []);
  var e = list.find(function(x){return x.id===id;});
  if (!e) return;
  if (e.source !== 'manual') { alert('لا يمكن حذف صرفية تم إنشاؤها تلقائياً (تسديد دين أو شراء نقدي). احذف العنصر الأصلي بدلاً من ذلك.'); return; }
  if (!confirm('حذف هذه الصرفية؟ ('+e.amount.toLocaleString()+' د.ع)')) return;
  audit('expense', id, 'deleted', e.amount, null, 'حذف صرفية يدوية');
  S('expenses', list.filter(function(x){return x.id!==id;}));
  renderExpenses();
}


// ═══════════════════════════════════════════════════════════════════
//  4) UNIFIED APPOINTMENT HUB
//  ───────────────────────────────────────────────────────────────────
//  Click any appointment → one screen with tabs:
//    • Plan (new quick / continue existing)
//    • Session (the existing session form)
//    • Prescription (already inline in session)
//    • Next appointment (already inline in session)
//  Reduces clicks from 5+ to 1.
// ═══════════════════════════════════════════════════════════════════
var _hubApptId = null;
var _hubPlanId = null;

function openApptHub(apptId){
  var appt = G('appointments', []).find(function(a){return a.id===apptId;});
  if (!appt) { alert('الموعد غير موجود'); return; }
  _hubApptId = apptId;
  _hubPlanId = null;
  CPid = appt.patientId;  // Set context patient

  var pt = pm()[appt.patientId];
  if (!pt) { alert('المريض غير موجود'); return; }

  // Pre-mark as arrived if scheduled
  if (appt.status === 'scheduled') {
    appt.status = 'arrived';
    appt.arrivedAt = new Date().toISOString();
    appt.arrivedBy = CU ? CU.id : null;
    var appts = G('appointments', []);
    var i = appts.findIndex(function(x){return x.id===apptId;});
    if (i>=0) { appts[i] = appt; S('appointments', appts); }
  }

  // Header
  var header = document.getElementById('hubHeader');
  if (header) header.innerHTML =
    '<div style="display:flex;align-items:center;gap:10px">'+
      '<div style="width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#0d5c7a,#083d55);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px">'+
        (pt.name||'؟').slice(0,2)+
      '</div>'+
      '<div>'+
        '<div style="font-weight:800;font-size:15px">'+pt.name+'</div>'+
        '<div style="font-size:11px;color:#64748b">'+(pt.phone||'-')+' • '+appt.date+(appt.time?' • '+appt.time:'')+'</div>'+
      '</div>'+
    '</div>';

  // Default tab: if patient has active plans → "continue", else → "new"
  var activePlans = G('plans',[]).filter(function(p){return p.patientId===appt.patientId && p.status!=='completed';});
  hubSwitchTab(activePlans.length ? 'continue' : 'newplan');
  openModal('mo-apptHub');
}

function hubSwitchTab(tab){
  document.querySelectorAll('.hub-tab').forEach(function(b){b.classList.remove('active'); b.style.background=''; b.style.color='';});
  var btn = document.getElementById('hubTab-'+tab);
  if (btn) { btn.classList.add('active'); btn.style.background='#0d5c7a'; btn.style.color='#fff'; }
  ['newplan','continue','session','rx','done'].forEach(function(t){
    var p = document.getElementById('hubPanel-'+t);
    if (p) p.style.display = (t===tab ? 'block' : 'none');
  });
  if (tab === 'newplan')  hubRenderNewPlan();
  if (tab === 'continue') hubRenderContinue();
  if (tab === 'session')  hubRenderSession();
  if (tab === 'rx')       hubRenderRx();
  if (tab === 'done')     hubRenderDone();
}

function hubRenderNewPlan(){
  var pnl = document.getElementById('hubPanel-newplan');
  if (!pnl) return;
  var docs = G('staff',[]).filter(function(s){return s.role==='doctor'||s.role==='doctor-manager';});
  var defaultDoc = (CU && (CU.role==='doctor'||CU.role==='doctor-manager')) ? CU.id : (docs[0]&&docs[0].id);
  pnl.innerHTML =
    '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px;margin-bottom:10px;font-size:12px;color:#166534">'+
      '⚡ <strong>خطة سريعة</strong> — اكتب الوصف والتكلفة فقط. التفاصيل (الأسنان، شركة الزرعة، عدد الجلسات...) تُملأ لاحقاً عند الحاجة.'+
    '</div>'+
    '<div class="form-group"><label>وصف العلاج <span style="color:red">*</span></label><textarea id="hubPlanDesc" rows="2" class="form-control" placeholder="مثال: تنظيف وحشوة سن 16"></textarea></div>'+
    '<div class="form-group"><label>نوع العلاج</label><select id="hubPlanType" class="form-control" onchange="hubRenderRingPills()">'+
      '<option value="general">🔬 علاج عام</option>'+
      '<option value="cleaning">✨ تنظيف</option>'+
      '<option value="filling">🪥 حشوة</option>'+
      '<option value="extract">🔩 قلع</option>'+
      '<option value="implant">🦷 زراعة</option>'+
      '<option value="ortho">🔧 تقويم</option>'+
      '<option value="crown">👑 تيجان/جسر</option>'+
      '<option value="nerve">🩺 عصب</option>'+
    '</select></div>'+
    '<div class="form-group"><label>الطبيب</label><select id="hubPlanDoc" class="form-control">'+
      docs.map(function(d){return '<option value="'+d.id+'"'+(d.id===defaultDoc?' selected':'')+'>'+d.name+'</option>';}).join('')+
    '</select></div>'+
    '<div class="form-group"><label>التكلفة المتوقّعة (د.ع)</label>'+
      '<input type="number" id="hubPlanCost" class="form-control" placeholder="مثال: 50000">'+
      '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">'+
        ['25000','50000','75000','100000','150000','200000','300000','500000','1000000'].map(function(v){
          return '<button type="button" class="btn btn-ghost btn-xs" onclick="document.getElementById(\'hubPlanCost\').value=\''+v+'\'">'+(parseInt(v)>=1000?(parseInt(v)/1000)+'k':v)+'</button>';
        }).join('')+
        '<label style="font-size:11px;display:flex;align-items:center;gap:4px;margin-right:8px"><input type="checkbox" id="hubPlanCostExact"> ثابتة (قطعية)</label>'+
      '</div>'+
    '</div>'+
    '<div class="form-group"><label>عدد الجلسات (تقريبي)</label><input type="number" id="hubPlanSess" class="form-control" value="1"></div>'+
    '<div class="form-group"><label>دفعة أولى الآن (اختياري)</label><input type="number" id="hubPlanDown" class="form-control" placeholder="0"></div>'+
    '<div style="display:flex;gap:8px;margin-top:14px">'+
      '<button class="btn btn-success" style="flex:1" onclick="hubSaveNewPlan(false)">💾 حفظ الخطة</button>'+
      '<button class="btn btn-primary" style="flex:1" onclick="hubSaveNewPlan(true)">💾 حفظ + بدء جلسة الآن</button>'+
    '</div>';
}

function hubSaveNewPlan(thenSession){
  var desc = (document.getElementById('hubPlanDesc').value||'').trim();
  if (!desc) { alert('وصف العلاج مطلوب'); return; }
  var cost = parseFloat(document.getElementById('hubPlanCost').value)||0;
  var down = parseFloat(document.getElementById('hubPlanDown').value)||0;
  var doctorId = document.getElementById('hubPlanDoc').value;
  var planType = document.getElementById('hubPlanType').value;
  var sessions = parseInt(document.getElementById('hubPlanSess').value)||1;
  var costExact = document.getElementById('hubPlanCostExact').checked;

  var docs = G('staff',[]);
  var doc = docs.find(function(d){return d.id===doctorId;});

  var plan = {
    id: 'pl' + uid(),
    patientId: CPid,
    description: desc,
    planType: planType,
    doctorId: doctorId,
    doctorComm: doc ? doc.comm : 0,
    sessions: sessions,
    completedSessions: 0,
    totalCost: cost,
    costExact: costExact,
    paidAmount: 0,
    debtAmount: 0,
    status: 'in_progress',
    sessionRecords: [],
    payments: [],
    createdAt: today(),
    createdBy: CU ? CU.id : null,
    isQuickPlan: true
  };
  if (down > 0) {
    plan.paidAmount = down;
    plan.payments.push({amount: down, date: today(), note: 'دفعة أولى'});
    addPay(CPid, doctorId, down, today(), desc, 'دفعة أولى');
  }
  var plans = G('plans', []);
  plans.push(plan);
  S('plans', plans);
  audit('plan', plan.id, 'created', null, desc + ' / ' + cost, 'خطة سريعة من شاشة الموعد');

  // Award marketer commission if applicable
  try { awardMarketerCommission(plan); } catch(e){}

  _hubPlanId = plan.id;
  if (thenSession) {
    hubSwitchTab('session');
  } else {
    showToast('✅ تم حفظ الخطة', 'success');
    hubSwitchTab('continue');
  }
}

function hubRenderContinue(){
  var pnl = document.getElementById('hubPanel-continue');
  if (!pnl) return;
  var plans = G('plans', []).filter(function(p){return p.patientId===CPid;});
  var active = plans.filter(function(p){return p.status!=='completed';});
  var completed = plans.filter(function(p){return p.status==='completed';});
  if (!active.length && !completed.length) {
    pnl.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8"><div style="font-size:42px">📋</div><div style="margin-top:10px">لا توجد خطط لهذا المريض. ابدأ خطة جديدة من التبويب الأول.</div></div>';
    return;
  }
  function planRow(pl, isActive){
    var pct = pl.totalCost ? Math.round((pl.paidAmount||0)/pl.totalCost*100) : 0;
    var nextSessIdx = pl.completedSessions || 0;
    return '<div style="border:1.5px solid '+(isActive?'#bae6fd':'#e2e8f0')+';border-radius:10px;padding:12px;margin-bottom:8px;background:'+(isActive?'#f0f9ff':'#fafafa')+'">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">'+
        '<div style="flex:1;min-width:0">'+
          '<div style="font-weight:700;font-size:14px">'+pl.description+'</div>'+
          '<div style="font-size:11px;color:#64748b;margin-top:2px">جلسة '+(pl.completedSessions||0)+'/'+(pl.sessions||1)+' • '+(pl.totalCost||0).toLocaleString()+' د.ع'+
            (pl.paidAmount?' • مدفوع '+pl.paidAmount.toLocaleString():'')+
            (pl.costExact?' • <span style="color:#16a34a">قطعية</span>':' • <span style="color:#64748b">تقريبية</span>')+
          '</div>'+
          '<div style="background:#e2e8f0;height:4px;border-radius:2px;margin-top:6px;overflow:hidden"><div style="background:#0d5c7a;height:100%;width:'+pct+'%"></div></div>'+
        '</div>'+
        '<div style="display:flex;flex-direction:column;gap:4px">'+
          (isActive ? '<button class="btn btn-success btn-xs" onclick="hubSelectPlanAndSess(\''+pl.id+'\','+nextSessIdx+')">📝 جلسة '+(nextSessIdx+1)+'</button>' : '')+
          (isActive ? '<button class="btn btn-ghost btn-xs" onclick="hubEditPlanCost(\''+pl.id+'\')">✏️ تعديل التكلفة</button>' : '<span class="badge badge-green">✓ مكتملة</span>')+
        '</div>'+
      '</div>'+
    '</div>';
  }
  pnl.innerHTML =
    (active.length ? '<div style="font-weight:700;margin-bottom:8px;color:#0d5c7a">📋 خطط نشطة ('+active.length+')</div>' + active.map(function(p){return planRow(p,true);}).join('') : '')+
    (completed.length ? '<div style="font-weight:700;margin:14px 0 8px;color:#64748b">✅ خطط مكتملة ('+completed.length+')</div>' + completed.map(function(p){return planRow(p,false);}).join('') : '');
}

function hubSelectPlanAndSess(planId, idx){
  _hubPlanId = planId;
  _hubSessIdx = idx;
  hubSwitchTab('session');
}

function hubEditPlanCost(planId){
  var plans = G('plans', []);
  var pl = plans.find(function(p){return p.id===planId;});
  if (!pl) return;
  openEditReason({
    title: 'تعديل تكلفة الخطة',
    label: 'التكلفة الجديدة (د.ع)',
    oldValue: pl.totalCost || 0,
    type: 'number',
    onSave: function(newVal, reason){
      var nv = parseFloat(newVal)||0;
      var old = pl.totalCost || 0;
      pl.totalCost = nv;
      pl.costExact = true; // explicit edit means user committed
      pl.debtAmount = Math.max(0, nv - (pl.paidAmount||0));
      S('plans', plans);
      audit('plan', planId, 'totalCost', old, nv, reason);
      hubRenderContinue();
      showToast('✅ تم تعديل التكلفة', 'success');
    }
  });
}

var _hubSessIdx = 0;
function hubRenderSession(){
  var pnl = document.getElementById('hubPanel-session');
  if (!pnl) return;
  if (!_hubPlanId) {
    pnl.innerHTML = '<div style="padding:30px;text-align:center;color:#94a3b8">'+
      '<div style="font-size:36px">📋</div>'+
      '<div style="margin:10px 0">اختر خطة من تبويب "الخطط النشطة"<br>أو ابدأ خطة جديدة</div>'+
      '<button class="btn btn-primary btn-sm" onclick="hubSwitchTab(\'continue\')">📋 خطط هذا المريض</button> '+
      '<button class="btn btn-success btn-sm" onclick="hubSwitchTab(\'newplan\')">+ خطة جديدة</button>'+
    '</div>';
    return;
  }
  var pl = G('plans', []).find(function(p){return p.id===_hubPlanId;});
  if (!pl) { pnl.innerHTML = '<div style="padding:20px;color:red">الخطة غير موجودة</div>'; return; }
  var idx = _hubSessIdx;
  var ex = (pl.sessionRecords||[]).find(function(r){return r.index===idx;});
  var docs = G('staff',[]).filter(function(s){return s.role==='doctor'||s.role==='doctor-manager';});

  pnl.innerHTML =
    '<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:10px;margin-bottom:10px;font-size:12px;color:#854d0e">'+
      '📋 الخطة: <strong>'+pl.description+'</strong> • جلسة '+(idx+1)+'/'+(pl.sessions||1)+
    '</div>'+
    '<div class="form-group"><label>العمل المنجز <span style="color:red">*</span></label><textarea id="hubSessWork" rows="2" class="form-control">'+(ex?ex.work||'':'')+'</textarea></div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'+
      '<div class="form-group"><label>الطبيب</label><select id="hubSessDoc" class="form-control">'+
        docs.map(function(d){return '<option value="'+d.id+'"'+((ex?ex.doctorId:pl.doctorId)===d.id?' selected':'')+'>'+d.name+'</option>';}).join('')+
      '</select></div>'+
      '<div class="form-group"><label>التاريخ</label><input type="date" id="hubSessDate" class="form-control" value="'+(ex&&ex.date||today())+'"></div>'+
    '</div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'+
      '<div class="form-group"><label>المبلغ المدفوع</label><input type="number" id="hubSessPaid" class="form-control" value="'+(ex?ex.paid||0:0)+'" oninput="hubSessCalcNet()"></div>'+
      '<div class="form-group"><label>خصم</label><input type="number" id="hubSessDisc" class="form-control" value="'+(ex?ex.discount||0:0)+'" oninput="hubSessCalcNet()"></div>'+
    '</div>'+
    '<div id="hubSessNet" style="display:none;background:#f0fdf4;padding:8px;border-radius:6px;margin-bottom:8px;font-size:13px;color:#166534"></div>'+
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">'+
      [15000,25000,50000,75000,100000,150000,200000].map(function(v){
        return '<button type="button" class="btn btn-ghost btn-xs" onclick="document.getElementById(\'hubSessPaid\').value=\''+v+'\';hubSessCalcNet()">'+(v/1000)+'k</button>';
      }).join('')+
    '</div>'+
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'+
      '<div class="form-group"><label>📅 الموعد القادم</label><input type="date" id="hubSessNextDate" class="form-control" value="'+(ex&&ex.nextDate||'')+'"></div>'+
      '<div class="form-group"><label>الوقت</label><select id="hubSessNextTime" class="form-control">'+buildTimeOptions(ex&&ex.nextTime||'', {step:15})+'</select></div>'+
    '</div>'+
    '<div class="form-group"><label>ملاحظات</label><textarea id="hubSessNotes" rows="2" class="form-control">'+(ex?ex.notes||'':'')+'</textarea></div>'+
    '<div style="display:flex;gap:8px;margin-top:10px">'+
      '<button class="btn btn-ghost" style="flex:0 0 auto" onclick="hubSwitchTab(\'rx\')">💊 وصفة طبية</button>'+
      '<button class="btn btn-success" style="flex:1" onclick="hubSaveSession()">✅ حفظ الجلسة</button>'+
    '</div>';
}

function hubSessCalcNet(){
  var paid = parseFloat(document.getElementById('hubSessPaid').value)||0;
  var disc = parseFloat(document.getElementById('hubSessDisc').value)||0;
  var net = Math.max(0, paid-disc);
  var el = document.getElementById('hubSessNet');
  if (disc > 0) {
    el.style.display = 'block';
    el.innerHTML = 'الصافي بعد الخصم: <strong>'+net.toLocaleString()+' د.ع</strong>';
  } else {
    el.style.display = 'none';
  }
}

function hubSaveSession(){
  if (!_hubPlanId) return;
  var work = (document.getElementById('hubSessWork').value||'').trim();
  if (!work) { alert('وصف العمل مطلوب'); return; }
  // ─── تحقق من الموعد القادم إن وُجد ───
  var _hndate = document.getElementById('hubSessNextDate').value;
  var _hntime = document.getElementById('hubSessNextTime').value;
  var _hndoc  = document.getElementById('hubSessDoc').value;
  if (_hndate && _hntime){
    if (!isWithinClinicHours(_hntime)){
      alert('⛔ وقت الموعد القادم خارج ساعات العمل (9 ص – 9 م).');
      return;
    }
    var _hnconflict = findApptConflict(_hndate, _hntime, _hndoc);
    if (_hnconflict){
      var _hpC = pm()[_hnconflict.patientId];
      if (!confirm('⚠️ يوجد موعد آخر للطبيب يوم '+_hndate+' الساعة '+_hnconflict.time+
                   (_hpC?(' (المريض: '+_hpC.name+')'):'')+
                   '.\n\nالفارق أقل من ٢٥ دقيقة. هل تريد المتابعة على أي حال؟')){
        return;
      }
    }
  }
  var paid = parseFloat(document.getElementById('hubSessPaid').value)||0;
  var disc = parseFloat(document.getElementById('hubSessDisc').value)||0;
  var net = Math.max(0, paid-disc);
  var idx = _hubSessIdx;

  var plans = G('plans', []);
  var pl = plans.find(function(p){return p.id===_hubPlanId;});
  if (!pl) return;
  if (!pl.sessionRecords) pl.sessionRecords = [];

  var rec = {
    index: idx,
    work: work,
    doctorId: document.getElementById('hubSessDoc').value,
    paid: net,
    discount: disc,
    date: document.getElementById('hubSessDate').value || today(),
    nextDate: document.getElementById('hubSessNextDate').value || '',
    nextTime: document.getElementById('hubSessNextTime').value || '',
    notes: document.getElementById('hubSessNotes').value || '',
    medications: window._hubMeds || [],
    tips: window._hubTips || [],
    rating: { hygiene: 0, compliance: 0 },
    savedAt: new Date().toISOString(),
    savedBy: CU ? CU.id : null,
    fromHub: true
  };
  var exIdx = pl.sessionRecords.findIndex(function(r){return r.index===idx;});
  var isEdit = exIdx >= 0;
  var oldPaid = isEdit ? (pl.sessionRecords[exIdx].paid||0) : 0;
  if (isEdit) pl.sessionRecords[exIdx] = rec;
  else pl.sessionRecords.push(rec);
  if (!isEdit && idx === pl.completedSessions) pl.completedSessions = idx + 1;

  var diff = net - oldPaid;
  if (diff !== 0) {
    pl.paidAmount = (pl.paidAmount||0) + diff;
    if (!pl.payments) pl.payments = [];
    if (!isEdit) pl.payments.push({amount: net, date: rec.date, note: 'جلسة '+(idx+1)});
    if (net > 0 || isEdit) addPay(pl.patientId, rec.doctorId||pl.doctorId, diff, rec.date, pl.description, isEdit?'تعديل جلسة '+(idx+1):'جلسة '+(idx+1));
  }
  S('plans', plans);
  audit('session', pl.id+'#'+idx, isEdit?'updated':'created', oldPaid, net, isEdit?'تعديل جلسة من الـ Hub':'إنشاء جلسة من الـ Hub');

  // Schedule next appointment if next date set
  if (rec.nextDate) {
    var appts = G('appointments', []);
    var nextId = 'a'+uid();
    appts.push({
      id: nextId, patientId: pl.patientId, doctorId: rec.doctorId||pl.doctorId,
      date: rec.nextDate, time: rec.nextTime||'',
      type: pl.description, notes: 'جلسة '+(idx+2),
      status: 'scheduled', createdAt: new Date().toISOString()
    });
    S('appointments', appts);
    try { scheduleApptReminders(nextId); } catch(e){}
  }

  // Mark current appointment as completed
  if (_hubApptId) {
    var aList = G('appointments', []);
    var ai = aList.findIndex(function(x){return x.id===_hubApptId;});
    if (ai >= 0) {
      aList[ai].status = 'completed';
      aList[ai].completedAt = new Date().toISOString();
      S('appointments', aList);
    }
  }

  showToast('✅ تم حفظ الجلسة', 'success');
  hubSwitchTab('done');
}

function hubRenderRx(){
  var pnl = document.getElementById('hubPanel-rx');
  if (!pnl) return;
  if (!_hubPlanId) {
    pnl.innerHTML = '<div style="padding:30px;text-align:center;color:#94a3b8">اختر خطة أولاً</div>';
    return;
  }
  var pl = G('plans',[]).find(function(p){return p.id===_hubPlanId;});
  window._hubMeds = window._hubMeds || [];
  window._hubTips = window._hubTips || [];
  var DRUGS_LITE = [
    {n:'Amoxicillin 500mg', d:'كبسولة كل 8 ساعات', dur:'5 أيام'},
    {n:'Ibuprofen 400mg',   d:'حبة كل 8 ساعات',   dur:'3 أيام'},
    {n:'Paracetamol 500mg', d:'حبة كل 6 ساعات',   dur:'3 أيام'},
    {n:'Metronidazole 500mg', d:'حبة كل 8 ساعات', dur:'5 أيام'},
    {n:'Chlorhexidine mouthwash', d:'مضمضة بعد التنظيف', dur:'7 أيام'}
  ];
  var TIPS_LITE = (pl && pl.planType === 'implant') ? ['لا تلمس منطقة الزراعة','تناول طعاماً طرياً لأسبوع','تجنب التدخين تماماً'] :
                  (pl && pl.planType === 'extract') ? ['عضّ على الشاش 30 دقيقة','لا تمضمض فمك 24 ساعة','تجنب التدخين 3 أيام'] :
                  ['حافظ على نظافة فمك','فرش بلطف بعد العلاج','تناول الدواء في مواعيده'];

  pnl.innerHTML =
    '<div style="background:#fef3c7;padding:10px;border-radius:8px;margin-bottom:10px;font-size:12px;color:#854d0e">💊 وصفة طبية ونصائح للمريض</div>'+
    '<div style="font-weight:700;margin-bottom:6px">أدوية شائعة:</div>'+
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">'+
      DRUGS_LITE.map(function(d,i){return '<button class="btn btn-ghost btn-xs" onclick="hubAddMed('+i+')">+ '+d.n+'</button>';}).join('')+
      '<button class="btn btn-ghost btn-xs" onclick="hubAddCustomMed()">+ يدوي</button>'+
    '</div>'+
    '<div id="hubMedsList"></div>'+
    '<div style="font-weight:700;margin:14px 0 6px">🌿 نصائح:</div>'+
    '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">'+
      TIPS_LITE.map(function(t){return '<button class="btn btn-ghost btn-xs" onclick="hubAddTip(\''+t.replace(/'/g,"\\'")+'\')">+ '+t+'</button>';}).join('')+
    '</div>'+
    '<div id="hubTipsList"></div>'+
    '<button class="btn btn-primary btn-sm" style="margin-top:14px" onclick="hubSwitchTab(\'session\')">← العودة للجلسة</button>';
  window._hubDrugsLite = DRUGS_LITE;
  hubRenderMeds();
  hubRenderTips();
}
function hubAddMed(i){
  var d = window._hubDrugsLite[i];
  window._hubMeds.push({name:d.n, dose:d.d, duration:d.dur, note:''});
  hubRenderMeds();
}
function hubAddCustomMed(){
  window._hubMeds.push({name:'',dose:'',duration:'',note:''});
  hubRenderMeds();
}
function hubDelMed(i){ window._hubMeds.splice(i,1); hubRenderMeds(); }
function hubSetMed(i,k,v){ if (window._hubMeds[i]) window._hubMeds[i][k] = v; }
function hubRenderMeds(){
  var el = document.getElementById('hubMedsList');
  if (!el) return;
  if (!window._hubMeds.length) { el.innerHTML = '<div style="color:#94a3b8;font-size:12px">لا توجد أدوية</div>'; return; }
  el.innerHTML = window._hubMeds.map(function(m,i){
    return '<div style="background:#f8fafc;border-radius:8px;padding:8px;margin-bottom:6px;display:grid;grid-template-columns:2fr 2fr 1fr auto;gap:6px;align-items:center">'+
      '<input class="form-control" style="font-size:12px" placeholder="اسم الدواء" value="'+(m.name||'').replace(/"/g,'&quot;')+'" oninput="hubSetMed('+i+',\'name\',this.value)">'+
      '<input class="form-control" style="font-size:12px" placeholder="الجرعة" value="'+(m.dose||'').replace(/"/g,'&quot;')+'" oninput="hubSetMed('+i+',\'dose\',this.value)">'+
      '<input class="form-control" style="font-size:12px" placeholder="المدة" value="'+(m.duration||'').replace(/"/g,'&quot;')+'" oninput="hubSetMed('+i+',\'duration\',this.value)">'+
      '<button class="btn btn-danger btn-xs" onclick="hubDelMed('+i+')">🗑</button>'+
    '</div>';
  }).join('');
}
function hubAddTip(t){ if (window._hubTips.indexOf(t)<0) window._hubTips.push(t); hubRenderTips(); }
function hubDelTip(i){ window._hubTips.splice(i,1); hubRenderTips(); }
function hubRenderTips(){
  var el = document.getElementById('hubTipsList');
  if (!el) return;
  if (!window._hubTips.length) { el.innerHTML = '<div style="color:#94a3b8;font-size:12px">لا توجد نصائح</div>'; return; }
  el.innerHTML = window._hubTips.map(function(t,i){
    return '<div style="background:#f0fdf4;border-radius:6px;padding:6px 10px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;font-size:12px">'+
      '<span>🌿 '+t+'</span>'+
      '<button class="btn btn-danger btn-xs" onclick="hubDelTip('+i+')">✕</button>'+
    '</div>';
  }).join('');
}

function hubRenderDone(){
  var pnl = document.getElementById('hubPanel-done');
  if (!pnl) return;
  pnl.innerHTML =
    '<div style="text-align:center;padding:30px">'+
      '<div style="font-size:64px">✅</div>'+
      '<div style="font-weight:800;font-size:18px;margin:14px 0 8px;color:#166534">تمت معالجة الموعد</div>'+
      '<div style="color:#64748b;font-size:13px;margin-bottom:20px">تم حفظ كل شيء: الخطة، الجلسة، الموعد القادم.</div>'+
      '<div style="display:flex;gap:8px;flex-direction:column;max-width:300px;margin:0 auto">'+
        '<button class="btn btn-ghost btn-sm" onclick="hubPrintRx()">🖨️ طباعة الوصفة</button>'+
        '<button class="btn btn-primary" onclick="closeApptHub()">إغلاق</button>'+
      '</div>'+
    '</div>';
}

function hubPrintRx(){
  if (!_hubPlanId) return;
  if (!window._hubMeds || !window._hubMeds.length) { alert('لا توجد أدوية للطباعة'); return; }
  var pl = G('plans', []).find(function(p){return p.id===_hubPlanId;});
  if (!pl) return;
  var rec = (pl.sessionRecords||[]).find(function(r){return r.index===_hubSessIdx;}) || {};
  var clinic = G('clinic', {});
  var pt = pm()[pl.patientId] || {};
  var doc = sm()[rec.doctorId||pl.doctorId] || {};
  var html = '<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><style>body{font-family:Tahoma;direction:rtl;padding:20px;color:#0f2030}h2{color:#0d5c7a}table{width:100%;border-collapse:collapse;margin-top:10px}th{background:#0d5c7a;color:#fff;padding:6px 10px;font-size:11px}td{padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:12px}.tip{background:#f0fdf4;padding:6px 10px;margin:3px 0;border-radius:6px;font-size:12px}@media print{button{display:none}}</style></head><body>'+
    '<h2>💊 وصفة طبية — '+(clinic.name||'عيادة سوران')+'</h2>'+
    '<div>المريض: <strong>'+(pt.name||'-')+'</strong> | الطبيب: '+(doc.name||'-')+' | التاريخ: '+(rec.date||today())+'</div>'+
    '<div style="margin-top:6px">العمل المنجز: '+(rec.work||'-')+'</div>'+
    '<table><thead><tr><th>الدواء</th><th>الجرعة</th><th>المدة</th><th>ملاحظة</th></tr></thead><tbody>'+
      window._hubMeds.map(function(m){return '<tr><td>'+(m.name||'-')+'</td><td>'+(m.dose||'-')+'</td><td>'+(m.duration||'-')+'</td><td>'+(m.note||'-')+'</td></tr>';}).join('')+
    '</tbody></table>'+
    (window._hubTips.length ? '<h3 style="margin-top:20px;color:#16a34a">🌿 النصائح</h3>'+window._hubTips.map(function(t){return '<div class="tip">• '+t+'</div>';}).join('') : '')+
    (rec.nextDate ? '<div style="margin-top:20px;padding:10px;background:#fef3c7;border-radius:6px;font-size:13px">📅 الموعد القادم: <strong>'+rec.nextDate+(rec.nextTime?' • '+rec.nextTime:'')+'</strong></div>' : '')+
    '<scr'+'ipt>window.print();</scr'+'ipt></body></html>';
  var w = window.open('','_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

function closeApptHub(){
  closeModal('mo-apptHub');
  _hubApptId = null; _hubPlanId = null; _hubSessIdx = 0;
  window._hubMeds = []; window._hubTips = [];
  if (typeof renderAppts === 'function') {
    var pg = document.querySelector('.page.active');
    if (pg && pg.id === 'pg-appointments') renderAppts();
  }
}


// ═══════════════════════════════════════════════════════════════════
//  5) DETAILED END-OF-DAY (with edit-with-reason)
// ═══════════════════════════════════════════════════════════════════
function renderEodTransactions(dateStr){
  // Returns all financial transactions for a given date (payments + expenses)
  var pays = G('payments', []).filter(function(p){return p.date===dateStr;});
  var expenses = G('expenses', []).filter(function(e){return e.date===dateStr;});
  return { pays: pays, expenses: expenses };
}

function eodOpenDetailedTransactions(){
  var dateStr = _eodDate || today();
  var data = renderEodTransactions(dateStr);
  var smap = sm(), pmap = pm();
  var totalRev = data.pays.reduce(function(s,p){return s+(p.amount||0);},0);
  var totalExp = data.expenses.reduce(function(s,e){return s+(e.amount||0);},0);
  var net = totalRev - totalExp;
  var byMethod = {};
  data.pays.forEach(function(p){
    var m = p.method || 'نقد';
    byMethod[m] = (byMethod[m]||0) + (p.amount||0);
  });

  var pnl = document.getElementById('eodTransactionsPanel');
  if (!pnl) return;

  var html =
    '<div class="card" style="border-right:4px solid #6366f1">'+
      '<div class="card-header" style="background:#eef2ff;color:#3730a3">'+
        '<span class="card-title">📋 تفاصيل معاملات يوم '+dateStr+'</span>'+
        '<button class="btn btn-ghost btn-xs" onclick="document.getElementById(\'eodTransactionsPanel\').style.display=\'none\'">✕</button>'+
      '</div>'+
      '<div class="card-body">'+
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">'+
          '<div style="background:#f0fdf4;padding:10px;border-radius:8px;text-align:center"><div style="font-size:10px;color:#166534">الإيرادات</div><div style="font-size:18px;font-weight:800;color:#16a34a">'+totalRev.toLocaleString()+'</div></div>'+
          '<div style="background:#fef2f2;padding:10px;border-radius:8px;text-align:center"><div style="font-size:10px;color:#991b1b">الصرفيات</div><div style="font-size:18px;font-weight:800;color:#dc2626">'+totalExp.toLocaleString()+'</div></div>'+
          '<div style="background:'+(net>=0?'#f0fdf4':'#fef2f2')+';padding:10px;border-radius:8px;text-align:center"><div style="font-size:10px;color:#64748b">الصافي</div><div style="font-size:18px;font-weight:800;color:'+(net>=0?'#16a34a':'#dc2626')+'">'+net.toLocaleString()+'</div></div>'+
        '</div>';

  // Payments table
  if (data.pays.length) {
    html += '<div style="font-weight:700;margin-bottom:6px;color:#166534">💰 المدفوعات الواردة ('+data.pays.length+')</div>'+
      '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px">'+
      '<thead><tr style="background:#f0fdf4"><th style="padding:8px;text-align:right">المريض</th><th style="padding:8px;text-align:right">الطبيب</th><th style="padding:8px;text-align:right">الخدمة</th><th style="padding:8px;text-align:right">المبلغ</th><th style="padding:8px"></th></tr></thead><tbody>'+
      data.pays.map(function(p){
        var pt = pmap[p.patientId];
        var doc = smap[p.doctorId];
        return '<tr style="border-top:1px solid #f1f5f9">'+
          '<td style="padding:8px">'+(pt?pt.name:'-')+'</td>'+
          '<td style="padding:8px">'+(doc?doc.name:'-')+'</td>'+
          '<td style="padding:8px">'+(p.service||'-')+(p.note?' • '+p.note:'')+'</td>'+
          '<td style="padding:8px;font-weight:700;color:#16a34a">'+(p.amount||0).toLocaleString()+'</td>'+
          '<td style="padding:8px;text-align:left">'+(can('*')?'<button class="btn btn-ghost btn-xs" onclick="eodEditPayment(\''+p.id+'\')">✏️</button>':'')+'</td>'+
        '</tr>';
      }).join('')+
      '</tbody></table>';
  }

  // Expenses table
  if (data.expenses.length) {
    html += '<div style="font-weight:700;margin-bottom:6px;color:#991b1b">💸 الصرفيات الصادرة ('+data.expenses.length+')</div>'+
      '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px">'+
      '<thead><tr style="background:#fef2f2"><th style="padding:8px;text-align:right">الفئة</th><th style="padding:8px;text-align:right">الوصف</th><th style="padding:8px;text-align:right">المصدر</th><th style="padding:8px;text-align:right">المبلغ</th><th style="padding:8px"></th></tr></thead><tbody>'+
      data.expenses.map(function(e){
        var SRC_LBL = {manual:'يدوي', debt_payment:'تسديد دين', purchase_cash:'شراء نقدي'};
        return '<tr style="border-top:1px solid #f1f5f9">'+
          '<td style="padding:8px">'+expCatLbl(e.category)+'</td>'+
          '<td style="padding:8px">'+(e.description||'-')+'</td>'+
          '<td style="padding:8px"><span style="font-size:11px;color:#64748b">'+(SRC_LBL[e.source]||e.source)+'</span></td>'+
          '<td style="padding:8px;font-weight:700;color:#dc2626">'+(e.amount||0).toLocaleString()+'</td>'+
          '<td style="padding:8px;text-align:left">'+(can('*')?'<button class="btn btn-ghost btn-xs" onclick="expEditAmount(\''+e.id+'\')">✏️</button>':'')+'</td>'+
        '</tr>';
      }).join('')+
      '</tbody></table>';
  }

  if (!data.pays.length && !data.expenses.length) {
    html += '<div style="text-align:center;padding:30px;color:#94a3b8">لا توجد أي معاملات في يوم '+dateStr+'</div>';
  }

  // Method breakdown
  if (Object.keys(byMethod).length) {
    html += '<div style="font-weight:700;margin-bottom:6px;color:#0d5c7a">💳 توزيع الإيرادات حسب طريقة الدفع</div>'+
      '<div style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:14px">'+
      Object.keys(byMethod).map(function(m){
        return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px"><span>'+m+'</span><strong>'+byMethod[m].toLocaleString()+' د.ع</strong></div>';
      }).join('')+
    '</div>';
  }

  html += '</div></div>';
  pnl.innerHTML = html;
  pnl.style.display = 'block';
}

function eodEditPayment(payId){
  if (!can('*')) return;
  var pays = G('payments', []);
  var p = pays.find(function(x){return x.id===payId;});
  if (!p) return;
  openEditReason({
    title: 'تعديل مبلغ الدفعة',
    label: 'المبلغ الجديد',
    oldValue: p.amount,
    type: 'number',
    onSave: function(newVal, reason){
      var nv = parseFloat(newVal)||0;
      var old = p.amount;
      var diff = nv - old;
      p.amount = nv;
      p.lastEditAt = new Date().toISOString();
      p.lastEditBy = CU ? CU.id : null;

      // Sync into related plan
      if (p.patientId) {
        var plans = G('plans', []);
        var pl = plans.find(function(x){return x.patientId===p.patientId && (x.description===p.service || (x.payments||[]).some(function(pp){return pp.amount===old && pp.date===p.date;}));});
        if (pl) {
          pl.paidAmount = (pl.paidAmount||0) + diff;
          // Update session record if matches
          (pl.sessionRecords||[]).forEach(function(r){
            if (r.date === p.date && r.paid === old) r.paid = nv;
          });
          S('plans', plans);
        }
      }
      S('payments', pays);
      audit('eod', payId, 'payment_amount', old, nv, reason);
      eodOpenDetailedTransactions();
      showToast('✅ تم التعديل', 'success');
    }
  });
}


// ═══════════════════════════════════════════════════════════════════
//  6) PURCHASE ↔ DEBT ↔ EXPENSE LINKING
//  ───────────────────────────────────────────────────────────────────
//  When a purchase item is marked as RECEIVED:
//    Ask: cash now? → create expense automatically
//          credit?  → create debt automatically
//  When a debt is paid → expense is auto-created (handled via wrapping
//  saveClinicDebtPayment).
// ═══════════════════════════════════════════════════════════════════
var _receivePurchaseId = null;

function openReceivePurchase(itemId){
  var items = G('inventory', []);
  var it = items.find(function(x){return x.id===itemId;});
  if (!it) return;
  _receivePurchaseId = itemId;
  document.getElementById('rpItemName').textContent = it.name;
  document.getElementById('rpAmount').value = '';
  document.getElementById('rpVendor').value = '';
  // Populate vendor dropdown
  var vendors = G('vendors', []);
  document.getElementById('rpVendor').innerHTML =
    '<option value="">— بدون جهة —</option>'+
    vendors.map(function(v){return '<option value="'+v.id+'">'+v.name+'</option>';}).join('');
  // Map cat to expense cat
  var CAT_MAP = {'مستهلكات':'materials','أدوات':'materials','مواد طبية':'materials','مواد مختبر':'lab','أخرى':'other'};
  var defaultCat = CAT_MAP[it.cat] || 'materials';
  document.getElementById('rpExpCat').innerHTML = expCatOptions(defaultCat);
  document.getElementById('rpDate').value = today();
  document.getElementById('rpNotes').value = '';
  // Default to cash
  rpSetMode('cash');
  openModal('mo-receivePurchase');
}

function rpSetMode(mode){
  document.getElementById('rpModeCash').classList.toggle('active', mode==='cash');
  document.getElementById('rpModeCredit').classList.toggle('active', mode==='credit');
  document.getElementById('rpModeCash').style.background = mode==='cash' ? '#16a34a':'';
  document.getElementById('rpModeCash').style.color = mode==='cash' ? '#fff':'';
  document.getElementById('rpModeCredit').style.background = mode==='credit' ? '#f59e0b':'';
  document.getElementById('rpModeCredit').style.color = mode==='credit' ? '#fff':'';
  document.getElementById('rpModeInput').value = mode;
  // Toggle due-date field for credit
  var dueRow = document.getElementById('rpDueRow');
  if (dueRow) dueRow.style.display = mode==='credit' ? 'block' : 'none';
}

function confirmReceivePurchase(){
  var amount = parseFloat(document.getElementById('rpAmount').value)||0;
  if (amount <= 0) { alert('أدخل المبلغ'); return; }
  var mode = document.getElementById('rpModeInput').value || 'cash';
  var vendorId = document.getElementById('rpVendor').value || '';
  var vendor = vendorId ? G('vendors',[]).find(function(v){return v.id===vendorId;}) : null;
  var category = document.getElementById('rpExpCat').value || 'materials';
  var date = document.getElementById('rpDate').value || today();
  var notes = document.getElementById('rpNotes').value || '';

  var items = G('inventory', []);
  var it = items.find(function(x){return x.id===_receivePurchaseId;});
  if (!it) return;

  it.status = 'bought';
  it.receivedAt = new Date().toISOString();
  it.receivedBy = CU ? CU.id : null;
  it.cost = amount;
  it.vendorId = vendorId;
  it.paymentMode = mode;

  if (mode === 'cash') {
    // Auto-create expense
    var exp = addExpense({
      amount: amount,
      date: date,
      category: category,
      description: '🛒 ' + it.name + (vendor ? ' — ' + vendor.name : ''),
      notes: notes,
      source: 'purchase_cash',
      sourceId: it.id,
      method: 'نقد'
    });
    it.expenseId = exp.id;
    audit('purchase', it.id, 'received_cash', null, amount, 'استلام بدفع نقدي — ربط بالصرفية '+exp.id);
  } else {
    // Auto-create debt
    var dueDate = document.getElementById('rpDue').value || '';
    var debts = G('clinicDebts', []);
    var debt = {
      id: 'cd_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
      creditor: vendor ? vendor.name : (notes || it.name),
      category: category === 'lab' ? 'مختبر' : 'مواد',
      amount: amount,
      phone: vendor ? (vendor.phone||'') : '',
      dueDate: dueDate,
      date: date,
      notes: 'مشتريات: ' + it.name + (notes ? ' — ' + notes : ''),
      payments: [],
      vendorId: vendorId,
      sourcePurchaseId: it.id,
      createdAt: new Date().toISOString(),
      createdBy: CU ? CU.id : null
    };
    debts.push(debt);
    S('clinicDebts', debts);
    it.debtId = debt.id;
    audit('purchase', it.id, 'received_credit', null, amount, 'استلام بالآجل — تم إنشاء دين '+debt.id);
    audit('debt', debt.id, 'created', null, amount, 'دين تلقائي من شراء آجل: '+it.name);
  }
  S('inventory', items);
  closeModal('mo-receivePurchase');
  renderInventory();
  showToast(mode==='cash' ? '✅ تم تسجيل الشراء + الصرفية' : '✅ تم تسجيل الشراء + الدين', 'success');
  _receivePurchaseId = null;
}


// ═══════════════════════════════════════════════════════════════════
//  7) PATIENT SIMPLE LOGIN
//  ───────────────────────────────────────────────────────────────────
//  Phone + "soran" + last 4 digits of phone.
//  e.g. phone 07701234567 → password "soran4567"
// ═══════════════════════════════════════════════════════════════════
function ptComputeSimplePass(phone){
  var p = String(phone||'').replace(/\D/g,'');
  if (p.length < 4) return null;
  var last4 = p.slice(-4);
  return 'soran' + last4;
}

function ptSetMode(mode){
  var simpleBtn = document.getElementById('ptModeSimpleBtn');
  var otpBtn = document.getElementById('ptModeOtpBtn');
  var simpleP = document.getElementById('ptModeSimple');
  var otpP = document.getElementById('ptModeOtp');
  if (mode === 'simple') {
    if (simpleBtn) { simpleBtn.style.background = '#16a34a'; simpleBtn.style.color = '#fff'; }
    if (otpBtn)    { otpBtn.style.background = 'transparent'; otpBtn.style.color = '#166534'; }
    if (simpleP) simpleP.style.display = '';
    if (otpP)    otpP.style.display = 'none';
  } else {
    if (otpBtn)    { otpBtn.style.background = '#25d366'; otpBtn.style.color = '#fff'; }
    if (simpleBtn) { simpleBtn.style.background = 'transparent'; simpleBtn.style.color = '#166534'; }
    if (otpP)    otpP.style.display = '';
    if (simpleP) simpleP.style.display = 'none';
  }
  var err = document.getElementById('ptErr1');
  if (err) err.style.display = 'none';
}

function ptDoSimpleLogin(){
  var rawPhone = (document.getElementById('ptPhone').value||'').trim();
  var pass = (document.getElementById('ptSimplePass').value||'').trim();
  var err = document.getElementById('ptErr1');
  err.style.display = 'none';
  if (!rawPhone) { err.textContent = '❌ أدخل رقم هاتفك'; err.style.display = 'block'; return; }
  if (!pass)     { err.textContent = '❌ أدخل كلمة المرور'; err.style.display = 'block'; return; }

  var normalized = normalizePhoneIQ(rawPhone);
  if (normalized.length < 9 || normalized.length > 11) {
    err.textContent = '❌ رقم الهاتف غير صالح';
    err.style.display = 'block';
    return;
  }
  var patients = G('patients', []);
  var matched = null;
  for (var i = 0; i < patients.length; i++) {
    var pp = normalizePhoneIQ(patients[i].phone || '');
    if (pp && pp === normalized) { matched = patients[i]; break; }
  }
  if (!matched) {
    err.textContent = '❌ هذا الرقم غير مسجّل في العيادة';
    err.style.display = 'block';
    return;
  }
  var expectedPass = ptComputeSimplePass(matched.phone);
  // Accept lowercase variants for forgiveness
  if (pass.toLowerCase() !== (expectedPass||'').toLowerCase()) {
    err.textContent = '❌ كلمة المرور غير صحيحة. (تتكوّن من كلمة soran + آخر 4 أرقام من رقمك)';
    err.style.display = 'block';
    return;
  }
  // Login as patient
  CU = {
    id: matched.id,
    name: matched.name,
    role: 'patient',
    patientId: matched.id,
    phone: matched.phone
  };
  CPid = matched.id;
  Sl('autoLogin', { userId: matched.id, expiry: Date.now() + 24*3600*1000, role: 'patient' });
  document.getElementById('ptPhone').value = '';
  document.getElementById('ptSimplePass').value = '';
  audit('appt', matched.id, 'patient_login', null, 'simple', 'دخول مريض بكلمة المرور البسيطة');
  startApp();
}


// ═══════════════════════════════════════════════════════════════════
//  8) NAV REBUILD WITH PERMISSIONS
//  ───────────────────────────────────────────────────────────────────
//  Wrap buildNav to filter items based on permissions.
// ═══════════════════════════════════════════════════════════════════
var _origBuildNav = (typeof buildNav === 'function') ? buildNav : null;

// Map nav page → required permission(s)
var NAV_PERM_MAP = {
  finance:     'revenue_view',
  commissions: 'commissions_view',
  debtors:     'debtors_view',
  // others default to allowed
};

// Override buildNav to inject expenses + audit log into nav and apply perms
function buildNav() {
  var items = (NAV_CFG[CU.role] || NAV_CFG.reception).slice();

  // Inject "expenses" page into nav for roles that can see it (after inventory)
  var hasExpenses = items.some(function(x){return x[1]==='expenses';});
  if (!hasExpenses && can('expenses_view')) {
    var insertAt = items.findIndex(function(x){return x[1]==='inventory';});
    var entry = ['💸','expenses','الصرفيات'];
    if (insertAt >= 0) items.splice(insertAt+1, 0, entry);
    else items.push(entry);
  }
  // Inject "auditLog" for managers
  if (can('*')) {
    var hasAudit = items.some(function(x){return x[1]==='auditLog';});
    if (!hasAudit) items.push(['📜','auditLog','سجل التدقيق']);
  }
  // Filter by permissions
  items = items.filter(function(x){
    var requiredPerm = NAV_PERM_MAP[x[1]];
    if (!requiredPerm) return true;
    return can(requiredPerm);
  });

  document.getElementById('sbNav').innerHTML = items.map(function(x) {
    return '<div class="sb-item" id="sb-'+x[1]+'" onclick="navTo(\''+x[1]+'\');closeSb()"><span class="si">'+x[0]+'</span>'+x[2]+'</div>';
  }).join('');
  document.getElementById('bnList').innerHTML = items.slice(0,5).map(function(x) {
    return '<button class="bn-btn" id="bn-'+x[1]+'" onclick="navTo(\''+x[1]+'\')"><span class="bn-icon">'+x[0]+'</span><span class="bn-label">'+x[2]+'</span></button>';
  }).join('');
  try { if (typeof renderChatBadge === 'function') renderChatBadge(); } catch(e){}
  // Apply perms to DOM elements with [data-perm]
  setTimeout(applyPermsToDOM, 50);
}

// Extend PAGE_TITLES
PAGE_TITLES['expenses'] = '💸 الصرفيات';
PAGE_TITLES['auditLog'] = '📜 سجل التدقيق';

// Wrap renderPage to handle new pages
var _origRenderPage = (typeof renderPage === 'function') ? renderPage : null;
renderPage = function(pg){
  if (pg === 'expenses')  { renderExpenses(); return; }
  if (pg === 'auditLog')  { renderAuditLog(); return; }
  if (_origRenderPage) _origRenderPage(pg);
};


// ═══════════════════════════════════════════════════════════════════
//  9) HOOK: Wrap saveClinicDebtPayment to auto-create expense
//  ───────────────────────────────────────────────────────────────────
//  When a payment is made on a clinic debt, we automatically log
//  a corresponding expense.
// ═══════════════════════════════════════════════════════════════════
var _origSaveClinicDebtPayment = (typeof saveClinicDebtPayment === 'function') ? saveClinicDebtPayment : null;
function saveClinicDebtPayment(){
  // We need to capture the debt + payment context before & after, so we
  // reimplement instead of wrapping (the original closes modal early).
  if (!_cdPayingId) return;
  var amount = parseFloat(document.getElementById('cdPayAmount').value)||0;
  if (amount <= 0) { alert('المبلغ يجب أن يكون أكبر من صفر'); return; }
  var debts = G('clinicDebts', []);
  var d = debts.find(function(x){return x.id===_cdPayingId;});
  if (!d) return;
  var paid = (d.payments||[]).reduce(function(s,p){return s+(p.amount||0);},0);
  var rem = (d.amount||0) - paid;
  if (amount > rem + 1) {
    if (!confirm('المبلغ المدخل ('+amount.toLocaleString()+') أكبر من المتبقّي ('+rem.toLocaleString()+'). متابعة؟')) return;
  }
  var method = document.getElementById('cdPayMethod').value || 'نقد';
  var date = document.getElementById('cdPayDate').value || today();
  var notes = (document.getElementById('cdPayNotes').value||'').trim();
  var payment = {
    id: 'p_'+Date.now().toString(36),
    amount: amount,
    date: date,
    method: method,
    notes: notes,
    by: CU ? CU.id : null,
    byName: CU ? CU.name : ''
  };
  d.payments = d.payments || [];
  d.payments.push(payment);
  S('clinicDebts', debts);

  // Auto-create expense
  var CAT_MAP = {'مختبر':'lab','مواد':'materials','إيجار':'rent','كهرباء/ماء':'utility','صيانة':'maintenance','قرض':'loan','راتب':'salary','أخرى':'other'};
  var expCat = CAT_MAP[d.category] || 'other';
  var exp = addExpense({
    amount: amount,
    date: date,
    category: expCat,
    description: '💼 تسديد دين: ' + (d.creditor||'-'),
    notes: notes,
    source: 'debt_payment',
    sourceId: d.id,
    method: method
  });
  payment.expenseId = exp.id;
  S('clinicDebts', debts); // Save again with linked expense id
  audit('debt', d.id, 'payment', null, amount, 'تسديد دفعة — ربط بالصرفية '+exp.id);

  closeModal('mo-payClinicDebt');
  renderClinicDebts();
  var newPaid = paid + amount;
  var newRem = (d.amount||0) - newPaid;
  if (d.phone) {
    var clinic = G('clinic', {});
    var msg = 'السلام عليكم،\n\nتم تسديد مبلغ '+amount.toLocaleString()+' د.ع لكم من '+(clinic.name||'عيادة سوران')+'.\n\n'+
      'الفئة: '+(d.category||'-')+'\n'+
      'تاريخ الدفع: '+(date)+'\n'+
      'طريقة الدفع: '+(method)+'\n'+
      (newRem>0 ? 'المبلغ المتبقّي: '+newRem.toLocaleString()+' د.ع\n' : '✅ تم تسديد كامل المبلغ.\n')+
      '\nشكراً لتعاونكم.';
    if (confirm('✅ تم تسجيل الدفعة (وأُنشئت صرفية تلقائياً).\n\nهل تريد فتح واتساب لإرسال تأكيد؟')) {
      var phone = normalizePhoneIQ(d.phone);
      window.open('https://wa.me/964'+phone+'?text='+encodeURIComponent(msg), '_blank');
    }
  } else {
    showToast('✅ تم التسديد + إنشاء صرفية تلقائياً', 'success');
  }
  _cdPayingId = null;
}


// ═══════════════════════════════════════════════════════════════════
//  10) RECONFIGURE BACKUP_KEYS to include new collections
// ═══════════════════════════════════════════════════════════════════
if (typeof BACKUP_KEYS !== 'undefined') {
  if (BACKUP_KEYS.indexOf('expenses') < 0) BACKUP_KEYS.push('expenses');
  if (BACKUP_KEYS.indexOf('auditLog') < 0) BACKUP_KEYS.push('auditLog');
  if (BACKUP_KEYS.indexOf('clinicDebts') < 0) BACKUP_KEYS.push('clinicDebts');
  if (BACKUP_KEYS.indexOf('vendors') < 0) BACKUP_KEYS.push('vendors');
  if (BACKUP_KEYS.indexOf('settlements') < 0) BACKUP_KEYS.push('settlements');
}


// ═══════════════════════════════════════════════════════════════════
//  11) DASHBOARD: add quick links to new sections (managers only)
// ═══════════════════════════════════════════════════════════════════
var _origRenderDash = (typeof renderDash === 'function') ? renderDash : null;
renderDash = function(){
  if (_origRenderDash) _origRenderDash();
  // After original render, inject EOD-detailed button into the EOD panel area
  // (the existing button stays — we just add a "تفاصيل المعاملات" button next to it)
  var eodBtn = document.querySelector('button[onclick="openEndOfDayPanel()"]');
  if (eodBtn && !document.getElementById('eodDetailedBtn') && can('*')) {
    var newBtn = document.createElement('button');
    newBtn.id = 'eodDetailedBtn';
    newBtn.className = 'btn btn-sm';
    newBtn.style.cssText = 'background:#6366f1;color:#fff;margin-right:6px';
    newBtn.innerHTML = '📋 تفاصيل المعاملات';
    newBtn.onclick = eodOpenDetailedTransactions;
    eodBtn.parentNode.insertBefore(newBtn, eodBtn.nextSibling);

    // Add transactions panel placeholder
    if (!document.getElementById('eodTransactionsPanel')) {
      var pnl = document.createElement('div');
      pnl.id = 'eodTransactionsPanel';
      pnl.style.cssText = 'display:none;margin-bottom:14px';
      var eodPnl = document.getElementById('endOfDayPanel');
      if (eodPnl) eodPnl.parentNode.insertBefore(pnl, eodPnl.nextSibling);
    }
  }
};

// ═══════════════════════════════════════════════════════════════════
//  END OF MODULE
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
//  12) PATIENT TARGETED ADS
//  ───────────────────────────────────────────────────────────────────
//  Smart, condition-based promotional banners shown on patient's
//  "My File" page. Targeted by oralAssessment + history.
// ═══════════════════════════════════════════════════════════════════
var DEFAULT_PATIENT_ADS = {
  implant: {
    enabled: true,
    icon: '🦷',
    title: 'استبدل أسنانك المفقودة',
    subtitle: 'زراعة أسنان بأحدث التقنيات',
    body: 'حلٌّ دائم وطبيعي يعيد ابتسامتك ووظيفة المضغ. نوفّر زراعات سويسرية وألمانية بضمان موثّق.',
    cta: '📅 استشارة مجانية',
    bg: 'linear-gradient(135deg,#0d5c7a 0%,#083d55 100%)',
    color: '#fff',
    targetService: 'استشارة زراعة'
  },
  ortho: {
    enabled: true,
    icon: '😬',
    title: 'احصل على ابتسامة مثالية',
    subtitle: 'تقويم تقليدي + شفّاف (Aligners)',
    body: 'صحّح اصطفاف أسنانك بأحدث الأنظمة. خطّة علاج مفصّلة + متابعة دورية.',
    cta: '📅 فحص تقويمي',
    bg: 'linear-gradient(135deg,#7c3aed 0%,#5b21b6 100%)',
    color: '#fff',
    targetService: 'استشارة تقويم'
  },
  crown: {
    enabled: true,
    icon: '👑',
    title: 'أعد الحياة لأسنانك المتضرّرة',
    subtitle: 'تيجان زيركون وخزف بجودة ألمانية',
    body: 'تيجان وجسور بأحدث التقنيات — نتيجة طبيعية ومضمونة لسنوات.',
    cta: '📅 استشارة تركيبات',
    bg: 'linear-gradient(135deg,#a87c00 0%,#854d0e 100%)',
    color: '#fff',
    targetService: 'استشارة تيجان'
  },
  cleaning: {
    enabled: true,
    icon: '✨',
    title: 'تنظيف احترافي للأسنان',
    subtitle: 'إزالة جير وتلميع وفحص لثة',
    body: 'حافظ على صحة لثتك وابتسامتك. نوصي بتنظيف كل 6 أشهر للوقاية من اللثة وتسوّس الأسنان.',
    cta: '📅 جلسة تنظيف',
    bg: 'linear-gradient(135deg,#0ea5e9 0%,#0369a1 100%)',
    color: '#fff',
    targetService: 'تنظيف'
  },
  filling: {
    enabled: true,
    icon: '🪥',
    title: 'عالج التسوّس قبل أن يصل العصب',
    subtitle: 'حشوات تجميلية بلون السن',
    body: 'حشوات مركّبة عالمية — علاج سريع، خالٍ من الألم، نتيجة طبيعية لا تُلاحظ.',
    cta: '📅 احجز موعد علاج',
    bg: 'linear-gradient(135deg,#16a34a 0%,#15803d 100%)',
    color: '#fff',
    targetService: 'حشوة'
  },
  whitening: {
    enabled: true,
    icon: '⭐',
    title: 'ابتسامة أنصع وأبيض',
    subtitle: 'تبييض احترافي للأسنان',
    body: 'تبييض آمن وفعّال بجلسة واحدة — نتائج فورية تدوم. مثالي قبل المناسبات.',
    cta: '📅 جلسة تبييض',
    bg: 'linear-gradient(135deg,#f59e0b 0%,#d97706 100%)',
    color: '#fff',
    targetService: 'تبييض'
  },
  checkup: {
    enabled: true,
    icon: '🔍',
    title: 'فحص دوري شامل',
    subtitle: 'كشف وفحص أسنان ولثة',
    body: 'الوقاية خير من العلاج — فحص دوري سريع للاطمئنان على صحة فمك. الكشف مجاني للحجوزات الجديدة.',
    cta: '📅 احجز فحصاً',
    bg: 'linear-gradient(135deg,#64748b 0%,#475569 100%)',
    color: '#fff',
    targetService: 'فحص'
  }
};

function ptAdsTpls(){
  return G('patientAds', JSON.parse(JSON.stringify(DEFAULT_PATIENT_ADS)));
}

// Compute the up-to-2 most relevant ads for a patient
function computePatientAds(patient){
  if (!patient) return [];
  var oa = patient.oralAssessment || {};
  var plans = G('plans', []).filter(function(p){return p.patientId===patient.id;});
  var ads = ptAdsTpls();

  // Honor patient's per-ad dismissals
  var dismissedKey = 'adsDismissed_'+patient.id;
  var dismissed = [];
  try { dismissed = JSON.parse(localStorage.getItem(dismissedKey)||'[]'); } catch(e){}

  // Skip ads for treatments currently in progress
  var hasActive = {};
  plans.forEach(function(pl){
    if (pl.status==='completed') return;
    if (pl.planType === 'implant') hasActive.implant = true;
    if (pl.planType === 'ortho')   hasActive.ortho = true;
    var d = pl.description || '';
    if (/(تاج|جسر|تركيب)/.test(d)) hasActive.crown = true;
    if (/(تنظيف|جير)/.test(d))     hasActive.cleaning = true;
    if (/تبييض/.test(d))           hasActive.whitening = true;
  });

  // Helper: turn a value (true/number) into a count
  function cnt(v){ return (typeof v === 'number') ? v : (v ? 1 : 0); }

  // Last cleaning timestamp
  var lastCleaningTs = 0;
  plans.forEach(function(pl){
    if (/(تنظيف|جير)/.test(pl.description||'')) {
      var ts = new Date(pl.completedAt||pl.createdAt||today()).getTime();
      if (ts > lastCleaningTs) lastCleaningTs = ts;
    }
  });
  var sixMonthsAgo = Date.now() - 180*86400000;
  var noRecentCleaning = lastCleaningTs < sixMonthsAgo;

  // Plan descriptions for fuzzy matching to deduce candidates
  var planTypes = plans.map(function(pl){return pl.planType||'';});

  var candidates = [];

  // Score each enabled ad
  Object.keys(ads).forEach(function(key){
    var ad = ads[key];
    if (!ad || ad.enabled === false) return;
    if (dismissed.indexOf(key) >= 0) return;
    if (hasActive[key]) return;

    var score = 0;

    if (key === 'implant') {
      var missing = cnt(oa.missing);
      if (missing >= 1) score = 100 + missing * 8;
      // boost if patient had nerve/extraction history but no implant yet
      if (cnt(oa.extraction) >= 1 && !planTypes.includes('implant')) score += 15;
    }
    else if (key === 'ortho') {
      if (oa.ortho) score = 95;
      else if (oa.bite) score = 80;
      // age check: ortho most relevant under 35
      if (patient.age && patient.age < 35) score += 10;
    }
    else if (key === 'crown') {
      if (oa.crown) score = 90;
      var nerveCount = cnt(oa.nerve);
      if (nerveCount >= 1) score = Math.max(score, 75 + nerveCount * 5);
    }
    else if (key === 'filling') {
      var fillCount = cnt(oa.filling_simple) + cnt(oa.filling_deep);
      if (fillCount >= 1) score = 70 + Math.min(fillCount*5, 25);
    }
    else if (key === 'cleaning') {
      if (oa.cleaning) score = 75;
      if (noRecentCleaning) score = Math.max(score, 60);
      // mostly always relevant — small fallback score
      if (score === 0) score = 25;
    }
    else if (key === 'whitening') {
      // Best candidate: healthy mouth, no major issues, after a cleaning
      if (oa.healthy) score = 55;
      else if (!oa.missing && !oa.nerve && !oa.crown) score = 35;
    }
    else if (key === 'checkup') {
      // Fallback for patients with no active conditions
      score = 20;
    }

    if (score > 0) candidates.push({ key: key, ad: ad, score: score });
  });

  candidates.sort(function(a,b){ return b.score - a.score; });
  return candidates.slice(0, 2);
}

// Render the ads block on the patient's My File page
function renderPatientAds(patient){
  var el = document.getElementById('myAds');
  if (!el) return;
  if (!patient) { el.innerHTML = ''; return; }

  var ads = computePatientAds(patient);
  if (!ads.length) { el.innerHTML = ''; return; }

  var clinic = G('clinic', {});
  var clinicPhone = clinic.phone ? normalizePhoneIQ(clinic.phone) : '';

  // Track impressions
  try {
    var imps = G('adsImpressions', {});
    ads.forEach(function(a){
      imps[a.key] = (imps[a.key]||0) + 1;
    });
    Sl('adsImpressions', imps); // local only — no cloud spam for impressions
  } catch(e){}

  var html = '<div style="margin:6px 0 14px">'+
    '<div style="font-size:11px;color:#64748b;margin-bottom:8px;font-weight:700;display:flex;align-items:center;gap:6px">'+
      '<span style="background:#fef3c7;color:#854d0e;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800">✨ مقترحة لك</span>'+
      '<span>عروض مختارة بناءً على فحصك</span>'+
    '</div>'+
    '<div style="display:grid;grid-template-columns:1fr;gap:10px">'+
    ads.map(function(a){
      var ad = a.ad;
      var safeTitle = String(ad.title||'').replace(/'/g,"\\'");
      var waMsg = encodeURIComponent('السلام عليكم، أرغب بالاستفسار عن: '+ (ad.title||'')+'\nاسمي: '+(patient.name||''));
      var waLink = clinicPhone ? ('https://wa.me/964'+clinicPhone+'?text='+waMsg) : '';
      return '<div style="background:'+(ad.bg||'#0d5c7a')+';color:'+(ad.color||'#fff')+';border-radius:14px;padding:16px 16px 14px;position:relative;overflow:hidden;box-shadow:0 6px 18px rgba(0,0,0,.14)">'+
        '<button onclick="dismissAd(\''+a.key+'\')" style="position:absolute;top:8px;left:8px;background:rgba(255,255,255,.18);border:none;color:'+(ad.color||'#fff')+';width:26px;height:26px;border-radius:50%;cursor:pointer;font-size:13px;line-height:1" title="إخفاء هذا الإعلان">✕</button>'+
        '<div style="display:flex;align-items:center;gap:14px;margin-bottom:10px;padding-left:30px">'+
          '<div style="font-size:48px;line-height:1">'+(ad.icon||'⭐')+'</div>'+
          '<div style="flex:1;min-width:0">'+
            '<div style="font-size:16px;font-weight:900;line-height:1.3">'+(ad.title||'')+'</div>'+
            '<div style="font-size:12px;opacity:.9;margin-top:3px">'+(ad.subtitle||'')+'</div>'+
          '</div>'+
        '</div>'+
        (ad.body ? '<div style="font-size:13px;line-height:1.65;opacity:.95;margin-bottom:12px">'+ad.body+'</div>' : '')+
        '<div style="display:flex;gap:8px">'+
          '<button onclick="adBookClick(\''+a.key+'\',\''+safeTitle+'\')" style="flex:1;background:rgba(255,255,255,.95);color:#0f172a;border:none;padding:12px;border-radius:10px;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit">'+(ad.cta||'📅 احجز موعداً')+'</button>'+
          (waLink ? '<a href="'+waLink+'" target="_blank" onclick="adWaClick(\''+a.key+'\')" style="background:rgba(255,255,255,.18);color:'+(ad.color||'#fff')+';border:1.5px solid rgba(255,255,255,.4);padding:11px 14px;border-radius:10px;font-weight:700;font-size:13px;text-decoration:none;display:flex;align-items:center;gap:4px">💬</a>' : '')+
        '</div>'+
      '</div>';
    }).join('')+
    '</div></div>';

  el.innerHTML = html;
}

// Patient dismisses an ad — remembered locally, doesn't bother them again on this device
function dismissAd(adKey){
  if (!CU || !CU.id) return;
  var key = 'adsDismissed_'+CU.id;
  var d = [];
  try { d = JSON.parse(localStorage.getItem(key)||'[]'); } catch(e){}
  if (d.indexOf(adKey) < 0) d.push(adKey);
  localStorage.setItem(key, JSON.stringify(d));
  if (typeof renderMyFile === 'function') renderMyFile();
}

// Track ad clicks (for analytics)
function adBookClick(adKey, title){
  var clicks = G('adsClicks', {});
  clicks[adKey] = (clicks[adKey]||0) + 1;
  S('adsClicks', clicks);
  // Pre-fill booking form context
  try { localStorage.setItem('bookappt_prefill', title || ''); } catch(e){}
  navTo('bookappt');
}
function adWaClick(adKey){
  var clicks = G('adsClicks', {});
  clicks[adKey+'_wa'] = (clicks[adKey+'_wa']||0) + 1;
  S('adsClicks', clicks);
}

// ═══════════════════════════════════════════════════════════════════
//  ADS SETTINGS PANEL (manager)
// ═══════════════════════════════════════════════════════════════════
function openAdsSettings(){
  if (!can('*')) { alert('فقط المدير يستطيع إدارة الإعلانات'); return; }
  var pnl = document.getElementById('adsSettingsPanel');
  if (!pnl) {
    // Create container in dashboard
    var dash = document.getElementById('pg-dashboard');
    pnl = document.createElement('div');
    pnl.id = 'adsSettingsPanel';
    pnl.style.cssText = 'margin:14px 0';
    if (dash) dash.appendChild(pnl);
  }
  if (pnl.style.display === 'block') { pnl.style.display = 'none'; pnl.innerHTML=''; return; }
  renderAdsSettings();
  pnl.style.display = 'block';
  pnl.scrollIntoView({behavior:'smooth', block:'start'});
}

function renderAdsSettings(){
  var pnl = document.getElementById('adsSettingsPanel');
  if (!pnl) return;
  var ads = ptAdsTpls();
  var clicks = G('adsClicks', {});
  var imps   = G('adsImpressions', {});

  var rows = Object.keys(ads).map(function(key){
    var ad = ads[key];
    var clk = clicks[key] || 0;
    var imp = imps[key] || 0;
    var ctr = imp ? Math.round(clk/imp*100) : 0;
    return '<div style="border:1.5px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:10px;background:'+(ad.enabled===false?'#f1f5f9':'#fff')+'">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">'+
        '<div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">'+
          '<div style="font-size:36px">'+(ad.icon||'⭐')+'</div>'+
          '<div style="flex:1;min-width:0">'+
            '<div style="font-weight:800;font-size:14px">'+(ad.title||key)+'</div>'+
            '<div style="font-size:11px;color:#64748b;margin-top:2px">'+(ad.subtitle||'')+'</div>'+
            '<div style="font-size:11px;margin-top:6px;display:flex;gap:10px;flex-wrap:wrap">'+
              '<span>👁️ '+imp+' عرض</span>'+
              '<span style="color:#16a34a">👆 '+clk+' نقرة</span>'+
              '<span style="color:#0d5c7a">📊 '+ctr+'% CTR</span>'+
            '</div>'+
          '</div>'+
        '</div>'+
        '<div style="display:flex;gap:6px;align-items:center">'+
          '<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">'+
            '<input type="checkbox" '+(ad.enabled!==false?'checked':'')+' onchange="adsToggle(\''+key+'\',this.checked)"> مفعّل'+
          '</label>'+
          '<button class="btn btn-ghost btn-xs" onclick="adsEdit(\''+key+'\')">✏️ تحرير</button>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');

  pnl.innerHTML =
    '<div class="card" style="border-right:4px solid #f59e0b">'+
      '<div class="card-header" style="background:#fef3c7;color:#854d0e">'+
        '<span class="card-title">📢 إعلانات بوابة المريض</span>'+
        '<div style="display:flex;gap:6px">'+
          '<button class="btn btn-ghost btn-xs" onclick="adsResetDefaults()">🔄 افتراضي</button>'+
          '<button class="btn btn-ghost btn-xs" onclick="openAdsSettings()">✕</button>'+
        '</div>'+
      '</div>'+
      '<div class="card-body">'+
        '<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;margin-bottom:12px;font-size:11px;color:#854d0e">'+
          '💡 الإعلانات تُعرض في صفحة "ملفي الطبي" للمريض، حتى إعلانان فقط لكل مريض، مختارة آلياً حسب فحصه (الأسنان المفقودة، التقويم، الحشوات...). لن يُعرض الإعلان لمريض يعالج هذه الحالة فعلاً.'+
        '</div>'+
        rows+
      '</div>'+
    '</div>';
}

function adsToggle(key, enabled){
  var ads = ptAdsTpls();
  if (!ads[key]) return;
  ads[key].enabled = !!enabled;
  S('patientAds', ads);
  audit('ad', key, 'toggle', !enabled, enabled, 'تفعيل/تعطيل إعلان');
  renderAdsSettings();
}

function adsResetDefaults(){
  if (!confirm('سيتم استعادة الإعلانات الافتراضية. هل أنت متأكد؟')) return;
  S('patientAds', JSON.parse(JSON.stringify(DEFAULT_PATIENT_ADS)));
  audit('ad', 'all', 'reset', null, 'defaults', 'استعادة الإعلانات الافتراضية');
  renderAdsSettings();
}

function adsEdit(key){
  var ads = ptAdsTpls();
  var ad = ads[key];
  if (!ad) return;
  // Build editor inline
  document.getElementById('adsEditKey').value = key;
  document.getElementById('adsEditIcon').value = ad.icon || '';
  document.getElementById('adsEditTitle').value = ad.title || '';
  document.getElementById('adsEditSubtitle').value = ad.subtitle || '';
  document.getElementById('adsEditBody').value = ad.body || '';
  document.getElementById('adsEditCta').value = ad.cta || '';
  document.getElementById('adsEditBg').value = ad.bg || '';
  openModal('mo-adsEdit');
}

function adsEditSave(){
  var key = document.getElementById('adsEditKey').value;
  var ads = ptAdsTpls();
  if (!ads[key]) return;
  var oldTitle = ads[key].title;
  ads[key].icon     = document.getElementById('adsEditIcon').value || '⭐';
  ads[key].title    = document.getElementById('adsEditTitle').value || '';
  ads[key].subtitle = document.getElementById('adsEditSubtitle').value || '';
  ads[key].body     = document.getElementById('adsEditBody').value || '';
  ads[key].cta      = document.getElementById('adsEditCta').value || '📅 احجز موعداً';
  var bg            = document.getElementById('adsEditBg').value || '';
  if (bg) ads[key].bg = bg;
  S('patientAds', ads);
  audit('ad', key, 'edit', oldTitle, ads[key].title, 'تحرير قالب الإعلان');
  closeModal('mo-adsEdit');
  renderAdsSettings();
  showToast('✅ تم حفظ الإعلان', 'success');
}

// Hook into renderMyFile (wrapping)
var _origRenderMyFile = (typeof renderMyFile === 'function') ? renderMyFile : null;
renderMyFile = function(){
  if (_origRenderMyFile) _origRenderMyFile();
  // After original render, add ads
  if (CU && CU.role === 'patient') {
    var p = G('patients', []).find(function(x){return x.id===CU.id;});
    if (p) renderPatientAds(p);
  }
};

// Add to BACKUP_KEYS
if (typeof BACKUP_KEYS !== 'undefined') {
  if (BACKUP_KEYS.indexOf('patientAds') < 0) BACKUP_KEYS.push('patientAds');
  if (BACKUP_KEYS.indexOf('adsClicks') < 0) BACKUP_KEYS.push('adsClicks');
}

console.log('✅ Patient ads module loaded');

console.log('✅ Soran v2.5 module loaded');

