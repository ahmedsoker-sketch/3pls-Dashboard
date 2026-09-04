// ══════════════════════════════════════════════════════
// Assign Tool — background.js (Service Worker)
// ══════════════════════════════════════════════════════

const BASE = 'https://eg.me.logisticsbackoffice.com/api/rooster/v3';

// ── Open side panel on icon click ─────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(()=>{});
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(()=>{});

// ── Token Capture ─────────────────────────────────────
chrome.webRequest.onSendHeaders.addListener(
  details => {
    const auth = (details.requestHeaders||[]).find(h => h.name.toLowerCase()==='authorization');
    if (auth?.value?.startsWith('Bearer ')) {
      chrome.storage.local.set({ cached_token: auth.value.replace('Bearer ',''), token_ts: Date.now() });
    }
  },
  { urls: ['https://eg.me.logisticsbackoffice.com/*'] },
  ['requestHeaders']
);

// ── Message Handler ───────────────────────────────────
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.action === 'getToken') {
    chrome.storage.local.get(['cached_token','token_ts'], res => {
      const fresh = res.token_ts && (Date.now()-res.token_ts) < 6*3600*1000;
      sendResponse({ token: fresh ? res.cached_token : null });
    });
    return true;
  }
  if (req.action === 'setCovAlarm') {
    if (req.enabled) {
      chrome.alarms.create('covRefresh', { periodInMinutes: req.mins });
    } else {
      chrome.alarms.clear('covRefresh');
    }
    sendResponse({ ok: true });
    return true;
  }
});

// ── Alarm Handler ─────────────────────────────────────
// async + await keeps the service worker alive until all uploads complete
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'covRefresh' || alarm.name === 'covRetry') await runBackground();
});

// ── Background Run ────────────────────────────────────
let _bgRunning = false;
async function runBackground() {
  if (_bgRunning) { console.log('BG already running, skip'); return; }
  _bgRunning = true;
  try { await _runBackgroundImpl(); } finally { _bgRunning = false; }
}
async function _runBackgroundImpl() {
  const stored = await chrome.storage.local.get(['cached_token','token_ts','cov_hc_url','cov_tg_url','cov_wh_url','github_token']);
  const fresh  = stored.token_ts && (Date.now()-stored.token_ts) < 6*3600*1000;
  if (!fresh || !stored.cov_hc_url || !stored.cov_tg_url) return;

  try {
    const dates = getThreeDays();
    const _bgNow = new Date(new Date().toLocaleString('en-US',{timeZone:'Africa/Cairo'}));
    const nowStr = _bgNow.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true});

    // Shifts: always fresh from Rooster API
    // Headcount + Targets: use popup's saved cache — popup fetches these correctly
    // (service worker context can't reliably access Google Sheets with auth cookies)
    const [allShifts, hcStored, tgStored] = await Promise.all([
      fetchShiftsRange(dates[0], dates[2], stored.cached_token),
      new Promise(r => chrome.storage.local.get('cov_hc_cache', r)),
      new Promise(r => chrome.storage.local.get('cov_tg_cache', r))
    ]);
    let headcount = hcStored.cov_hc_cache || [];
    let targets   = tgStored.cov_tg_cache || [];
    // Fallback: fetch fresh only if cache is completely empty (first-ever run)
    if (!headcount.length) headcount = await fetchSheetCSVCached(stored.cov_hc_url, 'cov_hc_cache');
    if (!targets.length)   targets   = await fetchSheetCSVCached(stored.cov_tg_url, 'cov_tg_cache');
    console.log(`BG data: shifts=${allShifts.length} hc=${headcount.length} tg=${targets.length}`);

    const byDate = {};
    for (const date of dates) {
      const result = processCoverage(date, allShifts, headcount, targets);
      if (result) byDate[date] = result;
    }

    const todayRes = byDate[dates[0]];
    if (!todayRes) return;

    // Save result for popup to display without re-fetching
    const statusText = `✅ ${nowStr} | ${todayRes.totalScheduled} مجدول اليوم`;
    chrome.storage.local.set({ cov_last_result: { byDate, dates, statusText } });

    // Notify popup to load from cache
    chrome.runtime.sendMessage({ action: 'covRefreshDone' }).catch(()=>{});
    chrome.runtime.sendMessage({ action: 'covAlarmReset' }).catch(()=>{});

    // Webhook (today only)
    if (stored.cov_wh_url) {
      const summary = [];
      Object.entries(todayRes.zoneData).forEach(([zone,offices]) => {
        offices.forEach(o => summary.push({zone,office:o.office,scheduled:o.scheduled,target:o.target,pct:o.pct!==null?Math.round(o.pct*100):null}));
      });
      fetch(stored.cov_wh_url, {method:'POST', body: JSON.stringify({action:'coverage_snapshot',timestamp:nowStr,date:dates[0],data:summary})}).catch(()=>{});
      if (todayRes.riderList?.length) {
        fetch(stored.cov_wh_url, {method:'POST', body: JSON.stringify({action:'rider_data',timestamp:nowStr,date:dates[0],riders:todayRes.riderList})}).catch(()=>{});
      }
    }

    // Push 3 days to GitHub — retry in 5 min if CSVs fail
    if (stored.github_token) {
      const { attempted, pushed } = await bgPushAllDays(byDate, dates, nowStr, stored.github_token);
      if (attempted > 0 && pushed < attempted) {
        // Had data to push but upload failed → retry in 5 minutes
        chrome.alarms.create('covRetry', { delayInMinutes: 5 });
        console.log('BG push incomplete, retry in 5 min');
      } else {
        // Push succeeded (or nothing to push) → clear any pending retry
        chrome.alarms.clear('covRetry');
      }
    }

    chrome.notifications.create('cov_done', {
      type:'basic', iconUrl:'icon48.png', title:'Assign Tool',
      message:`✅ ${todayRes.totalScheduled} طيار مجدول`
    });
  } catch(e) {
    console.error('BG error:', e);
  }
}

// ── GitHub Push Helpers ───────────────────────────────
async function bgPushFile(path, content, token) {
  const owner = 'ahmedsoker-sketch', repo = '3pls-Dashboard';
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000); // 60s per file

  async function fetchFreshSha() {
    const gr = await fetch(apiUrl, {
      headers: {'Authorization':'token '+token,'User-Agent':'AssignTool-BG'},
      signal: ctrl.signal
    });
    if (gr.ok) { const j = await gr.json(); return j.sha || null; }
    return null;
  }

  try {
    let sha = await fetchFreshSha();
    const encoded = btoa(unescape(encodeURIComponent(content)));
    const doput = async (s) => {
      const payload = { message:'Update '+path, content: encoded };
      if (s) payload.sha = s;
      return fetch(apiUrl, {
        method:'PUT',
        headers:{'Authorization':'token '+token,'Content-Type':'application/json','User-Agent':'AssignTool-BG'},
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
    };
    let pr = await doput(sha);
    // 409 = stale SHA — re-fetch and retry once
    if (pr.status === 409) {
      console.log('BG GitHub 409 on', path, '— retrying with fresh SHA');
      sha = await fetchFreshSha();
      pr  = await doput(sha);
    }
    if (!pr.ok) { console.log('BG GitHub push failed:',path,pr.status); return false; }
    else        { console.log('BG GitHub push OK:',path); return true; }
  } catch(e) {
    console.log('BG GitHub push error:',path,e.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Push files sequentially — avoids GitHub 409 branch conflicts from parallel writes
async function bgPushAllDays(byDate, dates, timestamp, token) {
  try {
    const keys = ['today','tomorrow','day2'];
    console.log('BG bgPushAllDays — riderList:', keys.map((k,i)=>`${k}:${byDate[dates[i]]?.riderList?.length||0}`).join(', '));
    const hdr  = 'Date,Timestamp,Rider ID,Name,Zone,Office,Phone,Last Shift,Scheduled';
    let csvAttempted = 0, csvPushed = 0;

    // Push CSVs one at a time (sequential = no SHA race on GitHub)
    for (let i = 0; i < dates.length; i++) {
      const result = byDate[dates[i]];
      if (!result?.riderList?.length) continue;
      csvAttempted++;
      const lines = [hdr];
      result.riderList.forEach(r => lines.push([
        dates[i], timestamp, r.id,
        (r.name||'').replace(/,/g,''), (r.zone||'').replace(/,/g,''), (r.office||'').replace(/,/g,''),
        (r.phone||'').replace(/,/g,''), (r.lastShift||'').replace(/,/g,''), r.scheduled?'Yes':'No'
      ].join(',')));
      const ok = await bgPushFile(`rider-data-${keys[i]}.csv`, lines.join('\n'), token);
      if (ok) csvPushed++;
    }

    // Targets (today only)
    const todayRes = byDate[dates[0]];
    if (todayRes) {
      const targets = [];
      Object.entries(todayRes.zoneData).forEach(([zone,offices]) => offices.forEach(o => targets.push({zone,office:o.office,target:o.target,scheduled:o.scheduled})));
      await bgPushFile('targets-data.json', JSON.stringify({date:dates[0],timestamp,targets},null,2), token);
    }

    // dates.json last — its presence signals a complete push
    await bgPushFile('rider-data-dates.json', JSON.stringify({today:dates[0],tomorrow:dates[1],day2:dates[2],pushedAt:timestamp}), token);

    console.log(`BG push done: ${csvPushed}/${csvAttempted} CSVs pushed`);
    return { attempted: csvAttempted, pushed: csvPushed };
  } catch(e) {
    console.log('BG GitHub push error:',e.message);
    return { attempted: 0, pushed: 0 };
  }
}

// ── Helpers ───────────────────────────────────────────
function getTodayCairo() {
  const d = new Date(new Date().toLocaleString('en-US',{timeZone:'Africa/Cairo'}));
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getThreeDays() {
  const base = new Date(new Date().toLocaleString('en-US',{timeZone:'Africa/Cairo'}));
  return [0,1,2].map(offset => {
    const d = new Date(base);
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  });
}

const norm = s => s.toLowerCase().replace(/[\s_\-()]/g,'');

function parseCSV(text) {
  if (!text?.trim()) return [];
  const lines = text.split(/\r?\n/).filter(l=>l.trim());
  if (lines.length < 2) return [];
  const parseLine = line => {
    const res=[]; let cur='',inQ=false;
    for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ;}else if(c===','&&!inQ){res.push(cur.trim());cur='';}else cur+=c;}
    res.push(cur.trim()); return res;
  };
  const headers = parseLine(lines[0]).map(h=>h.replace(/^"|"$/g,''));
  return lines.slice(1).map(line=>{const vals=parseLine(line);const row={};headers.forEach((h,i)=>{row[h]=(vals[i]||'').replace(/^"|"$/g,'');});return row;});
}

async function fetchShiftsRange(fromDate, toDate, token) {
  // Exact 3-day range: today → day2
  const params = new URLSearchParams({
    city_id:'1',
    start_at: fromDate+'T00:00:00.000Z',
    end_at:   toDate+'T23:59:59.000Z',
    page:'0', size:'10000', with_evaluations:'false', with_time_zone:'Africa/Cairo'
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000); // 30s timeout
  const res = await fetch(`${BASE}/shifts/export?${params}`, {
    headers: { authorization: 'Bearer '+token, accept: 'application/json' },
    signal: ctrl.signal
  }).finally(() => clearTimeout(timer));
  if (!res.ok) throw new Error('API '+res.status);
  return parseCSV(await res.text());
}

async function fetchSheetCSV(url, retries = 2) {
  if (!url?.trim()) return [];
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url+(url.includes('?')?'&':'?')+'_t='+Date.now());
      if (r.ok) { const d = parseCSV(await r.text()); if (d.length) return d; }
    } catch {}
    if (i < retries) await new Promise(res => setTimeout(res, 500));
  }
  return [];
}

async function fetchSheetCSVCached(url, cacheKey) {
  const live = await fetchSheetCSV(url);
  if (live.length) {
    chrome.storage.local.set({ [cacheKey]: live });
    return live;
  }
  const stored = await new Promise(r => chrome.storage.local.get(cacheKey, r));
  return stored[cacheKey] || [];
}

function processCoverage(today, shifts, headcount, targets) {
  if(!shifts.length||!headcount.length||!targets.length) return null;
  const sc=Object.keys(shifts[0]);
  const empCol=sc.find(c=>norm(c)==='employeeid'||norm(c)==='riderid');
  const dateCol=sc.find(c=>norm(c).includes('startdate')&&!norm(c).includes('actual'));
  const scheduled=new Set();
  shifts.forEach(s=>{const id=String(s[empCol]||'').trim().replace(/\.0+$/,'');const date=String(s[dateCol]||'').slice(0,10);if(id&&date===today)scheduled.add(id);});
  const hc=Object.keys(headcount[0]);
  const ridCol=hc.find(c=>norm(c)==='riderid'||norm(c)==='id')||hc[0];
  const zoneCol=hc.find(c=>norm(c).includes('lastoperatingzone')||norm(c).includes('operatingzone'));
  const offCol=hc.find(c=>norm(c).includes('lastcontractname')||norm(c).includes('contractname'));
  const nameCol=hc.find(c=>norm(c).includes('ridername')||norm(c)==='name'||norm(c).includes('firstname'));
  const phoneCol=hc.find(c=>norm(c).includes('phone')||norm(c).includes('mobile'));
  const riderMap={};
  headcount.forEach(r=>{const id=String(r[ridCol]||'').trim().replace(/\.0+$/,'');const zone=String(r[zoneCol]||'').trim();const office=String(r[offCol]||'').trim();const name=nameCol?String(r[nameCol]||'').trim():'';const phone=phoneCol?String(r[phoneCol]||'').trim():'';if(id)riderMap[id]={zone,office,name,phone};});
  const tc=Object.keys(targets[0]);
  const t3plCol=tc.find(c=>norm(c)==='3plname'||norm(c).includes('3pl'))||tc[0];
  const tZoneCol=tc.find(c=>norm(c)==='zone')||tc[1];
  const tTargetCol=tc.find(c=>norm(c)==='riderstarget'||(norm(c).includes('riders')&&norm(c).includes('target')));
  const targetMap={};
  targets.forEach(r=>{const office=String(r[t3plCol]||'').trim();const zone=String(r[tZoneCol]||'').trim();const target=parseFloat(String(r[tTargetCol]||'0').replace(/,/g,''))||0;if(office&&zone)targetMap[zone+'|||'+office]=target;});
  const countMap={};
  scheduled.forEach(id=>{const info=riderMap[id];if(!info?.zone||!info?.office)return;const key=info.zone+'|||'+info.office;countMap[key]=(countMap[key]||0)+1;});
  targets.forEach(r=>{const office=String(r[t3plCol]||'').trim();const zone=String(r[tZoneCol]||'').trim();if(office&&zone){const key=zone+'|||'+office;if(!(key in countMap))countMap[key]=0;}});
  const zoneData={};
  Object.entries(countMap).forEach(([key,sched])=>{const[zone,office]=key.split('|||');const target=targetMap[key]||0;if(!zoneData[zone])zoneData[zone]=[];zoneData[zone].push({office,scheduled:sched,target,pct:target>0?sched/target:null,delta:null});});
  Object.values(zoneData).forEach(arr=>arr.sort((a,b)=>b.target-a.target));
  const riderList=Object.entries(riderMap).map(([id,info])=>({id,name:info.name,zone:info.zone,office:info.office,phone:info.phone,scheduled:scheduled.has(id)})).filter(r=>r.zone&&r.office);
  // Office-centric
  const officeData={};
  Object.entries(countMap).forEach(([key,sched])=>{const[zone,office]=key.split('|||');const target=targetMap[key]||0;if(!officeData[office])officeData[office]=[];officeData[office].push({zone,scheduled:sched,target,pct:target>0?sched/target:null,delta:null});});
  Object.values(officeData).forEach(arr=>arr.sort((a,b)=>b.target-a.target));
  // Snapshot
  const snapshot={};Object.entries(countMap).forEach(([k,v])=>{snapshot[k]=v;});
  return {zoneData, officeData, totalScheduled:scheduled.size, snapshot, riderList};
}
