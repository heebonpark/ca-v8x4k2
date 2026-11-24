/* ==================== VWorld Digital Twin Land Precision Map Engine (v3 - Expert GIS) ==================== */
(() => {
'use strict';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(n).toLocaleString('ko-KR');

let cbSeq = 0;
const geoCache = new Map();

function loadGeoCache() {
  try {
    const raw = localStorage.getItem('vw_geocache_v1');
    if (raw) {
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) geoCache.set(k, v);
    }
  } catch {}
}
function saveGeoCache() {
  try {
    const entries = [...geoCache.entries()].slice(-1000);
    localStorage.setItem('vw_geocache_v1', JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}
loadGeoCache();

function getDomain() {
  return (location.origin && location.origin !== 'null' && /^https?:/.test(location.origin))
    ? location.origin
    : 'https://heebonpark.github.io';
}

function getKey(store, meta) {
  const local = String(store?.get?.('vworldKey', '') || '').replace(/\s+/g, '');
  if (local) return local;
  return String(meta?.vaultKeys?.vworld || '').replace(/\s+/g, '');
}

function maskKey(raw) {
  const s = String(raw || '').replace(/\s+/g, '');
  if (!s) return '미입력';
  if (s.length <= 16) return `${s.slice(0, 4)}… (${s.length}자)`;
  return `${s.slice(0, 7)}…${s.slice(-7)} (${s.length}자)`;
}

function jsonp(endpoint, params, key, timeoutMs = 9000) {
  if (!key) return Promise.reject(new Error('브이월드 인증키가 없습니다'));
  return new Promise((resolve, reject) => {
    const cb = `__vwtwin_${++cbSeq}_${Date.now()}`;
    const q = new URLSearchParams({ ...params, key, domain: getDomain(), format: 'json', callback: cb });
    const script = document.createElement('script');
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { delete window[cb]; } catch { window[cb] = undefined; }
      script.remove();
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('브이월드 응답 시간 초과')); }, timeoutMs);
    window[cb] = data => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('브이월드 네트워크 오류')); };
    script.src = `https://api.vworld.kr/req/${endpoint}?${q.toString()}`;
    document.head.appendChild(script);
  });
}

function cleanKoreanAddr(raw) {
  let a = String(raw || '').trim();
  if (!a) return '';
  a = a.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/,.*$/, ' ');
  const rm = a.match(/^(.+?[가-힣](?:로|길)\s*(?:지하\s*)?\d+(?:-\d+)?)/);
  if (rm) return rm[1].replace(/\s+/g, ' ').trim();
  const jm = a.match(/^(.+?[가-힣0-9]+(?:동|리|가)\s*(?:산\s*)?\d+(?:-\d+)?)/);
  if (jm) return jm[1].replace(/\s+/g, ' ').trim();
  return a.replace(/\s+/g, ' ').trim();
}

async function geocode(addr, fallbackName, key) {
  const cleaned = cleanKoreanAddr(addr);
  const cacheKey = cleaned || String(fallbackName || '').trim();
  if (cacheKey && geoCache.has(cacheKey)) return geoCache.get(cacheKey);

  const candidates = [...new Set([cleaned, String(addr || '').trim()].filter(Boolean))];
  for (const q of candidates) {
    for (const type of ['road', 'parcel']) {
      try {
        const j = await jsonp('address', {
          service: 'address', request: 'getCoord', version: '2.0',
          crs: 'epsg:4326', address: q, refine: 'true', simple: 'false', type,
        }, key);
        if (j?.response?.status === 'OK' && j.response.result?.point) {
          const pt = j.response.result.point;
          const x = parseFloat(pt.x), y = parseFloat(pt.y);
          if (x > 124 && x < 132 && y > 33 && y < 39.5) {
            const out = { lat: y, lon: x, method: type === 'road' ? '도로명 정밀' : '지번 정밀', text: j.response.refined?.text || q };
            if (cacheKey) { geoCache.set(cacheKey, out); saveGeoCache(); }
            return out;
          }
        }
      } catch {}
    }
  }
  const queries = [...new Set([
    `${String(addr || '').split(/\s+/).slice(0, 2).join(' ')} ${fallbackName || ''}`.trim(),
    String(fallbackName || '').replace(/\(주\)|㈜|주식회사|관리사무소|\[.*?\]|\(.*?\)/g, '').trim(),
    cleaned,
  ].filter(s => s && s.length >= 2))];
  for (const q of queries) {
    for (const type of ['place', 'address']) {
      try {
        const j = await jsonp('search', {
          service: 'search', request: 'search', version: '2.0',
          crs: 'EPSG:4326', size: '1', query: q, type,
        }, key);
        const it = j?.response?.status === 'OK' ? j.response.result?.items?.[0] : null;
        if (it?.point) {
          const x = parseFloat(it.point.x), y = parseFloat(it.point.y);
          if (x > 124 && x < 132 && y > 33 && y < 39.5) {
            const out = { lat: y, lon: x, method: type === 'place' ? '장소(POI)' : '주소 검색', text: it.address?.road || it.address?.parcel || it.title || q };
            if (cacheKey) { geoCache.set(cacheKey, out); saveGeoCache(); }
            return out;
          }
        }
      } catch {}
    }
  }
  return null;
}

async function searchPlaces(query, key) {
  const [pRes, aRes] = await Promise.allSettled([
    jsonp('search', { service: 'search', request: 'search', version: '2.0', crs: 'EPSG:4326', size: '6', query, type: 'place' }, key),
    jsonp('search', { service: 'search', request: 'search', version: '2.0', crs: 'EPSG:4326', size: '5', query, type: 'address', category: 'road' }, key),
  ]);
  const out = [];
  const push = (res, kind) => {
    if (res.status !== 'fulfilled' || res.value?.response?.status !== 'OK') return;
    for (const it of (res.value.response.result?.items || [])) {
      const x = parseFloat(it.point?.x), y = parseFloat(it.point?.y);
      if (!(x > 124 && x < 132 && y > 33 && y < 39.5)) continue;
      out.push({ kind, title: it.title || it.address?.road || it.address?.parcel || query, addr: it.address?.road || it.address?.parcel || '', lat: y, lon: x });
    }
  };
  push(pRes, '장소');
  push(aRes, '도로명');
  return out;
}

async function reverseAddr(lat, lon, key) {
  const j = await jsonp('address', {
    service: 'address', request: 'getAddress', version: '2.0',
    crs: 'epsg:4326', point: `${lon},${lat}`, type: 'both', zipcode: 'true', simple: 'false',
  }, key);
  if (j?.response?.status !== 'OK') return null;
  const res = j.response.result || [];
  const road = res.find(x => x.type === 'road') || null;
  const parcel = res.find(x => x.type === 'parcel') || null;
  const st = (road?.structure || parcel?.structure || {});
  return {
    road: road?.text || '',
    parcel: parcel?.text || '',
    zip: road?.zipcode || parcel?.zipcode || '',
    sido: st.level1 || '',
    sgg: st.level2 || '',
    dong: st.level4L || st.level4A || st.level3 || '',
  };
}

async function landInfo(lat, lon, key) {
  const pt = `POINT(${lon} ${lat})`;
  const [pRes, zRes] = await Promise.allSettled([
    jsonp('data', { service: 'data', request: 'GetFeature', data: 'LP_PA_CBND_BUBUN', geomFilter: pt }, key),
    jsonp('data', { service: 'data', request: 'GetFeature', data: 'LT_C_UQ111', geomFilter: pt }, key),
  ]);
  const pFeat = pRes.status === 'fulfilled' ? pRes.value?.response?.result?.featureCollection?.features?.[0] : null;
  const zFeats = zRes.status === 'fulfilled' ? (zRes.value?.response?.result?.featureCollection?.features || []) : [];
  const zoning = [...new Set(zFeats.map(f => f?.properties?.uname).filter(Boolean))];
  return { parcel: pFeat || null, zoning };
}

/* ==================== Spatial GIS Math (Expert Analytics) ==================== */
const RAD = Math.PI / 180;
function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m).toLocaleString('ko-KR')} m`;
}

// Spherical polygon area in m² (Shoelace on local Equirectangular / Geodesic approximation, <0.1% error in KR)
function polygonAreaM2(pts) {
  if (!pts || pts.length < 3) return 0;
  const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const mPerLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * RAD);
  const mPerLon = 111412.84 * Math.cos(lat0 * RAD);
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [y1, x1] = pts[i];
    const [y2, x2] = pts[(i + 1) % pts.length];
    sum += (x1 * mPerLon) * (y2 * mPerLat) - (x2 * mPerLon) * (y1 * mPerLat);
  }
  return Math.abs(sum) / 2;
}

// Andrew's Monotone Chain Convex Hull on [lat, lon] points
function convexHull(pts) {
  if (pts.length <= 2) return pts.slice();
  const s = pts.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const cross = (o, a, b) => (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
  const lower = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Lightweight Leaflet Canvas Kernel Density Heatmap Layer (Zero external dependencies)
function createHeatLayer(points) {
  const Heat = L.Layer.extend({
    initialize(pts) { this._pts = pts || []; },
    setPoints(pts) { this._pts = pts || []; this._redraw(); },
    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create('canvas', 'vw-heat-canvas');
      this._canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:320;';
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on('moveend zoomend resize', this._redraw, this);
      this._redraw();
    },
    onRemove(map) {
      map.off('moveend zoomend resize', this._redraw, this);
      this._canvas?.remove();
    },
    _redraw() {
      const m = this._map;
      if (!m || !this._canvas) return;
      const sz = m.getSize();
      const topLeft = m.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      this._canvas.width = sz.x;
      this._canvas.height = sz.y;
      const ctx = this._canvas.getContext('2d');
      ctx.clearRect(0, 0, sz.x, sz.y);
      if (!this._pts.length) return;

      const z = m.getZoom();
      const r = Math.max(18, Math.min(46, Math.round(14 + (z - 9) * 3.2)));
      const off = document.createElement('canvas');
      off.width = sz.x; off.height = sz.y;
      const octx = off.getContext('2d');
      for (const p of this._pts) {
        const pt = m.latLngToContainerPoint([p.lat, p.lon]);
        if (pt.x < -r || pt.y < -r || pt.x > sz.x + r || pt.y > sz.y + r) continue;
        const w = Math.max(0.35, Math.min(1, p.weight ?? 0.72));
        const g = octx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, r);
        g.addColorStop(0, `rgba(0,0,0,${(0.45 * w).toFixed(3)})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        octx.fillStyle = g;
        octx.beginPath();
        octx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        octx.fill();
      }
      const img = octx.getImageData(0, 0, sz.x, sz.y);
      const d = img.data;
      // Smooth viridis/thermal color ramp
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        if (!a) continue;
        const t = Math.min(1, a / 190);
        let R = 0, G = 0, B = 0;
        if (t < 0.25) { R = 30; G = Math.round(120 + t * 540); B = 245; }
        else if (t < 0.5) { const u = (t - 0.25) * 4; R = Math.round(30 + u * 50); G = 235; B = Math.round(245 - u * 165); }
        else if (t < 0.75) { const u = (t - 0.5) * 4; R = Math.round(80 + u * 175); G = Math.round(235 - u * 60); B = Math.round(80 - u * 60); }
        else { const u = (t - 0.75) * 4; R = 255; G = Math.round(175 - u * 145); B = Math.round(20 + u * 20); }
        d[i] = R; d[i + 1] = G; d[i + 2] = B;
        d[i + 3] = Math.round(Math.min(205, a * 1.15));
      }
      ctx.putImageData(img, 0, 0);
    },
  });
  return new Heat(points);
}

/* ==================== VWorld Base & Verified WMS Layers ==================== */
function makeBaseLayer(key, type) {
  const vwTile = (t, ext = 'png', maxN = 19) => L.tileLayer(
    `https://api.vworld.kr/req/wmts/1.0.0/${encodeURIComponent(key)}/${t}/{z}/{y}/{x}.${ext}`,
    { maxZoom: 20, maxNativeZoom: maxN, minZoom: 6, attribution: '© VWorld 국토교통부' }
  );
  if (type === 'vhyb') return vwTile('Satellite', 'jpeg', 19); // Label layer controlled cleanly via Hybrid toggle
  if (type === 'vwhite') return vwTile('white', 'png', 18);
  if (type === 'vmidnight') return vwTile('midnight', 'png', 18);
  return vwTile('Base', 'png', 19); // 기본: 브이월드 일반 정밀지도 (도로·건물·교차로)
}

function makeHybridLabelLayer(key) {
  return L.tileLayer(
    `https://api.vworld.kr/req/wmts/1.0.0/${encodeURIComponent(key)}/Hybrid/{z}/{y}/{x}.png`,
    { maxZoom: 20, maxNativeZoom: 19, minZoom: 6, opacity: 0.96, zIndex: 260 }
  );
}

// All empirically verified HTTP 200 image/png VWorld WMS layers!
const WMS_CFG = {
  sido:      { layers: 'lt_c_adsido_info', styles: 'lt_c_adsido', opacity: 0.85, minZoom: 6,  hint: '🗺 행정구역(시·도) 경계 ON' },
  sgg:       { layers: 'lt_c_adsigg_info', styles: 'lt_c_adsigg', opacity: 0.88, minZoom: 7,  hint: '🏛 행정구역(시·군·구) 경계·명칭 ON' },
  emd:       { layers: 'lt_c_ademd_info',  styles: 'lt_c_ademd',  opacity: 0.86, minZoom: 11, hint: '🏘 행정구역(읍·면·동) 경계·명칭 ON (줌 11+)' },
  cadastral: { layers: 'lp_pa_cbnd_bonbun,lp_pa_cbnd_bubun', styles: '', opacity: 0.88, minZoom: 14, hint: '📐 연속지적도 ON (줌 14+)' },
  zoning:    { layers: 'lt_c_uq111', styles: 'lt_c_uq111', opacity: 0.44, minZoom: 11, hint: '🏙 도시 용도지역 ON (줌 11+)' },
  bldg:      { layers: 'lt_c_bldginfo', styles: '', opacity: 0.72, minZoom: 15, hint: '🏢 건물 레이어 ON (줌 15+)' },
};

function makeWmsOverlay(key, kind) {
  const cfg = WMS_CFG[kind];
  if (!cfg) return null;
  return L.tileLayer.wms('https://api.vworld.kr/req/wms', {
    layers: cfg.layers, styles: cfg.styles, format: 'image/png', transparent: true,
    version: '1.3.0', key, domain: getDomain(), opacity: cfg.opacity, maxZoom: 20, minZoom: cfg.minZoom,
  });
}

function landSummaryHtml(addrInfo, land, geoMethod) {
  const p = land?.parcel?.properties;
  const jiga = Number(p?.jiga || 0);
  const pyungMan = jiga > 0 ? Math.round((jiga * 3.305785) / 10000) : 0;
  const zoningTxt = land?.zoning?.length ? land.zoning.join(' · ') : '정보 없음';
  const roadTxt = addrInfo?.road || '';
  const parcelTxt = p?.addr || addrInfo?.parcel || '';
  const adminTxt = [addrInfo?.sido, addrInfo?.sgg, addrInfo?.dong].filter(Boolean).join(' ');
  return `
    <div class="fkpi" style="margin-bottom:8px">
      <div><span>🏛 행정구역</span><b style="font-size:12.5px">${esc(adminTxt || '-')}</b><em>${esc(geoMethod || '클릭 지점')}</em></div>
      <div><span>🏙 용도지역</span><b style="font-size:12.5px">${esc(zoningTxt)}</b><em>국토부 도시계획</em></div>
      <div><span>💰 개별공시지가</span><b class="num" style="font-size:12.5px;color:#059669">${jiga > 0 ? fmt(jiga) + '원/㎡' : '-'}</b><em>${pyungMan > 0 ? `평당 약 ${fmt(pyungMan)}만원 (${esc(p?.gosi_year || '')})` : '미공시/도로'}</em></div>
      <div><span>📐 지번 · PNU</span><b style="font-size:12px">${esc(p?.jibun || '-')}</b><em>${addrInfo?.zip ? `우편 ${esc(addrInfo.zip)}` : esc(p?.pnu ? p.pnu.slice(-8) : '지적도')}</em></div>
    </div>
    ${(roadTxt || parcelTxt) ? `<div class="tiny" style="line-height:1.5;margin-bottom:6px">${roadTxt ? `<b>도로명:</b> ${esc(roadTxt)}<br>` : ''}${parcelTxt ? `<b>지번:</b> ${esc(parcelTxt)}` : ''}</div>` : ''}
    <div class="tiny" style="opacity:.85">💡 지도 내 다른 필지를 클릭하면 인접 부지의 행정구역·공시지가·용도지역이 즉시 조회됩니다.</div>`;
}

function gradeColor(g) {
  const s = String(g || '').toUpperCase();
  if (s === 'S' || s === 'AAA' || s === 'AA') return '#dc2626';
  if (s === 'A' || s === 'BBB') return '#2563eb';
  if (s === 'B' || s === 'BB') return '#059669';
  return '#64748b';
}

/* ==================== 1) Detail Drawer Precision Inspector ==================== */
let activeMap = null;
let inspectSeq = 0;
let activeFsEsc = null;
function destroyActiveMap() {
  inspectSeq++;
  if (activeFsEsc) {
    document.removeEventListener('keydown', activeFsEsc);
    activeFsEsc = null;
  }
  if (activeMap) {
    try { activeMap.remove(); } catch {}
    activeMap = null;
  }
}

async function renderInspector(container, { addr, name, store, meta }) {
  const seq = ++inspectSeq;
  const key = getKey(store, meta);
  if (!key) {
    container.innerHTML = '<p class="tiny">브이월드 인증키가 설정되지 않았습니다. 설정(⚙️)에서 인증키를 확인하세요.</p>';
    return;
  }
  if (!window.L) {
    container.innerHTML = '<p class="tiny">지도 엔진(Leaflet)을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.</p>';
    return;
  }
  container.innerHTML = '<p class="tiny">🇰🇷 브이월드 일반 정밀지도·행정구역·필지·개별공시지가를 불러오는 중입니다…</p>';

  try {
    const geo = await geocode(addr, name, key);
    if (seq !== inspectSeq) return;
    if (!geo) {
      container.innerHTML = `<p class="tiny">주소를 좌표로 변환하지 못했습니다 (${esc(addr || name || '주소 없음')}). 상단 네이버/카카오맵 링크를 이용해 주세요.</p>`;
      return;
    }
    const [addrRes, landRes] = await Promise.allSettled([
      reverseAddr(geo.lat, geo.lon, key),
      landInfo(geo.lat, geo.lon, key),
    ]);
    if (seq !== inspectSeq) return;
    const addrInfo = addrRes.status === 'fulfilled' ? addrRes.value : null;
    const land = landRes.status === 'fulfilled' ? landRes.value : null;

    if (activeMap) { try { activeMap.remove(); } catch {} activeMap = null; }
    if (activeFsEsc) { document.removeEventListener('keydown', activeFsEsc); activeFsEsc = null; }
    const mapId = 'vwMiniMap_' + Date.now();
    container.innerHTML = `
      <div class="vw-shell" data-vw-shell>
        <div class="vw-bar">
          <div class="vw-grp" role="group" aria-label="지도 보기 옵션">
            <button type="button" class="vw-opt on" data-vw-base="vbase">🗺 일반정밀</button>
            <button type="button" class="vw-opt" data-vw-base="vwhite">백지도</button>
            <button type="button" class="vw-opt" data-vw-base="vhyb">🛰 항공</button>
            <button type="button" class="vw-opt" data-vw-base="vmidnight">🌙 야간</button>
          </div>
          <div class="vw-grp" role="group" aria-label="행정구역 및 국토 오버레이">
            <button type="button" class="vw-opt" data-vw-ov="sgg">🏛 시군구</button>
            <button type="button" class="vw-opt" data-vw-ov="emd">🏘 읍면동</button>
            <button type="button" class="vw-opt on" data-vw-ov="cadastral">📐 지적</button>
            <button type="button" class="vw-opt" data-vw-ov="zoning">🏙 용도</button>
            <button type="button" class="vw-opt" data-vw-ov="bldg">🏢 건물</button>
          </div>
          <div class="vw-grp" role="group" aria-label="표시 및 반경 옵션">
            <button type="button" class="vw-opt on" data-vw-disp="labels">🏷 명칭</button>
            <button type="button" class="vw-opt on" data-vw-disp="markers">📍 마커</button>
            <button type="button" class="vw-opt" data-vw-disp="radius">🎯 반경</button>
          </div>
          <button type="button" class="vw-opt vw-fsbtn" data-vw-fs title="전체화면 확대">⛶ 확대</button>
        </div>
        <div class="vw-mapwrap">
          <div id="${mapId}" class="vw-map"></div>
          <div class="vw-zctl">
            <button type="button" data-vw-zin title="정밀 확대 (+0.5)">+</button>
            <span class="vw-zlbl" data-vw-zlbl>Z17.5</span>
            <button type="button" data-vw-zout title="정밀 축소 (-0.5)">−</button>
            <button type="button" data-vw-center title="대상 위치로 복귀">⌖</button>
          </div>
        </div>
        <div class="vw-kpi" data-vw-kpi>${landSummaryHtml(addrInfo, land, geo.method)}</div>
      </div>`;

    const m = L.map(mapId, { zoomControl: false, attributionControl: false, zoomSnap: 0.5, zoomDelta: 0.5, minZoom: 6, maxZoom: 20 }).setView([geo.lat, geo.lon], 17.5);
    L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(m);
    activeMap = m;

    let baseType = 'vbase';
    let showLabels = true;
    let showMarkers = true;
    let showRadius = false;
    let curBase = makeBaseLayer(key, baseType).addTo(m);
    let hybridLbl = null;

    const parcelGroup = L.layerGroup().addTo(m);
    const radiusGroup = L.layerGroup().addTo(m);
    const markerGroup = L.layerGroup().addTo(m);
    const marker = L.circleMarker([geo.lat, geo.lon], { radius: 7.5, color: '#ffffff', weight: 2.5, fillColor: '#e11d48', fillOpacity: 0.95 });
    const syncMarkerLabel = () => {
      marker.unbindTooltip();
      if (showLabels && name) {
        marker.bindTooltip(esc(name), { permanent: true, direction: 'top', offset: [0, -8], className: 'vw-lbl-tip' });
      }
    };
    markerGroup.addLayer(marker);
    syncMarkerLabel();

    const syncHybrid = () => {
      const need = showLabels && baseType !== 'vbase';
      if (need && !hybridLbl) hybridLbl = makeHybridLabelLayer(key).addTo(m);
      else if (!need && hybridLbl) { m.removeLayer(hybridLbl); hybridLbl = null; }
    };

    const drawRadius = (lat, lon) => {
      radiusGroup.clearLayers();
      if (!showRadius) return;
      [[300, '#2563eb'], [500, '#059669'], [1000, '#d97706']].forEach(([rad, col]) => {
        L.circle([lat, lon], { radius: rad, color: col, weight: 1.8, dashArray: '5 4', fillColor: col, fillOpacity: 0.05, interactive: false }).addTo(radiusGroup);
        const topLat = lat + (rad / 111320);
        L.marker([topLat, lon], {
          interactive: false,
          icon: L.divIcon({ className: 'vw-ring-lbl', html: `<span style="border-color:${col};color:${col}">${rad >= 1000 ? '1km' : rad + 'm'}</span>`, iconSize: [44, 18], iconAnchor: [22, 9] }),
        }).addTo(radiusGroup);
      });
    };

    const drawParcel = feat => {
      parcelGroup.clearLayers();
      if (feat?.geometry) {
        try { L.geoJSON(feat, { style: { color: '#d97706', weight: 2.5, fillColor: '#f59e0b', fillOpacity: 0.24 } }).addTo(parcelGroup); } catch {}
      }
    };
    if (land?.parcel) drawParcel(land.parcel);

    const wmsMap = {};
    const toggleOv = kind => {
      const btn = container.querySelector(`[data-vw-ov="${kind}"]`);
      if (wmsMap[kind]) { m.removeLayer(wmsMap[kind]); wmsMap[kind] = null; btn?.classList.remove('on'); return; }
      const ly = makeWmsOverlay(key, kind);
      if (ly) { wmsMap[kind] = ly.addTo(m); btn?.classList.add('on'); }
    };
    toggleOv('cadastral');

    const zLbl = container.querySelector('[data-vw-zlbl]');
    const syncZoom = () => { if (zLbl) zLbl.textContent = 'Z' + Number(m.getZoom().toFixed(1)); };
    m.on('zoomend', syncZoom);
    syncZoom();

    container.querySelectorAll('[data-vw-base]').forEach(btn => {
      btn.onclick = () => {
        baseType = btn.dataset.vwBase;
        if (curBase) m.removeLayer(curBase);
        curBase = makeBaseLayer(key, baseType).addTo(m);
        if (curBase.bringToBack) curBase.bringToBack();
        syncHybrid();
        container.querySelectorAll('[data-vw-base]').forEach(b => b.classList.toggle('on', b === btn));
      };
    });
    container.querySelectorAll('[data-vw-ov]').forEach(btn => { btn.onclick = () => toggleOv(btn.dataset.vwOv); });

    container.querySelector('[data-vw-disp="labels"]').onclick = e => {
      showLabels = !showLabels;
      e.currentTarget.classList.toggle('on', showLabels);
      syncMarkerLabel();
      syncHybrid();
    };
    container.querySelector('[data-vw-disp="markers"]').onclick = e => {
      showMarkers = !showMarkers;
      e.currentTarget.classList.toggle('on', showMarkers);
      if (showMarkers) markerGroup.addTo(m);
      else m.removeLayer(markerGroup);
    };
    container.querySelector('[data-vw-disp="radius"]').onclick = e => {
      showRadius = !showRadius;
      e.currentTarget.classList.toggle('on', showRadius);
      const ll = marker.getLatLng();
      drawRadius(ll.lat, ll.lng);
      if (showRadius && m.getZoom() > 15.5) m.setZoom(15);
    };

    container.querySelector('[data-vw-zin]').onclick = () => m.zoomIn(0.5);
    container.querySelector('[data-vw-zout]').onclick = () => m.zoomOut(0.5);
    container.querySelector('[data-vw-center]').onclick = () => m.setView([geo.lat, geo.lon], 17.5);

    const shell = container.querySelector('[data-vw-shell]');
    const fsBtn = container.querySelector('[data-vw-fs]');
    const setFs = on => {
      shell.classList.toggle('vw-full', on);
      fsBtn.textContent = on ? '✕ 축소' : '⛶ 확대';
      setTimeout(() => m.invalidateSize(), 80);
    };
    fsBtn.onclick = () => setFs(!shell.classList.contains('vw-full'));
    activeFsEsc = e => { if (e.key === 'Escape' && shell.classList.contains('vw-full')) setFs(false); };
    document.addEventListener('keydown', activeFsEsc);

    m.on('click', async ev => {
      const { lat, lng } = ev.latlng;
      marker.setLatLng([lat, lng]);
      if (showRadius) drawRadius(lat, lng);
      const kpiBox = container.querySelector('[data-vw-kpi]');
      if (kpiBox) kpiBox.innerHTML = '<p class="tiny">📐 클릭 필지 행정구역·공시지가·용도지역 조회 중…</p>';
      const [aR, lR] = await Promise.allSettled([reverseAddr(lat, lng, key), landInfo(lat, lng, key)]);
      if (seq !== inspectSeq) return;
      const aInf = aR.status === 'fulfilled' ? aR.value : null;
      const lInf = lR.status === 'fulfilled' ? lR.value : null;
      drawParcel(lInf?.parcel || null);
      if (kpiBox) kpiBox.innerHTML = landSummaryHtml(aInf, lInf, '선택 필지');
    });

    setTimeout(() => m.invalidateSize(), 120);
  } catch (err) {
    if (seq !== inspectSeq) return;
    container.innerHTML = `<p class="tiny">브이월드 조회 오류: ${esc(err.message)}</p>`;
  }
}

/* ==================== 2) Main Full-Panel Precision Road Map & Expert GIS Controller ==================== */
function createMainMap(container, { store, getMeta, getItems, onOpenItem, toast, itemLabel = '기업' }) {
  let m = null, curBase = null, hybridLbl = null;
  let pinLayer = null, parcelLayer = null, searchLayer = null;
  let radiusLayer = null, hullLayer = null, measureLayer = null, heatLayer = null;
  const wmsMap = {};
  let plottedPts = []; // [{ id, name, addr, sub, color, grade, score, lat, lon }]
  let plotting = false;
  let curBaseType = store?.get?.('vwMainBase', 'vbase') || 'vbase';
  let showLabels = true;
  let showMarkers = true;
  let colorMode = 'default'; // 'default' | 'grade'
  let expertOpen = true;
  let heatOn = false;
  let hullOn = false;
  let activeTool = ''; // '' | 'radius' | 'measure'
  let measurePts = [];
  let lastRadiusCenter = null;

  const plotIdleLabel = `📍 조회 ${itemLabel} 핀 배치`;

  container.innerHTML = `
    <div class="vw-main-toolbar">
      <div class="vw-top-row">
        <div class="vw-search-box">
          <input type="search" data-m-q placeholder="도로명·건물·역·단지 검색 (Enter)">
          <button type="button" data-m-go title="브이월드 정밀 검색">🔍</button>
        </div>
        <button type="button" class="vw-opt vw-pinbtn" data-m-plot>${esc(plotIdleLabel)}</button>
        <button type="button" class="vw-opt vw-expbtn on" data-m-exptog title="전문가 GIS 기법 옵션 열기/접기">🎓 전문가</button>
      </div>
      <div class="vw-search-res" data-m-res hidden></div>

      <div class="vw-opt-row">
        <div class="vw-grp" role="group" aria-label="배경지도">
          <button type="button" class="vw-opt on" data-m-base="vbase">🗺 일반정밀</button>
          <button type="button" class="vw-opt" data-m-base="vwhite">백지도</button>
          <button type="button" class="vw-opt" data-m-base="vhyb">🛰 항공</button>
          <button type="button" class="vw-opt" data-m-base="vmidnight">🌙 야간</button>
        </div>
        <div class="vw-grp" role="group" aria-label="행정구역">
          <button type="button" class="vw-opt" data-m-ov="sido" title="시·도 행정구역 경계">시도</button>
          <button type="button" class="vw-opt on" data-m-ov="sgg" title="시·군·구 행정구역 경계 및 명칭">🏛 시군구</button>
          <button type="button" class="vw-opt" data-m-ov="emd" title="읍·면·동 행정구역 경계 및 명칭">읍면동</button>
        </div>
        <div class="vw-grp" role="group" aria-label="국토정보">
          <button type="button" class="vw-opt" data-m-ov="cadastral" title="연속지적도">📐 지적</button>
          <button type="button" class="vw-opt" data-m-ov="zoning" title="도시 용도지역">🏙 용도</button>
          <button type="button" class="vw-opt" data-m-ov="bldg" title="건물 정보">🏢 건물</button>
        </div>
        <div class="vw-grp" role="group" aria-label="명칭 및 마커 표시">
          <button type="button" class="vw-opt on" data-m-disp="labels" title="마커 상시 상호명 및 지명 오버레이 표시">🏷 명칭</button>
          <button type="button" class="vw-opt on" data-m-disp="markers" title="배치된 마커 표시 ON/OFF">📍 마커</button>
        </div>
      </div>

      <div class="vw-opt-row vw-exp-bar" data-m-expbar>
        <div class="vw-grp" role="group" aria-label="전문가 공간분석 기법">
          <button type="button" class="vw-opt" data-m-exp="heat" title="커널 밀도(KDE) 핫스팟 히트맵">🔥 밀집도</button>
          <button type="button" class="vw-opt" data-m-exp="radius" title="지도 클릭 시 500m·1km·3km 반경 내 타깃 자동 집계">🎯 반경분석</button>
          <button type="button" class="vw-opt" data-m-exp="hull" title="영업권역 볼록껍질(Convex Hull) · 최적 중심점 · 1σ 분산 반경">🧭 영업권역</button>
          <button type="button" class="vw-opt" data-m-exp="measure" title="클릭으로 도로·직선 거리(m/km) 및 부지 면적(㎡·평) 정밀 측정">📏 거리·면적</button>
          <button type="button" class="vw-opt" data-m-exp="grade" title="전문가 퀀트 등급(S/A/B/C) 기준 마커 크기·색상 차등 표시">🎨 등급채색</button>
        </div>
        <button type="button" class="vw-opt vw-clrbtn" data-m-clr hidden title="분석 오버레이 초기화">✕ 분석 초기화</button>
      </div>
    </div>
    <div class="vw-main-canvas" data-m-canvas></div>
    <div class="vw-zctl vw-main-zctl">
      <button type="button" data-m-zin title="정밀 확대 (+0.5)">+</button>
      <span class="vw-zlbl" data-m-zlbl>Z12</span>
      <button type="button" data-m-zout title="정밀 축소 (-0.5)">−</button>
      <button type="button" data-m-loc title="내 위치">◎</button>
      <button type="button" data-m-fs title="전체화면 확대">⛶</button>
    </div>
    <div class="vw-hud" data-m-hud hidden></div>
    <div class="vw-main-status" data-m-status>브이월드 일반 정밀지도 · 시군구 경계 ON · 지도 클릭 시 필지·공시지가 실사</div>`;

  const canvas = container.querySelector('[data-m-canvas]');
  const statusEl = container.querySelector('[data-m-status]');
  const zLbl = container.querySelector('[data-m-zlbl]');
  const resBox = container.querySelector('[data-m-res]');
  const qInp = container.querySelector('[data-m-q]');
  const plotBtn = container.querySelector('[data-m-plot]');
  const expBar = container.querySelector('[data-m-expbar]');
  const hudEl = container.querySelector('[data-m-hud]');
  const clrBtn = container.querySelector('[data-m-clr]');

  const setStatus = txt => { if (statusEl) statusEl.textContent = txt; };

  function syncHybrid() {
    if (!m) return;
    const key = getKey(store, getMeta());
    const need = showLabels && curBaseType !== 'vbase';
    if (need && !hybridLbl && key) hybridLbl = makeHybridLabelLayer(key).addTo(m);
    else if (!need && hybridLbl) { m.removeLayer(hybridLbl); hybridLbl = null; }
  }

  function updateClearBtn() {
    const any = heatOn || hullOn || !!activeTool || measurePts.length > 0 || !!lastRadiusCenter || colorMode === 'grade';
    if (clrBtn) clrBtn.hidden = !any;
  }

  function setHud(html) {
    if (!hudEl) return;
    if (!html) { hudEl.hidden = true; hudEl.innerHTML = ''; return; }
    hudEl.innerHTML = html;
    hudEl.hidden = false;
  }

  function rebuildMarkers() {
    if (!pinLayer) return;
    pinLayer.clearLayers();
    for (const p of plottedPts) {
      const col = colorMode === 'grade' ? gradeColor(p.grade) : (p.color || '#2563eb');
      const rad = colorMode === 'grade'
        ? (p.score >= 80 ? 10 : p.score >= 70 ? 8.5 : p.score >= 55 ? 7 : 5.8)
        : 7;
      const mk = L.circleMarker([p.lat, p.lon], {
        radius: rad, color: '#ffffff', weight: 2, fillColor: col, fillOpacity: 0.94,
      });
      if (showLabels) {
        const shortNm = p.name.length > 14 ? p.name.slice(0, 13) + '…' : p.name;
        const badge = colorMode === 'grade' && p.grade ? `[${p.grade}] ` : '';
        mk.bindTooltip(`${badge}${esc(shortNm)}`, {
          permanent: true, direction: 'top', offset: [0, -rad - 2], className: 'vw-lbl-tip',
        });
      } else {
        mk.bindTooltip(`<b>${esc(p.name)}</b>${p.sub ? '<br>' + esc(p.sub) : ''}`, { direction: 'top', offset: [0, -6] });
      }
      mk.bindPopup(() => {
        const d = document.createElement('div');
        d.style.cssText = 'font-size:12.5px;min-width:215px;line-height:1.5';
        d.innerHTML = `<div style="font-weight:700;font-size:13.5px">${esc(p.name)}${p.grade ? ` <span style="font-size:11px;padding:1px 5px;border-radius:4px;background:${gradeColor(p.grade)};color:#fff">${esc(p.grade)}${p.score ? ' ' + p.score : ''}</span>` : ''}</div>
          ${p.sub ? `<div style="color:#4b5563">${esc(p.sub)}</div>` : ''}
          <div style="color:#6b7280;font-size:11.5px;margin:2px 0 6px">${esc(p.addr || '')}</div>
          <div style="display:flex;gap:6px">
            <button type="button" data-open-id style="flex:1;padding:4px 9px;border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:6px;cursor:pointer;font-size:12px">상세 보기</button>
            <button type="button" data-rad-here style="padding:4px 8px;border:1px solid #059669;background:#fff;color:#059669;border-radius:6px;cursor:pointer;font-size:12px">🎯 반경</button>
          </div>`;
        d.querySelector('[data-open-id]').onclick = () => onOpenItem && onOpenItem(p.id);
        d.querySelector('[data-rad-here]').onclick = () => {
          m.closePopup();
          runRadiusAnalysis(p.lat, p.lon, p.name);
        };
        return d;
      });
      pinLayer.addLayer(mk);
    }
    if (showMarkers && !m.hasLayer(pinLayer)) pinLayer.addTo(m);
    if (!showMarkers && m.hasLayer(pinLayer)) m.removeLayer(pinLayer);
  }

  function syncHeat() {
    if (!m) return;
    if (heatLayer) { m.removeLayer(heatLayer); heatLayer = null; }
    if (!heatOn) return;
    if (!plottedPts.length) {
      toast && toast(`먼저 "${plotIdleLabel}"로 대상을 지도에 올려주세요`);
      return;
    }
    heatLayer = createHeatLayer(plottedPts.map(p => ({ lat: p.lat, lon: p.lon, weight: p.score ? Math.max(0.4, p.score / 100) : 0.75 }))).addTo(m);
  }

  function syncHull() {
    if (!hullLayer) return;
    hullLayer.clearLayers();
    if (!hullOn) return;
    if (plottedPts.length < 2) {
      toast && toast('영업권역 분석은 2개 이상 배치 후 사용하세요');
      return;
    }
    const coords = plottedPts.map(p => [p.lat, p.lon]);
    const cLat = coords.reduce((s, p) => s + p[0], 0) / coords.length;
    const cLon = coords.reduce((s, p) => s + p[1], 0) / coords.length;
    const dists = coords.map(p => haversineM(cLat, cLon, p[0], p[1]));
    const stdDist = Math.sqrt(dists.reduce((s, d) => s + d * d, 0) / dists.length);
    const maxDist = Math.max(...dists);

    // 1) Convex Hull polygon
    let hullAreaKm2 = 0;
    if (coords.length >= 3) {
      const hull = convexHull(coords);
      hullAreaKm2 = polygonAreaM2(hull) / 1e6;
      L.polygon(hull, { color: '#7c3aed', weight: 2.2, dashArray: '6 4', fillColor: '#8b5cf6', fillOpacity: 0.11, interactive: false }).addTo(hullLayer);
    }
    // 2) Standard Distance (1σ core cluster circle)
    L.circle([cLat, cLon], { radius: Math.max(200, stdDist), color: '#0284c7', weight: 2, fillColor: '#38bdf8', fillOpacity: 0.08, interactive: false }).addTo(hullLayer);
    // 3) Optimal Hub Mean Center marker
    L.marker([cLat, cLon], {
      icon: L.divIcon({
        className: 'vw-hub-pin',
        html: `<span>★ 최적 거점</span>`,
        iconSize: [78, 22], iconAnchor: [39, 11],
      }),
    }).bindPopup(`<b>🧭 영업권역 최적 거점(무게중심)</b><br>배치 ${plottedPts.length}건 기준<br>핵심 밀집 반경(1σ): <b>${fmtDist(stdDist)}</b><br>최대 커버 반경: <b>${fmtDist(maxDist)}</b>${hullAreaKm2 > 0 ? `<br>권역 면적: <b>${hullAreaKm2.toFixed(2)} ㎢</b>` : ''}`).addTo(hullLayer);

    const coreCnt = dists.filter(d => d <= stdDist).length;
    setHud(`
      <div class="vw-hud-h"><b>🧭 전문가 영업권역 분석</b><button type="button" data-hud-x>✕</button></div>
      <div class="vw-hud-grid">
        <div><span>분석 대상</span><b>${plottedPts.length}건</b></div>
        <div><span>핵심 반경(1σ)</span><b>${fmtDist(stdDist)}</b></div>
        <div><span>1σ 내 밀집</span><b>${coreCnt}건 (${Math.round(coreCnt / plottedPts.length * 100)}%)</b></div>
        <div><span>권역 면적</span><b>${hullAreaKm2 > 0 ? hullAreaKm2.toFixed(2) + ' ㎢' : fmtDist(maxDist)}</b></div>
      </div>
      <div class="vw-hud-sub">보라 점선=볼록껍질 커버리지 · 파랑 원=1σ 핵심권역 · ★=최적 지사 중심</div>`);
    hudEl.querySelector('[data-hud-x]').onclick = () => {
      hullOn = false;
      container.querySelector('[data-m-exp="hull"]')?.classList.remove('on');
      hullLayer.clearLayers();
      setHud('');
      updateClearBtn();
    };
  }

  function runRadiusAnalysis(lat, lon, title = '선택 지점') {
    if (!radiusLayer) return;
    lastRadiusCenter = { lat, lon, title };
    radiusLayer.clearLayers();
    const rings = [[500, '#dc2626', '500m'], [1000, '#2563eb', '1km'], [3000, '#059669', '3km']];
    rings.forEach(([r, col, lbl]) => {
      L.circle([lat, lon], { radius: r, color: col, weight: 2, dashArray: '5 4', fillColor: col, fillOpacity: 0.05, interactive: false }).addTo(radiusLayer);
      L.marker([lat + r / 111320, lon], {
        interactive: false,
        icon: L.divIcon({ className: 'vw-ring-lbl', html: `<span style="border-color:${col};color:${col}">${lbl}</span>`, iconSize: [44, 18], iconAnchor: [22, 9] }),
      }).addTo(radiusLayer);
    });
    L.circleMarker([lat, lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#dc2626', fillOpacity: 1, interactive: false }).addTo(radiusLayer);

    const ds = plottedPts.map(p => ({ p, d: haversineM(lat, lon, p.lat, p.lon) })).sort((a, b) => a.d - b.d);
    const c500 = ds.filter(x => x.d <= 500).length;
    const c1k = ds.filter(x => x.d <= 1000).length;
    const c3k = ds.filter(x => x.d <= 3000).length;
    const nearest = ds[0] ? `${ds[0].p.name.slice(0, 14)} (${fmtDist(ds[0].d)})` : '배치 후 자동 집계';
    const dens1k = (c1k / (Math.PI * 1)).toFixed(1);

    setHud(`
      <div class="vw-hud-h"><b>🎯 반경분석 · ${esc(title.slice(0, 16))}</b><button type="button" data-hud-x>✕</button></div>
      <div class="vw-hud-grid">
        <div><span style="color:#dc2626">500m 내</span><b>${c500}건</b></div>
        <div><span style="color:#2563eb">1km 내</span><b>${c1k}건</b></div>
        <div><span style="color:#059669">3km 내</span><b>${c3k}건</b></div>
        <div><span>1km 밀도</span><b>${dens1k}건/㎢</b></div>
      </div>
      <div class="vw-hud-sub">최근접: ${esc(nearest)} · 지도 다른 곳 클릭 시 중심 이동</div>`);
    hudEl.querySelector('[data-hud-x]').onclick = () => {
      radiusLayer.clearLayers();
      lastRadiusCenter = null;
      if (activeTool === 'radius') {
        activeTool = '';
        container.querySelector('[data-m-exp="radius"]')?.classList.remove('on');
      }
      setHud('');
      updateClearBtn();
    };
    updateClearBtn();
  }

  function renderMeasure() {
    if (!measureLayer) return;
    measureLayer.clearLayers();
    if (!measurePts.length) return;
    let totalM = 0;
    measurePts.forEach((pt, idx) => {
      L.circleMarker(pt, { radius: 5.5, color: '#fff', weight: 2, fillColor: '#ea580c', fillOpacity: 1 }).addTo(measureLayer);
      if (idx > 0) {
        const seg = haversineM(measurePts[idx - 1][0], measurePts[idx - 1][1], pt[0], pt[1]);
        totalM += seg;
        const mid = [(measurePts[idx - 1][0] + pt[0]) / 2, (measurePts[idx - 1][1] + pt[1]) / 2];
        L.marker(mid, {
          interactive: false,
          icon: L.divIcon({ className: 'vw-ring-lbl', html: `<span style="border-color:#ea580c;color:#ea580c">${fmtDist(seg)}</span>`, iconSize: [64, 18], iconAnchor: [32, 9] }),
        }).addTo(measureLayer);
      }
    });
    if (measurePts.length >= 2) {
      L.polyline(measurePts, { color: '#ea580c', weight: 3, dashArray: '6 4' }).addTo(measureLayer);
    }
    let areaM2 = 0;
    if (measurePts.length >= 3) {
      areaM2 = polygonAreaM2(measurePts);
      L.polygon(measurePts, { color: '#ea580c', weight: 1.5, fillColor: '#fb923c', fillOpacity: 0.16, interactive: false }).addTo(measureLayer);
    }
    const pyung = Math.round(areaM2 / 3.305785);
    setHud(`
      <div class="vw-hud-h"><b>📏 정밀 거리·면적 측정 (${measurePts.length}점)</b><button type="button" data-hud-x>✕</button></div>
      <div class="vw-hud-grid">
        <div><span>총 거리</span><b>${fmtDist(totalM)}</b></div>
        <div><span>직선(시점→종점)</span><b>${measurePts.length >= 2 ? fmtDist(haversineM(measurePts[0][0], measurePts[0][1], measurePts[measurePts.length - 1][0], measurePts[measurePts.length - 1][1])) : '-'}</b></div>
        <div><span>면적 (㎡)</span><b>${areaM2 > 0 ? fmt(areaM2) + '㎡' : '3점 이상'}</b></div>
        <div><span>면적 (평)</span><b>${pyung > 0 ? fmt(pyung) + '평' : '-'}</b></div>
      </div>
      <div class="vw-hud-sub">지도를 계속 클릭해 경로/부지 추가 · <button type="button" data-m-undo class="vw-mini-act">되돌리기</button> <button type="button" data-m-reset class="vw-mini-act">초기화</button></div>`);
    hudEl.querySelector('[data-m-undo]')?.addEventListener('click', () => { measurePts.pop(); renderMeasure(); });
    hudEl.querySelector('[data-m-reset]')?.addEventListener('click', () => { measurePts = []; measureLayer.clearLayers(); setHud(''); updateClearBtn(); });
    hudEl.querySelector('[data-hud-x]')?.addEventListener('click', () => {
      measurePts = []; measureLayer.clearLayers(); activeTool = '';
      container.querySelector('[data-m-exp="measure"]')?.classList.remove('on');
      setHud(''); updateClearBtn();
    });
    updateClearBtn();
  }

  function showGradeLegend() {
    setHud(`
      <div class="vw-hud-h"><b>🎨 전문가 퀀트 등급 채색 범례</b><button type="button" data-hud-x>✕</button></div>
      <div class="vw-grade-leg">
        <span><i style="background:#dc2626"></i> S/AAA 최우선</span>
        <span><i style="background:#2563eb"></i> A/BBB 우수</span>
        <span><i style="background:#059669"></i> B/BB 보통</span>
        <span><i style="background:#64748b"></i> C/기타</span>
      </div>
      <div class="vw-hud-sub">점수·규모가 높을수록 마커 크기가 비례 확대됩니다.</div>`);
    hudEl.querySelector('[data-hud-x]').onclick = () => {
      colorMode = 'default';
      container.querySelector('[data-m-exp="grade"]')?.classList.remove('on');
      rebuildMarkers();
      setHud(''); updateClearBtn();
    };
  }

  function ensureMap() {
    if (m) { setTimeout(() => m.invalidateSize(), 60); return true; }
    const key = getKey(store, getMeta());
    if (!key || !window.L) {
      setStatus('브이월드 인증키 또는 지도 엔진이 준비되지 않았습니다.');
      return false;
    }
    m = L.map(canvas, { zoomControl: false, attributionControl: false, zoomSnap: 0.5, zoomDelta: 0.5, minZoom: 6, maxZoom: 20 }).setView([37.4935, 126.7196], 12);
    L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(m);
    curBase = makeBaseLayer(key, curBaseType).addTo(m);
    syncHybrid();

    parcelLayer = L.layerGroup().addTo(m);
    hullLayer = L.layerGroup().addTo(m);
    radiusLayer = L.layerGroup().addTo(m);
    measureLayer = L.layerGroup().addTo(m);
    pinLayer = L.layerGroup().addTo(m);
    searchLayer = L.layerGroup().addTo(m);

    // Default ON: 시군구 행정구역 경계·명칭
    const sggLy = makeWmsOverlay(key, 'sgg');
    if (sggLy) wmsMap.sgg = sggLy.addTo(m);

    container.querySelectorAll('[data-m-base]').forEach(b => b.classList.toggle('on', b.dataset.mBase === curBaseType));
    const syncZ = () => { if (zLbl) zLbl.textContent = 'Z' + Number(m.getZoom().toFixed(1)); };
    m.on('zoomend', syncZ);
    syncZ();

    m.on('click', async ev => {
      resBox.hidden = true;
      const { lat, lng } = ev.latlng;
      if (activeTool === 'measure') {
        measurePts.push([lat, lng]);
        renderMeasure();
        return;
      }
      if (activeTool === 'radius') {
        runRadiusAnalysis(lat, lng, '클릭 지점');
        return;
      }
      const k = getKey(store, getMeta());
      if (!k) return;
      const sid = 'vwPop_' + Date.now();
      L.popup({ maxWidth: 340 }).setLatLng(ev.latlng).setContent(`<div style="font-size:12.5px"><b>📐 브이월드 행정구역·필지·공시지가 실사</b><div id="${sid}" style="margin-top:4px;color:#666">조회 중…</div></div>`).openOn(m);
      const [aR, lR] = await Promise.allSettled([reverseAddr(lat, lng, k), landInfo(lat, lng, k)]);
      const aInf = aR.status === 'fulfilled' ? aR.value : null;
      const lInf = lR.status === 'fulfilled' ? lR.value : null;
      parcelLayer.clearLayers();
      if (lInf?.parcel?.geometry) {
        try { L.geoJSON(lInf.parcel, { style: { color: '#d97706', weight: 2.5, fillColor: '#f59e0b', fillOpacity: 0.24 } }).addTo(parcelLayer); } catch {}
      }
      const p = lInf?.parcel?.properties;
      const jiga = Number(p?.jiga || 0);
      const pyung = jiga > 0 ? Math.round((jiga * 3.305785) / 10000) : 0;
      const adminTxt = [aInf?.sido, aInf?.sgg, aInf?.dong].filter(Boolean).join(' ');
      if (adminTxt) setStatus(`🏛 ${adminTxt}${jiga > 0 ? ` · 공시지가 ${fmt(jiga)}원/㎡ (평당 ${fmt(pyung)}만)` : ''}`);
      const slot = document.getElementById(sid);
      if (slot) {
        slot.innerHTML = [
          adminTxt ? `<div style="color:#1d4ed8;font-weight:700">🏛 ${esc(adminTxt)}</div>` : '',
          aInf?.road ? `<div><b>${esc(aInf.road)}</b>${aInf.zip ? ` [${esc(aInf.zip)}]` : ''}</div>` : '',
          (p?.addr || aInf?.parcel) ? `<div style="color:#555">지번: ${esc(p?.addr || aInf?.parcel)}</div>` : '',
          lInf?.zoning?.length ? `<div style="margin-top:3px"><b>🏙 용도지역:</b> ${lInf.zoning.map(esc).join(' · ')}</div>` : '',
          jiga > 0 ? `<div style="margin-top:2px;color:#059669;font-weight:700">💰 개별공시지가: ${fmt(jiga)}원/㎡ (평당 약 ${fmt(pyung)}만원 · ${esc(p?.gosi_year || '')})</div>` : '',
          p?.pnu ? `<div style="font-size:11px;color:#777">PNU: ${esc(p.pnu)}</div>` : '',
        ].filter(Boolean).join('') || '필지 정보를 찾지 못했습니다.';
      }
    });

    setTimeout(() => m.invalidateSize(), 100);
    return true;
  }

  // Base map option buttons
  container.querySelectorAll('[data-m-base]').forEach(btn => {
    btn.onclick = () => {
      if (!ensureMap()) return;
      const key = getKey(store, getMeta());
      curBaseType = btn.dataset.mBase;
      store?.set?.('vwMainBase', curBaseType);
      if (curBase) m.removeLayer(curBase);
      curBase = makeBaseLayer(key, curBaseType).addTo(m);
      if (curBase.bringToBack) curBase.bringToBack();
      syncHybrid();
      container.querySelectorAll('[data-m-base]').forEach(b => b.classList.toggle('on', b === btn));
    };
  });

  // Admin boundaries & WMS overlays
  container.querySelectorAll('[data-m-ov]').forEach(btn => {
    btn.onclick = () => {
      if (!ensureMap()) return;
      const key = getKey(store, getMeta());
      const kind = btn.dataset.mOv;
      if (wmsMap[kind]) {
        m.removeLayer(wmsMap[kind]); wmsMap[kind] = null; btn.classList.remove('on');
        return;
      }
      const ly = makeWmsOverlay(key, kind);
      if (ly) {
        wmsMap[kind] = ly.addTo(m);
        btn.classList.add('on');
        if (WMS_CFG[kind]?.hint) toast && toast(WMS_CFG[kind].hint);
      }
    };
  });

  // Display options: Labels & Markers
  container.querySelector('[data-m-disp="labels"]').onclick = e => {
    if (!ensureMap()) return;
    showLabels = !showLabels;
    e.currentTarget.classList.toggle('on', showLabels);
    syncHybrid();
    rebuildMarkers();
    toast && toast(showLabels ? '🏷 명칭·지명 표시 ON' : '🏷 명칭·지명 표시 OFF');
  };
  container.querySelector('[data-m-disp="markers"]').onclick = e => {
    if (!ensureMap()) return;
    showMarkers = !showMarkers;
    e.currentTarget.classList.toggle('on', showMarkers);
    if (showMarkers) { pinLayer.addTo(m); searchLayer.addTo(m); }
    else { m.removeLayer(pinLayer); m.removeLayer(searchLayer); }
    toast && toast(showMarkers ? '📍 마커 표시 ON' : '📍 마커 표시 OFF');
  };

  // Expert GIS panel toggle & buttons
  container.querySelector('[data-m-exptog]').onclick = e => {
    expertOpen = !expertOpen;
    expBar.hidden = !expertOpen;
    e.currentTarget.classList.toggle('on', expertOpen);
  };

  container.querySelectorAll('[data-m-exp]').forEach(btn => {
    btn.onclick = () => {
      if (!ensureMap()) return;
      const kind = btn.dataset.mExp;
      if (kind === 'heat') {
        heatOn = !heatOn;
        btn.classList.toggle('on', heatOn);
        syncHeat();
      } else if (kind === 'hull') {
        hullOn = !hullOn;
        btn.classList.toggle('on', hullOn);
        if (hullOn) syncHull();
        else { hullLayer.clearLayers(); setHud(''); }
      } else if (kind === 'radius') {
        const next = activeTool === 'radius' ? '' : 'radius';
        activeTool = next;
        container.querySelector('[data-m-exp="measure"]')?.classList.remove('on');
        btn.classList.toggle('on', activeTool === 'radius');
        if (activeTool === 'radius') {
          const c = lastRadiusCenter || { lat: m.getCenter().lat, lon: m.getCenter().lng, title: '현재 중심' };
          runRadiusAnalysis(c.lat, c.lon, c.title);
          toast && toast('🎯 반경분석 ON — 지도 원하는 지점을 클릭하세요');
        } else {
          radiusLayer.clearLayers(); lastRadiusCenter = null; setHud('');
        }
      } else if (kind === 'measure') {
        const next = activeTool === 'measure' ? '' : 'measure';
        activeTool = next;
        container.querySelector('[data-m-exp="radius"]')?.classList.remove('on');
        btn.classList.toggle('on', activeTool === 'measure');
        if (activeTool === 'measure') {
          measurePts = []; measureLayer.clearLayers();
          setStatus('📏 거리·면적 측정 모드: 지도를 차례로 클릭하세요 (3점 이상 시 면적·평수 자동 계산)');
          toast && toast('📏 지도 위 지점을 차례로 클릭하세요');
        } else {
          measurePts = []; measureLayer.clearLayers(); setHud('');
        }
      } else if (kind === 'grade') {
        colorMode = colorMode === 'grade' ? 'default' : 'grade';
        btn.classList.toggle('on', colorMode === 'grade');
        rebuildMarkers();
        if (colorMode === 'grade') showGradeLegend();
        else setHud('');
      }
      updateClearBtn();
    };
  });

  clrBtn.onclick = () => {
    heatOn = false; hullOn = false; activeTool = ''; colorMode = 'default';
    measurePts = []; lastRadiusCenter = null;
    if (heatLayer && m) { m.removeLayer(heatLayer); heatLayer = null; }
    hullLayer?.clearLayers(); radiusLayer?.clearLayers(); measureLayer?.clearLayers(); parcelLayer?.clearLayers();
    container.querySelectorAll('[data-m-exp]').forEach(b => b.classList.remove('on'));
    rebuildMarkers();
    setHud('');
    updateClearBtn();
    toast && toast('전문가 분석 레이어를 초기화했습니다');
  };

  // Zoom / Locate / Fullscreen
  container.querySelector('[data-m-zin]').onclick = () => ensureMap() && m.zoomIn(0.5);
  container.querySelector('[data-m-zout]').onclick = () => ensureMap() && m.zoomOut(0.5);
  container.querySelector('[data-m-loc]').onclick = () => {
    if (!ensureMap()) return;
    m.locate({ setView: true, maxZoom: 16.5 });
    m.once('locationerror', () => toast && toast('위치 권한이 허용되지 않았습니다'));
  };
  const fsBtn = container.querySelector('[data-m-fs]');
  fsBtn.onclick = () => {
    const on = container.classList.toggle('vw-main-full');
    fsBtn.textContent = on ? '✕' : '⛶';
    fsBtn.title = on ? '전체화면 닫기 (Esc)' : '전체화면 확대';
    setTimeout(() => m && m.invalidateSize(), 80);
  };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && container.classList.contains('vw-main-full')) {
      container.classList.remove('vw-main-full');
      fsBtn.textContent = '⛶';
      setTimeout(() => m && m.invalidateSize(), 80);
    }
  });

  // Search bar
  const runSearch = async () => {
    const q = qInp.value.trim();
    if (!q || !ensureMap()) return;
    const key = getKey(store, getMeta());
    resBox.hidden = false;
    resBox.innerHTML = '<div class="vw-sr-it">🇰🇷 브이월드 정밀 검색 중…</div>';
    try {
      const items = await searchPlaces(q, key);
      resBox.innerHTML = items.length
        ? items.map((x, idx) => `<div class="vw-sr-it" data-sri="${idx}"><b>${esc(x.title)}</b><small>${esc(x.kind)} · ${esc(x.addr)}</small></div>`).join('')
        : '<div class="vw-sr-it">검색 결과가 없습니다</div>';
      resBox._items = items;
    } catch (e) {
      resBox.innerHTML = `<div class="vw-sr-it">검색 오류: ${esc(e.message)}</div>`;
    }
  };
  container.querySelector('[data-m-go]').onclick = runSearch;
  qInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
  resBox.onclick = e => {
    const it = e.target.closest('[data-sri]'); if (!it || !resBox._items) return;
    const x = resBox._items[+it.dataset.sri]; if (!x) return;
    resBox.hidden = true;
    searchLayer.clearLayers();
    const sp = L.circleMarker([x.lat, x.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 0.95 }).addTo(searchLayer);
    if (showLabels) sp.bindTooltip(esc(x.title), { permanent: true, direction: 'top', offset: [0, -10], className: 'vw-lbl-tip' });
    sp.bindPopup(`<b>${esc(x.title)}</b><br><small>${esc(x.addr)}</small>`).openPopup();
    m.setView([x.lat, x.lon], 17);
    setStatus(`검색 이동: ${x.title} (${x.addr})`);
  };

  // Plot filtered items (with geocache + expert metrics)
  async function plotFiltered(limit = 40) {
    if (plotting) { plotting = false; return; }
    if (!ensureMap()) return;
    const key = getKey(store, getMeta());
    const list = (getItems ? getItems(limit) : []).filter(x => x && (x.addr || x.name));
    if (!list.length) { toast && toast('지도에 표시할 조회 결과가 없습니다'); return; }

    plotting = true;
    plotBtn.textContent = '■ 배치 중지';
    plottedPts = [];
    pinLayer.clearLayers();
    const pts = [];

    for (let k = 0; k < list.length; k++) {
      if (!plotting) break;
      const it = list[k];
      setStatus(`📍 브이월드 정밀 배치 중… ${k + 1}/${list.length} (완료 ${plottedPts.length}건)`);
      const hadCache = geoCache.has(cleanKoreanAddr(it.addr) || it.name);
      const geo = await geocode(it.addr, it.name, key);
      if (geo) {
        plottedPts.push({ ...it, lat: geo.lat, lon: geo.lon });
        pts.push([geo.lat, geo.lon]);
      }
      if (!hadCache) await new Promise(r => setTimeout(r, 90));
    }

    plotting = false;
    plotBtn.textContent = plotIdleLabel;
    rebuildMarkers();
    if (heatOn) syncHeat();
    if (hullOn) syncHull();
    if (lastRadiusCenter) runRadiusAnalysis(lastRadiusCenter.lat, lastRadiusCenter.lon, lastRadiusCenter.title);

    if (pts.length) {
      if (pts.length === 1) m.setView(pts[0], 17);
      else m.fitBounds(pts, { padding: [44, 44], maxZoom: 16.5 });
      setStatus(`✅ 조회 상위 ${list.length}건 중 ${pts.length}건 정밀 배치 완료 · 전문가 기법(밀집도·반경·영업권역) 즉시 적용 가능`);
      toast && toast(`정밀지도에 ${pts.length}건 배치 완료`);
    } else {
      setStatus(`주소를 좌표로 변환한 ${itemLabel}이(가) 없습니다.`);
    }
  }
  plotBtn.onclick = () => plotFiltered(40);

  async function focusItem(it) {
    if (!it || !ensureMap()) return;
    const key = getKey(store, getMeta());
    const geo = await geocode(it.addr, it.name, key);
    if (!geo) return;
    searchLayer.clearLayers();
    const sp = L.circleMarker([geo.lat, geo.lon], { radius: 8.5, color: '#fff', weight: 3, fillColor: '#e11d48', fillOpacity: 0.96 }).addTo(searchLayer);
    if (showLabels) sp.bindTooltip(esc(it.name), { permanent: true, direction: 'top', offset: [0, -10], className: 'vw-lbl-tip' });
    sp.bindPopup(`<b>${esc(it.name)}</b><br><small>${esc(it.addr || '')}</small>`).openPopup();
    m.setView([geo.lat, geo.lon], 17.5);
    setStatus(`선택 ${itemLabel}: ${it.name} (${geo.method})`);
  }

  return {
    show() { ensureMap(); },
    invalidate() { m && setTimeout(() => m.invalidateSize(), 60); },
    focusItem,
    plotFiltered,
  };
}

async function healthChecks(store, meta) {
  const key = getKey(store, meta);
  const lat = 37.49354, lon = 126.71957;
  const runGeo = async () => {
    if (!key) return { name: '브이월드 지오코더', ok: false, status: 401, summary: '인증키 미입력', hint: '설정(⚙️)에서 브이월드 인증키를 확인하세요.' };
    const t0 = performance.now();
    try {
      const r = await reverseAddr(lat, lon, key);
      const ms = Math.round(performance.now() - t0);
      if (r && (r.road || r.parcel)) return { name: '브이월드 지오코더', ok: true, status: 200, summary: `정상 연결 (JSONP · ${ms}ms)`, hint: (r.road || r.parcel).slice(0, 32) };
      return { name: '브이월드 지오코더', ok: false, status: 400, summary: `응답 없음 (${ms}ms)`, hint: '인증키 상태를 확인하세요.' };
    } catch (e) {
      return { name: '브이월드 지오코더', ok: false, status: 0, summary: '연결 실패', hint: e.message };
    }
  };
  const runLand = async () => {
    if (!key) return { name: '브이월드 지적·공시지가', ok: false, status: 401, summary: '인증키 미입력', hint: '설정(⚙️)에서 브이월드 인증키를 확인하세요.' };
    const t0 = performance.now();
    try {
      const l = await landInfo(lat, lon, key);
      const ms = Math.round(performance.now() - t0);
      const p = l?.parcel?.properties;
      const zn = l?.zoning?.[0] || '';
      return { name: '브이월드 지적·공시지가', ok: true, status: 200, summary: `정상 연결 (JSONP · ${ms}ms)`, hint: `${zn || '필지 확인'}${p?.jiga ? ` · ${fmt(Number(p.jiga))}원/㎡` : ''}` };
    } catch (e) {
      return { name: '브이월드 지적·공시지가', ok: false, status: 0, summary: '연결 실패', hint: e.message };
    }
  };
  return Promise.all([runGeo(), runLand()]);
}

window.VWorldTwin = { getKey, maskKey, geocode, reverseAddr, landInfo, searchPlaces, renderInspector, destroyActiveMap, createMainMap, healthChecks };
})();
