"""Порівняння звуку Пердуна з еталонними записами (tools/analyze.py).

  python tools/analyze.py track      — з ref/*.wav: початок звуку, крива обертів за спектром,
                                       звірка з обертами, залогованими під час запису;
                                       пише tools/out/<car>.track.json для рендеру Пердуна.
  python tools/analyze.py compare    — порівнює ref/<car>.wav з tools/out/<car>-perdun.wav
                                       за фазами: запуск, холостий, газ, скидання.
"""
import json
import os
import sys
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, 'ref')
OUT = os.path.join(ROOT, 'tools', 'out')

# Сценарій запису (секунди від натискання START): 5 с холостий, 8 с газ, 6 с скидання.
GAS_ON, GAS_OFF, STOP = 5.0, 13.0, 19.2

# Машини: циліндри, холості/відсічка нашого профілю, оберти з логу під час запису teslasound
# (лог: +5 c холостий; +7,+9,+11,+13 газ; +15,+17,+19 скидання).
CARS = {
    'v8-muscle': dict(n=8, lim=6800, log=[770, 3260, 4380, 5980, 5330, 4350, 4170, 4000]),
    'v8-blower': dict(n=8, lim=6500, log=[760, 3550, 4840, 4790, 4060, 4040, 3880, 3740]),
    'flat6-gt': dict(n=6, lim=9000, log=[860, 5660, 7230, 7140, 8660, 6590, 6270, 5980]),
    'v12-super': dict(n=12, lim=8700, log=[910, 3960, 6500, 7290, 7160, 5630, 5410, 5190]),
}
LOG_T = [5, 7, 9, 11, 13, 15, 17, 19]


def load(path):
    w = wave.open(path)
    sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
    a = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768
    a = a.reshape(-1, ch)
    return sr, a.mean(axis=1), a


def onset(x, sr, thr=0.009):
    blk = sr // 100
    for i in range(0, len(x) - blk, blk):
        if np.sqrt(np.mean(x[i:i + blk] ** 2)) > thr:
            return i / sr
    return 0.0


def stft_mag(x, sr, nfft, hop):
    win = np.hanning(nfft).astype(np.float32)
    frames = 1 + (len(x) - nfft) // hop
    idx = np.arange(nfft)[None, :] + hop * np.arange(frames)[:, None]
    return np.abs(np.fft.rfft(x[idx] * win, axis=1)), np.arange(frames) * hop / sr + nfft / 2 / sr


def rpm_track(x, sr, ncyl, lim, anchors):
    """Оберти в кожному кадрі: гармонійна сума спектру на частоті спалахів і кратних,
    пошук у вікні ±30% навколо інтерпольованого логу (захист від помилки на октаву)."""
    nfft, hop = 8192, sr // 50
    mag, t = stft_mag(x, sr, nfft, hop)
    lm = np.log1p(mag * 50)
    df = sr / nfft
    at, av = anchors
    out = []
    for i, ti in enumerate(t):
        guess = np.interp(ti, at, av)
        cand = np.arange(max(300, guess * 0.7), min(lim * 1.15, guess * 1.3), 5.0)
        f0 = cand * ncyl / 120
        score = np.zeros_like(cand)
        for k, wk in ((1, 1.0), (2, 0.8), (3, 0.6), (4, 0.4)):
            b = np.clip(np.round(k * f0 / df).astype(int), 1, lm.shape[1] - 2)
            score += wk * np.maximum(np.maximum(lm[i, b - 1], lm[i, b]), lm[i, b + 1])
        out.append(cand[np.argmax(score)])
    r = np.array(out)
    # медіанне згладжування 5 кадрів
    rs = np.array([np.median(r[max(0, i - 2):i + 3]) for i in range(len(r))])
    return t, rs


def cmd_track():
    os.makedirs(OUT, exist_ok=True)
    for car, c in CARS.items():
        sr, x, _ = load(os.path.join(REF, car + '.wav'))
        t0 = onset(x, sr)
        seg = x[int(t0 * sr):int((t0 + STOP + 1.0) * sr)]
        at = [0.0, 2.6] + LOG_T
        av = [250.0, c['log'][0]] + c['log']
        t, r = rpm_track(seg, sr, c['n'], c['lim'], (at, av))

        # Зсув d: звук чутно трохи пізніше за клік START (стартер тихий).
        # Точка логу lt (від кліку) у нашій осі (від початку звуку) = lt - d.
        # Беремо d з мінімальною медіанною похибкою по точках логу.
        def err(d):
            return np.mean([min(abs(np.interp(lt - d, t, r) - lv) / lv, 0.3) for lt, lv in zip(LOG_T, c['log'])])
        ds = np.arange(0.0, 0.41, 0.02)
        d = float(ds[np.argmin([err(v) for v in ds])])

        rows = []
        for lt, lv in zip(LOG_T, c['log']):
            m = float(np.interp(lt - d, t, r))
            rows.append((lt, lv, m, 100 * (m - lv) / lv))
        bad = [x for x in rows if abs(x[3]) > 12]
        print(f'{car}: onset {t0:.2f}s, зсув кліку d={d:.2f}s; звірка обертів (спектр/лог):')
        print('   ' + '  '.join(f'+{lt}s {int(m)}/{lv} ({e:+.0f}%)' for lt, lv, m, e in rows))
        print(f'   розбіжностей >12%: {len(bad)}/{len(rows)}')
        # Вісь часу треку — від кліку START (t + d), щоб рендер Пердуна йшов у тій самій шкалі.
        with open(os.path.join(OUT, car + '.track.json'), 'w') as f:
            json.dump({'car': car, 'click': round(t0 - d, 3), 'd': round(d, 3),
                       't': [round(float(v + d), 3) for v in t],
                       'rpm': [round(float(v), 1) for v in r]}, f)


# ---------- порівняння ----------
BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000]
PHASES = [('запуск', 0.0, 2.6), ('холостий', 3.0, 4.8), ('газ', 5.5, 12.8), ('скидання', 13.3, 18.8)]


def db(v):
    return 20 * np.log10(max(v, 1e-9))


def features(x, sr, a, b):
    s = x[int(a * sr):int(b * sr)]
    rms = np.sqrt(np.mean(s ** 2))
    mag, _ = stft_mag(s, sr, 4096, 1024)
    p = (mag ** 2).mean(axis=0)
    f = np.fft.rfftfreq(4096, 1 / sr)
    cen = float((p * f).sum() / p.sum())
    bands = []
    for fc in BANDS:
        m = (f >= fc / np.sqrt(2)) & (f < fc * np.sqrt(2))
        bands.append(p[m].sum())
    tot = sum(bands)
    return rms, cen, [10 * np.log10(bv / tot + 1e-12) for bv in bands]


def pops(x, sr, a, b):
    """Постріли: короткі сплески, де RMS 10 мс перевищує медіану околу 0.5 с на 6+ дБ."""
    s = x[int(a * sr):int(b * sr)]
    blk = sr // 100
    e = np.array([np.sqrt(np.mean(s[i:i + blk] ** 2)) + 1e-9 for i in range(0, len(s) - blk, blk)])
    ev, i = [], 0
    while i < len(e):
        lo, hi = max(0, i - 25), min(len(e), i + 25)
        if db(e[i]) - db(np.median(e[lo:hi])) > 6:
            j = i
            while j < len(e) and db(e[j]) - db(np.median(e[lo:hi])) > 3:
                j += 1
            ev.append((i, j - i))
            i = j + 5
        else:
            i += 1
    if not ev:
        return 0, 0, 0
    gaps = np.diff([s for s, _ in ev]) * 10 if len(ev) > 1 else [0]
    return len(ev), float(np.median([d for _, d in ev]) * 10), float(np.median(gaps))


def start_env(x, sr):
    blk = sr // 20
    return [db(np.sqrt(np.mean(x[i:i + blk] ** 2))) for i in range(0, int(2.6 * sr), blk)]


def cmd_compare():
    total = []
    for car in CARS:
        rp = os.path.join(REF, car + '.wav')
        op = os.path.join(OUT, car + '-perdun.wav')
        if not os.path.exists(op):
            print(f'{car}: немає {op}')
            continue
        res = {}
        click = json.load(open(os.path.join(OUT, car + '.track.json')))['click']
        for tag, path in (('ref', rp), ('rev', op)):
            sr, x, _ = load(path)
            t0 = click if tag == 'ref' else 0.0   # обидва файли — від кліку START
            x = x[int(t0 * sr):]
            gas_rms = features(x, sr, 5.5, 12.8)[0]
            ph = {}
            for name, a, b in PHASES:
                rms, cen, bands = features(x, sr, a, b)
                ph[name] = (db(rms / gas_rms), cen, bands)
            res[tag] = dict(ph=ph, pops=pops(x, sr, 13.3, 18.8), env=start_env(x, sr), gas=db(gas_rms))
        print(f'\n===== {car} =====')
        print(f'{"фаза":<10}{"рівень відн. газу, дБ":>24}{"центр спектру, Гц":>22}   смуги 63..8k Гц, дБ відн. (ref | perdun | різниця)')
        car_err = []
        for name, *_ in PHASES:
            r, v = res['ref']['ph'][name], res['rev']['ph'][name]
            dl = v[0] - r[0]
            diff = [vb - rb for rb, vb in zip(r[2], v[2])]
            car_err += [abs(dl)] + [abs(d) for d in diff[1:7]]
            print(f'{name:<10}{r[0]:>8.1f} | {v[0]:>5.1f} ({dl:+.1f}){r[1]:>9.0f} | {v[1]:>5.0f}   '
                  + ' '.join(f'{d:+.0f}' for d in diff))
        rp_, vp_ = res['ref']['pops'], res['rev']['pops']
        print(f'постріли на скиданні: ref {rp_[0]} шт, тривалість ~{rp_[1]:.0f} мс, паузи ~{rp_[2]:.0f} мс | '
              f'perdun {vp_[0]} шт, ~{vp_[1]:.0f} мс, ~{vp_[2]:.0f} мс')
        re_, ve_ = res['ref']['env'], res['rev']['env']
        gr, gv = res['ref']['gas'], res['rev']['gas']
        print('запуск, RMS по 50 мс відн. газу (кожні 0.25 с):')
        print('  ref  : ' + ' '.join(f'{v - gr:+.0f}' for v in re_[::5]))
        print('  perdun: ' + ' '.join(f'{v - gv:+.0f}' for v in ve_[::5]))
        err = float(np.mean(car_err))
        total.append(err)
        print(f'середня розбіжність (рівні + смуги 125..4k): {err:.1f} дБ')
    if total:
        print(f'\nЗАГАЛОМ середня розбіжність: {np.mean(total):.1f} дБ')


def pop_profile(x, sr, a, b):
    """Середній спектр пострілів на скиданні: вікна 30 мс від початку кожного сплеску,
    мінус спектр фону (медіана). Повертає кількість, центр, площинність, тональний пік."""
    s = x[int(a * sr):int(b * sr)]
    blk = sr // 200                                   # 5 мс
    e = np.array([np.sqrt(np.mean(s[i:i + blk] ** 2)) + 1e-9 for i in range(0, len(s) - blk, blk)])
    starts, i = [], 0
    while i < len(e):
        lo, hi = max(0, i - 50), min(len(e), i + 50)
        if db(e[i]) - db(np.median(e[lo:hi])) > 6:
            starts.append(i * blk)
            i += 20                                   # не частіше 100 мс
        else:
            i += 1
    if not starts:
        return None
    n = int(0.03 * sr)
    win = np.hanning(n)
    f = np.fft.rfftfreq(n, 1 / sr)
    P = np.mean([np.abs(np.fft.rfft(s[k:k + n] * win)) ** 2 for k in starts if k + n < len(s)], axis=0)
    bg_idx = [k for k in range(0, len(s) - n, n)]
    B = np.median([np.abs(np.fft.rfft(s[k:k + n] * win)) ** 2 for k in bg_idx], axis=0)
    D = np.maximum(P - B, 1e-12)                      # енергія саме пострілу
    m = (f > 80) & (f < 8000)
    cen = float((D[m] * f[m]).sum() / D[m].sum())
    flat = float(np.exp(np.mean(np.log(D[m]))) / np.mean(D[m]))   # 1 = шум, ~0 = тон
    peak = float(D[m].max() / np.median(D[m]))                    # наскільки виділяється один пік
    bands = []
    for fc in BANDS:
        mm = (f >= fc / np.sqrt(2)) & (f < fc * np.sqrt(2))
        bands.append(D[mm].sum())
    tot = sum(bands)
    return len(starts), cen, flat, db(peak) / 2, [10 * np.log10(v / tot + 1e-12) for v in bands]


def cmd_pops():
    for car in CARS:
        op = os.path.join(OUT, car + '-perdun.wav')
        click = json.load(open(os.path.join(OUT, car + '.track.json')))['click']
        print(f'\n== {car}: постріли на скиданні ==')
        for tag, path, t0 in (('ref  ', os.path.join(REF, car + '.wav'), click), ('perdun', op, 0.0)):
            sr, x, _ = load(path)
            x = x[int(t0 * sr):]
            r = pop_profile(x, sr, 13.3, 18.8)
            if r is None:
                print(f'  {tag}: пострілів не знайдено')
                continue
            cnt, cen, flat, pk, bands = r
            print(f'  {tag}: {cnt:>2} шт, центр {cen:>5.0f} Гц, площинність {flat:.2f}, '
                  f'тональний пік {pk:+.0f} дБ, смуги 63..8k: ' + ' '.join(f'{v:+.0f}' for v in bands))


def texture(x, sr, tr_t, tr_r, ncyl, a, b):
    """Ознаки «живості» звуку на відрізку [a,b] (с від кліку):
    harm  — частка енергії 60–4000 Гц точно на порядках двигуна (більше = чистіший тон, «синтетичніше»);
    sharp — гострота піку порядку 4: енергія ±1 біна проти ±2…6 бінів, дБ (більше = ідеальніша періодичність);
    flat  — спектральна площинність 2–8 кГц (1 = шум, 0 = тони/артефакти);
    am    — живі коливання гучності: розкид RMS по 10 мс у межах 0.5 с, % (після прибирання тренду)."""
    nfft = 8192; win = np.hanning(nfft); df = sr / nfft
    f = np.fft.rfftfreq(nfft, 1 / sr)
    band = (f >= 60) & (f <= 4000)
    hs, sh, fl = [], [], []
    for tt in np.arange(a + 0.1, b - 0.1, 0.1):
        c = int(tt * sr)
        fr = x[c - nfft // 2:c + nfft // 2]
        if len(fr) != nfft:
            continue
        P = np.abs(np.fft.rfft(fr * win)) ** 2
        rpm = float(np.interp(tt, tr_t, tr_r))
        f0 = rpm / 60 * 0.5                         # крок напівпорядку
        mask = np.zeros_like(P, dtype=bool)
        k = 1
        while k * f0 < 4000:
            bi = int(round(k * f0 / df))
            mask[max(0, bi - 1):bi + 2] = True
            k += 1
        hs.append(P[mask & band].sum() / P[band].sum())
        b4 = int(round(rpm / 60 * ncyl / 2 / df))
        core = P[b4 - 1:b4 + 2].sum()
        ring = P[b4 - 6:b4 - 1].sum() + P[b4 + 2:b4 + 7].sum()
        sh.append(10 * np.log10(core / (ring + 1e-12)))
        hb = (f >= 2000) & (f <= 8000)
        fl.append(float(np.exp(np.mean(np.log(P[hb] + 1e-15))) / np.mean(P[hb])))
    # коливання гучності
    s = x[int(a * sr):int(b * sr)]
    blk = sr // 100
    e = np.array([np.sqrt(np.mean(s[i:i + blk] ** 2)) for i in range(0, len(s) - blk, blk)])
    am = []
    for i in range(0, len(e) - 50, 50):
        w = e[i:i + 50]
        tr = np.polyval(np.polyfit(np.arange(50), w, 1), np.arange(50))
        am.append(np.std(w - tr) / (np.mean(w) + 1e-9) * 100)
    return np.mean(hs) * 100, np.mean(sh), np.mean(fl), np.mean(am)


def cmd_texture():
    print('ознаки: harm% (тон на порядках) | sharp дБ (ідеальність періоду) | flat 2–8к | am% (живі коливання)')
    for car, c in CARS.items():
        tr = json.load(open(os.path.join(OUT, car + '.track.json')))
        tt, rr = np.array(tr['t']), np.array(tr['rpm'])
        print(f'\n== {car} ==')
        for tag, path, t0 in (('teslasound', os.path.join(REF, car + '.wav'), tr['click']),
                              ('Пердун    ', os.path.join(OUT, car + '-perdun.wav'), 0.0)):
            sr, x, _ = load(path)
            x = x[int(t0 * sr):]
            row = []
            for name, a, b in (('холостий', 3.0, 4.8), ('газ', 5.5, 12.8), ('скидання', 13.3, 18.8)):
                h, s_, fl, am = texture(x, sr, tt, rr, c['n'], a, b)
                row.append(f'{name}: {h:4.0f}% {s_:5.1f} {fl:.2f} {am:4.1f}%')
            print(f'  {tag}  ' + ' | '.join(row))


if __name__ == '__main__':
    {'track': cmd_track, 'compare': cmd_compare, 'pops': cmd_pops, 'texture': cmd_texture}[sys.argv[1]]()
