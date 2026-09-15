# Subtitulado local de una película en español

Transcripción completa —de un MP3 de 90 min a transcript y subtítulos— ejecutada 100 % en local, sin servicios en la nube, en un Mac Apple Silicon. Genera 4 entregables listos para usar (`out/`) y remite a [NOTAS.md](NOTAS.md) para el detalle técnico, la comparativa de motores y todas las mediciones.

## Resultado

Los 4 entregables finales, en `out/`:

| Archivo | Qué es | Para qué sirve |
|---|---|---|
| `out/TRANSCRIPT.srt` | Subtítulos SRT (380 segmentos, copia de `pelicula_fw_clean.srt`) | Reproductores de vídeo (VLC, IINA, QuickTime), editores de subtítulos |
| `out/TRANSCRIPT.vtt` | WebVTT del mismo contenido (cabecera `WEBVTT`, timestamps con punto) | Reproductores web HTML5 (`<track>`) |
| `out/TRANSCRIPT.txt` | Transcript plano, una línea por segmento (380 líneas / 1938 palabras) | Búsqueda, grep, procesado posterior |
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

# 1) transcripción con VAD (motor ganador)
.venv-fw/bin/python fw_transcribe.py "0708.MP3.mpeg" out/pelicula_fw

# nota: srt_tools.py y todos los pasos siguientes usan el python3 del sistema (stdlib pura)

# 2) limpieza y entregables finales
python3 srt_tools.py clean out/pelicula_fw.srt out/pelicula_fw_clean.srt
python3 srt_tools.py emit out/pelicula_fw_clean.srt out/TRANSCRIPT
cp out/pelicula_fw_clean.srt out/TRANSCRIPT.srt
```

Para estadísticas y comparación entre SRTs: `python3 srt_tools.py stats <srt>`, `python3 srt_tools.py compare <a.srt> <b.srt>`.

## Herramientas del repo

### `fw_transcribe.py` — transcripción

Uso: `fw_transcribe.py <audio_input> <output_prefix>`. Ejecuta faster-whisper `large-v3` en CPU `int8` con filtro VAD (`language="es"`, `min_silence_duration_ms=500`, `condition_on_previous_text=False`, `beam_size=5`) y escribe `<prefix>.txt`, `<prefix>.srt` y `<prefix>.vtt`. Al terminar imprime `segments`, `duration` y `compute`.

Se invoca con el Python del venv (faster-whisper no está en el sistema): `.venv-fw/bin/python fw_transcribe.py …`.

### `srt_tools.py` — post-proceso (stdlib pura, con `python3` del sistema)

- **`clean <entrada.srt> <salida.srt>`** — limpia alucinaciones y ventanas degeneradas:
  ```bash
  python3 srt_tools.py clean out/pelicula_fw.srt out/pelicula_fw_clean.srt
  ```
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
  python3 srt_tools.py emit out/pelicula_fw_clean.srt out/TRANSCRIPT
  ```

Las reglas exactas del limpiador (densidad, lista negra, bucles, rachas) están en [NOTAS.md](NOTAS.md).

## Cómo se eligió el motor

Se midieron dos motores locales sobre el mismo audio ([comparativa completa en NOTAS.md](NOTAS.md)):

| | mlx-whisper `large-v3-turbo` | faster-whisper `large-v3` + VAD |
|---|---|---|
| Cómputo | 71.3 s (76× tiempo real) | 535.7 s (10× tiempo real) |
| Alucinaciones "¡Suscríbete al canal!" | ×20 | **0** |
| Precisión (mismo pasaje) | "te DECÍA venir volando" | "te HICE venir volando" |
| Tras `clean` | 539 seg / 2335 palabras | 380 seg / 1938 palabras |

mlx-whisper es ~7× más rápido, pero se descartó por calidad: fabrica 20 alucinaciones del tipo "¡Suscríbete al canal!" (faster-whisper: 0), genera 47 ventanas degeneradas ≥ 25 s frente a 26, y su transcripción de diálogo es menos fiel. Gana **faster-whisper + VAD**.

## Limitaciones

- **Quechua no soportado**: Whisper no soporta quechua (no está en sus 99 idiomas); los pasajes cantados/hablados quedan transliterados a español inventado, sin valor semántico garantizado.
- **Poca voz**: solo ~20–25 min de los 90 tienen diálogo; el resto es música/ambiente. No es un fallo del motor: la película es así.
- **Segmentos no captados por fw**: 43 segmentos / 206 palabras que mlx captó y faster-whisper no (informe en `out/gap_report.txt`); no se fusionó mlx para no inyectar sus alucinaciones.
- **Ventanas largas**: fw generó 26 ventanas ≥ 25 s; el limpiador descarta 7 por baja densidad y recorta 31 ventanas infladas, dejando 4 multi-palabra legítimas.

Detalle y verificación uno a uno: [NOTAS.md](NOTAS.md).

## Nota sobre el audio fuente

`0708.MP3.mpeg` **no está en el repositorio** por tamaño (124 MB): MP3, 192 kbps, 44.1 kHz, estéreo, 90 min 34 s (5434.54 s). Colócalo en la raíz del proyecto con ese nombre exacto antes de reproducir.
