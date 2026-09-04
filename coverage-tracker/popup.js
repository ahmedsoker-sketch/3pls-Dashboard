// ══════════════════════════════════════════════════════
// Assign Tool — popup.js
// ══════════════════════════════════════════════════════

const BASE = 'https://eg.me.logisticsbackoffice.com/api/rooster/v3';
let _viewMode = 'zone'; // 'zone' | 'office'
let _lastResult = null;
let _activeDate = null;

// ── Helpers ──────────────────────────────────────────
function getTodayCairo() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getThreeDays() {
  const base = new Date(new Date().toLocaleString('en-US',{timeZone:'Africa/Cairo'}));
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const d1 = new Date(base); d1.setDate(d1.getDate()+1);
  const d2 = new Date(base); d2.setDate(d2.getDate()+2);
  return [fmt(base), fmt(d1), fmt(d2)];
}
const norm = s => s.toLowerCase().replace(/[\s_\-()]/g,'');

function parseCSV(text) {
  if (!text?.trim()) return [];
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const parseLine = line => {
    const res = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === ',' && !inQ) { res.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    res.push(cur.trim()); return res;
  };
  const headers = parseLine(lines[0]).map(h => h.replace(/^"|"$/g,''));
  return lines.slice(1).map(line => {
    const vals = parseLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (vals[i]||'').replace(/^"|"$/g,''); });
    return row;
  });
}

function pctStyle(pct) {
  if (pct == null) return { bg:'transparent', text:'var(--text-muted)' };
  if (pct >= 0.85) return { bg:'var(--success-bg)', text:'var(--success-text)' };
  if (pct >= 0.65) return { bg:'var(--warn-bg)',    text:'var(--warn-text)' };
  return             { bg:'var(--danger-bg)',  text:'var(--danger-text)' };
}

function fmtNum(n) {
  if (typeof n !== 'number') return '—';
  return n % 1 ? n.toFixed(1) : String(n);
}

function deltaHtml(delta) {
  if (delta == null || delta === 0) return '';
  if (delta > 0) return `<sup class="delta-up">↑${delta}</sup>`;
  return `<sup class="delta-down">↓${Math.abs(delta)}</sup>`;
}

// ── Token ─────────────────────────────────────────────
function refreshToken() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'getToken' }, res => {
      const t = res?.token || null;
      const bar = document.getElementById('token-bar');
      if (t) { bar.className = 'token-bar token-ok'; bar.textContent = '🟢 Token جاهز'; }
      else   { bar.className = 'token-bar token-err'; bar.textContent = '🔴 Token مش موجود — افتح الموقع وسجل دخول'; }
      resolve(t);
    });
  });
}

// ── Data Fetching ──────────────────────────────────────
// Single API call covering exactly fromDate → toDate (3 days)
async function fetchShiftsRange(fromDate, toDate, token) {
  const params = new URLSearchParams({
    city_id:'1',
    start_at: fromDate+'T00:00:00.000Z',
    end_at:   toDate+'T23:59:59.000Z',
    page:'0', size:'10000', with_evaluations:'false', with_time_zone:'Africa/Cairo'
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000); // 30s timeout
  const res = await fetch(`${BASE}/shifts/export?${params}`, {
    headers: { 'authorization': 'Bearer '+token, 'accept': 'application/json' },
    signal: ctrl.signal
  }).finally(() => clearTimeout(timer));
  if (!res.ok) throw new Error('API error '+res.status);
  return parseCSV(await res.text());
}

async function fetchSheetCSV(url, retries = 2) {
  if (!url?.trim()) return [];
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url+(url.includes('?')?'&':'?')+'_t='+Date.now());
      if (r.ok) {
        const data = parseCSV(await r.text());
        if (data.length) return data;
      }
    } catch {}
    if (i < retries) await new Promise(res => setTimeout(res, 500));
  }
  return [];
}

// Fetch Sheet with cache fallback — if live fails, use last saved copy
async function fetchSheetCSVCached(url, cacheKey) {
  const live = await fetchSheetCSV(url);
  if (live.length) {
    chrome.storage.local.set({ [cacheKey]: live }); // update cache
    return { data: live, fromCache: false };
  }
  // Live failed — try cache
  const stored = await new Promise(r => chrome.storage.local.get(cacheKey, r));
  const cached = stored[cacheKey];
  if (cached?.length) return { data: cached, fromCache: true };
  return { data: [], fromCache: false };
}

// ── Core Processing ────────────────────────────────────
function processCoverage(today, shifts, headcount, targets) {
  if (!shifts.length || !headcount.length || !targets.length) return null;

  const sc = Object.keys(shifts[0]);
  const empCol  = sc.find(c => norm(c)==='employeeid'||norm(c)==='riderid');
  const dateCol = sc.find(c => norm(c).includes('startdate')&&!norm(c).includes('actual'));

  const scheduled = new Set();
  shifts.forEach(s => {
    const id   = String(s[empCol]||'').trim().replace(/\.0+$/,'');
    const date = String(s[dateCol]||'').slice(0,10);
    if (id && date===today) scheduled.add(id);
  });

  const hc = Object.keys(headcount[0]);
  const ridCol  = hc.find(c => norm(c)==='riderid'||norm(c)==='id')||hc[0];
  const zoneCol = hc.find(c => norm(c).includes('lastoperatingzone')||norm(c).includes('operatingzone'));
  const offCol  = hc.find(c => norm(c).includes('lastcontractname')||norm(c).includes('contractname'));
  const nameCol = hc.find(c => norm(c).includes('ridername')||norm(c)==='name'||norm(c).includes('firstname'));
  const phoneCol    = hc.find(c => norm(c).includes('phone')||norm(c).includes('mobile'));
  const lastShiftCol= hc.find(c => norm(c).includes('lastshift')||norm(c).includes('last_shift'));

  const riderMap = {};
  headcount.forEach(r => {
    const id        = String(r[ridCol]||'').trim().replace(/\.0+$/,'');
    const zone      = String(r[zoneCol]||'').trim();
    const office    = String(r[offCol]||'').trim();
    const name      = nameCol       ? String(r[nameCol]||'').trim()       : '';
    const phone     = phoneCol      ? String(r[phoneCol]||%').trim()      : '';
    const lastShift = lastShiftCol  ? String(r[lastShiftCol]||'').trim()  : '';
    if (id) riderMap[id] = { zone, office, name, phone, lastShift };
  });

  const tc = Object.keys(targets[0]);
  const t3plCol    = tc.find(c => norm(c)==='3plname'||norm(c).includes('3pl'))||tc[0];
  const tZoneCol   = tc.find(c => norm(c)==='zone')||tc[1];
  const tTargetCol = tc.find(c => norm(c)==='riderstarget'||(norm(c).includes('riders')&&norm(c).includes('target')));
  const tAwhCol    = tc.find(c => norm(c).includes('awh')||(norm(c).includes('average')&&norm(c).includes('work')));

  const targetMap = {};
  const awhMap    = {};
  targets.forEach(r => {
    const office = String(r[t3plCol]||'').trim();
    const zone   = String(r[tZoneCol]||'').trim();
    const target = parseFloat(String(r[tTargetCol]||'0').replace(/,/g,''))||0;
    const awh    = tAwhCol ? parseFloat(String(r[tAwhCol]||'0').replace(/,/g,''))||0 : 0;
    if (office && zone) {
      targetMap[zone+'|||'+office] = target;
      if (awh) awhMap[zone+'|||'+office] = awh;
    }
  });

  const countMap = {};
  scheduled.forEach(id => {
    const info = riderMap[id];
    if (!info?.zone||!info?.office) return;
    const key = info.zone+'|||'+info.office;
    countMap[key] = (countMap[key]||0)+1;
  });
  targets.forEach(r => {
    const office = String(r[t3plCol]||'').trim();
    const zone   = String(r[tZoneCol]||'').trim();
    if (office && zone) { const key=zone+'|||'+office; if (!(key in countMap)) countMap[key]=0; }
  });

  // Zone-centric — sorted by target DESC
  const zoneData = {};
  Object.entries(countMap).forEach(([key, sched]) => {
    const [zone, office] = key.split('|||');
    const target = targetMap[key]||0;
    const awh    = awhMap[key]||0;
    if (!zoneData[zone]) zoneData[zone] = [];
    zoneData[zone].push({ office, scheduled:sched, target, pct: target>0?sched/target:null, delta:null, awh });
  });
  Object.values(zoneData).forEach(arr => arr.sort((a,b) => b.target - a.target));

  // Office-centric — sorted by target DESC
  const officeData = {};
  Object.entries(countMap).forEach(([key, sched]) => {
    const [zone, office] = key.split('|||');
    const target = targetMap[key]||0;
    if (!officeData[office]) officeData[office] = [];
    officeData[office].push({ zone, scheduled:sched, target, pct: target>0?sched/target:null, delta:null });
  });
  Object.values(officeData).forEach(arr => arr.sort((a,b) => b.target - a.target));

  // Snapshot for delta
  const snapshot = {};
  Object.entries(countMap).forEach(([k,v]) => { snapshot[k]=v; });

  // Rider list for dashboard — sorted by zone then lastShift DESC
  const riderList = Object.entries(riderMap).map(([id, info]) => ({
    id, name: info.name, zone: info.zone, office: info.office, phone: info.phone,
    lastShift: info.lastShift||'', scheduled: scheduled.has(id)
  })).filter(r => r.zone && r.office)
    .sort((a,b) => {
      if (a.zone < b.zone) return -1;
      if (a.zone > b.zone) return 1;
      // same zone: sort by lastShift DESC (most recent first)
      if (b.lastShift && a.lastShift) return b.lastShift.localeCompare(a.lastShift);
      if (b.lastShift) return 1;
      if (a.lastShift) return -1;
      return 0;
    });

  return { zoneData, officeData, totalScheduled: scheduled.size, snapshot, riderList };
}

// ── Delta helpers ──────────────────────────────────────
async function loadPrevSnapshot(date) {
  const d = await new Promise(r => chrome.storage.local.get('cov_snap', r));
  const snap = d.cov_snap;
  // Support new format {date: snapshot} and ignore old format {date:'...', snapshot:{}}
  if (!snap || snap.date) return null;
  return snap[date] || null;
}
function saveCurrSnapshot(date, snapshot) {
  chrome.storage.local.get('cov_snap', d => {
    const snaps = (d.cov_snap && !d.cov_snap.date) ? d.cov_snap : {};
    snaps[date] = snapshot;
    chrome.storage.local.set({ cov_snap: snaps });
  });
}
function applyDeltas(result, prevSnap) {
  if (!prevSnap) return;
  Object.entries(result.zoneData).forEach(([zone, offices]) => {
    offices.forEach(o => {
      const key = zone+'|||'+o.office;
      o.delta = prevSnap[key] !== undefined ? o.scheduled - prevSnap[key] : null;
    });
  });
  Object.entries(result.officeData).forEach(([office, zones]) => {
    zones.forEach(z => {
      const key = z.zone+'|||'+office;
      z.delta = prevSnap[key] !== undefined ? z.scheduled - prevSnap[key] : null;
    });
  });
}

// ── Zone Overview Cards (top summary) ──────────────────
function renderZoneOverview(zoneData) {
  const el = document.getElementById('zone-overview');
  if (!el) return;
  const zones = Object.keys(zoneData).sort();
  if (!zones.length) { el.innerHTML = ''; return; }
  el.innerHTML = zones.map(zone => {
    const offices  = zoneData[zone];
    const ts = offices.reduce((s,o) => s + o.scheduled, 0);
    const tt = offices.reduce((s,o) => s + o.target, 0);
    const pct = tt > 0 ? Math.round(ts / tt * 100) : null;
    const cls = pct === null ? '' : pct >= 85 ? 'pct-ok' : pct >= 70 ? 'pct-warn' : 'pct-bad';

    // Weighted average AWH: Σ(awh×scheduled) / Σ(scheduled)
    const totalHrs = offices.reduce((s,o) => s + (o.awh||0) * o.scheduled, 0);
    const avgAwh   = ts > 0 && totalHrs > 0 ? (totalHrs / ts).toFixed(1) : null;
    const totalHrsRounded = avgAwh ? Math.round(totalHrs) : null;

    return `<div class="zov-card">
      <div class="zov-name">${zone}</div>
      <div class="zov-nums">${ts} <span>/ ${tt}</span></div>
      ${pct !== null ? `<div class="zov-pct ${cls}">${pct}%</div>` : ''}
      ${avgAwh ? `<div class="zov-hrs">⏱ ${avgAwh}h · ${totalHrsRounded} hrs</div>` : ''}
    </div>`;
  }).join('');
}

// ── Zone View ──────────────────────────────────────────
function renderDashboard(zoneData) {
  const container = document.getElementById('dashboard');
  const zones = Object.keys(zoneData).sort();
  if (!zones.length) { container.innerHTML = '<div class="empty-state">📭 مفيش بيانات</div>'; return; }

  window._zoneDataMap = {};
  let html = '';
  zones.forEach(zone => {
    const offices  = zoneData[zone];
    window._zoneDataMap[zone] = offices;
    const ts = offices.reduce((s,o)=>s+o.scheduled,0);
    const tt = offices.reduce((s,o)=>s+o.target,0);
    const zp = tt>0?ts/tt:null;
    const zs = pctStyle(zp);
    const zpStr = zp!==null?Math.round(zp*100)+'%':'—';

    html += `
    <div class="zone-card">
      <div class="zone-header">
        <div class="zone-left">
          <span class="zone-arrow">▼</span>
          <span class="zone-name">${zone}</span>
          <span class="pill" style="background:${zs.bg};color:${zs.text}">${zpStr}</span>
        </div>
        <div class="zone-right">
          <span class="zone-total"><b>${ts}</b> / ${fmtNum(tt)}</span>
          <button class="copy-img-btn" data-zone="${zone}" title="نسخ كصورة">📷</button>
        </div>
      </div>
      <div class="zone-body">
        <table><thead><tr>
          <th>المكتب (3PL)</th><th>مجدول</th><th>Target</th><th>%</th>
        </tr></thead><tbody>`;

    offices.forEach(o => {
      const os = pctStyle(o.pct);
      const pStr = o.pct!==null?Math.round(o.pct*100)+'%':'—';
      html += `<tr>
        <td style="font-weight:500">${o.office}</td>
        <td><b>${o.scheduled}</b> ${deltaHtml(o.delta)}</td>
        <td style="color:var(--text-secondary)">${fmtNum(o.target)||'—'}</td>
        <td><span class="pill" style="background:${os.bg};color:${os.text}">${pStr}</span></td>
      </tr>`;
    });
    html += `</tbody></table></div></div>`;
  });

  container.innerHTML = html;
  _bindZoneEvents(container);
}

// ── Office View ────────────────────────────────────────
function renderOfficeView(officeData) {
  const container = document.getElementById('dashboard');
  const offices = Object.keys(officeData).sort();
  if (!offices.length) { container.innerHTML = '<div class="empty-state">📭 مفيش بيانات</div>'; return; }

  window._zoneDataMap = window._zoneDataMap || {};
  let html = '';
  offices.forEach(office => {
    const zones = officeData[office];
    // store for copy with prefix
    window._zoneDataMap['__office__'+office] = zones.map(z=>({office:z.zone, scheduled:z.scheduled, target:z.target, pct:z.pct, delta:z.delta}));

    const ts = zones.reduce((s,z)=>s+z.scheduled,0);
    const tt = zones.reduce((s,z)=>s+z.target,0);
    const op = tt>0?ts/tt:null;
    const os = pctStyle(op);
    const opStr = op!==null?Math.round(op*100)+'%':'—';

    html += `
    <div class="zone-card">
      <div class="zone-header">
        <div class="zone-left">
          <span class="zone-arrow">▼</span>
          <span class="zone-name">${office}</span>
          <span class="pill" style="background:${os.bg};color:${os.text}">${opStr}</span>
        </div>
        <div class="zone-right">
          <span class="zone-total"><b>${ts}</b> / ${fmtNum(tt)}</span>
          <button class="copy-img-btn" data-zone="__office__${office}" title="نسخ كصورة">📷</button>
        </div>
      </div>
      <div class="zone-body">
        <table><thead><tr>
          <th>المنطقة</th><th>مجدول</th><th>Target</th><th>%</th>
        </tr></thead><tbody>`;

    zones.forEach(z => {
      const zs = pctStyle(z.pct);
      const pStr = z.pct!==null?Math.round(z.pct*100)+'%':'—';
      html += `<tr>
        <td style="font-weight:500">${z.zone}</td>
        <td><b>${z.scheduled}</b> ${deltaHtml(z.delta)}</td>
        <td style="color:var(--text-secondary)">${fmtNum(z.target)||'—'}</td>
        <td><span class="pill" style="background:${zs.bg};color:${zs.text}">${pStr}</span></td>
      </tr>`;
    });
    html += `</tbody></table></div></div>`;
  });

  container.innerHTML = html;
  _bindZoneEvents(container);
}

function _bindZoneEvents(container) {
  container.querySelectorAll('.zone-header').forEach(h => h.addEventListener('click', ()=>toggleZone(h)));
  container.querySelectorAll('.copy-img-btn').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); copyZoneImg(b.dataset.zone); }));
}

function toggleZone(header) {
  const body  = header.nextElementSibling;
  const arrow = header.querySelector('.zone-arrow');
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (arrow) arrow.style.transform = isOpen ? 'rotate(-90deg)' : '';
}

// ── Main Build ─────────────────────────────────────────
async function buildCoverage(showLoading=true) {
  const statusEl = document.getElementById('status-bar');
  if (showLoading) statusEl.textContent = '⏳ جاري تحميل البيانات...';

  const token = await refreshToken();
  if (!token) { statusEl.textContent = '❌ مش متصل — افتح الموقع الأول'; return; }

  const stored = await new Promise(r => chrome.storage.local.get(['cov_hc_url','cov_tg_url','cov_wh_url'], r));
  if (!stored.cov_hc_url || !stored.cov_tg_url) {
    document.getElementById('settings-body').style.display = 'block';
    document.getElementById('settings-arrow').style.transform = '';
    statusEl.textContent = '⚠️ اضبط الـ URLs في الإعدادات الأول';
    return;
  }

  const dates = getThreeDays(); // [today, tomorrow, day2]
  try {
    // Single API call covers all 3 days
    const [allShifts, hcRes, tgRes] = await Promise.all([
      fetchShiftsRange(dates[0], dates[2], token),
      fetchSheetCSVCached(stored.cov_hc_url, 'cov_hc_cache'),
      fetchSheetCSVCached(stored.cov_tg_url, 'cov_tg_cache')
    ]);
    const headcount = hcRes.data;
    const targets   = tgRes.data;

    if (!allShifts.length) { statusEl.textContent = '❌ مش قادر يسحب الشيفتات'; return; }
    if (!headcount.length) { statusEl.textContent = '❌ HeadCount URL غلط أو فاضي'; return; }
    if (!targets.length)   { statusEl.textContent = '❌ 3PLS Target URL غلط أو فاضي'; return; }

    const cacheNote = (hcRes.fromCache || tgRes.fromCache) ? ' 📦 cached' : '';

    // Process each day separately (processCoverage filters by date internally)
    const byDate = {};
    for (const date of dates) {
      const result = processCoverage(date, allShifts, headcount, targets);
      if (result) {
        const prevSnap = await loadPrevSnapshot(date);
        applyDeltas(result, prevSnap);
        saveCurrSnapshot(date, result.snapshot);
        byDate[date] = result;
      }
    }

    if (!byDate[dates[0]]) { statusEl.textContent = '⚠️ مش قادر يعالج البيانات'; return; }

    _lastResult = { byDate, dates };
    if (!_activeDate || !byDate[_activeDate]) _activeDate = dates[0];

    renderDaySelector();
    renderCurrentDay();

    const _now = new Date(new Date().toLocaleString('en-US',{timeZone:'Africa/Cairo'}));
    const nowStr = _now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true});
    const statusText = `✅ ${nowStr} | ${byDate[dates[0]].totalScheduled} مجدول اليوم${cacheNote}`;
    statusEl.textContent = statusText;

    // حفظ النتيجة عؼان تتعرض عند فتح التول بدون API call
    try {
      chrome.storage.local.set({ cov_last_result: { byDate, dates, statusText } });
    } catch(e) {}

    // Webhook handled by background.js only (avoids CORS errors in popup context)

    // Push 3 days to GitHub
    pushAllDaysToGitHub(byDate, dates, nowStr);

  } catch(e) {
    statusEl.textContent = '❌ خطأ: '+e.message;
  }
}

// ── Active Day Helpers ─────────────────────────────────
function getActiveData() {
  if (!_lastResult || !_activeDate) return null;
  return _lastResult.byDate[_activeDate] || null;
}
function renderCurrentDay() {
  const d = getActiveData();
  if (!d) return;
  renderZoneOverview(d.zoneData);
  if (_viewMode === 'office') renderOfficeView(d.officeData);
  else renderDashboard(d.zoneData);
}
function setActiveDate(date) {
  if (!_lastResult?.byDate[date]) return;
  _activeDate = date;
  renderDaySelector();
  renderCurrentDay();
}
function renderDaySelector() {
  if (!_lastResult) return;
  const { dates } = _lastResult;
  const labels = ['النهارده','بكرة','بعده'];
  const dayAr  = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  let sel = document.getElementById('day-selector');
  if (!sel) {
    sel = document.createElement('div');
    sel.id = 'day-selector';
    sel.style.cssText = 'display:flex;gap:5px;margin-bottom:.65rem';
    document.getElementById('dashboard').before(sel);
  }
  sel.innerHTML = dates.map((d,i) => {
    const dt = new Date(d+'T12:00:00Z');
    const dayName = dayAr[dt.getUTCDay()];
    const active  = d === _activeDate;
    return `<button data-date="${d}" style="flex:1;padding:5px 4px;border:1px solid ${active?'var(--accent)':'var(--border)'};border-radius:7px;background:${active?'var(--accent)':'var(--surface)'};color:${active?'#fff':'var(--text-secondary)'};font-family:Poppins,sans-serif;font-size:11px;font-weight:${active?700:500};cursor:pointer;line-height:1.3;transition:all .15s"><div>${labels[i]}</div><div style="font-size:9px;opacity:.8">${dayName}</div></button>`;
  }).join('');
  sel.querySelectorAll('button[data-date]').forEach(btn => {
    btn.addEventListener('click', () => setActiveDate(btn.dataset.date));
  });
}

// ── GitHub Push ────────────────────────────────────────
async function pushFileToGitHub(path, content, token) {
  const owner = 'ahmedsoker-sketch', repo = '3pls-Dashboard';
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000); // 60s per file
  try {
    let sha = null;
    const gr = await fetch(apiUrl, {
      headers: {'Authorization':'token '+token,'User-Agent':'AssignTool-Extension'},
      signal: ctrl.signal
    });
    if (gr.ok) { const j = await gr.json(); sha = j.sha; }
    else if (gr.status === 401) { clearTimeout(timer); return { ok:false, status:401, path }; }
    const payload = { message:'Update '+path, content: btoa(unescape(encodeURIComponent(content))) };
    if (sha) payload.sha = sha;
    const pr = await fetch(apiUrl, {
      method:'PUT',
      headers:{'Authorization':'token '+token,'Content-Type':'application/json','User-Agent':'AssignTool-Extension'},
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!pr.ok) { console.log('GitHub push failed:',path,pr.status); return { ok:false, status:pr.status, path }; }
    console.log('GitHub push OK:',path);
    return { ok:true, path };
  } catch(e) {
    clearTimeout(timer);
    console.log('GitHub push error:',path,e.message);
    return { ok:false, status:e.name==='AbortError'?'timeout':e.message, path };
  }
}

function setGhStatus(html) {
  const el = document.getElementById('gh-status');
  if (el) el.innerHTML = html;
}

async function pushAllDaysToGitHub(byDate, dates, timestamp) {
  try {
    const stored = await chrome.storage.local.get(['github_token']);
    const token = stored.github_token;
    if (!token) { setGhStatus('<span style="color:#ffb0b0">⚠️ GitHub Token مش محفوظ</span>'); return; }
    setGhStatus('<span style="color:rgba(244,237,227,.45)">⬆️ جاري الرفع على GitHub...</span>');
    const keys = ['today','tomorrow','day2'];
    const hdr  = 'Date,Timestamp,Rider ID,Name,Zone,Office,Phone,Last Shift,Scheduled';
    const jobs = dates.map(async (date, i) => {
      const result = byDate[date];
      if (!result?.riderList?.length) return;
      const lines = [hdr];
      result.riderList.forEach(r => lines.push([
        date, timestamp, r.id,
        (r.name||'').replace(/,/g,''), (r.zone||'').replace(/,/g,''), (r.office||'').replace(/,/g,''),
        (r.phone||'').replace(/,/g,''), (r.lastShift||'').replace(/,/g,''), r.scheduled?'Yes':'No'
      ].join(',')));
      await pushFileToGitHub(`rider-data-${keys[i]}.csv`, lines.join('\n'), token);
    });
    // Targets (today's data — same targets for all days)
    const todayRes = byDate[dates[0]];
    if (todayRes) {
      const targets = [];
      Object.entries(todayRes.zoneData).forEach(([zone,offices]) => offices.forEach(o => targets.push({zone,office:o.office,target:o.target,scheduled:o.scheduled})));
      jobs.push(pushFileToGitHub('targets-data.json', JSON.stringify({date:dates[0],timestamp,targets},null,2), token));
    }
    // Dates metadata (for dashboard day labels)
    jobs.push(pushFileToGitHub('rider-data-dates.json', JSON.stringify({today:dates[0],tomorrow:dates[1],day2:dates[2],pushedAt:timestamp}), token));
    const results = await Promise.all(jobs);
    // Purge jsDelivr CDN cache so dashboard sees new data immediately
    const base = 'https://purge.jsdelivr.net/gh/ahmedsoker-sketch/3pls-Dashboard@main/';
    ['rider-data-today.csv','rider-data-tomorrow.csv','rider-data-day2.csv','targets-data.json','rider-data-dates.json']
      .forEach(f => fetch(base + f).catch(()=>{}));
    // Show upload result in UI
    const failed = results.filter(r => r && !r.ok);
    if (failed.length === 0) {
      setGhStatus('<span style="color:#a8ffb0">✅ GitHub — تم الرفع ' + timestamp + '</span>');
    } else {
      const code = failed[0].status;
      let msg = '❌ فشل الرفع';
      if (code === 401)       msg += ' — التوكن غلط أو انتهت صلاحيته (401)';
      else if (code === 403)  msg += ' — التوكن مش عنده صلاحية كتابة (403)';
      else if (code === 404)  msg += ' — الريبو مش موجود (404)';
      else if (code === 422)  msg += ' — خطأ في البيانات (422)';
      else if (code === 'timeout') msg += ' — انقطع الاتصال (timeout)';
      else if (code)          msg += ' — كود ' + code;
      setGhStatus('<span style="color:#ffb0b0">' + msg + '</span>');
    }
  } catch(e) {
    console.log('GitHub push error:',e.message);
    setGhStatus('<span style="color:#ffb0b0">❌ خطأ: ' + e.message + '</span>');
  }
}

// ── (legacy — kept for reference, not used) ────────────
async function pushRiderDataToGitHub(riders, date, timestamp) {
  try {
    const stored = await chrome.storage.local.get(['github_token']);
    const token = stored.github_token;
    if (!token) return;
    const owner = 'ahmedsoker-sketch';
    const repo  = '3pls-Dashboard';
    const path  = 'rider-data.csv';
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

    // Build CSV
    const lines = ['Date,Timestamp,Rider ID,Name,Zone,Office,Phone,Last Shift,Scheduled'];
    riders.forEach(r => {
      lines.push([
        date, timestamp, r.id,
        (r.name      ||'').replace(/,/g,''),
        (r.zone      ||'').replace(/,/g,''),
        (r.office    ||'').replace(/,/g,''),
        (r.phone     ||'').replace(/,/g,''),
        (r.lastShift ||'').replace(/,/g,''),
        r.scheduled ? 'Yes' : 'No'
      ].join(','));
    });
    const csv = lines.join('\n');

    // Get current SHA (needed to update existing file)
    let sha = null;
    const getResp = await fetch(apiUrl, {
      headers: { 'Authorization': 'token ' + token, 'User-Agent': 'AssignTool-Extension' }
    });
    if (getResp.ok) { const j = await getResp.json(); sha = j.sha; }

    // Push
    const payload = {
      message: 'Update rider data ' + date + ' ' + timestamp,
      content: btoa(unescape(encodeURIComponent(csv)))
    };
    if (sha) payload.sha = sha;

    const putResp = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'token ' + token,
        'Content-Type': 'application/json',
        'User-Agent': 'AssignTool-Extension'
      },
      body: JSON.stringify(payload)
    });
    if (!putResp.ok) {
      const err = await putResp.text();
      console.log('GitHub push failed:', putResp.status, err);
    } else {
      console.log('GitHub push OK — rider-data.csv updated');
    }
  } catch(e) {
    console.log('GitHub push error:', e.message);
  }
}

// ── Push Targets to GitHub ─────────────────────────────
async function pushTargetsToGitHub(zoneData, date, timestamp) {
  try {
    const stored = await chrome.storage.local.get(['github_token']);
    const token = stored.github_token;
    if (!token) return;
    const owner = 'ahmedsoker-sketch';
    const repo  = '3pls-Dashboard';
    const path  = 'targets-data.json';
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

    // Build targets array: [{zone, office, target, scheduled}]
    const targets = [];
    Object.entries(zoneData).forEach(([zone, offices]) => {
      offices.forEach(o => {
        targets.push({ zone, office: o.office, target: o.target, scheduled: o.scheduled });
      });
    });

    const payload_data = { date, timestamp, targets };
    const json = JSON.stringify(payload_data, null, 2);

    // Get current SHA
    let sha = null;
    const getResp = await fetch(apiUrl, {
      headers: { 'Authorization': 'token ' + token, 'User-Agent': 'AssignTool-Extension' }
    });
    if (getResp.ok) { const j = await getResp.json(); sha = j.sha; }

    const payload = {
      message: 'Update targets ' + date,
      content: btoa(unescape(encodeURIComponent(json)))
    };
    if (sha) payload.sha = sha;

    await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'token ' + token,
        'Content-Type': 'application/json',
        'User-Agent': 'AssignTool-Extension'
      },
      body: JSON.stringify(payload)
    });
    console.log('GitHub targets push OK');
  } catch(e) {
    console.log('GitHub targets push error:', e.message);
  }
}

// ── Copy as Image ──────────────────────────────────────
function copyZoneImg(zoneName) {
  const offices = window._zoneDataMap?.[zoneName];
  if (!offices) return;
  const isDark = document.documentElement.getAttribute('data-theme')==='dark';
  const label  = zoneName.startsWith('__office__') ? zoneName.replace('__office__','') : zoneName;
  const canvas = drawZoneCanvas(label, offices, isDark, 4); // 4K
  canvas.toBlob(async blob => {
    try {
      await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
      document.querySelectorAll('.copy-img-btn').forEach(b => {
        if (b.dataset.zone===zoneName) { b.textContent='✅'; setTimeout(()=>b.textContent='📷',1500); }
      });
    } catch(e) { alert('مش قادر ينسخ'); }
  });
}

function drawZoneCanvas(label, offices, isDark, SCALE=2) {
  const W=460, ROW=34, HDR=46, THDR=26, PAD=14;
  const H = HDR+THDR+offices.length*ROW+1;
  const cv=document.createElement('canvas'); cv.width=W*SCALE; cv.height=H*SCALE;
  const c=cv.getContext('2d'); c.scale(SCALE,SCALE);
  const C=isDark
    ?{bg:'#181816',surf:'#232321',bdr:'#3d3d3a',txt:'#f0f0ec',muted:'#7a7a78',hbg:'#1e1e1c'}
    :{bg:'#F4EDE3',surf:'#ffffff',bdr:'#e8ddd3',txt:'#1a0f0a',muted:'#9a9a98',hbg:'#f1ebe4'};
  c.fillStyle=C.surf; _rr(c,0,0,W,H,10); c.fill();
  c.fillStyle=C.hbg; _rrTop(c,0,0,W,HDR,10); c.fill();
  // Zone name (LTR — names are English)
  c.fillStyle=C.txt; c.font='bold 14px Arial,sans-serif';
  c.direction='ltr'; c.textAlign='right'; c.textBaseline='middle';
  c.fillText(label, W-PAD, HDR/2);
  // ▼ drawn as triangle path — sized 14×9 logical px, visible color
  const lw=c.measureText(label).width;
  const ax=W-PAD-lw-14, ay=HDR/2+1;
  c.fillStyle = isDark ? 'rgba(244,237,227,0.7)' : 'rgba(26,15,10,0.55)';
  c.beginPath(); c.moveTo(ax-7,ay-5); c.lineTo(ax+7,ay-5); c.lineTo(ax,ay+5); c.closePath(); c.fill();
  const ts=offices.reduce((s,o)=>s+o.scheduled,0), tt=offices.reduce((s,o)=>s+o.target,0), zp=tt>0?ts/tt:null;
  if (zp!==null) {
    const pc=_pc(zp,isDark);
    c.fillStyle=pc.bg; _rr(c,PAD,(HDR-20)/2,50,20,10); c.fill();
    c.fillStyle=pc.fg; c.font='bold 11px Arial'; c.direction='ltr'; c.textAlign='center';
    c.fillText(Math.round(zp*100)+'%',PAD+25,HDR/2);
    c.fillStyle=C.muted; c.font='11px Arial'; c.textAlign='left';
    c.fillText(ts+' / '+fmtNum(tt),PAD+58,HDR/2);
  }
  c.fillStyle=C.bg; c.fillRect(0,HDR,W,THDR);
  c.strokeStyle=C.bdr; c.lineWidth=0.5; _ln(c,0,HDR+THDR,W,HDR+THDR);
  const hdrs=[{t:'المكتب',x:W-PAD,a:'right'},{t:'مجدول',x:W-PAD-170,a:'center'},{t:'Target',x:W-PAD-240,a:'center'},{t:'%',x:PAD+25,a:'center'}];
  c.fillStyle=C.muted; c.font='bold 9px Arial'; c.direction='rtl';
  hdrs.forEach(h=>{c.textAlign=h.a; c.fillText(h.t,h.x,HDR+THDR/2);});
  offices.forEach((o,i)=>{
    const y=HDR+THDR+i*ROW;
    if (i>0){c.strokeStyle=C.bdr;c.lineWidth=0.5;_ln(c,0,y,W,y);}
    if (i%2===1){c.fillStyle=C.bg;c.fillRect(0,y,W,ROW);}
    const my=y+ROW/2;
    c.fillStyle=C.txt; c.font='12px Arial'; c.textAlign='right'; c.direction='rtl';
    c.fillText(o.office,W-PAD,my);
    c.font='bold 12px Arial'; c.direction='ltr'; c.textAlign='center';
    c.fillText(String(o.scheduled),W-PAD-170,my);
    // Delta ↑↓ superscript
    if (o.delta !== null && o.delta !== undefined && o.delta !== 0) {
      const sw = c.measureText(String(o.scheduled)).width;
      const dX = W-PAD-170 + sw/2 + 2;
      c.fillStyle = o.delta > 0 ? (isDark?'#5ab85a':'#2d7a2d') : (isDark?'#e07070':'#c0392b');
      c.font = 'bold 9px Arial'; c.textAlign = 'left';
      c.fillText((o.delta>0?'↑':'↓')+Math.abs(o.delta), dX, my-6);
    }
    c.fillStyle=C.muted; c.font='12px Arial';
    c.fillText(fmtNum(o.target)||'—',W-PAD-240,my);
    if (o.pct!==null){const pp=Math.round(o.pct*100),pc=_pc(o.pct,isDark); c.fillStyle=pc.bg;_rr(c,PAD,my-9,50,18,9);c.fill();c.fillStyle=pc.fg;c.font='bold 10px Arial';c.textAlign='center';c.fillText(pp+'%',PAD+25,my);}
  });
  c.strokeStyle=C.bdr; c.lineWidth=1; _rr(c,0.5,0.5,W-1,H-1,10); c.stroke();
  return cv;
}
function _rr(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.lineTo(x+w-r,y);c.quadraticCurveTo(x+w,y,x+w,y+r);c.lineTo(x+w,y+h-r);c.quadraticCurveTo(x+w,y+h,x+w-r,y+h);c.lineTo(x+r,y+h);c.quadraticCurveTo(x,y+h,x,y+h-r);c.lineTo(x,y+r);c.quadraticCurveTo(x,y,x+r,y);c.closePath();}
function _rrTop(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.lineTo(x+w-r,y);c.quadraticCurveTo(x+w,y,x+w,y+r);c.lineTo(x+w,y+h);c.lineTo(x,y+h);c.lineTo(x,y+r);c.quadraticCurveTo(x,y,x+r,y);c.closePath();}
function _ln(c,x1,y1,x2,y2){c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.stroke();}
function _pc(p,dark){if(p>=0.85)return dark?{bg:'#152215',fg:'#5ab85a'}:{bg:'#edf7ed',fg:'#2d7a2d'};if(p>=0.65)return dark?{bg:'#221a08',fg:'#f0b429'}:{bg:'#fff8e6',fg:'#b07800'};return dark?{bg:'#1e1010',fg:'#e07070'}:{bg:'#fef0f0',fg:'#c0392b'};}


// ── Copy All Zones as One Image (side-by-side, 4K) ────────────────────────
async function copyAllZonesImg() {
  const activeData = getActiveData();
  if (!activeData) return;
  const btn = document.getElementById('copy-all-btn');
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
  try {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const data   = _viewMode === 'office' ? activeData.officeData : activeData.zoneData;
    const keys   = Object.keys(data).sort();
    if (!keys.length) return;

    const HI = 4;                         // 4K quality scale
    const PAD = 24 * HI;                  // gap between canvases (scaled)
    const OUTER = 20 * HI;               // outer padding

    // Render each zone at 4K
    const canvases = keys.map(k => drawZoneCanvas(k, data[k], isDark, HI));

    // Side-by-side layout
    const totalW = canvases.reduce((s, cv) => s + cv.width, 0)
                 + PAD * (canvases.length - 1) + OUTER * 2;
    const totalH = Math.max(...canvases.map(cv => cv.height)) + OUTER * 2;

    const combined = document.createElement('canvas');
    combined.width = totalW; combined.height = totalH;
    const ctx = combined.getContext('2d');
    const bg  = isDark ? '#181816' : '#F4EDE3';
    ctx.fillStyle = bg; ctx.fillRect(0, 0, totalW, totalH);

    let x = OUTER;
    canvases.forEach(cv => {
      // Vertically center each canvas
      const yOff = OUTER + Math.floor((totalH - OUTER*2 - cv.height) / 2);
      ctx.drawImage(cv, x, yOff);
      x += cv.width + PAD;
    });

    combined.toBlob(async blob => {
      await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
      if (btn) { btn.textContent = '✅'; setTimeout(() => { btn.textContent = '📷 كل'; btn.disabled = false; }, 1500); }
    });
  } catch(e) {
    alert('مش قادر ينسخ: ' + e.message);
    if (btn) { btn.textContent = '📷 كل'; btn.disabled = false; }
  }
}

// ── Settings ───────────────────────────────────────────
function initSettings() {
  chrome.storage.local.get(['cov_hc_url','cov_tg_url','cov_wh_url','cov_auto','cov_interval','github_token'], res => {
    if (res.cov_hc_url) document.getElementById('hc-url').value = res.cov_hc_url;
    if (res.cov_tg_url) document.getElementById('tg-url').value = res.cov_tg_url;
    if (res.cov_wh_url) document.getElementById('wh-url').value = res.cov_wh_url;
    if (res.github_token) document.getElementById('github-token').value = res.github_token;
    document.getElementById('auto-refresh-toggle').checked = !!res.cov_auto;
    const interval = res.cov_interval||60;
    document.querySelectorAll('.interval-btn').forEach(b => {
      const active = parseInt(b.dataset.val)===interval;
      b.style.background  = active?'var(--accent)':'';
      b.style.color       = active?'#fff':'';
      b.style.borderColor = active?'var(--accent)':'';
    });
  });
}
function saveSettings() {
  chrome.storage.local.set({
    cov_hc_url: document.getElementById('hc-url').value.trim(),
    cov_tg_url: document.getElementById('tg-url').value.trim(),
    cov_wh_url: document.getElementById('wh-url').value.trim(),
    github_token: document.getElementById('github-token').value.trim()
  });
  const btn=document.getElementById('save-settings-btn');
  btn.textContent='✅ تم!'; setTimeout(()=>btn.textContent='💾 حفظ الإعدادات',1500);
}

// ── Countdown ──────────────────────────────────────────
let _cd=null;
function startCountdown() {
  const el=document.getElementById('timer-bar'); if(!el)return;
  chrome.alarms.get('covRefresh',alarm=>{
    if(!alarm){el.style.display='none'; if(_cd)clearInterval(_cd); return;}
    el.style.display='block';
    if(_cd)clearInterval(_cd);
    const tick=()=>{const diff=alarm.scheduledTime-Date.now();if(diff<=0){el.textContent='⏳ جاري التحديث...';return;}const m=Math.floor(diff/60000),s=Math.floor((diff%60000)/1000);el.textContent=`⏱️ تحديث بعد: ${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;};
    tick(); _cd=setInterval(tick,1000);
  });
}

// ── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Theme
  document.getElementById('theme-btn').addEventListener('click',()=>{
    const d=document.documentElement.getAttribute('data-theme')==='dark';
    document.documentElement.setAttribute('data-theme',d?'':'dark');
    document.getElementById('theme-btn').textContent=d?'🌙':'☀️';
    chrome.storage.local.set({cov_theme:d?'':'dark'});
  });
  chrome.storage.local.get('cov_theme',res=>{
    if(res.cov_theme){document.documentElement.setAttribute('data-theme',res.cov_theme);document.getElementById('theme-btn').textContent=res.cov_theme==='dark'?'☀️':'🌙';}
  });

  // Settings toggle
  document.getElementById('settings-toggle').addEventListener('click',()=>{
    const b=document.getElementById('settings-body'),a=document.getElementById('settings-arrow');
    const o=b.style.display!=='none'; b.style.display=o?'none':'block'; a.style.transform=o?'rotate(-90deg)':'';
  });
  document.getElementById('save-settings-btn').addEventListener('click',saveSettings);
  document.getElementById('refresh-btn').addEventListener('click',()=>buildCoverage(true));

  // View toggle
  document.getElementById('btn-zone-view').addEventListener('click',()=>setView('zone'));
  document.getElementById('btn-office-view').addEventListener('click',()=>setView('office'));
  document.getElementById('copy-all-btn').addEventListener('click', copyAllZonesImg);

  function setView(mode) {
    _viewMode = mode;
    document.getElementById('btn-zone-view').classList.toggle('vtbtn-active', mode==='zone');
    document.getElementById('btn-office-view').classList.toggle('vtbtn-active', mode==='office');
    if (_lastResult) renderCurrentDay();
  }

  // Auto-refresh
  document.getElementById('auto-refresh-toggle').addEventListener('change',e=>{
    const enabled=e.target.checked; chrome.storage.local.set({cov_auto:enabled});
    chrome.storage.local.get('cov_interval',res=>{ const mins=res.cov_interval||60; chrome.runtime.sendMessage({action:'setCovAlarm',enabled,mins},()=>setTimeout(startCountdown,300)); });
    if(!enabled){document.getElementById('timer-bar').style.display='none'; if(_cd)clearInterval(_cd);}
  });
  document.querySelectorAll('.interval-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const val=parseInt(btn.dataset.val); chrome.storage.local.set({cov_interval:val});
      document.querySelectorAll('.interval-btn').forEach(b=>{const a=parseInt(b.dataset.val)===val;b.style.background=a?'var(--accent)':'';b.style.color=a?'#fff':'';b.style.borderColor=a?'var(--accent)':'';});
      if(document.getElementById('auto-refresh-toggle').checked) chrome.runtime.sendMessage({action:'setCovAlarm',enabled:true,mins:val},()=>setTimeout(startCountdown,300));
    });
  });

  chrome.runtime.onMessage.addListener(req=>{
    if(req.action==='covRefreshDone') loadCachedResult(); // background already saved result
    if(req.action==='covAlarmReset')  startCountdown();
  });

  initSettings(); startCountdown(); loadCachedResult();
});

// ── Load cached result on open (no API call) ───────────
function loadCachedResult() {
  const statusEl = document.getElementById('status-bar');
  refreshToken(); // update token bar UI only, no data fetch
  chrome.storage.local.get('cov_last_result', res => {
    const cached = res.cov_last_result;
    if (cached?.byDate && cached?.dates) {
      _lastResult  = cached;
      _activeDate  = cached.dates[0];
      renderDaySelector();
      renderCurrentDay();
      statusEl.textContent = (cached.statusText || '📦 آخر بيانات محفوظة') + ' — اظغط 🔄 للتحديث';
    } else {
      statusEl.textContent = 'اضغط 🔄 لبدء التحميل';
    }
  });
}
