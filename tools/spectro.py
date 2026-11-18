"""Спектрограма 0..fmax Гц у PNG з накладеною кривою обертів (без matplotlib).

  python -X utf8 tools/spectro.py <wav> <t_from> <t_to> <out.png> [ncyl] [fmax]
Лінії: червона — частота спалахів за real.track.json, жовта — вдвічі вища (перевірка октави).
"""
import json
import os
import struct
import sys
import zlib

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import load, stft_mag  # noqa: E402


def png(path, rgb):
    h, w, _ = rgb.shape
    raw = b''.join(b'\x00' + rgb[y].tobytes() for y in range(h))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


wav, a, b, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
ncyl = int(sys.argv[5]) if len(sys.argv) > 5 else 8
fmax = float(sys.argv[6]) if len(sys.argv) > 6 else 700
sr, x, _ = load(wav)
seg = x[int(a * sr):int(b * sr)]
mag, t = stft_mag(seg, sr, 8192, sr // 10)
f = np.fft.rfftfreq(8192, 1 / sr)
m = f <= fmax
S = 20 * np.log10(mag[:, m] + 1e-7)
S = np.clip((S - (S.max() - 60)) / 60, 0, 1)            # 60 дБ динаміки
img = (S.T[::-1] * 255).astype(np.uint8)                # рядки — частота (вгорі fmax)
H = 2                                                    # масштаб по вертикалі
img = np.repeat(img, H, axis=0)
rgb = np.stack([img, img, img], axis=-1)
tr_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'real.track.json')
if os.path.exists(tr_path):
    tr = json.load(open(tr_path, encoding='utf-8'))
    tt, rr = np.array(tr['t']), np.array(tr['rpm'])
    nf = m.sum()
    for i, ti in enumerate(t):
        r = np.interp(ti, tt, rr)
        for mult, col in ((1, (255, 40, 40)), (2, (255, 220, 0))):
            fr = r * ncyl / 120 * mult
            row = int((1 - fr / fmax) * nf * H)
            if 0 <= row < rgb.shape[0]:
                rgb[max(0, row - 1):row + 1, i] = col
png(out, rgb)
print(out, rgb.shape)
