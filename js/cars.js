/*
 * Профілі машин. engine — для синтезатора (engine-core.js),
 * vehicle — для віртуальної трансмісії (vehicle.js).
 * Щоб додати машину, допишіть ще один об'єкт такої ж форми.
 */

// cylinders: кути спалахів у градусах циклу 720°, ряд (0/1), розкид сили,
// offs — постійні зсуви кожного спалаху в градусах (різна довжина випускних каналів):
// дають напівпорядки саме на високих частотах, як у справжніх V8.
function cylinders(step, banks, gains, offs = []) {
  return banks.map((b, i) => ({ ang: (i * step + (offs[i] || 0) + 720) % 720, bank: b, gain: gains[i % gains.length] }));
}

export const CARS = [
  {
    // Справжні дані: M177 4.0 л V8 бітурбо (турбіни в розвалі), хрестоподібний вал;
    // 430 кВт / 850 Нм; 9G-TRONIC 5.35…0.60, головна пара 3.45; ~2640 кг;
    // шини 275/50 R20; швидкість обмежена ~220 км/год.
    id: 'amg-g63',
    name: 'Mercedes-AMG G 63',
    tagline: '4.0 л V8 бітурбо · 6 500 об/хв · 9-ст. автомат',
    engine: {
      banks: 2,
      // порядок 1-5-4-8-6-3-7-2 (циліндри 1–4 — правий ряд, 5–8 — лівий):
      // ряди П Л П Л Л П Л П — нерівномірні імпульси на ряд, «бурчання» V8
      // більший розкид сили між циліндрами — більше субгармонік, «бурчання» в басу
      // зсуви ±3…8° — за заміром порядків справжнього G 63 (сильні напівпорядки 4.5…16)
      cylinders: cylinders(90, [0, 1, 0, 1, 1, 0, 1, 0], [1, 0.95, 1.04, 0.97, 1.03, 0.95, 1.05, 0.98],
        [0, 6, -5, 8, -7, 4, -8, 5]),
      idle: 650, limiter: 6500, launch: 2400, peakRpm: 6000,
      // довгий вихлоп великого позашляховика, турбіни приглушують верх — глибокий бас
      // Підігнано під запис справжнього G 63 (Akrapovič): щільний бас 125–250 Гц,
      // помітна хрипкість 1–4 кГц, рване бурчання й постріли на скиданні.
      pipe: [3.4, 3.9], pipeFb: -0.3, pipeDamp: 0.4,
      formants: [{ f: 140, q: 1.0, g: 0.85 }, { f: 420, q: 1.4, g: 0.3 }],
      dry: 0.5, muffler: 5500, intake: 1.2, intakeF: 3000,
      rasp: 0.5, lope: 0.25, crackle: 1.0, whine: 0.05, whineRatio: 30,
      idleStrength: 0.45, overrunStrength: 0.75, lowCut: 150,
      popGain: 1.8, burble: 0.8,
      // вузькі, різкі імпульси тиску — більше «хрипу» 1–4 кГц навіть на низьких обертах
      pulseWidth: 0.18, drive: 1.7, gain: 0.55,
    },
    vehicle: {
      mass: 2640, peakKw: 430, cdA: 1.85, tireCirc: 2.46, maxKmh: 220, grip: 0.72,
      ratios: [5.35, 3.24, 2.25, 1.64, 1.21, 1.0, 0.86, 0.72, 0.6], final: 3.45,
    },
  },
  {
    id: 'v8-muscle',
    name: 'V8 Muscle',
    tagline: 'Хрестоподібний V8 · 6.2 л · рваний холостий хід',
    engine: {
      banks: 2,
      // порядок 1-8-4-3-6-5-7-2: ряди Л П П Л П Л Л П — нерівномірні імпульси на ряд
      cylinders: cylinders(90, [0, 1, 1, 0, 1, 0, 0, 1], [1, 0.92, 1.06, 0.97, 1.03, 0.94, 1.07, 0.98]),
      idle: 750, limiter: 6800, launch: 2600, peakRpm: 6000,
      pipe: [2.6, 3.1], pipeFb: -0.35, pipeDamp: 0.45,
      formants: [{ f: 170, q: 1.2, g: 0.7 }, { f: 520, q: 2.0, g: 0.3 }],
      dry: 0.5, muffler: 1800, intake: 0.25, intakeF: 700,
      rasp: 0.35, lope: 0.6, crackle: 0.25, whine: 0, whineRatio: 0,
      overrunStrength: 0.75, idleStrength: 0.48,
      pulseWidth: 0.5, drive: 1.6, gain: 0.55,
    },
    vehicle: {
      mass: 1800, peakKw: 340, cdA: 0.75, tireCirc: 2.05,
      ratios: [2.97, 2.07, 1.43, 1.0, 0.84, 0.56], final: 3.42,
    },
  },
  {
    id: 'v8-blower',
    name: 'V8 з нагнітачем',
    tagline: 'V8 · 6.2 л · механічний нагнітач зі свистом',
    engine: {
      banks: 2,
      cylinders: cylinders(90, [0, 1, 1, 0, 1, 0, 0, 1], [1, 0.95, 1.04, 0.98, 1.02, 0.96, 1.05, 0.99]),
      idle: 800, limiter: 6500, launch: 2800, peakRpm: 6000,
      pipe: [2.4, 2.8], pipeFb: -0.4, pipeDamp: 0.4,
      formants: [{ f: 190, q: 1.2, g: 0.7 }, { f: 640, q: 2.0, g: 0.35 }],
      dry: 0.5, muffler: 2400, intake: 1.0, intakeF: 2500,
      rasp: 0.45, lope: 0.35, crackle: 0.25, whine: 0.6, whineRatio: 25,
      idleStrength: 0.7, overrunStrength: 0.75, crankStrength: 1.3, lowCut: 160,
      pulseWidth: 0.5, drive: 1.8, gain: 0.5,
    },
    vehicle: {
      mass: 2000, peakKw: 527, cdA: 0.8, tireCirc: 2.1,
      ratios: [4.71, 3.14, 2.11, 1.67, 1.29, 1.0, 0.84, 0.67], final: 2.62,
    },
  },
  {
    id: 'flat6-gt',
    name: 'Опозитна шістка GT',
    tagline: 'Атмосферний оппозит · 4.0 л · 9 000 об/хв',
    engine: {
      banks: 2,
      cylinders: cylinders(120, [0, 1, 0, 1, 0, 1], [1, 0.97, 1.03, 0.99, 1.02, 0.98]),
      idle: 900, limiter: 9000, launch: 3500, peakRpm: 8300,
      pipe: [1.5, 1.7], pipeFb: -0.55, pipeDamp: 0.55,
      formants: [{ f: 450, q: 1.5, g: 0.6 }, { f: 1600, q: 3.0, g: 0.35 }],
      dry: 0.45, muffler: 4500, intake: 0.5, intakeF: 1500,
      rasp: 0.45, lope: 0.12, crackle: 0.4, whine: 0, whineRatio: 0,
      idleStrength: 0.75, crankStrength: 2.0, lowCut: 70,
      pulseWidth: 0.45, drive: 1.7, gain: 0.55,
    },
    vehicle: {
      mass: 1450, peakKw: 375, cdA: 0.7, tireCirc: 2.1,
      ratios: [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84], final: 3.97,
    },
  },
  {
    id: 'i4-hothatch',
    name: 'Рядна четвірка',
    tagline: 'Турбо 2.0 · хот-хетч · постріли на скиданні',
    engine: {
      banks: 1,
      cylinders: cylinders(180, [0, 0, 0, 0], [1, 0.96, 1.04, 0.98]),
      idle: 850, limiter: 7000, launch: 3000, peakRpm: 6200,
      pipe: [1.8, 1.8], pipeFb: -0.45, pipeDamp: 0.5,
      formants: [{ f: 320, q: 1.4, g: 0.6 }, { f: 1100, q: 2.5, g: 0.35 }],
      dry: 0.5, muffler: 2200, intake: 0.35, intakeF: 1200,
      rasp: 0.5, lope: 0.08, crackle: 0.9, whine: 0, whineRatio: 0,
      pulseWidth: 0.45, drive: 1.6, gain: 0.6,
    },
    vehicle: {
      mass: 1350, peakKw: 180, cdA: 0.68, tireCirc: 1.98,
      ratios: [3.36, 2.09, 1.47, 1.1, 0.87, 0.73], final: 4.4,
    },
  },
  {
    id: 'v12-super',
    name: 'V12 Supercar',
    tagline: 'Атмосферний V12 · 6.5 л · 8 700 об/хв',
    engine: {
      banks: 2,
      cylinders: cylinders(60, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], [1, 0.98, 1.02, 0.99, 1.01, 0.97, 1.03, 0.99, 1.0, 0.98, 1.02, 1.0]),
      idle: 1000, limiter: 8700, launch: 3500, peakRpm: 8200,
      pipe: [1.3, 1.36], pipeFb: -0.5, pipeDamp: 0.55,
      formants: [{ f: 600, q: 1.5, g: 0.6 }, { f: 2200, q: 2.5, g: 0.3 }],
      dry: 0.45, muffler: 6500, intake: 0.6, intakeF: 1800,
      rasp: 0.3, lope: 0, crackle: 1.0, whine: 0, whineRatio: 0,
      idleStrength: 0.5, overrunStrength: 0.25, crankStrength: 0.9, lowCut: 100,
      pulseWidth: 0.45, drive: 1.6, gain: 0.65,
    },
    vehicle: {
      mass: 1600, peakKw: 515, cdA: 0.72, tireCirc: 2.1,
      ratios: [3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69], final: 4.6,
    },
  },
];
