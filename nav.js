/* 자리먼저 내비 연동 — 경로 기반 ETA 모델 · 길안내 딥링크 · 백엔드 API 어댑터
 * modelRoute는 backend/app/nav.py model_route와 같은 식이다 (backend/tests가 교차 검증). */
(function (root) {
  'use strict';

  const DEST = { name: '한결종합병원', lat: 37.5006, lng: 127.0364 };   // 가상 시설 위치
  // 시간대(0~23시)별 도심 · 간선 평균 속도(km/h) [가정]
  const URBAN_KMH = [38, 40, 40, 40, 38, 34, 30, 26, 19, 21, 25, 26, 26, 26, 25, 25, 24, 20, 18, 22, 28, 32, 34, 36];
  const HWY_KMH = [85, 88, 88, 88, 85, 78, 68, 60, 42, 50, 62, 65, 66, 66, 65, 64, 60, 45, 40, 55, 68, 75, 80, 82];
  const SAMPLE_ORIGINS = [
    { label: '판교역', lat: 37.3947, lng: 127.1112 },
    { label: '서울역', lat: 37.5547, lng: 126.9707 },
    { label: '수원역', lat: 37.2657, lng: 127.0000 },
    { label: '잠실역', lat: 37.5133, lng: 127.1001 },
  ];
  const PROVIDER_KO = { tmap: 'TMAP 실시간 교통', kakao: '카카오내비 실시간 교통', model: '교통 패턴 모델', manual: '직접 입력', 'reservation-prior': '예약 시각 기준' };
  const API_KEY = 'parkahead.api';

  function haversineKm(aLat, aLng, bLat, bLng) {
    const R = 6371.0088, to = Math.PI / 180;
    const dLat = (bLat - aLat) * to, dLng = (bLng - aLng) * to;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * to) * Math.cos(bLat * to) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function stdOf(dur, traffic) { return traffic ? Math.max(180, 0.08 * dur) : Math.max(240, 0.15 * dur); }
  // hour: 출발 시각(KST, 0~23)
  function modelRoute(o, d, hour) {
    const air = haversineKm(o.lat, o.lng, d.lat, d.lng);
    const km = air * (1.25 + 0.15 * Math.exp(-air / 5));
    const urban = Math.min(km, 6 + 0.15 * Math.max(0, km - 6));
    const hwy = km - urban;
    const h = ((Math.floor(hour) % 24) + 24) % 24;
    const dur = urban / URBAN_KMH[h] * 3600 + hwy / HWY_KMH[h] * 3600 + 90;
    return { provider: 'model', duration_s: dur, distance_m: km * 1000, traffic: false, std_s: stdOf(dur, false) };
  }

  // 길안내 앱 딥링크 (TMAP은 iOS · Android 파라미터가 다르다)
  function deepLink(app, dest, ua) {
    dest = dest || DEST;
    ua = ua || (typeof navigator !== 'undefined' ? navigator.userAgent : '');
    const ios = /iPhone|iPad|iPod/i.test(ua);
    const n = encodeURIComponent(dest.name);
    if (app === 'tmap') return ios
      ? `tmap://route?rGoName=${n}&rGoX=${dest.lng}&rGoY=${dest.lat}`
      : `tmap://route?referrer=com.skt.Tmap&goalx=${dest.lng}&goaly=${dest.lat}&goalname=${n}`;
    if (app === 'kakao') return `kakaomap://route?ep=${dest.lat},${dest.lng}&by=CAR`;
    const host = typeof location !== 'undefined' && location.hostname ? location.hostname : 'parkahead';
    return `nmap://navigation?dlat=${dest.lat}&dlng=${dest.lng}&dname=${n}&appname=${encodeURIComponent(host)}`;
  }

  // 백엔드 주소: ?api= 또는 저장값 또는 config.js. 허용 목록 밖의 주소는 쓰지 않는다 (위치가 엉뚱한 서버로 가지 않게)
  function apiBase() {
    const cfg = root.PARKAHEAD_CONFIG || {};
    const allowed = (cfg.allowedApiOrigins || []).slice();
    if (cfg.api) try { allowed.push(new URL(cfg.api).origin); } catch (e) { /* 무시 */ }
    const isLocal = o => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
    let cand = null;
    try {
      const q = new URLSearchParams(location.search).get('api');
      if (q === 'off') { localStorage.removeItem(API_KEY); return null; }
      cand = q || localStorage.getItem(API_KEY);
    } catch (e) { /* 저장소 차단 환경 */ }
    cand = cand || cfg.api || null;
    if (!cand) return null;
    let origin;
    try { origin = new URL(cand).origin; } catch (e) { return null; }
    if (!isLocal(origin) && !allowed.includes(origin)) return null;
    try { localStorage.setItem(API_KEY, origin); } catch (e) { /* 무시 */ }
    return origin;
  }

  function Api(base) { this.base = base; }
  Api.prototype.req = async function (method, path, body) {
    const r = await fetch(this.base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const d = data.detail;
      throw new Error(typeof d === 'string' ? d : d ? JSON.stringify(d) : `서버 응답 ${r.status}`);
    }
    return data;
  };
  Api.prototype.health = function () { return this.req('GET', '/health'); };
  Api.prototype.createSession = function (reservation) { return this.req('POST', '/v1/sessions', { reservation_token: reservation }); };
  Api.prototype.consent = function (tok, body) { return this.req('POST', `/v1/sessions/${tok}/consent`, body); };
  Api.prototype.eta = function (tok, body) { return this.req('POST', `/v1/sessions/${tok}/eta`, body); };
  Api.prototype.assignment = function (tok, preview) { return this.req('GET', `/v1/sessions/${tok}/assignment${preview ? '?preview=true' : ''}`); };
  Api.prototype.assignNow = function (tok) { return this.req('POST', `/v1/sessions/${tok}/assign-now`); };
  Api.prototype.demoEnter = function (tok) { return this.req('POST', `/v1/sessions/${tok}/demo/enter`); };
  Api.prototype.demoPark = function (tok) { return this.req('POST', `/v1/sessions/${tok}/demo/park`); };
  Api.prototype.state = function (fid) { return this.req('GET', `/v1/facilities/${fid}/state?slots=true`); };

  // ISO 시각 → "오늘 07:00 KST 기준 초" (화면의 시뮬레이션 시각과 같은 축)
  function isoToT(iso) { return msToT(new Date(iso).getTime()); }
  function msToT(ms) { const s = Math.floor(ms / 1000) + 9 * 3600; return ((s % 86400) + 86400) % 86400 - 7 * 3600; }
  function nowT() { return msToT(Date.now()); }
  function kstHour(ms) { return Math.floor((((Math.floor(ms / 1000) + 9 * 3600) % 86400) + 86400) % 86400 / 3600); }

  const API = { DEST, SAMPLE_ORIGINS, PROVIDER_KO, URBAN_KMH, HWY_KMH, haversineKm, modelRoute, stdOf, deepLink, apiBase, Api, isoToT, nowT, kstHour };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.ParkNav = API;
})(typeof window !== 'undefined' ? window : globalThis);
