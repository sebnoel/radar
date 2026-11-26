const AIRLINES = {
  UAL:'United', AAL:'American', DAL:'Delta', SWA:'Southwest', JBU:'JetBlue', ACA:'Air Canada',
  AFR:'Air France', BAW:'British Airways', DLH:'Lufthansa', KLM:'KLM', RYR:'Ryanair', EZY:'easyJet',
  UAE:'Emirates', IBE:'Iberia', VLG:'Vueling', TVF:'Transavia', SWR:'Swiss', SAS:'SAS',
  TAP:'TAP Portugal', FDX:'FedEx', UPS:'UPS', QTR:'Qatar', THY:'Turkish', ETD:'Etihad',
  AZA:'ITA Airways', AUA:'Austrian', BEL:'Brussels', FIN:'Finnair', EIN:'Aer Lingus',
  NAX:'Norwegian', WZZ:'Wizz Air', ELY:'El Al', SIA:'Singapore', CPA:'Cathay', ANA:'ANA',
  JAL:'JAL', KAL:'Korean Air', QFA:'Qantas', OCN:'Discover', EWG:'Eurowings', CFG:'Condor',
  TOM:'TUI', TUI:'TUI', EXS:'Jet2', BCS:'DHL', GEC:'Lufthansa Cargo', CLX:'Cargolux',
  MSR:'EgyptAir', RAM:'Royal Air Maroc', DAH:'Air Algérie', TAR:'Tunisair', AEE:'Aegean',
  LOT:'LOT Polish', CSA:'Czech Airlines', BTI:'airBaltic', HOP:'Air France Hop',
  AEA:'Air Europa', VOE:'Volotea', EZS:'easyJet CH', TRA:'Transavia', SXS:'SunExpress',
  PGT:'Pegasus', EJU:'easyJet'
};

const UA_HEADER = { 'User-Agent': 'FlightDisplayRadar/1.0', 'Accept': 'application/json' };
const REGISTRY_KEY = 'subs_registry';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // Expiration après 30 jours d'inactivité totale
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;        // Anti-doublon de 15 min par avion

let lastCronInMemory = null;

/* ============ Registre unique (1 lecture KV, 0 appel list) ============ */
async function loadRegistry(env) {
  const existing = await env.RADAR_KV.get(REGISTRY_KEY, 'json');
  if (existing && typeof existing === 'object') {
    return { registry: existing, migrated: false };
  }

  const registry = {};
  const list = await env.RADAR_KV.list({ prefix: 'sub:' });
  if (list.keys.length) {
    const legacySubs = await Promise.all(list.keys.map(k => env.RADAR_KV.get(k.name, 'json')));
    for (const s of legacySubs) {
      if (s && s.topic && s.enabled) {
        registry[s.topic] = {
          ...s,
          expiresAt: Date.now() + SESSION_TTL_MS,
          sent: {}
        };
      }
    }
    await Promise.all(list.keys.map(k => env.RADAR_KV.delete(k.name)));
  }
  await env.RADAR_KV.put(REGISTRY_KEY, JSON.stringify(registry));
  return { registry, migrated: true };
}

/* ============ Générateur PNG pur JS (miniature radar 240x240) ============ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function encodePNG(w, h, rgba) {
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
  }
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();

  const parts = [];
  let total = 0;
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const zdat = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { zdat.set(p, off); off += p.length; }

  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, w);
  idv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const c1 = pngChunk('IHDR', ihdr);
  const c2 = pngChunk('IDAT', zdat);
  const c3 = pngChunk('IEND', new Uint8Array(0));

  const png = new Uint8Array(sig.length + c1.length + c2.length + c3.length);
  png.set(sig, 0);
  png.set(c1, sig.length);
  png.set(c2, sig.length + c1.length);
  png.set(c3, sig.length + c1.length + c2.length);
  return png;
}

async function renderRadarPNG({ dx = 1.2, dy = 1.5, tr = 45, r = 15, zr = 3.5 }) {
  const S = 240, cx = 120, cy = 120, R = 110;
  const rgba = new Uint8Array(S * S * 4);

  const blend = (x, y, cr, cg, cb, ca) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= S || y >= S || ca <= 0) return;
    const i = (y * S + x) * 4;
    const a = Math.min(1, ca);
    rgba[i]     = Math.round(rgba[i]     * (1 - a) + cr * a);
    rgba[i + 1] = Math.round(rgba[i + 1] * (1 - a) + cg * a);
    rgba[i + 2] = Math.round(rgba[i + 2] * (1 - a) + cb * a);
    rgba[i + 3] = 255;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= R) {
        const k = 1 - d / R;
        rgba[i]     = Math.round(4 + 10 * k);
        rgba[i + 1] = Math.round(30 + 48 * k);
        rgba[i + 2] = Math.round(13 + 22 * k);
      } else {
        rgba[i] = 2; rgba[i + 1] = 10; rgba[i + 2] = 6;
      }
      rgba[i + 3] = 255;
    }
  }

  const circle = (x0, y0, rad, cr, cg, cb, ca, thick = 1.3) => {
    const minX = Math.max(0, Math.floor(x0 - rad - 2));
    const maxX = Math.min(S - 1, Math.ceil(x0 + rad + 2));
    const minY = Math.max(0, Math.floor(y0 - rad - 2));
    const maxY = Math.min(S - 1, Math.ceil(y0 + rad + 2));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const diff = Math.abs(Math.hypot(x - x0, y - y0) - rad);
        if (diff < thick) blend(x, y, cr, cg, cb, ca * (1 - diff / thick));
      }
    }
  };

  const fillCircle = (x0, y0, rad, cr, cg, cb, ca) => {
    const minX = Math.max(0, Math.floor(x0 - rad - 1));
    const maxX = Math.min(S - 1, Math.ceil(x0 + rad + 1));
    const minY = Math.max(0, Math.floor(y0 - rad - 1));
    const maxY = Math.min(S - 1, Math.ceil(y0 + rad + 1));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const d = Math.hypot(x - x0, y - y0);
        if (d <= rad) blend(x, y, cr, cg, cb, ca * Math.min(1, rad - d + 0.5));
      }
    }
  };

  const line = (x0, y0, x1, y1, cr, cg, cb, ca, thick = 1.2) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
    for (let s = 0; s <= steps; s++) {
      const t = steps ? s / steps : 0;
      fillCircle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thick, cr, cg, cb, ca);
    }
  };

  for (let k = 1; k <= 4; k++) circle(cx, cy, R * k / 4, 90, 255, 130, k === 4 ? 0.75 : 0.4, 1.3);
  line(cx - R, cy, cx + R, cy, 90, 255, 130, 0.35, 0.8);
  line(cx, cy - R, cx, cy + R, 90, 255, 130, 0.35, 0.8);

  const scale = R / Math.max(1, r);
  const zPx = Math.min(R - 4, Math.max(18, zr * scale));
  fillCircle(cx, cy, zPx, 255, 190, 60, 0.14);
  circle(cx, cy, zPx, 255, 190, 60, 0.85, 1.6);

  fillCircle(cx, cy, 4, 244, 255, 208, 1);

  const px = Math.max(24, Math.min(S - 24, cx + dx * scale));
  const py = Math.max(24, Math.min(S - 24, cy - dy * scale));
  const radTr = (tr || 0) * Math.PI / 180;
  const sin = Math.sin(radTr), cos = Math.cos(radTr);

  line(px - sin * 28, py + cos * 28, px, py, 255, 190, 60, 0.45, 1.2);
  fillCircle(px, py, 16, 255, 190, 60, 0.22);

  const rot = (lx, ly) => [px + lx * cos + ly * sin, py + lx * sin - ly * cos];
  const seg = (ax, ay, bx, by, th) => {
    const [x0, y0] = rot(ax, ay), [x1, y1] = rot(bx, by);
    line(x0, y0, x1, y1, 255, 205, 80, 1, th);
  };
  seg(0, 11, 0, -10, 2.2);
  seg(-11, -2, 0, 4, 2.0);
  seg(11, -2, 0, 4, 2.0);
  seg(-5, -9, 0, -6, 1.5);
  seg(5, -9, 0, -6, 1.5);

  return encodePNG(S, S, rgba);
}

/* ============ Calculs géographiques & API ADS-B ============ */
function kmDist(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function isWithinSchedule(startStr = '09:00', endStr = '00:00', tz = 'Europe/Paris') {
  const parseMin = s => {
    const [h, m] = String(s || '00:00').split(':').map(Number);
    return (isFinite(h) ? h : 0) * 60 + (isFinite(m) ? m : 0);
  };
  const start = parseMin(startStr);
  const end = parseMin(endStr);
  if (start === end) return true;

  let nowMin;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const h = Number(parts.find(p => p.type === 'hour')?.value || 0) % 24;
    const m = Number(parts.find(p => p.type === 'minute')?.value || 0);
    nowMin = h * 60 + m;
  } catch (e) {
    const d = new Date();
    nowMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  return end > start ? (nowMin >= start && nowMin < end) : (nowMin >= start || nowMin < end);
}

function getAltitudeFeet(p) {
  if (typeof p.alt_baro === 'number') return p.alt_baro;
  if (typeof p.alt_geom === 'number') return p.alt_geom;
  return null;
}

function closestApproachNextMinute(p, subLat, subLon) {
  const altFt = getAltitudeFeet(p);
  if (altFt === null || altFt <= 300) {
    return { angle: 90, dx: 0, dy: 0, altKm: 10, altFt: 0 };
  }
  const altKm = altFt * 0.0003048;
  const kmx = 111.32 * Math.cos(subLat * Math.PI / 180);
  const kmy = 110.57;

  const dx0 = (p.lon - subLon) * kmx;
  const dy0 = (p.lat - subLat) * kmy;

  const v = (p.gs || 0) * 1.852 / 3600;
  const tr = (p.track || 0) * Math.PI / 180;
  const vx = v * Math.sin(tr);
  const vy = v * Math.cos(tr);

  const v2 = vx * vx + vy * vy;
  const tStar = v2 > 1e-9 ? Math.max(0, Math.min(60, -(dx0 * vx + dy0 * vy) / v2)) : 0;
  const dx = dx0 + vx * tStar;
  const dy = dy0 + vy * tStar;
  const minD = Math.hypot(dx, dy);

  return { angle: Math.atan2(minD, altKm) * (180 / Math.PI), dx, dy, altKm, altFt };
}

async function fetchAircraftAround(lat, lon, radiusNm, env) {
  const nm = Math.min(250, Math.max(15, radiusNm)).toFixed(1);
  const distKm = Math.min(500, Math.max(25, Math.round(radiusNm * 1.852)));
  const errors = [];

  if (env?.FLYITALY_KEY) {
    try {
      const r = await fetch(`https://api.flyitalyadsb.com/v2/lat/${lat}/lon/${lon}/dist/${distKm}`, {
        headers: { ...UA_HEADER, 'X-Api-Key': env.FLYITALY_KEY },
        signal: AbortSignal.timeout(5000)
      });
      if (r.ok) {
        const j = await r.json();
        return { source: 'flyitalyadsb', ac: j.ac || j.aircraft || [], errors };
      }
      errors.push(`flyitalyadsb:${r.status}`);
    } catch (e) { errors.push(`flyitalyadsb:${e.message}`); }
  }

  const sources = [
    ['adsb.lol', `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`],
    ['airplanes.live', `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`],
    ['adsb.fi', `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${nm}`],
    ['adsb.one', `https://api.adsb.one/v2/point/${lat}/${lon}/${nm}`]
  ];
  for (const [name, u] of sources) {
    try {
      const r = await fetch(u, { headers: UA_HEADER, signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const j = await r.json();
        return { source: name, ac: j.ac || j.aircraft || [], errors };
      }
      errors.push(`${name}:${r.status}`);
    } catch (e) { errors.push(`${name}:${e.message}`); }
  }
  return { source: 'none', ac: [], errors };
}

async function getFlightRoute(cs, lat, lon, memo) {
  if (!cs) return '';
  if (memo.has(cs)) return memo.get(cs);
  let routeTxt = '';
  try {
    const r = await fetch(`https://api.adsb.lol/api/0/route/${encodeURIComponent(cs)}/${lat}/${lon}`, {
      headers: UA_HEADER,
      signal: AbortSignal.timeout(2500)
    });
    if (r.ok) {
      let j = await r.json();
      if (Array.isArray(j)) j = j[0];
      const list = j?._airports || [];
      if (j && j.plausible !== false && j.plausible !== 0 && list.length >= 2) {
        const o = list[0].location || list[0].iata || '';
        const d = list[list.length - 1].location || list[list.length - 1].iata || '';
        if (o && d) routeTxt = `${o} -> ${d}`;
      }
    }
  } catch (e) {}
  memo.set(cs, routeTxt);
  return routeTxt;
}

async function sendNtfy(topic, title, body, targetUrl, radarImgUrl) {
  const baseHeaders = { 'Title': title, 'Tags': 'airplane', 'Priority': 'default' };
  if (targetUrl && /^https?:\/\//.test(targetUrl)) {
    baseHeaders['Click'] = targetUrl;
    baseHeaders['Actions'] = `view, Ouvrir le radar, ${targetUrl}`;
  }

  if (radarImgUrl) {
    const rImg = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Attach': radarImgUrl,
        'Filename': 'radar.png',
        'Icon': radarImgUrl
      },
      body
    });
    if (rImg.ok) return rImg;
  }

  return fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: baseHeaders,
    body
  });
}

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    const noCacheJson = {
      ...cors,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const u = new URL(req.url);

    // Satellites TLE via CelesTrak (0 opération KV, cache Cloudflare 4h)
    if (req.method === 'GET' && u.pathname === '/satellites') {
      const groups = ['stations', 'visual'];
      const seen = new Set();
      const sats = [];
      for (const grp of groups) {
        try {
          const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${grp}&FORMAT=tle`, {
            headers: { 'User-Agent': 'FlightDisplayRadar/1.0', 'Accept': 'text/plain' },
            cf: { cacheTtl: 14400, cacheEverything: true }
          });
          if (!r.ok) continue;
          const txt = await r.text();
          const lines = txt.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          for (let i = 0; i + 2 < lines.length; i++) {
            if (lines[i + 1].startsWith('1 ') && lines[i + 2].startsWith('2 ')) {
              const name = lines[i];
              const tle1 = lines[i + 1];
              const tle2 = lines[i + 2];
              const norad = tle1.slice(2, 7).trim();
              if (norad && !seen.has(norad)) {
                seen.add(norad);
                sats.push({ name, tle1, tle2 });
              }
              i += 2;
            }
          }
        } catch (e) {}
      }
      return new Response(JSON.stringify({ ok: true, count: sats.length, sats }), {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    // Synchronisation des paramètres (PC <-> Mobile)
    if (u.pathname.startsWith('/cfg/')) {
      if (!env.RADAR_KV) {
        return new Response(JSON.stringify({ error: 'Binding KV RADAR_KV manquant' }), { status: 500, headers: noCacheJson });
      }
      const topic = u.pathname.slice(5).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      if (topic.length < 4) {
        return new Response(JSON.stringify({ error: 'Code de profil invalide' }), { status: 400, headers: noCacheJson });
      }
      if (req.method === 'GET') {
        const saved = await env.RADAR_KV.get(`cfg:${topic}`);
        if (saved) return new Response(saved, { status: 200, headers: noCacheJson });

        const { registry } = await loadRegistry(env);
        const sub = registry[topic];
        if (sub) {
          return new Response(JSON.stringify({
            ntfyTopic: topic,
            lat: sub.lat,
            lon: sub.lon,
            city: sub.city || 'Ma position',
            notifEnabled: !!sub.enabled,
            notifAngle: sub.angle || 15,
            notifStart: sub.start || '09:00',
            notifEnd: sub.end || '00:00',
            updatedAt: sub.updatedAt || Date.now()
          }), { status: 200, headers: noCacheJson });
        }
        return new Response(JSON.stringify({ error: 'Profil introuvable' }), { status: 404, headers: noCacheJson });
      }
      if (req.method === 'POST') {
        try {
          const data = await req.json();
          const cleanCfg = { ...data, ntfyTopic: topic, updatedAt: Date.now() };
          await env.RADAR_KV.put(`cfg:${topic}`, JSON.stringify(cleanCfg));
          return new Response(JSON.stringify({ ok: true, updatedAt: cleanCfg.updatedAt }), { headers: noCacheJson });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: noCacheJson });
        }
      }
    }

    // Miniature PNG radar dynamique
    if (req.method === 'GET' && (u.pathname === '/radar-img' || u.pathname === '/radar.png')) {
      const png = await renderRadarPNG({
        dx: Number(u.searchParams.get('dx') ?? 1.2),
        dy: Number(u.searchParams.get('dy') ?? 1.5),
        tr: Number(u.searchParams.get('tr') ?? 45),
        r:  Number(u.searchParams.get('r')  ?? 15),
        zr: Number(u.searchParams.get('zr') ?? 3.5)
      });
      return new Response(png, {
        headers: {
          ...cors,
          'Content-Type': 'image/png',
          'Content-Disposition': 'inline; filename="radar.png"',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    // Diagnostic en direct (1 lecture KV, 0 écriture)
    if (req.method === 'GET' && u.pathname === '/notify/debug') {
      if (!env.RADAR_KV) {
        return new Response(JSON.stringify({ ok: false, error: 'RADAR_KV non lié' }, null, 2), { headers: noCacheJson });
      }
      const { registry } = await loadRegistry(env);
      const now = Date.now();
      const report = [];
      for (const s of Object.values(registry)) {
        if (!s) continue;
        const expired = now > (s.expiresAt || 0);
        const inSchedule = !expired && isWithinSchedule(s.start, s.end, s.tz);
        const { source, ac, errors } = await fetchAircraftAround(s.lat, s.lon, 30, env);
        const closest = ac.filter(p => typeof p.lat === 'number' && typeof p.lon === 'number').map(p => ({
          flight: (p.flight || p.hex || '').trim(),
          alt_ft: getAltitudeFeet(p) != null ? Math.round(getAltitudeFeet(p)) : p.alt_baro,
          dist_km: +kmDist(s.lat, s.lon, p.lat, p.lon).toFixed(2),
          zenith_deg: +closestApproachNextMinute(p, s.lat, s.lon).angle.toFixed(1)
        })).sort((a, b) => a.zenith_deg - b.zenith_deg).slice(0, 5);
        report.push({
          topic: s.topic,
          city: s.city,
          coords: [s.lat, s.lon],
          angle_seuil: s.angle,
          expires_in_days: Math.max(0, +(((s.expiresAt || 0) - now) / 86400000).toFixed(1)),
          expired,
          plage: `${s.start} -> ${s.end} (${s.tz})`,
          plage_active_maintenant: inSchedule,
          source_adsb: source,
          erreurs_sources: errors,
          avions_trouves: ac.length,
          plus_proches_zenith: closest
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        mode: 'single_registry_30d_ttl',
        dernier_cron_memoire: lastCronInMemory,
        abonnes: report
      }, null, 2), { headers: noCacheJson });
    }

    // Inscription / Désinscription aux notifications
    if (req.method === 'POST' && u.pathname === '/notify/sub') {
      if (!env.RADAR_KV) return new Response(JSON.stringify({ error: 'Binding KV manquant' }), { status: 500, headers: noCacheJson });
      try {
        const data = await req.json();
        const topic = String(data.topic || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
        if (topic.length < 4) return new Response(JSON.stringify({ error: 'Canal ntfy invalide' }), { status: 400, headers: noCacheJson });

        const { registry } = await loadRegistry(env);
        if (!data.enabled) {
          delete registry[topic];
          await env.RADAR_KV.put(REGISTRY_KEY, JSON.stringify(registry));
          return new Response(JSON.stringify({ ok: true, enabled: false }), { headers: noCacheJson });
        }

        const prevSent = registry[topic]?.sent || {};
        registry[topic] = {
          topic,
          enabled: true,
          lat: Number(data.lat),
          lon: Number(data.lon),
          city: String(data.city || '').slice(0, 80),
          angle: Math.min(85, Math.max(1, Number(data.angle) || 15)),
          start: String(data.start || '09:00'),
          end: String(data.end || '00:00'),
          tz: String(data.tz || 'Europe/Paris'),
          appUrl: String(data.appUrl || '').slice(0, 250),
          workerUrl: u.origin,
          updatedAt: Date.now(),
          expiresAt: Date.now() + SESSION_TTL_MS,
          sent: prevSent
        };
        await env.RADAR_KV.put(REGISTRY_KEY, JSON.stringify(registry));
        return new Response(JSON.stringify({ ok: true, enabled: true, expiresAt: registry[topic].expiresAt }), { headers: noCacheJson });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: noCacheJson });
      }
    }

    // Prolongation de session lors de l'ouverture de la page web
    if (req.method === 'POST' && u.pathname === '/notify/heartbeat') {
      if (!env.RADAR_KV) return new Response(JSON.stringify({ ok: false }), { status: 500, headers: noCacheJson });
      try {
        const data = await req.json();
        const topic = String(data.topic || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
        if (topic.length < 4) return new Response(JSON.stringify({ ok: false }), { status: 400, headers: noCacheJson });

        const { registry } = await loadRegistry(env);
        if (registry[topic] && registry[topic].enabled) {
          registry[topic].expiresAt = Date.now() + SESSION_TTL_MS;
          await env.RADAR_KV.put(REGISTRY_KEY, JSON.stringify(registry));
          return new Response(JSON.stringify({ ok: true, extended: true }), { headers: noCacheJson });
        }
        return new Response(JSON.stringify({ ok: true, extended: false }), { headers: noCacheJson });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: noCacheJson });
      }
    }

    // Notification de test
    if (req.method === 'POST' && u.pathname === '/notify/test') {
      try {
        const data = await req.json();
        const topic = String(data.topic || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
        if (topic.length < 4) throw new Error('Canal invalide');
        const angle = Number(data.angle) || 15;
        const zr = 10.67 * Math.tan(angle * Math.PI / 180);
        const testImg = `${u.origin}/radar.png?dx=${(zr * 0.45).toFixed(2)}&dy=${(zr * 0.55).toFixed(2)}&tr=45&r=${Math.max(10, zr * 2.2).toFixed(1)}&zr=${zr.toFixed(2)}`;
        const targetUrl = data.appUrl ? `${data.appUrl}?view=radar&sync=${encodeURIComponent(topic)}` : '';

        const r = await sendNtfy(topic, 'Test Radar Zenith', `Alertes actives (cone de ${angle}°). Le clic ouvrira le radar.`, targetUrl, testImg);
        if (!r.ok) throw new Error('Erreur ntfy ' + r.status);
        return new Response(JSON.stringify({ ok: true }), { headers: noCacheJson });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: noCacheJson });
      }
    }

    // Logos compagnies aériennes
    if (u.pathname.startsWith('/logo/')) {
      const code = u.pathname.slice(6).replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
      for (const src of [`https://images.kiwi.com/airlines/64x64/${code}.png`, `https://pics.avs.io/128/128/${code}.png`]) {
        try {
          const r = await fetch(src, { cf: { cacheTtl: 604800, cacheEverything: true } });
          const type = r.headers.get('Content-Type') || '';
          if (r.ok && type.startsWith('image')) return new Response(r.body, { headers: { ...cors, 'Content-Type': type, 'Cache-Control': 'public, max-age=604800' } });
        } catch (e) {}
      }
      return new Response('not found', { status: 404, headers: cors });
    }

    // Relais API ADS-B temps réel
    if (req.method === 'GET' && u.pathname.startsWith('/v2/')) {
      if (env.FLYITALY_KEY) {
        const mP = u.pathname.match(/^\/v2\/point\/([^/]+)\/([^/]+)\/([^/]+)/);
        const mC = u.pathname.match(/^\/v2\/callsign\/([^/]+)/);
        const fUrl = mP ? `https://api.flyitalyadsb.com/v2/lat/${mP[1]}/lon/${mP[2]}/dist/${Math.max(1, Math.round(Number(mP[3]) * 1.852))}` : mC ? `https://api.flyitalyadsb.com/v2/callsign/${mC[1]}` : null;
        if (fUrl) {
          try {
            const r = await fetch(fUrl, { headers: { ...UA_HEADER, 'X-Api-Key': env.FLYITALY_KEY }, cf: { cacheTtl: 5, cacheEverything: true } });
            if (r.ok) return new Response(r.body, { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
          } catch (e) {}
        }
      }
      for (const h of ['https://api.adsb.lol', 'https://api.airplanes.live']) {
        try {
          const r = await fetch(h + u.pathname + u.search, { headers: UA_HEADER, cf: { cacheTtl: 5, cacheEverything: true } });
          if (r.ok) return new Response(r.body, { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
        } catch (e) {}
      }
      return new Response(JSON.stringify({ error: 'upstream' }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Itinéraires de secours
    if (u.pathname.startsWith('/adsbdb/')) {
      const r = await fetch('https://api.adsbdb.com' + u.pathname.slice(7) + u.search, { headers: UA_HEADER, cf: { cacheTtl: 3600, cacheEverything: true } });
      return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const r = await fetch('https://api.adsb.lol' + u.pathname + u.search, {
      method: req.method,
      headers: { ...UA_HEADER, 'Content-Type': 'application/json' },
      body: req.method === 'POST' ? await req.text() : undefined
    });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': r.headers.get('Content-Type') || 'application/json' } });
  },

  async scheduled(event, env, ctx) {
    if (!env.RADAR_KV) return;

    const now = Date.now();
    const { registry, migrated } = await loadRegistry(env);
    let dirty = migrated;

    const activeSubs = [];
    for (const [topic, sub] of Object.entries(registry)) {
      if (!sub || !sub.enabled || !isFinite(sub.lat) || !isFinite(sub.lon) || now > (sub.expiresAt || 0)) {
        delete registry[topic];
        dirty = true;
        continue;
      }
      if (sub.sent && typeof sub.sent === 'object') {
        for (const [hex, ts] of Object.entries(sub.sent)) {
          if (now - ts > ALERT_COOLDOWN_MS) {
            delete sub.sent[hex];
            dirty = true;
          }
        }
      } else {
        sub.sent = {};
      }

      if (isWithinSchedule(sub.start, sub.end, sub.tz)) {
        activeSubs.push(sub);
      }
    }

    const cronLog = { time: new Date(now).toISOString(), active_subs: activeSubs.length, source: 'none', aircraft: 0, alerts: [] };

    if (!activeSubs.length) {
      if (dirty) await env.RADAR_KV.put(REGISTRY_KEY, JSON.stringify(registry));
      lastCronInMemory = cronLog;
      return;
    }

    const clusters = [];
    for (const sub of activeSubs) {
      const neededKm = 14 * Math.tan((sub.angle || 15) * Math.PI / 180) + 20;
      const neededNm = Math.min(250, Math.max(20, neededKm / 1.852));
      let cluster = clusters.find(c => kmDist(c.lat, c.lon, sub.lat, sub.lon) < 180);
      if (!cluster) {
        clusters.push({ lat: sub.lat, lon: sub.lon, radiusNm: neededNm, subs: [sub] });
      } else {
        cluster.radiusNm = Math.min(250, Math.max(cluster.radiusNm, kmDist(cluster.lat, cluster.lon, sub.lat, sub.lon) / 1.852 + neededNm));
        cluster.subs.push(sub);
      }
    }

    const routeMemo = new Map();

    for (const cluster of clusters) {
      const { source, ac: aircraft } = await fetchAircraftAround(cluster.lat, cluster.lon, cluster.radiusNm, env);
      cronLog.source = source;
      cronLog.aircraft += aircraft.length;
      if (!aircraft.length) continue;

      for (const sub of cluster.subs) {
        const workerBase = sub.workerUrl || 'https://radar-relay.sebnoel.workers.dev';
        const tanA = Math.tan((sub.angle || 15) * Math.PI / 180);

        for (const p of aircraft) {
          if (typeof p.lat !== 'number' || typeof p.lon !== 'number' || !p.hex) continue;
          const { angle, dx, dy, altKm, altFt } = closestApproachNextMinute(p, sub.lat, sub.lon);
          if (angle > sub.angle) continue;

          if (sub.sent[p.hex] && (now - sub.sent[p.hex]) < ALERT_COOLDOWN_MS) continue;

          const cs = (p.flight || p.hex || '').trim();
          const icao = /^[A-Z]{3}\d/.test(cs) ? cs.slice(0, 3) : '';
          const airline = AIRLINES[icao] || p.ownOp || '';
          const altTxt = altFt >= 18000 ? 'FL' + String(Math.round(altFt / 100)).padStart(3, '0') : Math.round(altFt / 100) * 100 + ' ft';
          const routeTxt = await getFlightRoute(cs, p.lat, p.lon, routeMemo);

          const zr = Math.max(0.5, altKm * tanA);
          const radarRadius = Math.max(5, zr * 2.2);

          const radarImgUrl = `${workerBase}/radar.png?dx=${dx.toFixed(2)}&dy=${dy.toFixed(2)}&tr=${Math.round(p.track || 0)}&r=${radarRadius.toFixed(1)}&zr=${zr.toFixed(2)}`;
          const targetUrl = sub.appUrl ? `${sub.appUrl}?view=radar&hex=${encodeURIComponent(p.hex)}&sync=${encodeURIComponent(sub.topic)}` : '';

          const line1 = `${airline ? airline + ' ' : ''}${cs} • Alt ${altTxt}${routeTxt ? ' • ' + routeTxt : ''}`;
          const line2 = `Cap ${Math.round(p.track || 0)}° • Vitesse ${Math.round(p.gs || 0)} kt`;

          const res = await sendNtfy(
            sub.topic,
            `Avion au zenith (${angle.toFixed(1)}°)`,
            `${line1}\n${line2}`,
            targetUrl,
            radarImgUrl
          );

          cronLog.alerts.push({ topic: sub.topic, flight: cs, zenith: +angle.toFixed(1), ntfy_http: res.status });

          if (res.ok) {
            sub.sent[p.hex] = now;
            sub.expiresAt = now + SESSION_TTL_MS;
            dirty = true;
          }
        }
      }
    }

    if (dirty) {
      await env.RADAR_KV.put(REGISTRY_KEY, JSON.stringify(registry));
    }
    lastCronInMemory = cronLog;
  }
};