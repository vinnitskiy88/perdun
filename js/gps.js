/*
 * gps.js — швидкість і прискорення з Geolocation API.
 * Прискорення — лінійна регресія по останніх ~2 с фіксів.
 * Між фіксами швидкість екстраполюється, щоб звук змінювався плавно.
 */

const WINDOW_MS = 2000, KEEP_MS = 3000, MAX_EXTRAP_S = 1.2, STALE_S = 5, STANDSTILL = 0.45;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, k = Math.PI / 180;
  const dLat = (lat2 - lat1) * k, dLon = (lon2 - lon1) * k;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * k) * Math.cos(lat2 * k) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export class GpsSpeed {
  constructor(onStatus) { this.onStatus = onStatus || (() => {}); this.id = null; this.reset(); }

  reset() { this.samples = []; this.last = null; this.a = 0; this.vLast = 0; this.tLast = 0; }

  start() {
    if (!('geolocation' in navigator)) { this.onStatus('unsupported'); return; }
    if (this.id !== null) return;
    this.reset();
    this.onStatus('waiting');
    this.id = navigator.geolocation.watchPosition(
      (p) => this.onFix(p),
      (err) => this.onStatus(err.code === 1 ? 'denied' : 'error', { message: err.message }),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  }

  stop() {
    if (this.id !== null) navigator.geolocation.clearWatch(this.id);
    this.id = null;
    this.reset();     // старі фікси не повинні «доганяти» після повторного запуску
    this.onStatus('off');
  }

  onFix(p) {
    const now = performance.now(), c = p.coords;
    let v = c.speed;
    if (v == null || Number.isNaN(v)) {
      v = this.vLast;
      if (this.last) {
        const dt = (p.timestamp - this.last.ts) / 1000;
        if (dt > 0.2) v = haversine(this.last.lat, this.last.lon, c.latitude, c.longitude) / dt;
      } else v = 0;
    }
    if (v < STANDSTILL) v = 0;
    this.last = { lat: c.latitude, lon: c.longitude, ts: p.timestamp };

    this.samples.push({ t: now, v });
    while (this.samples.length > 2 && now - this.samples[0].t > KEEP_MS) this.samples.shift();
    this.a = this.fitSlope(now);
    this.vLast = v; this.tLast = now;
    this.onStatus('ok', { accuracy: c.accuracy, speed: v });
  }

  fitSlope(now) {
    const s = this.samples.filter((x) => now - x.t <= WINDOW_MS);
    if (s.length < 2) return 0;
    const span = (s[s.length - 1].t - s[0].t) / 1000;
    if (span < 0.4) return this.a;
    let st = 0, sv = 0, stt = 0, stv = 0;
    for (const x of s) { const t = (x.t - s[0].t) / 1000; st += t; sv += x.v; stt += t * t; stv += t * x.v; }
    const n = s.length, den = n * stt - st * st;
    if (Math.abs(den) < 1e-9) return 0;
    return Math.max(-12, Math.min(12, (n * stv - st * sv) / den));
  }

  read(now) {
    if (!this.tLast) return { speed: 0, accel: 0, stale: true };
    const age = (now - this.tLast) / 1000;
    if (age > STALE_S) return { speed: 0, accel: 0, stale: true };
    let speed = this.vLast + this.a * Math.min(age, MAX_EXTRAP_S);
    if (this.vLast === 0 && this.a <= 0) speed = 0;
    return { speed: Math.max(0, speed), accel: this.a, stale: false };
  }
}
