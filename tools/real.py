"""Аналіз запису справжньої машини (без логу обертів): tools/real.py

  python -X utf8 tools/real.py track <wav> <ncyl> <t_from> <t_to>
      → крива обертів зі спектру (Вітербі), фази (розгін/скидання/рівно/холостий),
        tools/out/real.track.json для рендеру Пердуна і короткий звіт.
  python -X utf8 tools/real.py compare <ref.wav> <perdun.wav>
      → порівняння тембру по фазах (смуги, центр спектру, постріли) за real.track.json.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import load, stft_mag, db, BANDS, pop_profile  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools', 'out')


def viterbi_rpm(x, sr, ncyl, lo=550, hi=7000):
    nfft, hop = 8192, sr // 50                     # кадр 20 мс
    mag, t = stft_mag(x, sr, nfft, hop)
    lm = np.log1p(mag * 50)
    df = sr / nfft
    cand = np.arange(lo, hi, 10.0)
    f0 = cand * ncyl / 120
    S = np.zeros((len(t), len(cand)))
    for k, wk in ((1, 1.0), (2, 0.7), (3, 0.5), (4, 0.35)):
        b = np.clip(np.round(k * f0 / df).astype(int), 1, lm.shape[1] - 2)
        S += wk * np.maximum(np.maximum(lm[:, b - 1], lm[:, b]), lm[:, b + 1])
    # штраф за «половинну» частоту: справжній основний тон сильніший за f/2 між гармоніками
    bh = np.clip(np.round(0.5 * f0 / df).astype(int), 1, lm.shape[1] - 2)
    S -= 0.6 * lm[:, bh]
    S = (S - S.mean(axis=1, keepdims=True)) / (S.std(axis=1, keepdims=True) + 1e-9)
    # Вітербі: перехід дешевий у межах ~±150 об/хв за кадр (розгін/перемикання до ~7500 об/хв/с)
    n, m = S.shape
    idx = np.arange(m)
    jump = np.abs(idx[:, None] - idx[None, :]) * 10.0   # об/хв
    trans = -np.maximum(0, jump - 150) / 300.0
    score = S[0].copy()
    back = np.zeros((n, m), dtype=np.int32)
    for i in range(1, n):
        tot = score[None, :] + trans                     # [to, from]
        back[i] = np.argmax(tot, axis=1)
        score = tot[idx, back[i]] + S[i]
    path = np.zeros(n, dtype=np.int32)
    path[-1] = int(np.argmax(score))
    for i in range(n - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    conf = S[np.arange(n), path]
    return t, cand[path], conf


def phases(t, rpm, idle):
    """Фази за похідною обертів (згладженою): розгін / скидання / рівно / холостий."""
    k = 15
    r = np.convolve(rpm, np.ones(k) / k, mode='same')
    d = np.gradient(r, t)
    ph = np.where(r < idle * 1.25, 'холостий',
          np.where(d > 250, 'розгін', np.where(d < -150, 'скидання', 'рівно')))
    return ph, d


def cmd_track(wav, ncyl, a, b):
    sr, x, _ = load(wav)
    seg = x[int(a * sr):int(b * sr)]
    t, rpm, conf = viterbi_rpm(seg, sr, ncyl)
    idle = float(np.percentile(rpm, 5))
    ph, d = phases(t, rpm, idle)
    os.makedirs(OUT, exist_ok=True)
    json.dump({'src': os.path.basename(wav), 'from': a, 'to': b, 'ncyl': ncyl,
               't': [round(float(v), 3) for v in t], 'rpm': [round(float(v), 1) for v in rpm],
               'phase': ph.tolist(), 'conf': [round(float(v), 2) for v in conf]},
              open(os.path.join(OUT, 'real.track.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'{len(t)} кадрів, {t[-1]:.0f} с; оберти: мін {rpm.min():.0f}, 5% {idle:.0f}, '
          f'медіана {np.median(rpm):.0f}, 95% {np.percentile(rpm, 95):.0f}, макс {rpm.max():.0f}')
    print(f'впевненість (z-score піку): медіана {np.median(conf):.1f}, частка кадрів <1.5: {np.mean(conf < 1.5) * 100:.0f}%')
    for p in ('холостий', 'розгін', 'скидання', 'рівно'):
        print(f'  {p:<9}: {np.mean(ph == p) * 100:4.0f}% часу')
    print('оберти кожні 5 с: ' + ' '.join(f'{int(rpm[(t >= s)][0])}' for s in range(0, int(t[-1]), 5)))


def seg_features(x, sr, mask_t, t):
    """Середній спектр по кадрах, що належать фазі (маска в осі t кадрів 20 мс)."""
    hop = sr // 50
    frames = [x[int(tt * sr) - 2048:int(tt * sr) + 2048] for tt, m in zip(t, mask_t) if m]
    frames = [f for f in frames if len(f) == 4096]
    if len(frames) < 10:
        return None
    win = np.hanning(4096)
    P = np.mean([np.abs(np.fft.rfft(f * win)) ** 2 for f in frames[::3]], axis=0)
    f = np.fft.rfftfreq(4096, 1 / sr)
    m = (f > 30) & (f < 10000)
    cen = float((P[m] * f[m]).sum() / P[m].sum())
    e = []
    for fc in BANDS:
        mm = (f >= fc / np.sqrt(2)) & (f < fc * np.sqrt(2))
        e.append(P[mm].sum())
    tot = sum(e)
    rms = float(np.sqrt(np.mean(np.concatenate(frames) ** 2)))
    return rms, cen, [10 * np.log10(v / tot + 1e-12) for v in e]


def cmd_compare(ref, per):
    tr = json.load(open(os.path.join(OUT, 'real.track.json'), encoding='utf-8'))
    t = np.array(tr['t']); ph = np.array(tr['phase'])
    res = {}
    for tag, path, off in (('справжній', ref, tr['from']), ('Пердун', per, 0.0)):
        sr, x, _ = load(path)
        x = x[int(off * sr):]
        all_rms = seg_features(x, sr, np.ones(len(t), bool), t)[0]
        res[tag] = {p: seg_features(x, sr, ph == p, t) for p in ('холостий', 'розгін', 'рівно', 'скидання')}
        res[tag]['_all'] = all_rms
        res[tag]['_pops'] = pop_profile(x, sr, 0, t[-1])
    print(f'{"фаза":<10}{"рівень відн. середнього, дБ":>30}{"центр, Гц":>16}   смуги 63..8k (Пердун − справжній)')
    errs = []
    for p in ('холостий', 'розгін', 'рівно', 'скидання'):
        r, v = res['справжній'][p], res['Пердун'][p]
        if r is None or v is None:
            print(f'{p:<10} мало даних'); continue
        lr, lv = db(r[0] / res['справжній']['_all']), db(v[0] / res['Пердун']['_all'])
        diff = [b - a for a, b in zip(r[2], v[2])]
        errs += [abs(lv - lr)] + [abs(d) for d in diff[1:7]]
        print(f'{p:<10}{lr:>10.1f} | {lv:>5.1f} ({lv - lr:+.1f}){r[1]:>11.0f} | {v[1]:>5.0f}   ' + ' '.join(f'{d:+.0f}' for d in diff))
        print(f'{"":<10}{"":>30}{"":>16}   справжній: ' + ' '.join(f'{d:+.0f}' for d in r[2]))
    for tag in ('справжній', 'Пердун'):
        pp = res[tag]['_pops']
        print(f'постріли, {tag}: ' + ('немає' if pp is None else
              f'{pp[0]} шт, центр {pp[1]:.0f} Гц, площинність {pp[2]:.2f}, смуги ' + ' '.join(f'{v:+.0f}' for v in pp[4])))
    print(f'середня розбіжність: {np.mean(errs):.1f} дБ')


ORDERS = [o / 2 for o in range(1, 33)]          # 0.5 … 16.0


def order_profile(x, sr, t, rpm, conf, ph=None, phase=None):
    """Рівень кожного порядку (дБ відносно порядку 4) за кривою обертів."""
    nfft = 8192
    win = np.hanning(nfft)
    df = sr / nfft
    acc = np.zeros(len(ORDERS)); n = 0
    for i in range(0, len(t), 5):                   # кожні 100 мс
        if rpm[i] < 900 or conf[i] < 1.5 or (phase is not None and ph[i] != phase):
            continue
        c = int(t[i] * sr)
        fr = x[c - nfft // 2:c + nfft // 2]
        if len(fr) != nfft:
            continue
        m = np.abs(np.fft.rfft(fr * win)) ** 2
        for k, o in enumerate(ORDERS):
            b = int(round(rpm[i] / 60 * o / df))
            if 1 <= b < len(m) - 1:
                acc[k] += m[b - 1:b + 2].max()
        n += 1
    if n == 0:
        return None
    acc /= n
    ref = acc[ORDERS.index(4.0)]
    return [10 * np.log10(v / ref + 1e-12) for v in acc], n


def cmd_orders(ref, per):
    tr = json.load(open(os.path.join(OUT, 'real.track.json'), encoding='utf-8'))
    t = np.array(tr['t']); r = np.array(tr['rpm']); cf = np.array(tr['conf']); ph = np.array(tr['phase'])
    sr1, x1, _ = load(ref); x1 = x1[int(tr['from'] * sr1):]
    sr2, x2, _ = load(per)
    for phase in (None, 'розгін', 'скидання'):
        a = order_profile(x1, sr1, t, r, cf, ph, phase)
        b = order_profile(x2, sr2, t, r, cf, ph, phase)
        if not a or not b:
            continue
        print(f'\n== {"усі фази" if phase is None else phase} (кадрів {a[1]}) — дБ відносно порядку 4 ==')
        print('порядок   ' + ' '.join(f'{o:>5g}' for o in ORDERS))
        print('справжній ' + ' '.join(f'{v:>5.0f}' for v in a[0]))
        print('Пердун    ' + ' '.join(f'{v:>5.0f}' for v in b[0]))
        print('різниця   ' + ' '.join(f'{q - p:>+5.0f}' for p, q in zip(a[0], b[0])))


if __name__ == '__main__':
    if sys.argv[1] == 'orders':
        cmd_orders(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == 'track':
        cmd_track(sys.argv[2], int(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]))
    else:
        cmd_compare(sys.argv[2], sys.argv[3])
