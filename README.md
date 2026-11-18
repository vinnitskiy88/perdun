# Пердун — звук двигуна для електромобіля

Статичний сайт: синтезує звук ДВЗ у браузері (Web Audio / AudioWorklet) зі швидкості з GPS
або з екранних педалей. Аудіофайлів немає, увесь звук рахується в реальному часі.

## Запуск локально

```powershell
python -m http.server 8765 --directory D:\Claude\engine-sound
```

Відкрити http://localhost:8765. З `file://` не працює: AudioWorklet і GPS вимагають
захищеного контексту (https або localhost).

## У машині

Потрібен будь-який HTTPS-хостинг статики (GitHub Pages, Cloudflare Pages, свій nginx).
Відкрити сайт у браузері авто → «Запустити двигун» → режим «GPS-їзда» → дозволити геолокацію.

## Файли

| Файл | Що робить |
|---|---|
| `js/engine-core.js` | синтезатор: колінвал → спалахи → труба → форманти → глушник |
| `js/engine-worklet.js` | обгортка AudioWorklet |
| `js/vehicle.js` | віртуальна коробка, оберти, навантаження, відсічка, фізика тест-драйву |
| `js/gps.js` | швидкість і прискорення з Geolocation API |
| `js/cars.js` | профілі двигунів (додати машину = додати об'єкт) |
| `js/gauge.js`, `js/app.js` | тахометр і логіка інтерфейсу |
| `test.html` | офлайн-рендер усіх двигунів: перевірка NaN/піків + прослуховування |
| `tools/devserver.py` | dev-сервер (статика + `POST /save` у `tools/out/`), `python tools/devserver.py 8765` |
| `tools/analyze.py` | `track`: крива обертів з еталонів `ref/*.wav` + звірка з логом; `compare`: порівняння фаз |
| `tools/render.html` | рендер Пердуна за кривою обертів еталона → `tools/out/<car>-perdun.wav` |

## Підгонка під еталон

1. `python -X utf8 tools/analyze.py track` — пише `tools/out/<car>.track.json`.
2. Відкрити `http://localhost:8765/tools/render.html` — рендерить і зберігає WAV Пердуна.
3. `python -X utf8 tools/analyze.py compare` — таблиця розбіжностей (рівні фаз, спектр, постріли, запуск).
