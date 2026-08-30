
const SUPABASE_URL = 'https://mvaepekgvzqyuettixvd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Rp-h4XEN8aK27Hx7-RKKpQ_HXNCX12G';

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
  drawCraftTable();
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


async function loadStoreFromSupabase(){
  try {
    const pageSize = 1000;
    let from = 0;
    let all = [];
    while (true) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/price_records?select=id,t,label,base,level,price,category&order=t.asc`, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Range-Unit': 'items',
          'Range': `${from}-${from + pageSize - 1}`,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      all = all.concat(rows);
      if (rows.length < pageSize) break;
      from += pageSize;
    }
    store = all.map(r => ({
      id: String(r.id),
      t: Number(r.t),
      label: r.label,
      base: r.base,
      level: Number(r.level),
      price: Number(r.price),
      category: r.category || '未分類',
    }));
    statusLineEl.textContent = store.length ? '' : 'まだデータがありません。';
    statusLineEl.classList.remove('err');
    updateLastUpdatedLine();
    updateDataSpanLine();
  } catch (err) {
    console.error(err);
    statusLineEl.textContent = 'データの読み込みに失敗しました。時間をおいて再読み込みしてください。';
    statusLineEl.classList.add('err');
  }
}

function formatDateTime(ts){
  const d = new Date(ts);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function updateLastUpdatedLine(){
  if (!store.length){ lastUpdatedEl.textContent = ''; return; }
  const maxT = Math.max(...store.map(r => r.t));
  lastUpdatedEl.textContent = `データ更新日: ${formatDateTime(maxT)}`;
}

function updateDataSpanLine(){
  if (!store.length){ dataSpanLineEl.textContent = ''; return; }
  const minT = Math.min(...store.map(r => r.t));
  const maxT = Math.max(...store.map(r => r.t));
  const days = Math.max(1, Math.ceil((maxT - minT) / 86400000) + 1);
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
  drawFavoritesTable();
}

function allLevelsInStore(){
  return [...new Set(store.map(r => r.level))].sort((a, b) => a - b);
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

function render(){
  renderLevelToggles();
  const categoryMap = buildCategoryMap(store);
  allSeries = buildSeries(visibleStore(), categoryMap);
  allSeriesFull = buildSeries(store, categoryMap);
  const cats = [...new Set(allSeries.map(s => s.category))];
  if (activeCategory !== '__ALL__' && !cats.includes(activeCategory)) activeCategory = '__ALL__';
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
  hidden = new Set([...hidden].filter(h => series.some(s => s.base === h)));
  drawPicker();
  drawTable();
  drawAverageTable();
  drawCraftTable();
  drawFavoritesTable();
  draw();
}

function filteredSeries(){
  const q = searchText.trim().toLowerCase();
  if (!q) return series;
  return series.filter(s => s.base.toLowerCase().includes(q));
}

function drawPicker(){
  const list = filteredSeries();
  pickerListEl.innerHTML = '';
  if (series.length === 0){
    pickerListEl.innerHTML = '<div class="picker-empty">アイテムがありません。</div>';
    return;
  }
  if (list.length === 0){
    pickerListEl.innerHTML = '<div class="picker-empty">「' + escapeHtml(searchText) + '」に一致するアイテムがありません。</div>';
    return;
  }
  list.forEach(s => {
    const on = !hidden.has(s.base);
    const isFav = favorites.has(s.base);
    const el = document.createElement('div');
    el.className = 'pick' + (on ? ' on' : '');
    el.innerHTML = `<span class="fav-star${isFav ? ' active' : ''}">${isFav ? '★' : '☆'}</span><span class="dot" style="background:${on ? s.color : 'var(--border)'}"></span>${escapeHtml(s.base)}`;
    el.querySelector('.fav-star').addEventListener('click', e => {
      e.stopPropagation();
      toggleFavorite(s.base);
    });
    el.addEventListener('click', () => {
      if (hidden.has(s.base)) hidden.delete(s.base); else hidden.add(s.base);
      drawPicker(); drawTable(); drawAverageTable(); drawCraftTable(); draw();
    });
    pickerListEl.appendChild(el);
  });
}

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

// Chart.js（https://www.chartjs.org/）を使ってグラフを描画する。
// 以前は目盛りの計算やマウス位置とのあたり判定を自前で書いていたが、
// ライブラリに任せることでその部分をまるごと削除できた。
// x軸はtimeスケールにしているので、目盛りの間隔や表示形式は
// chartjs-adapter-date-fns が日時に応じて自動でいい感じに選んでくれる。
function draw(){
  const act = activeSeries();

  if (act.length === 0){
    if (chartInstance){ chartInstance.destroy(); chartInstance = null; }
    return;
  }

  const datasets = [];
  act.forEach(s => {
    for (const [level, arr] of s.history){
      datasets.push({
        label: `${s.base} +${level}`,
        data: arr.map(p => ({ x: p.t, y: p.price, dateLabel: p.label })),
        borderColor: s.color,
        backgroundColor: s.color,
        borderDash: levelDash(level),
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        tension: 0,
      });
    }
  });

  if (chartInstance){
    chartInstance.data.datasets = datasets;
    chartInstance.update();
    return;
  }

  chartInstance = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: {
          type: 'linear',
          ticks: { callback: v => formatAxisDate(v), color: '#8b83a0' },
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

function craftAveragePriceMap(){
  let rows = store;
  if (rangeDays > 0) {
    const cutoff = Date.now() - rangeDays * 86400000;
    rows = rows.filter(r => r.t >= cutoff);
  }
  const agg = new Map();
  rows.forEach(r => {
    const key = r.base + '||' + r.level;
    if (!agg.has(key)) agg.set(key, { sum: 0, count: 0 });
    const o = agg.get(key);
    o.sum += r.price;
    o.count += 1;
  });
  const avgMap = new Map();
  for (const [key, o] of agg) avgMap.set(key, o.sum / o.count);
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
  rows.sort((a, b) => a.base.localeCompare(b.base, 'ja') || a.level - b.level || (a.fromLevel ?? -1) - (b.fromLevel ?? -1));
  return rows;
}

function drawCraftTable(){
  const cs = craftSeries();
  if (cs.length === 0){ craftWrap.innerHTML = '<div class="empty">抽出できたアイテムがありません。</div>'; return; }
  const rows = buildCraftRows(cs);
  if (!rows.length){ craftWrap.innerHTML = '<div class="empty">選択中のアイテムに、比較できる価格データがありません。</div>'; return; }

  let html = '<table><thead><tr><th>アイテム</th><th style="text-align:right">強化値</th><th style="text-align:right">購入元</th><th style="text-align:right">合成コスト</th><th style="text-align:right">現在価格</th><th style="text-align:right">平均価格</th><th style="text-align:right">判定（現在比）</th><th style="text-align:right">判定（平均比）</th></tr></thead><tbody>';
  rows.forEach(r => {
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

    html += `<tr><td><span class="swatch" style="display:inline-block;background:${r.color};vertical-align:middle;margin-right:6px;"></span>${escapeHtml(r.base)}</td>`;
    html += `<td class="num">+${r.level}</td>`;
    html += `<td class="num">${isBase ? '-' : `+${r.fromLevel}を${fmt(r.qty)}個`}</td>`;
    html += `<td class="num">${isBase ? '-' : fmt(Math.round(r.craftCost))}</td>`;
    html += `<td class="num">${fmt(r.directPrice)}</td>`;
    html += `<td class="num">${r.avgPrice === undefined ? '-' : fmt(Math.round(r.avgPrice))}</td>`;
    html += `<td class="num">${verdictHtml}</td>`;
    html += `<td class="num">${verdictAvgHtml}</td></tr>`;
  });
  html += '</tbody></table>';
  craftWrap.innerHTML = '<div class="table-scroll">' + html + '</div>';
}

function drawTable(){
  if (series.length === 0){ tableWrap.innerHTML = '<div class="empty">抽出できたアイテムがありません。</div>'; return; }
  const shown = activeSeries();
  if (shown.length === 0){ tableWrap.innerHTML = '<div class="empty">表示中のアイテムがありません。上のアイテム選択リストから選んでください。</div>'; return; }
  const showCat = activeCategory === '__ALL__';

  let rows = [];
  shown.forEach(s => {
    for (const [level, arr] of s.history) {
      arr.forEach((entry, i) => {
        const prevPrice = i > 0 ? arr[i - 1].price : null;
        const diff = prevPrice === null ? null : entry.price - prevPrice;
        rows.push({ t: entry.t, label: entry.label, base: s.base, category: s.category, color: s.color, level, price: entry.price, diff });
      });
    }
  });
  if (!rows.length){ tableWrap.innerHTML = '<div class="empty">価格の記録がまだありません。</div>'; return; }
  rows.sort((a, b) => b.t - a.t || a.base.localeCompare(b.base, 'ja') || a.level - b.level);

  let html = '<table><thead><tr><th>日付</th><th>アイテム</th>';
  if (showCat) html += '<th>カテゴリ</th>';
  html += '<th style="text-align:right">強化値</th><th style="text-align:right">価格</th><th style="text-align:right">前回比</th></tr></thead><tbody>';
  rows.forEach(r => {
    let diffHtml;
    if (r.diff === null) diffHtml = '<span class="delta-flat">初回</span>';
    else if (r.diff > 0) diffHtml = `<span class="delta-up">▲ +${fmt(r.diff)}</span>`;
    else if (r.diff < 0) diffHtml = `<span class="delta-down">▼ ${fmt(r.diff)}</span>`;
    else diffHtml = '<span class="delta-flat">±0</span>';
    html += `<tr><td>${escapeHtml(r.label)}</td><td><span class="swatch" style="display:inline-block;background:${r.color};vertical-align:middle;margin-right:6px;"></span>${escapeHtml(r.base)}</td>`;
    if (showCat) html += `<td>${escapeHtml(r.category)}</td>`;
    html += `<td class="num">+${r.level}</td><td class="num">${fmt(r.price)}</td><td class="num">${diffHtml}</td></tr>`;
  });
  html += '</tbody></table>';
  tableWrap.innerHTML = '<div class="table-scroll">' + html + '</div>';
}

function drawAverageTable(){
  if (series.length === 0){ avgWrap.innerHTML = '<div class="empty">抽出できたアイテムがありません。</div>'; return; }
  const shown = activeSeries();
  if (shown.length === 0){ avgWrap.innerHTML = '<div class="empty">表示中のアイテムがありません。上のアイテム選択リストから選んでください。</div>'; return; }
  const showCat = activeCategory === '__ALL__';

  let rows = [];
  shown.forEach(s => {
    for (const [level, arr] of s.history) {
      if (!arr.length) continue;
      const sum = arr.reduce((a, e) => a + e.price, 0);
      const avg = sum / arr.length;
      const min = Math.min(...arr.map(e => e.price));
      const max = Math.max(...arr.map(e => e.price));
      const latest = arr[arr.length - 1].price;
      rows.push({ base: s.base, category: s.category, color: s.color, level, avg, min, max, latest, count: arr.length });
    }
  });
  if (!rows.length){ avgWrap.innerHTML = '<div class="empty">価格の記録がまだありません。</div>'; return; }
  rows.sort((a, b) => a.base.localeCompare(b.base, 'ja') || a.level - b.level);

  let html = '<table><thead><tr><th>アイテム</th>';
  if (showCat) html += '<th>カテゴリ</th>';
  html += '<th style="text-align:right">強化値</th><th style="text-align:right">平均価格</th><th style="text-align:right">最安</th><th style="text-align:right">最高</th><th style="text-align:right">最新</th><th style="text-align:right">件数</th></tr></thead><tbody>';
  rows.forEach(r => {
    html += `<tr><td><span class="swatch" style="display:inline-block;background:${r.color};vertical-align:middle;margin-right:6px;"></span>${escapeHtml(r.base)}</td>`;
    if (showCat) html += `<td>${escapeHtml(r.category)}</td>`;
    html += `<td class="num">+${r.level}</td><td class="num">${fmt(Math.round(r.avg))}</td><td class="num">${fmt(r.min)}</td><td class="num">${fmt(r.max)}</td><td class="num">${fmt(r.latest)}</td><td class="num">${fmt(r.count)}</td></tr>`;
  });
  html += '</tbody></table>';
  avgWrap.innerHTML = '<div class="table-scroll">' + html + '</div>';
}

function drawFavoritesTable(){
  if (!favoritesWrap) return;
  if (!favorites.size){ favoritesWrap.innerHTML = '<div class="empty">まだお気に入りがありません。上のアイテム選択リストの☆をタップして登録してください。</div>'; return; }

  let rows = store;
  if (rangeDays > 0) {
    const cutoff = Date.now() - rangeDays * 86400000;
    rows = rows.filter(r => r.t >= cutoff);
  }
  rows = rows.filter(r => favorites.has(r.base));

  const groups = new Map();
  rows.forEach(r => {
    const key = r.base + '||' + r.level;
    if (!groups.has(key)) groups.set(key, { base: r.base, level: r.level, category: r.category, entries: [] });
    groups.get(key).entries.push(r);
  });

  const items = [...groups.values()].filter(g => g.entries.length);
  if (!items.length){ favoritesWrap.innerHTML = '<div class="empty">お気に入りアイテムの価格データが選択中の期間にありません。</div>'; return; }
  items.forEach(g => {
    g.entries.sort((a, b) => a.t - b.t);
    g.avg = g.entries.reduce((a, e) => a + e.price, 0) / g.entries.length;
    g.latest = g.entries[g.entries.length - 1].price;
    g.diff = g.avg - g.latest;
    g.color = colorForBase(g.base);
  });
  items.sort((a, b) => a.base.localeCompare(b.base, 'ja') || a.level - b.level);

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
  drawPicker(); drawTable(); drawAverageTable(); drawCraftTable(); draw();
};
document.getElementById('selNone').onclick = () => {
  filteredSeries().forEach(s => hidden.add(s.base));
  drawPicker(); drawTable(); drawAverageTable(); drawCraftTable(); draw();
};

(async function init(){
  loadHiddenLevelsFromLocalStorage();
  loadFavoritesFromLocalStorage();
  await loadStoreFromSupabase();
  render();

  setInterval(async () => {
    await loadStoreFromSupabase();
    render();
  }, 5 * 60 * 1000);
})();
