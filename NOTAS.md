# NOTAS — Subtitulado local de una película en español (0708.MP3.mpeg)

Fecha: 2026-09-15 · macOS 26.6.2 · Apple M2 Max (32 GB) · Working dir: `/Users/adrian/Workspace/Subtitulado`

## Fuente

- Archivo: `0708.MP3.mpeg` (extensión rara, contenido MP3 detectado por ffmpeg)
- Duración: 5434.54 s (**90 min 34 s**) · mp3 · 192 kbps · 44.1 kHz · estéreo
- La película habla poco: **~20–25 min de voz real sobre 90**, el resto es música/ambiente
  (verificado con `ffmpeg -af volumedetect`: tramos sin diálogo a mean ≈ −30 dB, picos musicales a −5/−6 dB).
  Contiene pasajes cantados/hablados en **quechua** (ver Limitaciones).

## Pipeline ganador (el que generó los entregables)

faster-whisper **1.2.1** / ctranslate2 **4.8.2**, modelo `large-v3`, CPU `int8`, con VAD:

```
WhisperModel("large-v3", device="cpu", compute_type="int8")
model.transcribe(audio, language="es", vad_filter=True,
                 vad_parameters=dict(min_silence_duration_ms=500),
                 condition_on_previous_text=False, beam_size=5)
```

- Script: `fw_transcribe.py`
- Cómputo: **535.7 s** (≈ 10× tiempo real)
- Salida bruta: 389 segmentos → tras limpiar: **380 segmentos**

## Post-proceso (`srt_tools.py clean`, stdlib pura)

Reglas: ventanas ≥ 10 s con ≤ 6 palabras se deciden por **densidad**
(< 0.05 palabras/s → alucinación/basura sobre música → descartada;
≥ 0.05 → diálogo real en ventana inflada → se conserva y se recorta su
`end` a `start + palabras/2.5 + 1.5 s`); lista negra de alucinaciones
(coincidencia exacta tras normalizar: "suscribete al canal", "suscribete",
"gracias por ver", "subtitulos por", "subtitulado por", "amara org"; y por
contención: "www" y ".com"); colapsa bucles internos (palabra/frase repetida
>3 veces consecutivas); colapsa rachas (≥3 segmentos consecutivos idénticos →
primero con `end` extendido); renumera. Ojo: "La Biblia" **no** está en la
lista negra — las 9 ventanas de "La Biblia" se eliminan por la regla de
duración (30 s con 2 palabras), no por la lista. La repetición del texto
NO descarta por sí sola: los motivos reales de la película se repiten
("Ellos mataron a mi Carmelo." en la escena inicial y a 01:14).

- fw: 389 → **380** segmentos (7 de baja densidad fuera + 31 ventanas infladas recortadas)
- Subcomandos: `clean`, `stats`, `compare`, `emit`

## Entregables finales

| Archivo | Contenido |
|---|---|
| `out/TRANSCRIPT.srt` | subtítulos SRT (copia de `pelicula_fw_clean.srt`) |
| `out/TRANSCRIPT.vtt` | WebVTT (cabecera `WEBVTT`, timestamps con punto) |
| `out/TRANSCRIPT.txt` | transcript, una línea por segmento (380 líneas / 1938 palabras) |
| `out/TRANSCRIPT_legible.txt` | transcript por bloques de 5 min con párrafos |

## Comparativa de motores (números medidos, no estimados)

| | mlx-whisper `large-v3-turbo` | faster-whisper `large-v3` + VAD |
|---|---|---|
| Cómputo total | 71.3 s (**76×** tiempo real) | 535.7 s (**10×**) |
| Segmentos brutos | 679 | 389 |
| Palabras brutas | 2727 | 1967 |
| Ventanas degeneradas ≥25 s | 47 (44 de exactamente 30.000 s) | 26 (la peor: 263 s con "Buenas tardes.") |
| Alucinación tipo "¡Suscríbete al canal!" | **×20** (más "La Biblia" ×9, bucle "TORRES DE LA" ×112 palabras, racha "¡Ah!" ×28) | **0** |
| Precisión (mismo pasaje) | "te DECÍA venir volando", "me EMPEZABA a perder" | **"te HICE venir volando", "me HE EMPEZADO a perder"** |
| Tras `clean` | 539 seg / 2335 palabras / 27.6% cubierta | 380 seg / 1938 palabras / 24.0% cubierta |
| Densidad de diálogo real (<5 s) | 2.16 palabras/s | **2.53 palabras/s** |
| Detección de idioma | — | VAD deja vacíos los tramos de música (verificado en 2 tramos donde mlx alucinaba) |

**Veredicto: gana faster-whisper+VAD.** Sin fusión con mlx: ver limitación (c).

## Limitaciones conocidas (sin adornos)

**(a) Pasajes en quechua transliterados a español inventado.** Whisper no soporta
quechua (no está en sus 99 idiomas); forzando `--language es` los translitera fonéticamente.
En `out/TRANSCRIPT.srt` ocurre en:

```
01:13:25,450 → 01:13:29,110   ¡Taita! ¡Extraña a mi papá!
01:13:32,660 → 01:13:37,800   ¡Alim ya cancán! ¡Taita y que jamamos cachonque!
01:13:42,860 → 01:13:45,160   Una guagua siempre tiene que estar al lado de su madre.
01:18:48,130 → 01:18:50,210   Aquí te traigo unos regalitos, Taita.
01:27:24,370 → 01:27:27,310   Pucuna, ajo, yoy, kitan, chas, kichon.
01:28:07,980 → 01:28:13,730   ¡Nyoka, wagame, kutsuka, katsun! ¡Kutsuka, katsun!
```

Verificación por autodetección (sin `--language`): el cántico final (01:27:20–01:28:15)
lo clasifica como **"Tagalog"** (idioma fonéticamente más cercano disponible) y produce
una sopa fonética; el control español (00:02:48–00:03:10) detecta **"es"** con texto
correcto, lo que valida el método. El bloque 01:10:30–01:12:00 se autodetecta "es"
(los primeros 30 s son diálogo español) y el cántico degenera en un bucle "¡Vamos allá!" ×17.
Estos pasajes quedan transliterados, **no traducidos**: cualquier texto quechua del
deliverable es fonética aproximada, sin valor semántico garantizado.

**(b) Poca voz.** Solo ~20–25 min de los 90 tienen diálogo (mean ≈ −30 dB en el resto).
No es un fallo del motor: la película es así.

**(c) 43 segmentos / 206 palabras que mlx captó y fw no** (sin ningún solape temporal
de fw; informe completo en `out/gap_report.txt`, regenerado tras la corrección del
limpiador). Los 3 huecos más largos verificados uno a uno sobre el audio:
1 murmullo real tenue (`Anda, fuma tranquilo.`, −31 dB), 1 grito ilegible sobre
música (dos lecturas de mlx contradictorias), y 1 alucinación de mlx (`"..."` al
transcribir el clip aislado). No se fusionó mlx en el entregable para no inyectar
alucinaciones. En sentido inverso fw aporta 19 segmentos / 89 palabras sin solape
de mlx (tras el recorte de ventanas infladas).

**(d) fw generó 26 ventanas largas propias** (≥ 25 s, la peor de 263 s con solo
"Buenas tardes."). El limpiador corregido descarta las de baja densidad
(7 en total, incluida la de 263 s) y recorta las 31 ventanas infladas con
diálogo real; quedan 4 ≥ 25 s, todas multi-palabra (diálogos largos legítimos).
El audio subyacente en las descartadas es música, verificado con volumedetect.

## Cómo reproducir

```bash
# dependencias
brew install ffmpeg
uv tool install mlx-whisper          # binario mlx_whisper en ~/.local/bin (motor descartado y verificaciones)

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

# motor descartado (referencia):
time mlx_whisper "0708.MP3.mpeg" --model mlx-community/whisper-large-v3-turbo \
  --language es --condition-on-previous-text False --output-dir out \
  --output-name pelicula --output-format all --verbose False
```

Estadísticas y comparación entre motores: `python3 srt_tools.py stats <srt>`,
`python3 srt_tools.py compare <a.srt> <b.srt>`.
