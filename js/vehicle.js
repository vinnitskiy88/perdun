/*
 * vehicle.js — віртуальна трансмісія.
 * Перетворює швидкість на те, що робив би двигун внутрішнього згоряння:
 * передача, оберти, навантаження, гальмування двигуном, відсічка.
 * Швидкість береться або з GPS (газ оцінюється з прискорення),
 * або з простої фізики, яку керують екранні педалі (тест-драйв).
 */

const G = 9.81, RHO = 1.2;
const START_CRANK = 0.9, START_CATCH = 1.3, START_DONE = 2.6;
const LIMIT_DROP = 220;   // на скільки об/хв падають оберти під час відсічки

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const follow = (dt, tau) => 1 - Math.exp(-dt / tau);
const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

export class Vehicle {
  constructor(car) { this.running = false; this.reset(); this.setCar(car); }

  setCar(car) {
    this.e = car.engine; this.v = car.vehicle;
    this.gear = 1; this.shiftT = 0; this.cut = 0; this.limT = 0;
    if (this.running) this.startT = START_DONE; // зміна машини на ходу — без повторного запуску
  }

  reset() {
    this.speed = 0; this.accel = 0; this.rpm = 0; this.load = 0; this.overrun = 0;
    this.cut = 0; this.crank = 0; this.throttle = 0; this.startT = 0;
    this.gear = 1; this.shiftT = 0; this.limT = 0; this.limCut = false;
  }

  start() { this.running = true; this.startT = 0; this.gear = 1; }
  stop() { this.running = false; }
  get started() { return this.running && this.startT >= START_DONE; }

  wheelRpm(speed, gear) { return speed / this.v.tireCirc * 60 * this.v.ratios[gear - 1] * this.v.final; }

  powerFrac(rpm) {
    const r = rpm / this.e.peakRpm;
    return r <= 1 ? 0.12 + 0.88 * (2 * r - r * r) : Math.max(0.5, 1 - (r - 1) * 2.5);
  }

  resist(speed) {
    return 0.5 * RHO * this.v.cdA * speed * speed + (speed > 0.1 ? 0.013 * this.v.mass * G : 0);
  }

  /** mode: 'test' | 'gps'; inp: {gas, brake} або {speed, accel} */
  update(dt, mode, inp) {
    const e = this.e, v = this.v;

    // 0. Двигун заглушено: оберти швидко падають до нуля (~2.5× від поточних за секунду,
    //    але не повільніше 300 об/хв/с), швидкість на екрані плавно сходить до нуля
    //    приблизно за ту саму ~1–1.5 с — в обох режимах, незалежно від GPS.
    if (!this.running) {
      this.rpm = Math.max(0, this.rpm - Math.max(this.rpm * 2.5, 300) * dt);
      this.speed = Math.max(0, this.speed - Math.max(this.speed * 2.5, 3) * dt);
      this.accel = 0; this.throttle = 0;
      this.load = 0; this.overrun = 0; this.cut = 0; this.crank = 0;
      this.gear = 1; this.shiftT = 0; this.limCut = false;
      return;
    }

    // 1. Швидкість і газ
    if (mode === 'test') {
      const tgt = this.started ? inp.gas : 0;
      this.throttle += (tgt - this.throttle) * follow(dt, tgt > this.throttle ? 0.12 : 0.08);
      let F = 0;
      if (this.started && this.shiftT <= 0 && !this.cut) {
        F = this.throttle * v.peakKw * 1000 * this.powerFrac(this.rpm) / Math.max(this.speed, 4);
        F = Math.min(F, v.mass * G * 1.05);
      }
      let res = this.resist(this.speed) + inp.brake * v.mass * 9;
      if (this.running && this.throttle < 0.05 && this.speed > 1) res += v.mass * (this.rpm / e.limiter) * 1.0;
      let a = (F - res) / v.mass;
      this.speed = Math.max(0, this.speed + a * dt);
      if (this.speed === 0 && a < 0) a = 0;
      this.accel = a;
    } else {
      this.speed = inp.speed; this.accel = inp.accel;
      const need = (v.mass * this.accel + this.resist(this.speed)) * Math.max(this.speed, 1);
      let est = need / (v.peakKw * 1000 * Math.max(0.3, this.powerFrac(this.rpm)));
      if (this.accel < -0.15) est = 0;
      est = clamp(est, 0, 1);
      this.throttle += (est - this.throttle) * follow(dt, 0.25);
    }

    // 3. Запуск. Окремого тону стартера немає: стартер лише крутить двигун,
    //    і чути такти стиснення у вихлопі (оберти «гойдаються» ~6 разів/с).
    //    Потім схоплює: оберти різко злітають, горіння сильне — «рявк»,
    //    далі оберти по експоненті сідають на холостий, а горіння згасає.
    if (this.startT < START_DONE) {
      this.startT += dt;
      const t = this.startT;
      if (t < START_CRANK) {
        this.crank = 1;
        this.rpm = 220 + 55 * Math.sin(t * Math.PI * 2 * 6) + 15 * Math.sin(t * 37);
        this.load = 0.02;
      } else if (t < START_CATCH) {
        this.crank = 0;
        this.rpm = Math.min(e.idle * 1.85, this.rpm + 4800 * dt);
        this.load = 0.65;
      } else {
        const u = (t - START_CATCH) / (START_DONE - START_CATCH);
        this.rpm += (e.idle - this.rpm) * follow(dt, 0.35);
        this.load = 0.65 * (1 - smoothstep(u)) + 0.2 * smoothstep(u);
      }
      this.overrun = 0; this.cut = 0;
      return;
    }

    // 4. Автоматична коробка
    const N = v.ratios.length;
    if (this.speed < 0.5 && this.shiftT <= 0) this.gear = 1;
    if (this.shiftT > 0) {
      this.shiftT -= dt;
      if (this.shiftT <= 0) { this.shiftT = 0; this.cut = 0; }
    } else {
      const up = e.idle + (e.limiter * 0.96 - e.idle) * (0.3 + 0.66 * this.throttle);
      const rNow = this.wheelRpm(this.speed, this.gear);
      if (this.gear < N && rNow > up) {
        this.gear++;
        this.shiftT = lerp(0.35, 0.15, this.throttle);
        this.cut = this.throttle > 0.6 ? 1 : 0;
      } else if (this.gear > 1) {
        const rDown = this.wheelRpm(this.speed, this.gear - 1);
        const kick = this.throttle > 0.85 && rDown < e.limiter * 0.8;
        const lug = rNow < e.idle * 1.5 + 600 * this.throttle;
        if ((kick || lug) && rDown < up * 0.9) { this.gear--; this.shiftT = 0.2; this.cut = 0; }
      }
    }

    // 5. Оберти: колеса + пробуксовка зчеплення на першій
    const wheel = this.wheelRpm(this.speed, this.gear);
    const slip = e.idle + this.throttle * (e.launch - e.idle);
    let target = Math.max(wheel, this.gear === 1 ? slip : e.idle, e.idle);
    // Ціль трохи за відсічкою, щоб оберти дійшли до неї й відскочили
    target = Math.min(target, e.limiter + 120);

    // 6. Обмежувач обертів з відскоком: запалювання вимкнене, доки оберти
    //    не впадуть на LIMIT_DROP, потім двигун знову схоплює й летить угору.
    if (this.shiftT <= 0) {
      if (this.limCut) {
        this.rpm -= 4500 * dt;
        if (this.rpm < e.limiter - LIMIT_DROP || this.throttle < 0.3) this.limCut = false;
      } else {
        this.rpm += (target - this.rpm) * follow(dt, 0.05);
        if (this.rpm >= e.limiter && this.throttle >= 0.3) this.limCut = true;
      }
      this.rpm = Math.min(this.rpm, e.limiter + 20);
      this.cut = this.limCut ? 1 : 0;
    } else {
      this.limCut = false;
      this.rpm += (Math.min(target, e.limiter) - this.rpm) * follow(dt, 0.09);
    }

    // 7. Навантаження і гальмування двигуном
    const coasting = mode === 'gps' ? this.accel < -0.25 : this.throttle < 0.05;
    const ov = coasting && this.rpm > e.idle * 1.35 && this.speed > 2 ? 1 : 0;
    this.overrun += (ov - this.overrun) * follow(dt, 0.15);
    const idleLoad = 0.2 * clamp(1 - (this.rpm - e.idle) / 1500, 0, 1);
    const thr = mode === 'gps' ? Math.pow(this.throttle, 0.6) : this.throttle;
    this.load = Math.max(thr, idleLoad, coasting ? 0 : 0.1);
    this.crank = 0;
  }
}
