# NOTAS — Subtitulado local de una película en español (0708.MP3.mpeg)

Fecha: 2026-09-15 · macOS 26.6.2 · Apple M2 Max (32 GB) · Working dir: `/Users/adrian/Workspace/Subtitulado`

## Fuente

- Archivo: `0708.MP3.mpeg` (extensión rara, contenido MP3 detectado por ffmpeg)
- Duración: 5434.54 s (**90 min 34 s**) · mp3 · 192 kbps · 44.1 kHz · estéreo
- La película habla poco: **~20–25 min de voz real sobre 90**, el resto es música/ambiente
  (verificado con `ffmpeg -af volumedetect`: tramos sin diálogo a mean ≈ −30 dB, picos musicales a −5/−6 dB).
  Contiene pasajes cantados/hablados en **quechua** (ver Limitaciones).

## Pipeline actual (el que generó los entregables)

faster-whisper **1.2.1** / ctranslate2 **4.8.2**, modelo `large-v3`, CPU `int8`, con VAD y
**timestamps por palabra**:

```
WhisperModel("large-v3", device="cpu", compute_type="int8")
model.transcribe(audio, language="es", vad_filter=True,
                 vad_parameters=dict(min_silence_duration_ms=500),
                 condition_on_previous_text=False, beam_size=5,
                 word_timestamps=True)
```

- Script: `fw_transcribe.py <audio> <prefijo>`
- Cómputo: **543.6 s** (≈ 10× tiempo real; `word_timestamps` apenas añade coste porque el VAD
  deja vacío ~70 % de la película)
- Salida bruta: **319 segmentos**
- Escribe `.txt`, `.srt`, `.vtt` y **`<prefijo>_words.json`** con, por cada segmento:
  `id`, `start`, `end`, `text`, `avg_logprob`, `no_speech_prob`, `compression_ratio` y la lista
  de palabras `{"w", "s", "e", "p"}` (timestamp y probabilidad por palabra); `duration` real con
  ffprobe. Ese JSON es la entrada del resincronizado.

## RESINCRONIZADO (`srt_tools.py resync`) — por qué hacía falta

Dos causas del desfase del entregable anterior:

1. **Los timestamps de segmento de faster-whisper son groseros** y con `vad_filter` los
   segmentos se estiran sobre silencios: la peor ventana del run nuevo cubre **384.6 s**
   (seg 112, 00:20:00→00:26:25) y en el run viejo llegó a 263 s. Las palabras dentro de una
   ventana estirada quedan interpoladas a lo largo del silencio.
2. **El limpiador viejo INVENTABA duraciones**: cuando un segmento era largo con pocas
   palabras, recortaba su `end` con la fórmula `start + palabras/2.5 + 1.5`. Es una duración
   sintética, no medida — 31 segmentos del entregable anterior llevaban ese `end` inventado.
   La fórmula está **eliminada** de `clean`.

**Prueba del desfase** (ejemplo concreto): *"Ellos mataron a mi Carmelo."* estaba en el viejo
`TRANSCRIPT.srt` en **00:00:09,520**, mientras el habla real —según los timestamps de palabra—
empieza en **67.57 s** ("mataron"): casi un minuto de adelanto. La palabra "Ellos" (28.63 s)
está interpolada a 38.40 s del resto de su frase.

### Reglas de `resync` (subcomando: `resync <words.json> <salida.srt>`)

- **Dos líneas por subtítulo**: `--max-chars 42` es el máximo POR LÍNEA (capacidad ≈ 84).
  El corte entre líneas se hace en el punto más equilibrado que NO rompa sintagma:
  se prefiere tras coma, antes de conjunción/preposición, y nunca entre artículo y sustantivo.
- **Cortes preferentes**: se corta en puntuación fuerte (`. ? ! …`) siempre que el grupo dure
  ≥ `--min-dur`; si aún no llega, el corte queda pendiente y se ejecuta en cuanto la duración
  lo permite. En coma solo se corta si la velocidad de lectura se dispara (> 21 cps).
- `--max-gap 1.2` s entre palabras. `--max-dur 6.0` s por subtítulo.
- `--min-dur 1.0` s: los grupos más cortos se fusionan con el vecino de hueco menor (si caben
  en 2 líneas y en `max-dur`); si no hay fusión posible, se extiende el `end` a
  `start + min-dur` SIN invadir el `start` del siguiente (nunca se inventan solapes).
- **Fusión sintáctica** iterativa (`--merge-gap 3.0`): dos grupos consecutivos se funden si el
  primero no cierra frase (sin `.?!…:` ni coma), el segundo empieza en minúscula, el hueco es
  < 3.0 s y la unión cabe en 2 líneas y en 6 s. Reparó p. ej. "No he" / "venido a que me des
  tus consejos" (hueco de 1.92 s entre palabras era ruido de timestamp, no pausa real).
- Tokens pegados al anterior no llevan espacio (`-50`, `%`, `'`, `)` …; y nada tras `¿ ¡ (`).

### Reglas de descarte y recolocación (con justificación empírica)

El principio es **NUNCA descartar texto de alta confianza por aislamiento temporal** — esta
película tiene ~65 min de silencio/música, así que una línea corta rodeada de pausas largas es
lo NORMAL. Los 65 grupos aislados (p. ej. "Mamá," / "¿cómo estás?" separados por una pausa de
6.7 s) se EMITEN como subtítulos normales y se listan como `aislados_conservados` en el informe
para revisión humana. La única regla de DESCARTE es:

1. **`conf_baja`**: confianza media del grupo < 0.6 (p. ej. "Te" conf=0.16, "Vamos" conf=0.25).

**`interpolacion_intra_segmento` → RECOLOCACIÓN, no descarte.** Una palabra separada del RESTO
DE PALABRAS DE SU PROPIO SEGMENTO DE ORIGEN por más de **10.0 s** tiene el timestamp interpolado
por Whisper sobre silencio — corrupto — pero el TEXTO es bueno. La primera versión de esta regla
DESCARTABA esas palabras y mutilaba diálogo real: la línea 2 del transcript quedó como
"mataron a mi Carmelo." (sin "Ellos") y la línea 19 como "tardes, señor Aníbal." (sin "Buenas",
conf 1.00). Corregido: la palabra se FUSIONA con el grupo que contiene el resto de las palabras
de su mismo segmento — delante si precede al grupo ("Ellos", "Buenas"), detrás si va después
("noches", "Ophelia.") — y NO aporta su timestamp corrupto: los límites del resultado son los
de las palabras bien medidas. Si la fusión no cabiera en 2 líneas de 42 o en `max-dur`, se
divide en dos subtítulos consecutivos usando SIEMPRE el rango temporal del grupo real.
El umbral 10.0 s **se calibró midiendo la distribución real** de huecos intra-segmento: las
pausas dramáticas reales quedan ≤ 9.7 s ("Mamá," con 7.20 s, "mío"/"Dios" con 7.75 s,
"cigarrito" con 8.07 s) y los artefactos empiezan en 10.46 s ("Ellos" con 38.40 s,
"Buenas noches" con 142 s, "No" con 155 s). El informe lista cada recolocación con su
timestamp corrupto original, el asignado, la palabra y el subtítulo resultante completo.

Además, `emit` escribe el `.txt` con UNA línea por subtítulo (las 2 líneas del SRT se unen con
espacio): el contrato documentado es "una línea por segmento".

Informe: `out/resync_report.txt` — total, duración media, distribución, cps>21, lista de
`recolocados`, lista de `fusiones_sintacticas`, lista de `descartados` (solo conf_baja) y lista
de `aislados_conservados`.

## Números finales (entregable actual)

| Métrica | Valor |
|---|---|
| Subtítulos | **297** |
| Palabras | **1851** |
| Duración media | **2.51 s** (2.37-2.51 según iteración del agrupador) |
| Subs < 1 s / > 6 s | **0 / 0** |
| Solapes | **0** |
| Líneas > 42 caracteres / subs > 2 líneas | **0 / 0** |
| Palabras recolocadas (interpoladas) | 24 |
| Descartados (conf_baja) | 4 |
| Aislados conservados | 65 |
| Fusiones sintácticas | 11 |

## Comparativa de motores (números medidos, histórico — decisión de motor)

| | mlx-whisper `large-v3-turbo` | faster-whisper `large-v3` + VAD |
|---|---|---|
| Cómputo total | 71.3 s (**76×** tiempo real) | 543.6 s (**10×**) |
| Segmentos brutos | 679 | 319 (con word_timestamps; 389 sin) |
| Alucinación tipo "¡Suscríbete al canal!" | ×20 (más "La Biblia" ×9, bucle "TORRES DE LA" ×112) | **0** |
| Precisión (mismo pasaje) | "te DECÍA venir volando" | **"te HICE venir volando"** |
| Densidad de diálogo real (<5 s) | 2.16 palabras/s | 2.58 palabras/s |

**Veredicto: gana faster-whisper+VAD.** Sin fusión con mlx (ver limitación (c)).

## Limitaciones conocidas (sin adornos)

**(a) Pasajes en quechua transliterados a español inventado.** Whisper no soporta quechua
(no está en sus 99 idiomas); forzando `--language es` los translitera fonéticamente. La
pasada nueva (con `word_timestamps`) ni siquiera transcribe el cántico final: el
`words.json` acaba en 01:25:04 y el cántico (01:27:20-01:28:15) no está en el entregable.
En el entregable anterior ocurría en 01:13:25-01:13:45, 01:18:48, 01:27:24-01:28:13
(verificación por autodetección: el cántico lo clasifica como "Tagalog"; el control español
detecta "es" con texto correcto). **Cualquier texto quechua es fonética aproximada, sin valor
semántico garantizado.**

**(b) Poca voz.** Solo ~20-25 min de los 90 tienen diálogo. No es un fallo del motor.

**(c) Huecos frente a mlx.** Informe en `out/gap_report.txt`. No se fusionó mlx en el
entregable para no inyectar alucinaciones.

**(d) pérdida de contenido aceptada (frente al TRANSCRIPT anterior).** El
resincronizado usa una transcripción distinta (319 segmentos con `word_timestamps` vs 389 sin),
y el intercambio se aceptó de forma explícita tras comparar contenido con ventana ±90 s:
**−87 palabras (−4.5 %)** (la recolocación de interpoladas recuperó 24 palabras que la primera
versión perdía; el delta original era −111 / −5.7 %). Desglose: ~28 son el cántico quechua no
transcrito por la pasada nueva; ~15-25 son español real en tramos de audio turbio (la riña de
01:10 —"¿Ella?", "Sí, mamita.", "Ay, cariño, chico.", "¿Qué pasa?"— y ~12 líneas sueltas como
"Dame mi dinero", "Cállate.", "No sabía lo que había adentro"); el resto son artefactos de
comparación (números como dígitos "22" vs "Veintidós", variantes de nombres propios
"Diana"→"Ludiana", "Yanet"→"Janet", "apos"→"sapos", "queco"→"equeco"). **Se aceptó ese coste a
cambio del sincronismo. NO se fusionó con el TRANSCRIPT viejo para no reintroducir las
alucinaciones ya descartadas.** Además una paráfrasis: "me **he empezado** a perder" (viejo,
lectura validada) → "me **empezaba** a perder" (nuevo). Dos líneas reales cayeron por
`conf_baja` ("Angra, suena como una chiscuña." conf=0.38; "Las bolillas siguen girando Y el Es"
conf=0.57) — recuperables subiendo `LOW_CONF` en `srt_tools.py`.

## Interfaz de revisión

`review/` contiene una página local (HTML + JS vanilla, sin build ni dependencias de red) para
**revisar los subtítulos escuchando el audio**: colorea cada palabra según la confianza del
transcriptor, sigue la reproducción en vivo, permite corregir texto y tiempos, insertar y borrar
subtítulos, y exportar el SRT definitivo. Además del texto, cada subtítulo tiene edición de
`start`/`end` (escritura directa en varios formatos y ajuste fino de ±100 ms), los borrados se
marcan (no se destruyen) y son restaurables desde el filtro «Borrados», y la interfaz señala los
problemas de tiempo (solapes,
duración fuera de 1-6 s, >21 cps). Su papel en el pipeline: el humano escucha los tramos marcados
de baja confianza y los aislados conservados (listados en `out/resync_report.txt`), corrige, y
exporta el deliverable final.

**Semántica del offset frente a los tiempos por segmento** (lo único no obvio del diseño): todos
los tiempos se guardan en la línea temporal de los SUBTÍTULOS, sin offset. Los campos de tiempo
editables se escriben en tiempo CON offset (lo que se ve en pantalla) y se guarda SIN él; al
exportar el SRT el offset se vuelve a SUMAR, de modo que el timestamp cae en el instante real del
audio que el usuario tenía delante al escribir. Lo mismo vale para los ajustes de ±100 ms. La
exportación avisa antes de descargar:
subtítulos con `end ≤ start` (el SRT llevaría duración CERO, tal cual — no se inventa una
duración), solapes y vivos con texto vacío (que no se exportarán); cancelar no descarga nada.
Detalles de uso en `review/README.md`.

## Servidor de la interfaz de revisión (HTTP Range)

**Síntoma**: al dar a play, el audio volvía a 0 y la barra de progreso no dejaba adelantar.

**Causa confirmada**: `python3 -m http.server` (SimpleHTTP/0.6, Python 3.13.5) ignora la
cabecera `Range` y responde siempre `200` con el fichero entero
(`Content-Length: 130429639`), sin `Content-Range` ni `Accept-Ranges`. Sin
`206 Partial Content` el navegador no puede hacer seek dentro de un MP3 de 130 MB. Se descartó
la hipótesis alternativa de un reset del frontend: `app.js` no resetea la posición — solo
asigna `currentTime` en `seekTo()`, y `tick()` únicamente lo lee.

**Solución**: `review/serve.py` — servidor estático en stdlib pura sobre `ThreadingHTTPServer`.
Parsea `bytes=N-`, `bytes=N-M` y `bytes=-N`, responde `206` con `Content-Range`, `416` para
rangos insatisfacibles, anuncia `Accept-Ranges: bytes` y transmite en trozos de 64 KB. Escucha
solo en `127.0.0.1` (opción `--host`) para no publicar el audio en la red local.

**Verificación en Chrome real**: `duration = 5434.54`, `seekable.end(0) = 5434.54`; seek a
1800 aterriza en 1800 (no en 0), y play avanza 1800 → 1801.93 en 2 s. Integridad de los rangos
comprobada extrayendo los bytes con `dd` y comparando con `cmp` contra el cuerpo HTTP:
idénticos. Nota: el navegador headless no sirve para verificar esto porque Chrome suspende el
media player en pestañas ocultas (`kSuspended`); hay que usar una ventana visible.

## Cómo reproducir

```bash
# dependencias
brew install ffmpeg
uv tool install mlx-whisper          # binario mlx_whisper en ~/.local/bin (motor descartado, referencias)

# faster-whisper vive en un venv aislado, NO en el python3 del sistema:
uv venv .venv-fw --python 3.12
uv pip install --python .venv-fw/bin/python faster-whisper   # fw 1.2.1 / ctranslate2 4.8.2

# 1) transcripción con VAD y timestamps por palabra (genera words.json)
.venv-fw/bin/python fw_transcribe.py "0708.MP3.mpeg" out/pelicula_w
#    produce out/pelicula_w.{txt,srt,vtt} y out/pelicula_w_words.json

# nota: srt_tools.py y todos los pasos siguientes usan el python3 del sistema (stdlib pura)

# 2) resincronizado desde los timestamps de palabra (con informe a out/resync_report.txt)
python3 srt_tools.py resync out/pelicula_w_words.json out/pelicula_w_resync.srt --report out/resync_report.txt

# 3) entregables finales
python3 srt_tools.py emit out/pelicula_w_resync.srt out/TRANSCRIPT
cp out/pelicula_w_resync.srt out/TRANSCRIPT.srt

# 4) revisión humana con audio (corregir confianza baja y exportar)
ffmpeg -i "0708.MP3.mpeg" -c:a copy review/audio.mp3   # derivado no versionado, si no existe
cp out/pelicula_w_words.json review/words.json         # derivado no versionado, si no existe
python3 review/serve.py                                # http://127.0.0.1:8765

# motor descartado (referencia histórica):
time mlx_whisper "0708.MP3.mpeg" --model mlx-community/whisper-large-v3-turbo \
  --language es --condition-on-previous-text False --output-dir out \
  --output-name pelicula --output-format all --verbose False
```

Estadísticas y comparación: `python3 srt_tools.py stats <srt>`,
`python3 srt_tools.py compare <a.srt> <b.srt>`.
