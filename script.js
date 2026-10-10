
const SUPABASE_URL = 'https://mvaepekgvzqyuettixvd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Rp-h4XEN8aK27Hx7-RKKpQ_HXNCX12G';

// localeCompareは呼ぶたびに照合器を作るため、ソートでは使い回す
const jaCollator = new Intl.Collator('ja');
const PALETTE = ['#eebbcd','#4fb0c6','#e07a5f','#8bc34a','#b085f5','#f06292','#4dd0e1','#ffb74d','#9ccc65','#7986cb'];


function colorForBase(base){
  let hash = 0;
  for (let i = 0; i < base.length; i++){
    hash = (hash * 31 + base.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PALETTE.length;
  return PALETTE[idx];
}

const canvas = document.getElementById('chart');
const tableWrap = document.getElementById('tableWrap');
const craftWrap = document.getElementById('craftWrap');
const avgWrap = document.getElementById('avgWrap');
const favoritesWrap = document.getElementById('favoritesWrap');
let useLadderPricing = false;
document.getElementById('ladderPricingToggle').addEventListener('change', e => {
  useLadderPricing = e.target.checked;
  refreshPanels(['craft']);
});
  const tabsEl = document.getElementById('tabs');
const searchEl = document.getElementById('search');
const pickerListEl = document.getElementById('pickerList');
const chartTitleEl = document.getElementById('chartTitle');
const statusLineEl = document.getElementById('statusLine');
const lastUpdatedEl = document.getElementById('lastUpdatedLine');
const dataSpanLineEl = document.getElementById('dataSpanLine');
const levelToggleListEl = document.getElementById('levelToggleList');

const HIDDEN_LEVELS_STORAGE_KEY = 'market-hidden-levels';
const FAVORITES_STORAGE_KEY = 'market-favorites';

let store = [];
let hiddenLevels = new Set(); 
let favorites = new Set();
let allSeries = [];
let allSeriesFull = [];
let series = [];
let hidden = new Set();
let chartInstance = null;
let activeCategory = '__ALL__';
let searchText = '';
let rangeDays = 0;


const REST_URL = `${SUPABASE_URL}/rest/v1/price_records`;
const SELECT_COLS = 'id,t,label,base,level,price,category';
const ORDER = 'order=t.asc,id.asc';       // idも並べて、ページ境界で順序が揺れないようにする
const PAGE_SIZE = 1000;
const FETCH_CONCURRENCY = 5;               // 並列取得数
const REFRESH_MS = 5 * 60 * 1000;
const FULL_RESYNC_MS = 3 * 60 * 60 * 1000;  // 古い行の修正を拾うため、これより古ければ全件取得し直す
const RECENT_WINDOW_MS = 3 * 86400000;     // 直近この期間は毎回丸ごと取得して置き換える(修正・削除も反映)
const IDB_NAME = 'market-cache';
const IDB_STORE = 'kv';
const CACHE_KEY = 'price_records_v1';
const ROW_CHUNK = 200;                     // 表は200行ずつ、スクロールに応じて追加描画

let storeVersion = 0;
let fullSyncedAt = 0;
let refreshing = false;
let lastRefreshAt = 0;
let rendered = false;
let selectionInitialized = false;

// ---- IndexedDB キャッシュ（失敗しても動作は継続）----
let dbPromise = null;
function idb(){
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function idbGet(key){
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (err) { console.warn('cache read failed', err); return undefined; }
}
async function idbSet(key, value){
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) { console.warn('cache write failed', err); }
}

// ---- Supabase 取得 ----
async function fetchPage(query, from, to, withCount){
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Range-Unit': 'items',
    'Range': `${from}-${to}`,
  };
  if (withCount) headers['Prefer'] = 'count=exact';
  const res = await fetch(`${REST_URL}?${query}`, { headers });
  if (res.status === 416) return { rows: [], total: 0 };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const m = /\/(\d+)$/.exec(res.headers.get('Content-Range') || '');
  return { rows: await res.json(), total: m ? Number(m[1]) : null };
}

// 1ページ目で総件数を取得し、残りのページを並列で取得する
async function fetchAllRows(query, onProgress){
  const first = await fetchPage(query, 0, PAGE_SIZE - 1, true);
  const size = first.rows.length;
  if (first.total === null) {
    // Content-Rangeが読めない場合は順次取得
    let all = first.rows, last = first.rows, from = size;
    while (last.length >= PAGE_SIZE) {
      last = (await fetchPage(query, from, from + PAGE_SIZE - 1, false)).rows;
      all = all.concat(last);
      from += PAGE_SIZE;
    }
    return all;
  }
  if (size >= first.total) return first.rows;
  const pages = Math.ceil(first.total / size);
  const results = new Array(pages);
  results[0] = first.rows;
  let next = 1, done = 1;
  const worker = async () => {
    while (next < pages) {
      const p = next++;
      results[p] = (await fetchPage(query, p * size, (p + 1) * size - 1, false)).rows;
      if (onProgress) onProgress(++done, pages);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, pages - 1) }, worker));
  return results.flat();
}

const normalizeRow = r => ({
  id: String(r.id),
  t: Number(r.t),
  label: r.label,
  base: r.base,
  level: Number(r.level),
  price: Number(r.price),
  category: r.category || '未分類',
});
const rowEq = (o, r) => o.id === r.id && o.t === r.t && o.price === r.price && o.level === r.level && o.base === r.base && o.label === r.label && o.category === r.category;
const cmpRow = (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// idで重複排除しつつマージ。storeは常に t,id 昇順を保つ
function mergeRows(current, incoming){
  const map = new Map(current.map(r => [r.id, r]));
  let changed = false;
  for (const r of incoming) {
    const o = map.get(r.id);
    if (!o || !rowEq(o, r)) {
      map.set(r.id, r);
      changed = true;
    }
  }
  return changed ? { rows: [...map.values()].sort(cmpRow), changed } : { rows: current, changed };
}

// IndexedDBへの保存(構造化複製)は重いので、描画を妨げないようアイドル時に行う
let saveQueued = false;
function scheduleCacheSave(){
  if (saveQueued) return;
  saveQueued = true;
  const run = () => { saveQueued = false; idbSet(CACHE_KEY, { rows: store, fullSyncedAt }); };
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 5000 });
  else setTimeout(run, 1000);
}

// 通常は「最新tより後の差分」+「総件数の照合」だけ。件数が合わない/12時間以上経過なら全件取得
async function syncStore(onProgress){
  const needFull = !store.length || Date.now() - fullSyncedAt > FULL_RESYNC_MS;
  let next = null, changed = false;
  if (!needFull) {
    const winStart = store[store.length - 1].t - RECENT_WINDOW_MS;
    const [recent, count] = await Promise.all([
      fetchAllRows(`select=${SELECT_COLS}&t=gte.${winStart}&${ORDER}`),
      fetchPage('select=id', 0, 0, true),
    ]);
    const fresh = mergeRows([], recent.map(normalizeRow)).rows;   // 重複排除+昇順
    let idx = store.length;
    while (idx > 0 && store[idx - 1].t >= winStart) idx--;
    const merged = store.slice(0, idx).concat(fresh);              // 期間より前は据え置き、期間内は置き換え
    // 期間より前で追加/削除があれば総件数が合わない → 全件取得へ
    if (count.total === null || count.total === merged.length) {
      const old = store.slice(idx);
      changed = old.length !== fresh.length || old.some((o, k) => !rowEq(o, fresh[k]));
      next = changed ? merged : store;
    }
  }
  if (!next) {
    const rows = await fetchAllRows(`select=${SELECT_COLS}&${ORDER}`, onProgress);
    next = mergeRows([], rows.map(normalizeRow)).rows;
    changed = true;
    fullSyncedAt = Date.now();
  }
  if (changed) {
    store = next;
    scheduleCacheSave();
  }
  return changed;
}

function onStoreChanged(){
  storeVersion++;
  updateLastUpdatedLine();
  updateDataSpanLine();
}

async function refresh(){
  if (refreshing) return false;
  refreshing = true;
  let changed = false;
  try {
    changed = await syncStore((done, pages) => {
      if (!store.length) statusLineEl.textContent = `読み込み中… ${done}/${pages}`;
    });
    statusLineEl.classList.remove('err');
    statusLineEl.textContent = store.length ? '' : 'まだデータがありません。';
    if (changed) { onStoreChanged(); render(); }
  } catch (err) {
    console.error(err);
    statusLineEl.textContent = store.length
      ? '最新データの取得に失敗しました。保存済みのデータを表示しています。'
      : 'データの読み込みに失敗しました。時間をおいて再読み込みしてください。';
    statusLineEl.classList.add('err');
  } finally {
    refreshing = false;
    lastRefreshAt = Date.now();
  }
  return changed;
}

function formatDateTime(ts){
  const d = new Date(ts);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// storeは時刻昇順なので先頭/末尾を参照するだけでよい（Math.max(...)の大量展開も回避）
function updateLastUpdatedLine(){
  if (!store.length){ lastUpdatedEl.textContent = ''; return; }
  lastUpdatedEl.textContent = `データ更新日: ${formatDateTime(store[store.length - 1].t)}`;
}

function updateDataSpanLine(){
  if (!store.length){ dataSpanLineEl.textContent = ''; return; }
  const days = Math.max(1, Math.ceil((store[store.length - 1].t - store[0].t) / 86400000) + 1);
  dataSpanLineEl.textContent = `現在 ${days} 日分のデータがあります`;
}


function loadHiddenLevelsFromLocalStorage(){
  try {
    const raw = localStorage.getItem(HIDDEN_LEVELS_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    hiddenLevels = new Set(Array.isArray(arr) ? arr.filter(n => Number.isFinite(n)) : []);
  } catch (err) {
    console.error(err);
    hiddenLevels = new Set();
  }
}

function saveHiddenLevelsToLocalStorage(){
  try {
    localStorage.setItem(HIDDEN_LEVELS_STORAGE_KEY, JSON.stringify([...hiddenLevels]));
  } catch (err) {
    console.error(err);
  }
}

function loadFavoritesFromLocalStorage(){
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    favorites = new Set(Array.isArray(arr) ? arr : []);
  } catch (err) {
    console.error(err);
    favorites = new Set();
  }
}

function saveFavoritesToLocalStorage(){
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...favorites]));
  } catch (err) {
    console.error(err);
  }
}

function toggleFavorite(base){
  if (favorites.has(base)) favorites.delete(base); else favorites.add(base);
  saveFavoritesToLocalStorage();
  drawPicker();
  refreshPanels(['favorites']);
}

let levelsCache = { version: -1, levels: [] };
function allLevelsInStore(){
  if (levelsCache.version !== storeVersion) {
    levelsCache = { version: storeVersion, levels: [...new Set(store.map(r => r.level))].sort((a, b) => a - b) };
  }
  return levelsCache.levels;
}

function renderLevelToggles(){
  const levels = allLevelsInStore();
  levelToggleListEl.innerHTML = '';
  if (!levels.length){
    levelToggleListEl.innerHTML = '<div class="picker-empty">データがありません。</div>';
    return;
  }
  levels.forEach(lv => {
    const isHidden = hiddenLevels.has(lv);
    const label = document.createElement('label');
    label.className = 'level-toggle' + (isHidden ? ' is-hidden' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !isHidden;
    cb.onchange = () => {
      if (cb.checked) hiddenLevels.delete(lv); else hiddenLevels.add(lv);
      saveHiddenLevelsToLocalStorage();
      render();
    };
    const span = document.createElement('span');
    span.textContent = '+' + lv;
    label.appendChild(cb);
    label.appendChild(span);
    levelToggleListEl.appendChild(label);
  });
}


function visibleStore(){
  let rows = hiddenLevels.size ? store.filter(r => !hiddenLevels.has(r.level)) : store;
  if (rangeDays > 0) {
    const cutoff = Date.now() - rangeDays * 86400000;
    rows = rows.filter(r => r.t >= cutoff);
  }
  return rows;
}

function visibleStoreForCraft(){
  return hiddenLevels.size ? store.filter(r => !hiddenLevels.has(r.level)) : store;
}

function buildCategoryMap(records){
  const map = new Map();
  for (const r of records) {
    if (!r.category || r.category === '未分類') continue;
    if (!map.has(r.base)) map.set(r.base, r.category);
  }
  return map;
}

function buildSeries(records, categoryMap){
  const groups = new Map();
  for (const r of records) {
    if (!groups.has(r.base)) groups.set(r.base, { category: r.category, hist: new Map() });
    const g = groups.get(r.base);
    if (r.category && r.category !== '未分類') g.category = r.category;
    if (!g.hist.has(r.level)) g.hist.set(r.level, []);
    g.hist.get(r.level).push({ t: r.t, price: r.price, label: r.label });
  }

  const result = [];
  for (const [base, g] of groups) {
    const history = new Map();
    for (const [level, arr] of g.hist) {
      arr.sort((a, b) => a.t - b.t);
      history.set(level, arr);
    }
    const points = [...history.entries()]
      .map(([level, arr]) => ({ level, price: arr[arr.length - 1].price }))
      .sort((a, b) => a.level - b.level);
    const resolvedCategory = (categoryMap && categoryMap.get(base)) || g.category || '未分類';
    result.push({
      base,
      category: resolvedCategory,
      color: colorForBase(base),
      points,
      history,
    });
  }
  return result;
}

function fmt(n){ return n.toLocaleString('ja-JP'); }
function pad2(n){ return String(n).padStart(2, '0'); }
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// データ・期間・強化値フィルタが変わらない限り系列を再構築しない
let seriesCache = { version: -1, categoryMap: null, full: null, byBase: null, visKey: '', visible: null };
function getSeriesSets(){
  const c = seriesCache;
  if (c.version !== storeVersion) {
    c.version = storeVersion;
    c.categoryMap = buildCategoryMap(store);
    c.full = buildSeries(store, c.categoryMap);
    c.byBase = new Map(c.full.map(s => [s.base, s]));
    c.visKey = '';
  }
  const key = `${rangeDays}|${[...hiddenLevels].sort((a, b) => a - b).join(',')}|${Math.floor(Date.now() / 3600000)}`;
  if (c.visKey !== key) {
    c.visKey = key;
    c.visible = (rangeDays === 0 && hiddenLevels.size === 0) ? c.full : buildSeries(visibleStore(), c.categoryMap);
  }
  return { visible: c.visible, full: c.full };
}

function render(){
  rendered = true;
  renderLevelToggles();
  const sets = getSeriesSets();
  allSeries = sets.visible;
  allSeriesFull = sets.full;
  const cats = [...new Set(allSeries.map(s => s.category))];
  if (activeCategory !== '__ALL__' && !cats.includes(activeCategory)) activeCategory = '__ALL__';
  // 初回(データが入った最初の描画)だけ、お気に入り以外を非表示にする
  if (!selectionInitialized && allSeriesFull.length) {
    selectionInitialized = true;
    hidden = new Set(allSeriesFull.filter(s => !favorites.has(s.base)).map(s => s.base));
  }
  drawTabs(cats);
  applyCategory();
}

function craftSeries(){
  const base = activeCategory === '__ALL__'
    ? allSeriesFull
    : allSeriesFull.filter(s => s.category === activeCategory);
  return base.filter(s => !hidden.has(s.base));
}

function applyCategory(){
  series = activeCategory === '__ALL__'
    ? allSeries
    : allSeries.filter(s => s.category === activeCategory);
  // hiddenはカテゴリをまたいで保持する(タブ切替で選択をリセットしない)
  drawPicker();
  refreshPanels();
  draw();
}

function onSelectionChanged(){
  drawPicker();
  refreshPanels(['craft', 'table', 'avg']);
  draw();
}

// 開いているパネルだけ描画し、閉じているものは開いた時に描画する
const panels = {
  favorites: { el: document.getElementById('favDetails'), draw: drawFavoritesTable, dirty: true },
  craft:     { el: document.getElementById('craftDetails'), draw: drawCraftTable, dirty: true },
  table:     { el: document.getElementById('tableDetails'), draw: drawTable, dirty: true },
  avg:       { el: document.getElementById('avgDetails'), draw: drawAverageTable, dirty: true },
};
function drawPanel(p){ p.dirty = false; p.draw(); }
function refreshPanels(keys = Object.keys(panels)){
  keys.forEach(k => {
    const p = panels[k];
    if (p.el.open) drawPanel(p); else p.dirty = true;
  });
}
Object.values(panels).forEach(p => {
  p.el.addEventListener('toggle', () => { if (p.el.open && p.dirty) drawPanel(p); });
});


function filteredSeries(){
  const q = searchText.trim().toLowerCase();
  if (!q) return series;
  return series.filter(s => s.base.toLowerCase().includes(q));
}

let pickerScroll = 0;
pickerListEl.addEventListener('scroll', () => { pickerScroll = pickerListEl.scrollTop; }, { passive: true });

function drawPicker(){
  const list = filteredSeries();
  const scrollTop = pickerScroll;   // scrollTopを直接読むと強制リフローになるので、スクロールイベントで保存した値を使う
  if (series.length === 0){
    pickerListEl.innerHTML = '<div class="picker-empty">アイテムがありません。</div>';
    return;
  }
  if (list.length === 0){
    pickerListEl.innerHTML = '<div class="picker-empty">「' + escapeHtml(searchText) + '」に一致するアイテムがありません。</div>';
    return;
  }
  let html = '';
  for (const s of list) {
    const on = !hidden.has(s.base);
    const isFav = favorites.has(s.base);
    html += `<div class="pick${on ? ' on' : ''}" data-base="${escapeHtml(s.base)}"><span class="fav-star${isFav ? ' active' : ''}">${isFav ? '★' : '☆'}</span><span class="dot" style="background:${on ? s.color : 'var(--border)'}"></span>${escapeHtml(s.base)}</div>`;
  }
  pickerListEl.innerHTML = html;
  if (scrollTop > 0) pickerListEl.scrollTop = scrollTop;   // 選択のたびに先頭へ戻らないようにする(0なら触らない)
}

// リストの要素ごとではなく親で1回だけクリックを受ける
pickerListEl.addEventListener('click', e => {
  const el = e.target.closest('.pick');
  if (!el) return;
  const base = el.dataset.base;
  if (e.target.closest('.fav-star')) { toggleFavorite(base); return; }
  if (hidden.has(base)) hidden.delete(base); else hidden.add(base);
  onSelectionChanged();
});

function drawTabs(cats){
  tabsEl.innerHTML = '';
  const makeTab = (label, value, count) => {
    const el = document.createElement('div');
    el.className = 'tab' + (activeCategory === value ? ' active' : '');
    el.innerHTML = `${escapeHtml(label)}<span class="count">${count}</span>`;
    el.onclick = () => {
      activeCategory = value;
      drawTabs(cats);
      applyCategory();
    };
    tabsEl.appendChild(el);
  };
  makeTab('すべて', '__ALL__', allSeries.length);
  cats.forEach(c => makeTab(c, c, allSeries.filter(s => s.category === c).length));
}

function activeSeries(){ return series.filter(s => !hidden.has(s.base)); }

function levelDash(level){
  const dashes = [[], [6,4], [2,3], [8,3,2,3], [1,3]];
  return dashes[level % dashes.length];
}

function formatAxisDate(ts){
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const HOUR_MS = 3600000;
const TICK_STEPS_MS = [1, 3, 6, 12, 24, 48, 72, 168, 336, 720].map(h => h * HOUR_MS);

// x軸の目盛りを、ローカル時刻の0時を基準にしたきりのいい間隔に揃える
function buildDateTicks(scale){
  const min = scale.min, max = scale.max;
  const range = max - min;
  if (!(range > 0)) return;
  const step = TICK_STEPS_MS.find(s => range / s <= 8) || TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
  const d = new Date(min);
  d.setHours(0, 0, 0, 0);
  const ticks = [];
  if (step >= 24 * HOUR_MS) {
    const days = Math.round(step / (24 * HOUR_MS));
    for (; d.getTime() <= max; d.setDate(d.getDate() + days)) {
      if (d.getTime() >= min) ticks.push({ value: d.getTime() });
    }
  } else {
    for (let t = d.getTime(); t <= max; t += step) {
      if (t >= min) ticks.push({ value: t });
    }
  }
  if (ticks.length) {
    scale.ticks = ticks;
    scale._stepMs = step;
  }
}

function formatTickLabel(ts, stepMs){
  const d = new Date(ts);
  const date = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  return stepMs && stepMs < 24 * HOUR_MS ? `${date} ${pad2(d.getHours())}:00` : date;
}

// Chart.js（https://www.chartjs.org/）を使ってグラフを描画する。
// x軸はlinearスケールで、目盛りはbuildDateTicksで日付の区切りに揃えている。
let drawQueued = false;
function draw(){  // 1フレーム内の連続呼び出しを1回にまとめる
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawChart(); });
}

// {x,y}配列への変換は系列ごとに1回だけ
const pointCache = new WeakMap();
function toPoints(arr){
  let p = pointCache.get(arr);
  if (!p) {
    p = arr.map(e => ({ x: e.t, y: e.price, dateLabel: e.label }));
    pointCache.set(arr, p);
  }
  return p;
}

function drawChart(){
  const act = activeSeries();

  if (act.length === 0){
    if (chartInstance){ chartInstance.destroy(); chartInstance = null; }
    return;
  }

  const lines = [];
  act.forEach(s => { for (const [level, arr] of s.history) lines.push({ s, level, arr }); });

  const totalPoints = lines.reduce((n, l) => n + l.arr.length, 0);
  // 点が多いほどマーカーを小さく→非表示にする（ホバー時は表示される）
  const radius = totalPoints > 1500 ? 0 : totalPoints > 600 ? 2 : 3;
  const width = lines.length > 40 ? 1.5 : 2;

  const datasets = lines.map(({ s, level, arr }) => ({
    label: `${s.base} +${level}`,
    data: toPoints(arr),
    borderColor: s.color,
    backgroundColor: s.color,
    borderDash: levelDash(level),
    borderWidth: width,
    pointRadius: radius,
    pointHoverRadius: 5,
    pointHitRadius: 6,
    tension: 0,
  }));

  if (chartInstance){
    chartInstance.data.datasets = datasets;
    chartInstance.update('none');
    return;
  }

  chartInstance = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,       // データは{x,y}の昇順で渡しているので解析を省略
      normalized: true,
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: {
          type: 'linear',
          bounds: 'data',   // データの最初と最後を軸の端にする(左右の空白をなくす)
          afterBuildTicks: buildDateTicks,
          ticks: { callback: function(v){ return formatTickLabel(v, this._stepMs); }, color: '#8b83a0', maxTicksLimit: 12 },
          grid: { color: 'rgba(155,127,212,0.16)' },
        },
        y: {
          beginAtZero: true,
          ticks: { callback: v => fmt(v), color: '#8b83a0' },
          grid: { color: '#ddd4ec' },
        },
      },
      plugins: {
        legend: { display: false },
        // 1系列が300点を超えたらLTTBで間引く（折れ線の形状を保つ）
        decimation: { enabled: true, algorithm: 'lttb', threshold: 300, samples: 200 },
        tooltip: {
          callbacks: {
            title: items => items[0]?.raw?.dateLabel || formatAxisDate(items[0].parsed.x),
            label: item => `${item.dataset.label}: ${fmt(item.parsed.y)} マー`,
          },
        },
      },
    },
  });
}

let avgMapCache = { key: '', map: null };
function craftAveragePriceMap(){
  const key = `${storeVersion}|${rangeDays}|${Math.floor(Date.now() / 3600000)}`;
  if (avgMapCache.key === key) return avgMapCache.map;
  const cutoff = rangeDays > 0 ? Date.now() - rangeDays * 86400000 : -Infinity;
  const agg = new Map();
  for (const r of store) {
    if (r.t < cutoff) continue;
    const k = r.base + '||' + r.level;
    let o = agg.get(k);
    if (!o) { o = { sum: 0, count: 0 }; agg.set(k, o); }
    o.sum += r.price;
    o.count += 1;
  }
  const avgMap = new Map();
  for (const [k, o] of agg) avgMap.set(k, o.sum / o.count);
  avgMapCache = { key, map: avgMap };
  return avgMap;
}

function buildCraftRows(cs){
  const rows = [];
  const avgMap = craftAveragePriceMap();
  cs.forEach(s => {
    const priceByLevel = new Map(s.points.map(p => [p.level, p.price]));
    const levels = [...priceByLevel.keys()].sort((a, b) => a - b);
    levels.forEach(lv => {
      if (hiddenLevels.has(lv)) return;
      const directPrice = priceByLevel.get(lv);
      const avgPrice = avgMap.get(s.base + '||' + lv);
      if (lv === 0) {
        const diffAvg = avgPrice === undefined ? null : avgPrice - directPrice;
        rows.push({ base: s.base, color: s.color, level: lv, fromLevel: null, qty: null, craftCost: null, directPrice, diff: null, avgPrice, diffAvg });
        return;
      }
      levels.forEach(base => {
        if (base >= lv || !priceByLevel.has(base)) return;
        const steps = lv - base;
        const qty = Math.pow(3, steps);
        const basePrice = priceByLevel.get(base);
        const craftCost = useLadderPricing
          ? qty * basePrice + Math.ceil(qty / 2)
          : basePrice * qty;
        const diff = directPrice - craftCost;
        const diffAvg = avgPrice === undefined ? null : avgPrice - craftCost;
        rows.push({ base: s.base, color: s.color, level: lv, fromLevel: base, qty, craftCost, directPrice, diff, avgPrice, diffAvg });
      });
    });
  });
  rows.sort((a, b) => jaCollator.compare(a.base, b.base) || a.level - b.level || (a.fromLevel ?? -1) - (b.fromLevel ?? -1));
  return rows;
}

const tableObservers = new Map();
// 表を一度に全行描画せず、先頭ROW_CHUNK行 → 末尾が見えそうになったら次のROW_CHUNK行、と追加する。
// 行は追加するだけで作り直さないので、スクロール位置は保たれる。
function renderChunkedTable(wrapEl, headHtml, rows, rowHtml){
  const prev = tableObservers.get(wrapEl);
  if (prev) { prev.disconnect(); tableObservers.delete(wrapEl); }
  wrapEl.innerHTML = `<div class="table-scroll"><table><thead>${headHtml}</thead><tbody></tbody></table></div>`;
  const tbody = wrapEl.querySelector('tbody');
  const sentinel = document.createElement('tr');
  sentinel.innerHTML = '<td colspan="99" style="padding:0;border:0;height:1px"></td>';
  tbody.appendChild(sentinel);
  let next = 0;
  const appendChunk = () => {
    const end = (typeof IntersectionObserver === 'undefined') ? rows.length : Math.min(next + ROW_CHUNK, rows.length);
    let html = '';
    for (let i = next; i < end; i++) html += rowHtml(rows[i]);
    sentinel.insertAdjacentHTML('beforebegin', html);
    next = end;
  };
  appendChunk();
  if (next >= rows.length) { sentinel.remove(); return; }
  const io = new IntersectionObserver(entries => {
    if (!entries.some(e => e.isIntersecting)) return;
    appendChunk();
    if (next >= rows.length) { io.disconnect(); tableObservers.delete(wrapEl); sentinel.remove(); return; }
    io.unobserve(sentinel); io.observe(sentinel);   // まだ画面内なら続けて追加する
  }, { rootMargin: '300px' });
  io.observe(sentinel);
  tableObservers.set(wrapEl, io);
}

const swatchHtml = color => `<span class="swatch" style="display:inline-block;background:${color};vertical-align:middle;margin-right:6px;"></span>`;
const TH_R = '<th style="text-align:right">';

function drawCraftTable(){
  const cs = craftSeries();
  if (cs.length === 0){ craftWrap.innerHTML = '<div class="empty">抽出できたアイテムがありません。</div>'; return; }
  const rows = buildCraftRows(cs);
  if (!rows.length){ craftWrap.innerHTML = '<div class="empty">選択中のアイテムに、比較できる価格データがありません。</div>'; return; }

  const head = `<tr><th>アイテム</th>${TH_R}強化値</th>${TH_R}購入元</th>${TH_R}合成コスト</th>${TH_R}現在価格</th>${TH_R}平均価格</th>${TH_R}判定（現在比）</th>${TH_R}判定（平均比）</th></tr>`;
  renderChunkedTable(craftWrap, head, rows, r => {
    const isBase = r.fromLevel === null;
    let verdictHtml;
    if (isBase) verdictHtml = '<span class="verdict-even">合成対象外</span>';
    else if (r.diff > 0) verdictHtml = `<span class="verdict-craft">合成がお得（${fmt(r.diff)}マー節約）</span>`;
    else if (r.diff < 0) verdictHtml = `<span class="verdict-buy">直接購入がお得（${fmt(-r.diff)}マー節約）</span>`;
    else verdictHtml = '<span class="verdict-even">同額</span>';

    let verdictAvgHtml;
    if (r.diffAvg === null) verdictAvgHtml = '<span class="verdict-even">データ不足</span>';
    else if (isBase) {
      if (r.diffAvg > 0) verdictAvgHtml = `<span class="verdict-craft">今が買い時（平均より${fmt(Math.round(r.diffAvg))}マー安い）</span>`;
      else if (r.diffAvg < 0) verdictAvgHtml = `<span class="verdict-buy">今は割高（平均より${fmt(Math.round(-r.diffAvg))}マー高い）</span>`;
      else verdictAvgHtml = '<span class="verdict-even">平均並み</span>';
    } else if (r.diffAvg > 0) verdictAvgHtml = `<span class="verdict-craft">合成がお得（${fmt(Math.round(r.diffAvg))}マー節約）</span>`;
    else if (r.diffAvg < 0) verdictAvgHtml = `<span class="verdict-buy">直接購入がお得（${fmt(Math.round(-r.diffAvg))}マー節約）</span>`;
    else verdictAvgHtml = '<span class="verdict-even">同額</span>';

    return `<tr><td>${swatchHtml(r.color)}${escapeHtml(r.base)}</td>`
      + `<td class="num">+${r.level}</td>`
      + `<td class="num">${isBase ? '-' : `+${r.fromLevel}を${fmt(r.qty)}個`}</td>`
      + `<td class="num">${isBase ? '-' : fmt(Math.round(r.craftCost))}</td>`
      + `<td class="num">${fmt(r.directPrice)}</td>`
      + `<td class="num">${r.avgPrice === undefined ? '-' : fmt(Math.round(r.avgPrice))}</td>`
      + `<td class="num">${verdictHtml}</td>`
      + `<td class="num">${verdictAvgHtml}</td></tr>`;
  });
}

function drawTable(){
  if (series.length === 0){ tableWrap.innerHTML = '<div class="empty">抽出できたアイテムがありません。</div>'; return; }
  const shown = activeSeries();
  if (shown.length === 0){ tableWrap.innerHTML = '<div class="empty">表示中のアイテムがありません。上のアイテム選択リストから選んでください。</div>'; return; }
  const showCat = activeCategory === '__ALL__';

  // 行は参照だけの軽いオブジェクトにして、HTMLは表示する分だけ作る
  const rows = [];
  shown.forEach(s => {
    for (const [level, arr] of s.history) {
      for (let i = 0; i < arr.length; i++) rows.push({ t: arr[i].t, s, level, arr, i });
    }
  });
  if (!rows.length){ tableWrap.innerHTML = '<div class="empty">価格の記録がまだありません。</div>'; return; }
  rows.sort((a, b) => b.t - a.t || jaCollator.compare(a.s.base, b.s.base) || a.level - b.level);

  const head = `<tr><th>日付</th><th>アイテム</th>${showCat ? '<th>カテゴリ</th>' : ''}${TH_R}強化値</th>${TH_R}価格</th>${TH_R}前回比</th></tr>`;
  renderChunkedTable(tableWrap, head, rows, r => {
    const entry = r.arr[r.i];
    const diff = r.i > 0 ? entry.price - r.arr[r.i - 1].price : null;
    let diffHtml;
    if (diff === null) diffHtml = '<span class="delta-flat">初回</span>';
    else if (diff > 0) diffHtml = `<span class="delta-up">▲ +${fmt(diff)}</span>`;
    else if (diff < 0) diffHtml = `<span class="delta-down">▼ ${fmt(diff)}</span>`;
    else diffHtml = '<span class="delta-flat">±0</span>';
    return `<tr><td>${escapeHtml(entry.label)}</td><td>${swatchHtml(r.s.color)}${escapeHtml(r.s.base)}</td>`
      + (showCat ? `<td>${escapeHtml(r.s.category)}</td>` : '')
      + `<td class="num">+${r.level}</td><td class="num">${fmt(entry.price)}</td><td class="num">${diffHtml}</td></tr>`;
  });
}

// 系列(配列)ごとの統計。系列が再構築されない限り再計算しない
const statsCache = new WeakMap();
function seriesStats(arr){
  let st = statsCache.get(arr);
  if (!st) {
    let sum = 0, min = Infinity, max = -Infinity;
    for (const e of arr) { sum += e.price; if (e.price < min) min = e.price; if (e.price > max) max = e.price; }
    st = { avg: sum / arr.length, min, max, latest: arr[arr.length - 1].price, count: arr.length };
    statsCache.set(arr, st);
  }
  return st;
}

function drawAverageTable(){
  if (series.length === 0){ avgWrap.innerHTML = '<div class="empty">抽出できたアイテムがありません。</div>'; return; }
  const shown = activeSeries();
  if (shown.length === 0){ avgWrap.innerHTML = '<div class="empty">表示中のアイテムがありません。上のアイテム選択リストから選んでください。</div>'; return; }
  const showCat = activeCategory === '__ALL__';

  const rows = [];
  shown.forEach(s => {
    for (const [level, arr] of s.history) {
      if (!arr.length) continue;
      const st = seriesStats(arr);
      rows.push({ base: s.base, category: s.category, color: s.color, level, avg: st.avg, min: st.min, max: st.max, latest: st.latest, count: st.count });
    }
  });
  if (!rows.length){ avgWrap.innerHTML = '<div class="empty">価格の記録がまだありません。</div>'; return; }
  rows.sort((a, b) => jaCollator.compare(a.base, b.base) || a.level - b.level);

  const head = `<tr><th>アイテム</th>${showCat ? '<th>カテゴリ</th>' : ''}${TH_R}強化値</th>${TH_R}平均価格</th>${TH_R}最安</th>${TH_R}最高</th>${TH_R}最新</th>${TH_R}件数</th></tr>`;
  renderChunkedTable(avgWrap, head, rows, r =>
    `<tr><td>${swatchHtml(r.color)}${escapeHtml(r.base)}</td>`
    + (showCat ? `<td>${escapeHtml(r.category)}</td>` : '')
    + `<td class="num">+${r.level}</td><td class="num">${fmt(Math.round(r.avg))}</td><td class="num">${fmt(r.min)}</td><td class="num">${fmt(r.max)}</td><td class="num">${fmt(r.latest)}</td><td class="num">${fmt(r.count)}</td></tr>`
  );
}

function drawFavoritesTable(){
  if (!favoritesWrap) return;
  if (!favorites.size){ favoritesWrap.innerHTML = '<div class="empty">まだお気に入りがありません。上のアイテム選択リストの☆をタップして登録してください。</div>'; return; }

  const cutoff = rangeDays > 0 ? Date.now() - rangeDays * 86400000 : -Infinity;
  const groups = new Map();
  for (const base of favorites) {
    const sr = seriesCache.byBase && seriesCache.byBase.get(base);
    if (!sr) continue;
    for (const [level, arr] of sr.history) {
      const entries = rangeDays > 0 ? arr.filter(e => e.t >= cutoff) : arr;
      if (entries.length) groups.set(base + '||' + level, { base, level, category: sr.category, entries });
    }
  }

  const items = [...groups.values()].filter(g => g.entries.length);
  if (!items.length){ favoritesWrap.innerHTML = '<div class="empty">お気に入りアイテムの価格データが選択中の期間にありません。</div>'; return; }
  items.forEach(g => {
    g.entries.sort((a, b) => a.t - b.t);
    g.avg = g.entries.reduce((a, e) => a + e.price, 0) / g.entries.length;
    g.latest = g.entries[g.entries.length - 1].price;
    g.diff = g.avg - g.latest;
    g.color = colorForBase(g.base);
  });
  items.sort((a, b) => jaCollator.compare(a.base, b.base) || a.level - b.level);

  let html = '<table><thead><tr><th>アイテム</th><th style="text-align:right">強化値</th><th style="text-align:right">現在価格</th><th style="text-align:right">平均価格</th><th style="text-align:right">判定</th></tr></thead><tbody>';
  items.forEach(g => {
    let verdictHtml;
    if (g.diff > 0) verdictHtml = `<span class="verdict-craft">買い時（平均より${fmt(Math.round(g.diff))}マー安い）</span>`;
    else if (g.diff < 0) verdictHtml = `<span class="verdict-buy">割高（平均より${fmt(Math.round(-g.diff))}マー高い）</span>`;
    else verdictHtml = '<span class="verdict-even">平均並み</span>';
    html += `<tr><td><span class="swatch" style="display:inline-block;background:${g.color};vertical-align:middle;margin-right:6px;"></span>${escapeHtml(g.base)}</td>`;
    html += `<td class="num">+${g.level}</td><td class="num">${fmt(g.latest)}</td><td class="num">${fmt(Math.round(g.avg))}</td><td class="num">${verdictHtml}</td></tr>`;
  });
  html += '</tbody></table>';
  favoritesWrap.innerHTML = '<div class="table-scroll">' + html + '</div>';
}

const scrollTopBtn = document.getElementById('scrollTopBtn');
window.addEventListener('scroll', () => {
  scrollTopBtn.style.display = window.scrollY > 300 ? 'flex' : 'none';
});
scrollTopBtn.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

const rangeSegEl = document.getElementById('rangeSeg');
rangeSegEl.addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  rangeDays = Number(btn.dataset.days);
  rangeSegEl.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

searchEl.addEventListener('input', () => {
  searchText = searchEl.value;
  drawPicker();
});
document.getElementById('selAll').onclick = () => {
  filteredSeries().forEach(s => hidden.delete(s.base));
  onSelectionChanged();
};
document.getElementById('selNone').onclick = () => {
  filteredSeries().forEach(s => hidden.add(s.base));
  onSelectionChanged();
};

// ---- Realtime: DBの追加/修正/削除をWebSocketで受け取る ----
// 事前にDB側で `alter publication supabase_realtime add table price_records;` が必要(realtime_setup.sql参照)。
// 未設定でも動作はするが、その場合は従来どおり定期再同期(REFRESH_MS)だけで更新される。
const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2';
const REFRESH_MS_LIVE = 30 * 60 * 1000;   // Realtime接続中は、保険の再同期を30分に1回にする
let rtStarted = false;
let rtConnected = false;
let rtQueue = [];
let rtTimer = null;

function loadScript(src){
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = resolve;
    el.onerror = reject;
    document.head.appendChild(el);
  });
}

const isFullRow = r => !!r && r.id != null && r.t != null && r.base != null && r.level != null && r.price != null;

function onRealtimeEvent(payload){
  rtQueue.push(payload);
  if (!rtTimer) rtTimer = setTimeout(flushRealtime, 800);   // 連続入力は800msぶんまとめて1回で反映
}

function flushRealtime(){
  rtTimer = null;
  if (refreshing) { rtTimer = setTimeout(flushRealtime, 500); return; }   // 再同期中は終わってから適用
  const events = rtQueue;
  rtQueue = [];
  if (!events.length) return;
  let needResync = false;
  const map = new Map(store.map(r => [r.id, r]));
  for (const ev of events) {
    if (ev.eventType === 'DELETE') {
      const id = ev.old && ev.old.id;
      if (id == null) needResync = true;           // 旧行にidが無ければ特定できないので全件取得
      else map.delete(String(id));
    } else if (isFullRow(ev.new)) {
      const row = normalizeRow(ev.new);
      map.set(row.id, row);
    } else {
      needResync = true;
    }
  }
  store = [...map.values()].sort(cmpRow);
  scheduleCacheSave();
  onStoreChanged();
  render();
  if (needResync) { fullSyncedAt = 0; refresh(); }
}

function startRealtime(){
  if (rtStarted || !window.supabase || !window.supabase.createClient) return;
  rtStarted = true;
  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  client
    .channel('price-records-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'price_records' }, onRealtimeEvent)
    .subscribe(status => {
      if (status === 'SUBSCRIBED') {
        rtConnected = true;
        if (Date.now() - lastRefreshAt > 10000) refresh();   // 切断中の取りこぼしを補う
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        rtConnected = false;
      }
    });
}

(async function init(){
  loadHiddenLevelsFromLocalStorage();
  loadFavoritesFromLocalStorage();

  // キャッシュがあれば先に表示し、裏で差分を取得する
  const cached = await idbGet(CACHE_KEY);
  if (cached && Array.isArray(cached.rows) && cached.rows.length) {
    store = cached.rows;
    fullSyncedAt = cached.fullSyncedAt || 0;
    onStoreChanged();
    render();
    statusLineEl.textContent = '最新データを確認中…';
  }
  const changed = await refresh();
  if (!rendered) render();

  // supabase-js(Realtime用)は初回描画の後に読み込む
  const kick = () => loadScript(SUPABASE_JS_URL).then(startRealtime)
    .catch(err => console.warn('Realtimeを開始できません(定期更新のみで動作します)', err));
  if ('requestIdleCallback' in window) requestIdleCallback(kick, { timeout: 3000 }); else setTimeout(kick, 1000);

  // 保険の再同期: Realtime接続中は30分、未接続なら5分
  setInterval(() => {
    if (document.hidden) return;
    if (Date.now() - lastRefreshAt >= (rtConnected ? REFRESH_MS_LIVE : REFRESH_MS)) refresh();
  }, 60 * 1000);
  // バックグラウンドのタブはWebSocketが止まることがあるため、戻ったときに1分以上古ければ再同期
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastRefreshAt > 60 * 1000) refresh();
  });
})();
