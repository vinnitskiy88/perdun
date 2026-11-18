/* gauge.js — тахометр на canvas */

const START = Math.PI * 0.75, SWEEP = Math.PI * 1.5;

export class Tacho {
  constructor(canvas) { this.c = canvas; this.ctx = canvas.getContext('2d'); this.size = 0; }

  fit() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.c.clientWidth;
    if (w * dpr !== this.size) { this.size = w * dpr; this.c.width = this.c.height = this.size; }
  }

  draw(rpm, limiter, throttle) {
    this.fit();
    const ctx = this.ctx, S = this.size, cx = S / 2, cy = S / 2, R = S * 0.44;
    const max = Math.ceil((limiter + 600) / 1000) * 1000;
    const ang = (r) => START + SWEEP * Math.min(r, max) / max;
    ctx.clearRect(0, 0, S, S);

    // фон шкали
    ctx.lineCap = 'round';
    ctx.lineWidth = S * 0.035;
    ctx.strokeStyle = '#23262d';
    ctx.beginPath(); ctx.arc(cx, cy, R, START, START + SWEEP); ctx.stroke();

    // червона зона
    ctx.strokeStyle = 'rgba(229,56,59,.85)';
    ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(cx, cy, R, ang(limiter * 0.92), START + SWEEP); ctx.stroke();

    // заповнення до поточних обертів
    const grad = ctx.createLinearGradient(0, S, S, 0);
    grad.addColorStop(0, '#ffb15c'); grad.addColorStop(1, '#ff5a1a');
    ctx.strokeStyle = rpm >= limiter * 0.92 ? '#ff3b3b' : grad;
    ctx.lineCap = 'round';
    ctx.lineWidth = S * 0.035;
    if (rpm > 20) { ctx.beginPath(); ctx.arc(cx, cy, R, START, ang(rpm)); ctx.stroke(); }

    // поділки
    ctx.fillStyle = '#9aa0aa';
    ctx.font = `600 ${Math.round(S * 0.045)}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let r = 0; r <= max; r += 500) {
      const a = ang(r), major = r % 1000 === 0;
      const r1 = R - S * (major ? 0.06 : 0.04), r2 = R - S * 0.025;
      ctx.strokeStyle = r >= limiter * 0.92 ? '#e5383b' : major ? '#9aa0aa' : '#4a4f58';
      ctx.lineWidth = S * (major ? 0.006 : 0.004);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.stroke();
      if (major) {
        const rt = R - S * 0.1;
        ctx.fillText(String(r / 1000), cx + Math.cos(a) * rt, cy + Math.sin(a) * rt);
      }
    }
    ctx.fillStyle = '#6b717c';
    ctx.font = `500 ${Math.round(S * 0.028)}px system-ui, sans-serif`;
    ctx.fillText('×1000 об/хв', cx, cy + R * 0.78);

    // стрілка-точка на дузі
    const a = ang(rpm);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * R, cy + Math.sin(a) * R, S * 0.022, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff7a1a';
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * R, cy + Math.sin(a) * R, S * 0.012, 0, Math.PI * 2); ctx.fill();
  }
}
