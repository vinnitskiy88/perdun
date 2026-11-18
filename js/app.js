import { CARS } from './cars.js';
import { Vehicle } from './vehicle.js';
import { GpsSpeed } from './gps.js';
import { Tacho } from './gauge.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('perdun.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('perdun.' + k, JSON.stringify(v)); } catch { /* приватний режим */ } },
};

const state = {
  carIdx: Math.min(store.get('car', 0), CARS.length - 1),
  mode: store.get('mode', 'test'),
  volume: store.get('vol', 80) / 100,
  crackle: store.get('crk', 100) / 100,
  gas: 0, brake: 0,
  shownSpeed: 0,
};

const vehicle = new Vehicle(CARS[state.carIdx]);
const tacho = new Tacho($('tacho'));
const gps = new GpsSpeed(onGpsStatus);

// ---------- Аудіо ----------
let ctx = null, node = null, master = null;

async function ensureAudio() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(new URL('./engine-worklet.js', import.meta.url));
  node = new AudioWorkletNode(ctx, 'engine-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
  master = ctx.createGain();
  master.gain.value = 0;
  node.connect(comp).connect(master).connect(ctx.destination);
  sendCar();
  node.port.postMessage({ type: 'crackle', value: state.crackle });
}

function sendCar() { if (node) node.port.postMessage({ type: 'car', engine: CARS[state.carIdx].engine }); }

function setParam(name, value, tau = 0.02) {
  node.parameters.get(name).setTargetAtTime(value, ctx.currentTime, tau);
}

// ---------- Запуск / зупинка ----------
let wakeLock = null;

async function startEngine() {
  try {
    await ensureAudio();
  } catch (err) {
    alert('Не вдалося запустити аудіо: ' + err.message);
    return;
  }
  await ctx.resume();
  vehicle.start();
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setTargetAtTime(state.volume, ctx.currentTime, 0.08);
  if (state.mode === 'gps') gps.start();
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* не критично */ }
  renderStartBtn();
}

function stopEngine() {
  vehicle.stop();
  if (master) master.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
  gps.stop();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  renderStartBtn();
}

$('btnStart').addEventListener('click', () => (vehicle.running ? stopEngine() : startEngine()));

// ---------- Режими ----------
function setMode(mode) {
  state.mode = mode; store.set('mode', mode);
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('gpsInfo').hidden = mode !== 'gps';
  $('pedals').hidden = mode !== 'test';
  if (mode === 'gps' && vehicle.running) gps.start();
  if (mode === 'test') gps.stop();
  state.gas = state.brake = 0;
}
document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

function onGpsStatus(s, info) {
  const chip = $('chipGps'), st = $('gpsStatus');
  chip.classList.remove('on', 'bad');
  const map = {
    off: ['GPS вимк.', 'GPS вимкнено'],
    waiting: ['GPS…', 'Очікування сигналу GPS…'],
    unsupported: ['Немає GPS', 'Браузер не підтримує геолокацію'],
    denied: ['GPS заборонено', 'Доступ до геолокації заборонено. Увімкніть його в налаштуваннях сайту.'],
    error: ['GPS помилка', 'Помилка GPS: ' + (info?.message || '')],
  };
  if (s === 'ok') {
    chip.textContent = 'GPS ±' + Math.round(info.accuracy) + ' м';
    chip.classList.add('on');
    st.textContent = 'Сигнал є, точність ±' + Math.round(info.accuracy) + ' м';
  } else {
    [chip.textContent, st.textContent] = map[s] || [s, s];
    if (s === 'denied' || s === 'error' || s === 'unsupported') chip.classList.add('bad');
  }
}

// ---------- Машини ----------
function renderCars() {
  const box = $('cars');
  box.innerHTML = '';
  CARS.forEach((car, i) => {
    const b = document.createElement('button');
    b.className = 'car' + (i === state.carIdx ? ' active' : '');
    b.innerHTML = `<b></b><span></span>`;
    b.querySelector('b').textContent = car.name;
    b.querySelector('span').textContent = car.tagline;
    b.addEventListener('click', () => selectCar(i));
    box.appendChild(b);
  });
}
function selectCar(i) {
  state.carIdx = i; store.set('car', i);
  vehicle.setCar(CARS[i]);
  sendCar();
  renderCars();
}

// ---------- Педалі й клавіатура ----------
function bindPedal(el, key) {
  const down = (e) => { e.preventDefault(); state[key] = 1; el.classList.add('down'); el.setPointerCapture?.(e.pointerId); };
  const up = () => { state[key] = 0; el.classList.remove('down'); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
bindPedal($('pedGas'), 'gas');
bindPedal($('pedBrake'), 'brake');

const KEYS = { ArrowUp: 'gas', KeyW: 'gas', Space: 'gas', ArrowDown: 'brake', KeyS: 'brake' };
function onKey(e, v) {
  const k = KEYS[e.code];
  if (!k || state.mode !== 'test' || e.target.tagName === 'INPUT') return;
  e.preventDefault();
  state[k] = v;
  $(k === 'gas' ? 'pedGas' : 'pedBrake').classList.toggle('down', !!v);
}
window.addEventListener('keydown', (e) => onKey(e, 1));
window.addEventListener('keyup', (e) => onKey(e, 0));

// ---------- Повзунки ----------
$('vol').value = Math.round(state.volume * 100);
$('crk').value = Math.round(state.crackle * 100);
function syncSliders() {
  $('volOut').textContent = $('vol').value + '%';
  $('crkOut').textContent = $('crk').value + '%';
}
$('vol').addEventListener('input', () => {
  state.volume = $('vol').value / 100; store.set('vol', +$('vol').value);
  if (master && vehicle.running) master.gain.setTargetAtTime(state.volume, ctx.currentTime, 0.05);
  syncSliders();
});
$('crk').addEventListener('input', () => {
  state.crackle = $('crk').value / 100; store.set('crk', +$('crk').value);
  node?.port.postMessage({ type: 'crackle', value: state.crackle });
  syncSliders();
});

// ---------- Цикл симуляції (не залежить від rAF, щоб працювати у фоні) ----------
let lastT = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  let inp;
  if (state.mode === 'gps') {
    const g = gps.read(now);
    if (!vehicle.running) state.shownSpeed = 0;   // після зупинки — з нуля
    else state.shownSpeed += (g.speed - state.shownSpeed) * (1 - Math.exp(-dt / 0.2));
    inp = { speed: state.shownSpeed, accel: g.accel };
  } else {
    inp = { gas: state.gas, brake: state.brake };
  }
  vehicle.update(dt, state.mode, inp);
  if (node) {
    setParam('rpm', vehicle.rpm);
    setParam('load', vehicle.load);
    setParam('overrun', vehicle.overrun);
    setParam('cut', vehicle.cut, 0.003);
    setParam('crank', vehicle.crank);
  }
}, 16);

// ---------- Малювання ----------
function frame() {
  const e = CARS[state.carIdx].engine;
  tacho.draw(vehicle.rpm, e.limiter, vehicle.throttle);
  $('speed').textContent = Math.round(vehicle.speed * 3.6);
  $('rpm').textContent = Math.round(vehicle.rpm / 10) * 10 + ' об/хв';
  $('gear').textContent = vehicle.started ? (vehicle.speed < 0.5 && vehicle.throttle < 0.05 ? 'N' : vehicle.gear) : '–';
  $('thrBar').style.width = Math.round(vehicle.throttle * 100) + '%';
  requestAnimationFrame(frame);
}

function renderStartBtn() {
  const b = $('btnStart'), chip = $('chipEngine');
  b.textContent = vehicle.running ? 'Заглушити' : 'Запустити двигун';
  b.classList.toggle('running', vehicle.running);
  chip.textContent = vehicle.running ? 'Двигун працює' : 'Двигун вимк.';
  chip.classList.toggle('on', vehicle.running);
}

// ---------- Ініціалізація ----------
if (!window.isSecureContext) $('secureWarn').hidden = false;
renderCars();
setMode(state.mode);
syncSliders();
renderStartBtn();
requestAnimationFrame(frame);
