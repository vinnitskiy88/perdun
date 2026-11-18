/*
 * engine-core.js — процедурний синтезатор двигуна внутрішнього згоряння.
 * Чистий модуль без DOM: використовується в AudioWorklet (engine-worklet.js)
 * і в офлайн-тесті (test.html).
 *
 * Модель (на кожен семпл):
 *   фаза колінвала (цикл 4-тактного двигуна = 720°)
 *   → спалахи циліндрів за порядком роботи
 *   → кожен спалах кидає імпульс тиску + гаусів шумовий сплеск у вихлоп свого ряду
 *   → вихлопна труба (лінія затримки з інвертованим відбиттям і втратами)
 *   → форманти → глушник 4-го порядку (два ФНЧ поспіль)
 *   → + впуск (шум, що «дихає» з імпульсами вихлопу)
 *   → + постріли у вихлоп (серіями, повз глушник, залежать від нагріву вихлопу)
 *   → відбиття від салону (дві згасаючі затримки на канал)
 *   → DC-фільтр → м'яке насичення
 *   → + свист нагнітача (кілька розстроєних голосів, повз глушник і насичення).
 *
 * Параметри ззовні: rpm, load (0..1), overrun (гальмування двигуном),
 * cut (відсічка запалювання), crank (стартер 0..1).
 */

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// Швидкий генератор шуму (xorshift32), [-1, 1)
let seed = 0x9e3779b9;
function noise() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 2147483648 - 1;
}
function rand() { return (noise() + 1) * 0.5; }
// Наближено гаусів шум (сума 4 рівномірних), RMS ≈ 0.58 — як у рівномірного
function gauss() { return (noise() + noise() + noise() + noise()) * 0.5; }

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  bandpass(f, q, sr) {
    const w = TAU * clamp(f, 20, sr * 0.45) / sr, s = Math.sin(w), c = Math.cos(w);
    const al = s / (2 * q), a0 = 1 + al;
    this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  lowpass(f, q, sr) {
    const w = TAU * clamp(f, 20, sr * 0.45) / sr, s = Math.sin(w), c = Math.cos(w);
    const al = s / (2 * q), a0 = 1 + al;
    this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0;
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  highpass(f, q, sr) {
    const w = TAU * clamp(f, 10, sr * 0.45) / sr, s = Math.sin(w), c = Math.cos(w);
    const al = s / (2 * q), a0 = 1 + al;
    this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0;
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// Лінія затримки з дробовим читанням
class Delay {
  constructor(len) { this.n = len; this.buf = new Float32Array(len); this.w = 0; }
  read(d) {
    let r = this.w - d;
    if (r < 0) r += this.n;
    const i = r | 0, fr = r - i, j = i + 1 === this.n ? 0 : i + 1;
    return this.buf[i] * (1 - fr) + this.buf[j] * fr;
  }
  write(x) { this.buf[this.w] = x; this.w = this.w + 1 === this.n ? 0 : this.w + 1; }
}

// Вихлопна труба: затримка з відбиттям (fb < 0 — відкритий кінець) і загасанням
class Pipe {
  constructor(sr) { this.d = new Delay(Math.ceil(sr * 0.03)); this.lp = 0; }
  run(x, d, fb, damp) {
    this.lp += damp * (this.d.read(d) - this.lp);
    const y = x + fb * this.lp;
    this.d.write(y);
    return y;
  }
}

// Відбиття від салону: дві паралельні згасаючі затримки з темнішанням хвоста
class Cabin {
  constructor(sr, ms) {
    this.taps = ms.map((m) => ({ d: new Delay(Math.ceil(sr * m * 0.001) + 2), len: sr * m * 0.001, lp: 0 }));
  }
  run(x, fb, damp) {
    let out = 0;
    for (const t of this.taps) {
      t.lp += damp * (t.d.read(t.len) - t.lp);
      t.d.write(x + fb * t.lp);
      out += t.lp;
    }
    return out * 0.5;
  }
}

// Набір активних імпульсів (ряд циліндрів або постріли)
class Bank {
  constructor(size) {
    this.p = [];
    for (let i = 0; i < size; i++) this.p.push({ on: false, t: 0, dur: 1, amp: 0, ne: 0, dec: 0 });
  }
  fire(dur, amp, nAmp, decay) {
    let slot = this.p[0];
    for (const q of this.p) {
      if (!q.on) { slot = q; break; }
      if (q.t > slot.t) slot = q;
    }
    slot.on = true; slot.t = 0; slot.dur = dur; slot.amp = amp; slot.ne = nAmp; slot.dec = decay;
  }
  run(dt) {
    let s = 0;
    for (const q of this.p) {
      if (!q.on) continue;
      const u = q.t / q.dur;
      if (u < 1) { const sv = Math.sin(Math.PI * u); s += q.amp * sv * sv; }
      s += q.ne * gauss();
      q.ne *= q.dec;
      q.t += dt;
      if (u >= 1 && q.ne < 1e-4) q.on = false;
    }
    return s;
  }
}

// Постріли у вихлоп. Без жодного генератора тону (тон давав «8-бітний барабан»):
//  • удар тиску — широкий одиночний імпульс 4–8 мс, згладжений двома ФНЧ:
//    глухий неперіодичний «бух» у районі ~100–200 Гц;
//  • тріск — 1–3 мікроімпульси з інтервалом 1–6 мс («пр-р-ап»), кожен — гострий
//    сплеск + гаусів шум, що гасне за 2–5 мс; смуга ~300–9000 Гц.
const POP_THUMP = 3.0, POP_CRACK = 1.2;
class Pops {
  constructor(sr) {
    this.sr = sr;
    this.v = [];
    for (let i = 0; i < 3; i++) {
      this.v.push({ on: false, t: 0, subs: [0, 1, 2].map(() => ({ at: 0, amp: 0, ws: 1, ne: 0, dec: 0 })) });
    }
    this.kT = 1 - Math.exp(-TAU * 300 / sr);    // згладжування удару
    this.kH = 1 - Math.exp(-TAU * 800 / sr);    // низ тріску
    this.kL = 1 - Math.exp(-TAU * 6000 / sr);   // верх тріску
    this.kTH = 1 - Math.exp(-TAU * 140 / sr);   // зріз низу удару (без «гудіння»)
  }
  trigger(A) {
    let v = this.v[0];
    for (const q of this.v) { if (!q.on) { v = q; break; } if (q.t > v.t) v = q; }
    const sr = this.sr;
    v.on = true; v.t = 0; v.A = A;
    v.W = Math.round(sr * (0.0025 + rand() * 0.0025));
    v.l1 = 0; v.l2 = 0; v.h = 0; v.c1 = 0; v.c2 = 0;
    v.n = 1 + ((rand() * 3) | 0);
    let at = 0;
    for (let k = 0; k < 3; k++) {
      const s = v.subs[k];
      s.at = at; s.amp = A * (k === 0 ? 1 : 0.4 + rand() * 0.6);
      s.ws = Math.round(sr * (0.0003 + rand() * 0.0003));
      s.ne = s.amp * 1.2; s.dec = Math.exp(-1 / (sr * (0.002 + rand() * 0.003)));
      at += Math.round(sr * (0.001 + rand() * 0.005));
    }
    v.end = Math.max(v.W, at) + Math.round(sr * 0.04);
  }
  run() {
    let s = 0;
    for (const v of this.v) {
      if (!v.on) continue;
      const t = v.t;
      // удар тиску
      const raw = t < v.W ? v.A * Math.sin(Math.PI * t / v.W) : 0;
      v.l1 += this.kT * (raw - v.l1);
      v.l2 += this.kT * (v.l1 - v.l2);
      v.h += this.kTH * (v.l2 - v.h);
      // тріск із мікроімпульсів
      let cr = 0;
      for (let k = 0; k < v.n; k++) {
        const sb = v.subs[k], u = t - sb.at;
        if (u < 0) continue;
        if (u < sb.ws) cr += sb.amp * Math.sin(Math.PI * u / sb.ws);
        cr += sb.ne * gauss();
        sb.ne *= sb.dec;
      }
      v.c1 += this.kH * (cr - v.c1);
      v.c2 += this.kL * ((cr - v.c1) - v.c2);
      s += (v.l2 - v.h) * POP_THUMP + v.c2 * POP_CRACK;
      if (++v.t > v.end) v.on = false;
    }
    return s;
  }
}

// Голоси нагнітача: [множник висоти, гучність]; гармоніки: амплітуди 1×, 2×, 3×
const BLOWER_VOICES = [[1, 1], [1.011, 0.55], [0.992, 0.45]];
const BLOWER_HARM = [1, 0.45, 0.2];

export class EngineSynth {
  constructor(sr) {
    this.sr = sr; this.dt = 1 / sr;
    this.banks = [new Bank(10), new Bank(10)];
    this.pops = [new Pops(sr), new Pops(sr)];
    this.popWait = 0;     // пауза до наступного можливого пострілу, с
    this.pipes = [new Pipe(sr), new Pipe(sr)];
    this.form = [[new Biquad(), new Biquad()], [new Biquad(), new Biquad()]];
    this.muff = [[new Biquad(), new Biquad()], [new Biquad(), new Biquad()]];
    this.intakeBp = new Biquad();
    this.cabin = [new Cabin(sr, [6.1, 9.7]), new Cabin(sr, [7.3, 11.3])];
    this.phase = 0;
    this.whinePh = BLOWER_VOICES.map(() => 0);
    this.rpmS = 0; this.loadS = 0; this.ovS = 0;
    this.intakeEnv = 0;
    this.heat = 0;        // нагрів вихлопу після активної їзди (0..1) — паливо для пострілів
    this.burst = 0;       // скільки ще спалахів триває поточна серія пострілів
    this.lowCut = [new Biquad(), new Biquad()];
    this.crank = 0;
    this.crackleUser = 1;
    this.e = null;
  }

  setCar(e) {
    // Значення за замовчуванням для полів, яких може не бути в профілі
    e = Object.assign({ idleStrength: 0.35, overrunStrength: 0.6, crankStrength: 1.1, lowCut: 130 }, e);
    this.e = e;
    for (const f of this.lowCut) f.highpass(e.lowCut, 0.7, this.sr);
    this.cyl = e.cylinders.map(c => ({ ang: (c.ang % 720) / 720, bank: c.bank, gain: c.gain }));
    this.nCyl = this.cyl.length;
    for (let b = 0; b < 2; b++) {
      e.formants.forEach((f, k) => { if (k < 2) this.form[b][k].bandpass(f.f * (b ? 1.04 : 1), f.q, this.sr); });
    }
  }

  fireCylinder(c, load, overrun, cut) {
    const e = this.e, rpm = Math.max(this.rpmS, 100);
    const interval = 120 / (rpm * this.nCyl);
    // Імпульс тиску не ширший за 2.5 мс: ширший майже не має енергії вище ~160 Гц
    const dur = clamp(e.pulseWidth * interval, 0.0004, 0.0025);
    const idleF = clamp(1 - (this.rpmS - e.idle) / 2500, 0, 1);

    // Сила спалаху: стиснута крива, щоб холостий був лише на ~5 дБ тихіший за повний газ
    // (так звучить еталон); при відсічці — лише прокачування повітря.
    let strength = cut > 0.5 ? 0.05 : e.idleStrength + (1 - e.idleStrength) * Math.pow(load, 0.7);
    // Гальмування двигуном: плавний перехід до власної сили (у V8 — гучне «бурчання»,
    // у V12 — тихіше за холостий)
    strength += (e.overrunStrength - strength) * overrun;
    if (this.crank > 0.5) strength = e.crankStrength;   // такти під стартером добре чутно
    let jit = 1 + (rand() - 0.5) * 2 * (0.05 + e.lope * 0.35 * idleF);
    if (rand() < e.lope * 0.05 * idleF * this.crackleUser) jit *= 0.35; // «рваний» холостий хід
    const amp = strength * c.gain * jit;
    const nAmp = amp * e.rasp * (0.15 + 0.85 * load);   // на малому газу майже без шипіння
    this.banks[c.bank].fire(dur, amp, nAmp, Math.exp(-this.dt / 0.0012));

    // Постріли: потрібне незгоріле паливо в гарячому вихлопі.
    // Між пострілами завжди є пауза; серія — 1–4 «бахи» через 50–170 мс,
    // між серіями 0.15–0.5 с.
    if (this.popWait <= 0 && this.rpmS > e.idle * 1.3 && e.crackle > 0) {
      const base = this.crackleUser * e.crackle;
      let p = base * (overrun * this.heat * 0.02 + cut * 0.12);
      if (this.burst > 0 && overrun + cut > 0.3) p = Math.max(p, base * 0.5);
      if (rand() < p) {
        if (this.burst > 0) this.burst--; else this.burst = (rand() * 4) | 0;
        const pa = (0.7 + rand() * rand() * 1.3) * (0.5 + 0.5 * this.heat);
        this.pops[c.bank].trigger(pa);
        this.popWait = this.burst > 0 ? 0.2 + rand() * 0.25 : 0.4 + rand() * 0.5;
      }
    }
  }

  render(outL, outR, n, prm) {
    const e = this.e;
    if (!e) { outL.fill(0); if (outR !== outL) outR.fill(0); return; }
    const dt = this.dt, sr = this.sr;
    const kR = 1 - Math.exp(-dt / 0.015), kL = 1 - Math.exp(-dt / 0.03), kEnv = 1 - Math.exp(-dt / 0.004);
    const rpmT = prm.rpm, loadT = prm.load, ovT = prm.overrun, cut = prm.cut;
    this.crank = prm.crank || 0;

    // ---- Раз на блок ----
    const rpmNorm = clamp(this.rpmS / e.limiter, 0, 1.2);
    const fcM = e.muffler * (0.6 + 0.8 * this.loadS) * (0.6 + 0.8 * rpmNorm) * (1 - 0.3 * this.ovS);
    for (let b = 0; b < 2; b++) {
      const f = fcM * (b ? 1.03 : 1);
      this.muff[b][0].lowpass(f, 0.6, sr); this.muff[b][1].lowpass(f * 1.15, 0.75, sr);
    }
    this.intakeBp.bandpass(e.intakeF * (0.7 + 0.8 * rpmNorm), 1.3, sr);
    const d0 = e.pipe[0] * 0.001 * sr, d1 = e.pipe[1] * 0.001 * sr;
    const g0 = e.formants[0] ? e.formants[0].g : 0, g1 = e.formants[1] ? e.formants[1].g : 0;
    const single = e.banks === 1;
    const cabWet = e.cabin ?? 0.35, cabFb = 0.45, cabDamp = 0.3;

    // Нагрів вихлопу: росте від навантаження на високих обертах, остигає за ~3 с
    const blockT = n * dt;
    this.heat += (this.loadS * rpmNorm * 1.6) * blockT;
    this.heat *= Math.exp(-blockT / 3);
    this.heat = clamp(this.heat, 0, 1);
    this.popWait -= blockT;
    if (this.ovS + cut < 0.1) this.burst = 0;

    // Нагнітач: свистить лише під наддувом (байпас відкритий на холостих і круїзі)
    const boost = smoothstep((this.loadS - 0.35) / 0.45);
    const whineAmp = e.whine * (0.15 + 0.85 * boost) * rpmNorm * rpmNorm;

    for (let i = 0; i < n; i++) {
      this.rpmS += (rpmT - this.rpmS) * kR;
      this.loadS += (loadT - this.loadS) * kL;
      this.ovS += (ovT - this.ovS) * kL;

      // Колінвал і спалахи
      const prev = this.phase;
      this.phase += (this.rpmS / 120) * dt;
      const wrapped = this.phase >= 1;
      if (wrapped) this.phase -= 1;
      if (this.rpmS > 60) {
        for (let k = 0; k < this.nCyl; k++) {
          const a = this.cyl[k].ang;
          const hit = wrapped ? (a > prev || a <= this.phase) : (a > prev && a <= this.phase);
          if (hit) this.fireCylinder(this.cyl[k], this.loadS, this.ovS, cut);
        }
      }

      // Вихлоп по рядах
      const s0 = this.banks[0].run(dt), s1 = single ? 0 : this.banks[1].run(dt);
      const y0 = this.pipes[0].run(s0, d0, e.pipeFb, e.pipeDamp);
      const y1 = single ? 0 : this.pipes[1].run(s1, d1, e.pipeFb, e.pipeDamp);
      const f0 = y0 * e.dry + this.form[0][0].run(y0) * g0 + this.form[0][1].run(y0) * g1;
      const m0 = this.muff[0][1].run(this.muff[0][0].run(f0));
      let m1 = 0;
      if (!single) {
        const f1 = y1 * e.dry + this.form[1][0].run(y1) * g0 + this.form[1][1].run(y1) * g1;
        m1 = this.muff[1][1].run(this.muff[1][0].run(f1));
      }

      // Впуск: шум, що «дихає» разом з імпульсами вихлопу
      this.intakeEnv += (Math.abs(s0 + s1) - this.intakeEnv) * kEnv;
      const intake = this.intakeBp.run(noise()) * e.intake * this.loadS * (0.3 + rpmNorm) * (0.3 + 1.4 * clamp(this.intakeEnv, 0, 1));

      // Постріли: повз глушник
      const p0 = this.pops[0].run();
      const p1 = single ? p0 : this.pops[1].run();

      let l, r;
      if (single) { l = r = m0 * 0.9; }
      else { l = m0 * 0.8 + m1 * 0.35; r = m1 * 0.8 + m0 * 0.35; }
      l += intake * 0.5 + p0 * 0.75 + p1 * 0.3;
      r += intake * 0.5 + p1 * 0.75 + p0 * 0.3;

      // Відбиття від салону
      l += this.cabin[0].run(l * 0.8 + r * 0.2, cabFb, cabDamp) * cabWet;
      r += this.cabin[1].run(r * 0.8 + l * 0.2, cabFb, cabDamp) * cabWet;

      // DC-фільтр (~25 Гц) + насичення
      // Зріз низу (2-й порядок, ~90 Гц): прибирає «гудіння» і постійну складову
      const hl = this.lowCut[0].run(l), hr = this.lowCut[1].run(r);
      let oL = Math.tanh(hl * e.drive) * e.gain, oR = Math.tanh(hr * e.drive) * e.gain;

      // Свист нагнітача: з моторного відсіку, повз вихлоп і насичення
      if (whineAmp > 1e-4) {
        let w = 0;
        for (let v = 0; v < BLOWER_VOICES.length; v++) {
          let ph = this.whinePh[v] + (this.rpmS / 60) * e.whineRatio * BLOWER_VOICES[v][0] * dt;
          if (ph >= 1) ph -= 1;
          this.whinePh[v] = ph;
          for (let h = 0; h < BLOWER_HARM.length; h++) w += Math.sin(TAU * ph * (h + 1)) * BLOWER_HARM[h] * BLOWER_VOICES[v][1];
        }
        w *= whineAmp * 0.35;
        oL += w; oR += w;
      }

      outL[i] = oL;
      if (outR !== outL) outR[i] = oR;
    }
  }
}
