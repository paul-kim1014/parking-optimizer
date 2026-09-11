// engine.js · nav.js 계산값을 JSON으로 내보낸다. backend/tests가 Python 구현과 비교한다.
// 실행: node backend/scripts/export_js_fixture.js
const fs = require('fs');
const path = require('path');
const E = require('../../engine.js');
const N = require('../../nav.js');

const fac = E.buildFacility();
const NZ = E.ZONES.length;
const hours = [0, 3, 8, 12];
const slots = [];
for (let i = 0; i < fac.N; i += 7) {
  const s = fac.slots[i];
  const walk = {}, best = {};
  for (const h of hours) {
    walk[h] = []; best[h] = [];
    for (let z = 0; z < NZ; z++) { walk[h].push(fac.walkTab[h][i * NZ + z]); best[h].push(fac.bestE[h][i * NZ + z]); }
  }
  slots.push({ i, label: s.label, f: s.f, zone: s.zone, disabled: s.disabled, ev: s.ev, compact: s.compact, closed: s.closedDefault,
    drive: [fac.drive[i * 2], fac.drive[i * 2 + 1]], walk, best });
}
// 비용 함수: 가상 상태 한 개에서 몇 가지 차량 조건의 상위 5개 슬롯
const status = new Uint8Array(fac.N);
for (let s = 0; s < fac.N; s++) status[s] = fac.slots[s].closedDefault ? E.CLOSED : (s * 37) % 10 < 7 ? E.OCC : E.FREE;
const ctx = { h: 3, rampPen: [12, 4], floorPen: [30, 0, 0] };
const vehicles = [{ zone: 0 }, { zone: 3, disabled: true }, { zone: 5, ev: true, evWant: true }, { zone: 2, large: true }];
const ranks = vehicles.map(v => E.rankSlots(fac, status, v, ctx, E.DEFAULT_W, 5).map(c => ({ s: c.s, ramp: c.ramp, total: c.total })));
const origins = N.SAMPLE_ORIGINS.concat([{ label: '인천공항', lat: 37.4602, lng: 126.4407 }]);
const model = [];
for (const o of origins) for (const h of [3, 8, 13, 18]) {
  const r = N.modelRoute(o, N.DEST, h);
  model.push({ origin: o, hour: h, duration_s: r.duration_s, distance_m: r.distance_m, std_s: r.std_s });
}
const out = path.join(__dirname, '../tests/fixtures/js_tables.json');
fs.writeFileSync(out, JSON.stringify({ N: fac.N, hours, slots, rank_case: { status: Array.from(status), ctx, vehicles, ranks }, model }));
console.log('wrote', out, 'slots', slots.length, 'model cases', model.length);
