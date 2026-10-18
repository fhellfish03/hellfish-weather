// HellFish Weather recorder. Runs on a schedule in GitHub Actions (see .github/workflows/record.yml).
//
// Each run, for each town:
//   1. Once per local day (first run after 5 AM), saves that morning's 7-day forecast,
//      keyed by the day it is for and how many days ahead it was made ("lead").
//   2. Fills in what actually happened for recent past days: high and low from the
//      NWS airport station (real thermometer readings), with Open-Meteo's analysis as a
//      fallback, plus rainfall and, for Fort Oglethorpe, average soil temperature.
// It also saves the National Hurricane Center storm list, which the app can't fetch itself.
//
// It also keeps, refreshed on their own schedules:
//   data/almanac/<town>.json  normal and record highs and lows for every date (NOAA ACIS, monthly)
//   data/tides.json           Clearwater Beach high and low tide predictions (NOAA CO-OPS, every run)
//   data/creeks.json          latest USGS stream gauge readings near Fort Oglethorpe (every run)
//   data/iss.json             ISS orbit elements for pass predictions (CelesTrak, daily)
//
// Output: data/history/<town>.json, data/nhc.json and the files above. No packages needed (Node 20+).

import fs from "node:fs/promises";

const TOWNS = [
  { id: "fto", name: "Fort Oglethorpe", lat: 34.949, lon: -85.2569, station: "KCHA", soil: true, acis: ["CHAthr", "CHA"] },
  { id: "clw", name: "Clearwater", lat: 27.9659, lon: -82.8001, station: "KPIE", acis: ["TPAthr", "TPA"] },
  { id: "qc", name: "Queen Creek", lat: 33.2487, lon: -111.6343, station: "KIWA", acis: ["PHXthr", "PHX"] }
];
const NWS_HEADERS = { "User-Agent": "hellfish-weather personal weather app (github actions)", Accept: "application/geo+json" };
const SNAPSHOT_AFTER_HOUR = 5;

const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
const cToF = c => c * 9 / 5 + 32;
const dayMs = 864e5;
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / dayMs);
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * dayMs).toISOString().slice(0, 10);

async function getJSON(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status} from ${url}`);
  return r.json();
}
async function readJSON(path, fallback) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return fallback; }
}

async function stationHighLow(station, dateStr, offsetSec) {
  const start = new Date(Date.parse(dateStr + "T00:00:00Z") - offsetSec * 1000);
  const end = new Date(start.getTime() + dayMs);
  const url = `https://api.weather.gov/stations/${station}/observations?start=${start.toISOString()}&end=${end.toISOString()}`;
  const j = await getJSON(url, NWS_HEADERS);
  const temps = (j.features || [])
    .map(f => f.properties && f.properties.temperature && f.properties.temperature.value)
    .filter(v => typeof v === "number");
  if (temps.length < 12) return null; // too many gaps to trust
  return { hi: r1(cToF(Math.max(...temps))), lo: r1(cToF(Math.min(...temps))), n: temps.length };
}

async function recordTown(t) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${t.lat}&longitude=${t.lon}&timezone=auto&past_days=3&forecast_days=7`
    + `&temperature_unit=fahrenheit&precipitation_unit=inch`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max`
    + (t.soil ? `&hourly=soil_temperature_6cm` : "");
  const om = await getJSON(url);
  const off = om.utc_offset_seconds;
  const localNow = new Date(Date.now() + off * 1000);
  const today = localNow.toISOString().slice(0, 10);
  const hour = localNow.getUTCHours();
  const path = `data/history/${t.id}.json`;
  const hist = await readJSON(path, { town: t.id, name: t.name, station: t.station, started: today, days: {} });
  const D = om.daily;

  // 1. Morning forecast snapshot, once per local day
  if (hour >= SNAPSHOT_AFTER_HOUR && hist.lastSnapshot !== today) {
    D.time.forEach((d, i) => {
      const lead = daysBetween(today, d);
      if (lead < 0 || lead > 6) return;
      const day = (hist.days[d] ||= {});
      day.fc ||= {};
      if (day.fc[lead] == null) {
        day.fc[lead] = { hi: r1(D.temperature_2m_max[i]), lo: r1(D.temperature_2m_min[i]), pop: D.precipitation_probability_max[i] ?? null, rain: r2(D.precipitation_sum[i]) };
      }
    });
    hist.lastSnapshot = today;
  }

  // 2. What actually happened, for past days not yet final
  for (let i = 0; i < D.time.length; i++) {
    const d = D.time[i];
    if (d >= today) continue;
    const day = (hist.days[d] ||= {});
    if (day.obs && day.obs.final) continue;
    const obs = { hi: r1(D.temperature_2m_max[i]), lo: r1(D.temperature_2m_min[i]), rain: r2(D.precipitation_sum[i]), src: "model" };
    try {
      const st = await stationHighLow(t.station, d, off);
      if (st) { obs.hi = st.hi; obs.lo = st.lo; obs.src = t.station; }
    } catch (e) { console.log(`${t.id} ${d}: station read failed (${e.message}), using model values`); }
    if (t.soil && om.hourly && om.hourly.soil_temperature_6cm) {
      const vals = om.hourly.time.map((tm, k) => (tm.slice(0, 10) === d ? om.hourly.soil_temperature_6cm[k] : null)).filter(v => v != null);
      if (vals.length >= 20) obs.soil = r1(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
    obs.final = d <= addDays(today, -2);
    day.obs = obs;
  }

  hist.updated = new Date().toISOString();
  await fs.writeFile(path, JSON.stringify(hist));
  console.log(`${t.id}: ${Object.keys(hist.days).length} days on file, snapshot ${hist.lastSnapshot}`);
}

async function recordStorms() {
  try {
    const data = await getJSON("https://www.nhc.noaa.gov/CurrentStorms.json", { "User-Agent": NWS_HEADERS["User-Agent"] });
    await fs.writeFile("data/nhc.json", JSON.stringify({ fetched: new Date().toISOString(), data }));
    console.log(`nhc: ${(data.activeStorms || []).length} active storms`);
  } catch (e) { console.log(`nhc: fetch failed (${e.message}), keeping the last copy`); }
}

/* ---------- Almanac: normals (1991 to 2020) and records for each calendar date ---------- */
async function fileAgeDays(path) { try { return (Date.now() - (await fs.stat(path)).mtimeMs) / dayMs; } catch { return Infinity; } }
async function recordAlmanac(t) {
  const path = `data/almanac/${t.id}.json`;
  if ((await fileAgeDays(path)) < 30) return;
  let rows = null, sidUsed = null;
  for (const sid of t.acis) {
    try {
      const params = encodeURIComponent(JSON.stringify({ sid, sdate: "por", edate: "por", elems: "maxt,mint" }));
      const j = await getJSON(`https://data.rcc-acis.org/StnData?params=${params}`);
      if (j.data && j.data.length > 3650) { rows = j.data; sidUsed = sid; break; }
    } catch (e) { console.log(`${t.id} almanac ${sid}: ${e.message}`); }
  }
  if (!rows) { console.log(`${t.id} almanac: no station data, keeping the last copy`); return; }
  const num = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };
  const byMD = {};
  for (const [date, maxt, mint] of rows) {
    const md = date.slice(5), yr = Number(date.slice(0, 4)), hi = num(maxt), lo = num(mint);
    const e = (byMD[md] ||= { rh: null, rhy: null, rl: null, rly: null });
    if (hi != null && (e.rh == null || hi > e.rh)) { e.rh = hi; e.rhy = yr; }
    if (lo != null && (e.rl == null || lo < e.rl)) { e.rl = lo; e.rly = yr; }
  }
  /* Normals: 1991 to 2020 average, smoothed over a 15-day window centered on the date */
  const ref = rows.filter(r => r[0] >= "1991-01-01" && r[0] <= "2020-12-31");
  const doy = d => Math.round((Date.parse("2001" + d.slice(4) + "T00:00:00Z") - Date.parse("2001-01-01T00:00:00Z")) / dayMs);
  const sums = Array.from({ length: 366 }, () => ({ h: 0, hn: 0, l: 0, ln: 0 }));
  for (const [date, maxt, mint] of ref) {
    if (date.slice(5) === "02-29") continue;
    const k = doy(date), hi = num(maxt), lo = num(mint);
    if (hi != null) { sums[k].h += hi; sums[k].hn++; }
    if (lo != null) { sums[k].l += lo; sums[k].ln++; }
  }
  const out = {};
  for (let k = 0; k < 365; k++) {
    let h = 0, hn = 0, l = 0, ln = 0;
    for (let w = -7; w <= 7; w++) { const s = sums[(k + w + 365) % 365]; h += s.h; hn += s.hn; l += s.l; ln += s.ln; }
    const md = new Date(Date.parse("2001-01-01T00:00:00Z") + k * dayMs).toISOString().slice(5, 10);
    out[md] = { nh: hn ? r1(h / hn) : null, nl: ln ? r1(l / ln) : null, ...byMD[md] };
  }
  out["02-29"] = { ...out["02-28"], ...byMD["02-29"] };
  await fs.mkdir("data/almanac", { recursive: true });
  await fs.writeFile(path, JSON.stringify({ sid: sidUsed, since: rows[0][0], built: new Date().toISOString(), days: out }));
  console.log(`${t.id} almanac: ${sidUsed}, records since ${rows[0][0]}`);
}

/* ---------- Clearwater tides ---------- */
async function recordTides() {
  try {
    const now = new Date(Date.now() - 5 * 3600e3);
    const begin = now.toISOString().slice(0, 10).replace(/-/g, "");
    const j = await getJSON(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=hellfish_weather&begin_date=${begin}&range=96&datum=MLLW&station=8726724&time_zone=lst_ldt&units=english&interval=hilo&format=json`);
    if (!j.predictions) throw new Error(j.error ? j.error.message : "no predictions");
    await fs.writeFile("data/tides.json", JSON.stringify({ fetched: new Date().toISOString(), station: "8726724", predictions: j.predictions }));
    console.log(`tides: ${j.predictions.length} predictions`);
  } catch (e) { console.log(`tides: ${e.message}, keeping the last copy`); }
}

/* ---------- Creek gauges near Fort Oglethorpe ---------- */
async function recordCreeks() {
  try {
    const j = await getJSON("https://waterservices.usgs.gov/nwis/iv/?format=json&bBox=-85.50,34.75,-85.00,35.10&parameterCd=00060,00065&siteStatus=active&period=P7D");
    await fs.writeFile("data/creeks.json", JSON.stringify({ fetched: new Date().toISOString(), data: j }));
    console.log(`creeks: ${(j.value && j.value.timeSeries || []).length} series`);
  } catch (e) { console.log(`creeks: ${e.message}, keeping the last copy`); }
}

/* ---------- ISS orbit elements ---------- */
async function recordISS() {
  if ((await fileAgeDays("data/iss.json")) < 0.9) return;
  try {
    const r = await fetch("https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE", { headers: { "User-Agent": NWS_HEADERS["User-Agent"] } });
    if (!r.ok) throw new Error(r.status);
    const lines = (await r.text()).trim().split(/\r?\n/).map(x => x.trim());
    if (lines.length < 3 || !lines[1].startsWith("1 ") || !lines[2].startsWith("2 ")) throw new Error("unexpected format");
    await fs.writeFile("data/iss.json", JSON.stringify({ fetched: new Date().toISOString(), name: lines[0], tle1: lines[1], tle2: lines[2] }));
    console.log("iss: orbit elements saved");
  } catch (e) { console.log(`iss: ${e.message}, keeping the last copy`); }
}

await fs.mkdir("data/history", { recursive: true });
let failures = 0;
for (const t of TOWNS) {
  try { await recordTown(t); } catch (e) { failures++; console.log(`${t.id}: failed (${e.message})`); }
}
await recordStorms();
for (const t of TOWNS) { try { await recordAlmanac(t); } catch (e) { console.log(`${t.id} almanac failed (${e.message})`); } }
await recordTides();
await recordCreeks();
await recordISS();
if (failures === TOWNS.length) process.exit(1); // every town failed: flag the run as failed in GitHub
