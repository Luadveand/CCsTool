# Subtitulado local de una película en español

Transcripción completa —de un MP3 de 90 min a transcript y subtítulos— ejecutada 100 % en local, sin servicios en la nube, en un Mac Apple Silicon. Genera 4 entregables listos para usar (`out/`) y remite a [NOTAS.md](NOTAS.md) para el detalle técnico, la comparativa de motores y todas las mediciones.

## Resultado

Los 4 entregables finales, en `out/`:

| Archivo | Qué es | Para qué sirve |
|---|---|---|
| `out/TRANSCRIPT.srt` | Subtítulos SRT resincronizados desde timestamps por palabra (297 subtítulos / 1851 palabras) | Reproductores de vídeo (VLC, IINA, QuickTime), editores de subtítulos |
| `out/TRANSCRIPT.vtt` | WebVTT del mismo contenido (cabecera `WEBVTT`, timestamps con punto) | Reproductores web HTML5 (`<track>`) |
| `out/TRANSCRIPT.txt` | Transcript plano, una línea por subtítulo (297 líneas / 1851 palabras) | Búsqueda, grep, procesado posterior |
| `out/TRANSCRIPT_legible.txt` | Transcript organizado por bloques de 5 min con párrafos | Lectura humana, revisión de la película |

## Requisitos

- macOS en Apple Silicon (producido y verificado en macOS 26.6.2, Apple M2 Max, 32 GB)
- `ffmpeg` (`brew install ffmpeg`)
- [`uv`](https://docs.astral.sh/uv/) (gestiona el venv de faster-whisper)
- Python 3.12 (para el venv `.venv-fw`); para `srt_tools.py` basta el `python3` del sistema — es stdlib pura
- Versiones usadas: **faster-whisper 1.2.1**, **ctranslate2 4.8.2**, modelo `large-v3`, CPU `int8`

## Uso rápido

```bash
# dependencias
brew install ffmpeg

# faster-whisper vive en un venv aislado, NO en el python3 del sistema:
uv venv .venv-fw --python 3.12
uv pip install --python .venv-fw/bin/python faster-whisper   # fw 1.2.1 / ctranslate2 4.8.2

# 1) transcripción con VAD y timestamps por palabra (genera words.json)
.venv-fw/bin/python fw_transcribe.py "0708.MP3.mpeg" out/pelicula_w

# nota: srt_tools.py y todos los pasos siguientes usan el python3 del sistema (stdlib pura)

# 2) resincronizado desde los timestamps de palabra (con informe a out/resync_report.txt)
python3 srt_tools.py resync out/pelicula_w_words.json out/pelicula_w_resync.srt --report out/resync_report.txt

# 3) entregables finales
python3 srt_tools.py emit out/pelicula_w_resync.srt out/TRANSCRIPT
cp out/pelicula_w_resync.srt out/TRANSCRIPT.srt
```

Para estadísticas y comparación entre SRTs: `python3 srt_tools.py stats <srt>`, `python3 srt_tools.py compare <a.srt> <b.srt>`.

## Herramientas del repo

### `fw_transcribe.py` — transcripción

Uso: `fw_transcribe.py <audio_input> <output_prefix>`. Ejecuta faster-whisper `large-v3` en CPU `int8` con filtro VAD (`language="es"`, `min_silence_duration_ms=500`, `condition_on_previous_text=False`, `beam_size=5`, `word_timestamps=True`) y escribe `<prefix>.txt`, `<prefix>.srt`, `<prefix>.vtt` y **`<prefix>_words.json`** (timestamp y probabilidad por palabra + confianza por segmento; es la entrada del `resync`). Al terminar imprime `segments`, `duration` y `compute`.

Se invoca con el Python del venv (faster-whisper no está en el sistema): `.venv-fw/bin/python fw_transcribe.py …`.

### `srt_tools.py` — post-proceso (stdlib pura, con `python3` del sistema)

- **`resync <words.json> <salida.srt>`** — reconstruye el SRT desde cero a partir de los timestamps por palabra (nada de duraciones inventadas). Subtítulos de hasta 2 líneas × 42 caracteres, cortes en puntuación fuerte, duración mínima 1 s, máxima 6 s, control de 21 cps, fusión sintáctica (`--merge-gap 3.0`). Las palabras con timestamp interpolado se RECOLOCAN fusionándolas con su frase (sin aportar el timestamp corrupto); el único descarte es confianza < 0.6. Genera `out/resync_report.txt` con recolocados, fusiones, descartados y aislados conservados:
  ```bash
  python3 srt_tools.py resync out/pelicula_w_words.json out/pelicula_w_resync.srt --report out/resync_report.txt
  ```
- **`clean <entrada.srt> <salida.srt>`** — limpiador clásico de SRTs brutos (alucinaciones, bucles, rachas); el pipeline actual usa `resync` sobre `words.json` en su lugar.
- **`stats <archivo.srt> [--total N]`** — imprime una línea TSV con 8 columnas (la cabecera va por stderr):
  `segmentos` · `palabras` · `duracion_cubierta_s` · `pct_cobertura` · `n_seg>=25s` · `n_seg>=10s<=6pal` · `wps_seg<5s` · `max_racha_identica`
  ```bash
  python3 srt_tools.py stats out/TRANSCRIPT.srt
  ```
- **`compare <a.srt> <b.srt> [--bucket 300]`** — tabla por tramos de tiempo: palabras y segundos cubiertos de A vs B (columnas `inicio`, `pal_A`, `pal_B`, `delta(A-B)`, `cub_A`, `cub_B`, más fila `TOTAL`):
  ```bash
  python3 srt_tools.py compare out/pelicula_fw.srt out/pelicula_clean.srt
  ```
- **`emit <entrada.srt> <prefijo_salida>`** — genera `<prefijo>.txt`, `<prefijo>.vtt` y `<prefijo>_legible.txt` desde un SRT:
  ```bash
  python3 srt_tools.py emit out/pelicula_w_resync.srt out/TRANSCRIPT
  ```

### `review/serve.py` — servidor estático con HTTP Range (stdlib pura, con `python3` del sistema)

Servidor de la interfaz de revisión: sirve `review/` respondiendo `206 Partial Content` a cabeceras `Range` (seek de audio grande; `python3 -m http.server` no lo soporta). Escucha en `--host 127.0.0.1`, `--port 8765`, y sirve el directorio `--directory` (por defecto `review/`):
  ```bash
  python3 review/serve.py
  # abrir http://127.0.0.1:8765
  ```


Las reglas exactas de `resync` y del limpiador están en [NOTAS.md](NOTAS.md).

## Cómo se eligió el motor

Se midieron dos motores locales sobre el mismo audio ([comparativa completa en NOTAS.md](NOTAS.md)):

| | mlx-whisper `large-v3-turbo` | faster-whisper `large-v3` + VAD |
|---|---|---|
| Cómputo | 71.3 s (76× tiempo real) | 543.6 s (10× tiempo real) |
| Alucinaciones "¡Suscríbete al canal!" | ×20 | **0** |
| Precisión (mismo pasaje) | "te DECÍA venir volando" | "te HICE venir volando" |
| Entregable final | 539 seg / 2335 palabras | 297 subtítulos / 1851 palabras (resincronizados) |

mlx-whisper es ~7× más rápido, pero se descartó por calidad: fabrica 20 alucinaciones del tipo "¡Suscríbete al canal!" (faster-whisper: 0), genera 47 ventanas degeneradas ≥ 25 s frente a 26, y su transcripción de diálogo es menos fiel. Gana **faster-whisper + VAD**.


## Limitaciones

- **Quechua no soportado**: Whisper no soporta quechua (no está en sus 99 idiomas); los pasajes cantados/hablados quedan transliterados a español inventado, sin valor semántico garantizado. La pasada con `word_timestamps` ni siquiera transcribe el cántico final (01:27:20-01:28:15).
- **Poca voz**: solo ~20–25 min de los 90 tienen diálogo; el resto es música/ambiente. No es un fallo del motor: la película es así.
- **Coste de contenido aceptado a cambio del sincronismo** (frente al TRANSCRIPT anterior): −87 palabras (−4.5 %). ~28 son el cántico quechua no transcrito por la pasada nueva y ~15-25 son español real en tramos de audio turbio (la riña de 01:10 y ~12 líneas sueltas); el resto son artefactos de comparación (dígitos vs palabras, variantes de nombres propios). Se aceptó explícitamente ese intercambio: el desfase era la queja principal, y no se fusionó con el TRANSCRIPT viejo para no reintroducir alucinaciones. La recolocación de palabras interpoladas recuperó 24 palabras que la primera versión del resync mutilaba.

## Revisión humana

`review/` contiene una interfaz local para **revisar los subtítulos escuchando el audio**: colorea
cada palabra según la confianza del transcriptor, sigue la reproducción en vivo, permite corregir
texto y tiempos, insertar y borrar subtítulos, y exportar el SRT definitivo. Además del texto, cada
subtítulo tiene edición de inicio/fin (escritura directa, ajuste fino de ±100 ms y marcado con el
cursor del audio: «Inicio aquí»/«Fin aquí», atajos `I`/`O`), los borrados son restaurables, y la
interfaz marca los problemas de tiempo (solapes, duración fuera de 1-6 s, >21 cps). Los tramos a
mirar están marcados en `out/resync_report.txt` (descartados, aislados conservados, palabras con
confianza < 0.6). No abras `review/index.html` directamente (sin servidor falla el `fetch` de
`words.json` y no hay HTTP Range para el seek del audio); arranca `review/serve.py`:

```bash
ffmpeg -i "0708.MP3.mpeg" -c:a copy review/audio.mp3   # derivado no versionado, si no existe
cp out/pelicula_w_words.json review/words.json         # derivado no versionado, si no existe
python3 review/serve.py
# abrir http://127.0.0.1:8765
```

Detalles en [`review/README.md`](review/README.md).

Detalle y verificación uno a uno: [NOTAS.md](NOTAS.md).

## Nota sobre el audio fuente

`0708.MP3.mpeg` **no está en el repositorio** por tamaño (124 MB): MP3, 192 kbps, 44.1 kHz, estéreo, 90 min 34 s (5434.54 s). Colócalo en la raíz del proyecto con ese nombre exacto antes de reproducir.
