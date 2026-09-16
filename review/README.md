# review — interfaz de revisión de subtítulos

Página local (HTML + JS vanilla, sin build y sin dependencias de red) para revisar
los subtítulos escuchando el audio: colorea cada palabra según la confianza del
transcriptor, sigue la reproducción en vivo, permite corregir texto y tiempos, insertar y borrar
subtítulos, y exportar el SRT definitivo (con el desfase global aplicado) y el JSON de correcciones.

## Arrancarlo

```sh
cd /Users/adrian/Workspace/Subtitulado
ffmpeg -i "0708.MP3.mpeg" -c:a copy review/audio.mp3      # copia reproducible por el navegador, sin recodificar
cp out/pelicula_w_words.json review/words.json             # cuando exista
python3 review/serve.py      # (o python3 serve.py desde dentro de review/)
# abrir http://localhost:8765
```

**No uses `python3 -m http.server`**: no implementa HTTP Range, y sin `206 Partial Content` el
navegador no puede hacer seek dentro de un MP3 grande — al dar a play vuelve a 0 y arrastrar la
barra de progreso no funciona. `serve.py` es un servidor estático en stdlib pura con soporte de
Range completo (escucha solo en `127.0.0.1` para no publicar el audio en la red local;
usa `--port` y `--directory` si quieres cambiar los valores por defecto, 8765 y `review/`,
y `--host` si algún día necesitas exponerlo a propósito).

**Importante: `review/audio.mp3` y `review/words.json` NO están en el repositorio.**
Son copias derivadas y están en `.gitignore`, así que hay que generarlas con los dos
primeros comandos antes de arrancar la interfaz:

| fichero | de dónde sale | si falta |
|---|---|---|
| `review/audio.mp3` | `ffmpeg -i "0708.MP3.mpeg" -c:a copy review/audio.mp3` (copia el stream mp3 tal cual, sin recodificar; tarda menos de un segundo) | no se puede escuchar nada: el reproductor queda a `0:00 / 0:00` y aparece un aviso rojo en la cabecera |
| `review/words.json` | `cp out/pelicula_w_words.json review/words.json` (salida del transcriptor con timestamps y confianza por palabra) | la app **cae al `fixture.json`** de prueba y lo avisa en un cartel amarillo: «AVISO: no hay words.json (HTTP 404) — usando el FIXTURE de prueba…, con texto INVENTADO» |

El fallback al fixture está pensado solo para desarrollar sin depender del transcriptor.
Si ves el cartel amarillo, los subtítulos que estás revisando son inventados: copia el
`words.json` real y recarga. También puedes abrir el fichero a mano con el botón
**Cargar words.json…** del panel superior.

## Uso

- **Click en un segmento** → salta a su `start` y reproduce. **Click en una palabra** → salta al `s` de esa palabra.
- **Seguimiento en vivo**: mientras suena el audio, el segmento activo se resalta y la lista hace auto-scroll
  para mantenerlo visible. Si el subtítulo va desfasado, se ve enseguida; si el audio está en un tramo sin
  subtítulo, no se resalta nada (lo cual también es información: hay un hueco).
- **Editar**: el texto de cada segmento es `contenteditable`. Al escribir, el segmento se marca como *revisado*.
  Todo se guarda en `localStorage` (clave `subtitulado-review-v1`) y se restaura al recargar.
- **Editar tiempos**: cada segmento muestra sus timestamps; **click en uno de ellos** lo convierte en
  campo editable (Enter o blur confirma, `Esc` cancela; el valor aparece tal cual, sin seleccionar,
  con el cursor donde hiciste el clic — `Cmd/Ctrl+A` selecciona todo). Acepta `00:01:23,450`,
  `1:23`, `83.5`…
  A cada lado hay botones **−/+ de 100 ms** (visibles al pasar el ratón por el segmento; mantener
  pulsado repite el ajuste) que no mueven el audio. Y al pasar el ratón sobre un timestamp aparece
  bajo él una **perilla de arrastre**: desplaza ese `start` o `end` ±2 s desde el valor que tenía
  al empezar, con paso de 10 ms; el timestamp se actualiza en vivo mientras arrastras, al soltar
  queda donde lo dejaste y la perilla desaparece. Cada arrastre completo cuenta como un solo cambio
  (una sola entrada de deshacer). El botón **↺ revertir tiempos** (aparece solo si
  has tocado los tiempos) devuelve `start`/`end` a los valores del JSON original.
- **Insertar**: **+ Insertar aquí** (barra superior) crea un subtítulo vacío de 2 s en la posición
  actual del audio, colocado en su sitio por orden temporal; se edita texto y tiempos como cualquier
  otro (se exporta como texto plano, sin colores por palabra).
- **Borrar y restaurar**: el botón **borrar** de cada segmento lo saca de la lista, del SRT y del
  conteo (con confirmación), pero no lo destruye: el filtro **Borrados** muestra los subtítulos
  borrados atenuados, cada uno con su botón **Restaurar** que los devuelve a la lista, al SRT y al
  contador de siempre. Tanto el borrado como la restauración persisten al recargar; el badge
  «borrados N» aparece en la barra mientras haya alguno.
- **Integridad temporal**: un segmento se marca como **con problemas de tiempo** si `end ≤ start`,
  solapa con el anterior o el siguiente, dura menos de 1 s o más de 6 s, o su velocidad de lectura
  supera 21 caracteres por segundo. La barra muestra el contador «N con problemas de tiempo» y el
  filtro **Con problemas de tiempo** lista solo esos. Los contadores muestran también
  `revisados N / total M`, `dudosos K`, `visibles V` y `borrados N`.
- **Búsqueda**: el campo «Buscar texto…» filtra por subcadena ignorando mayúsculas y acentos, y se combina
  con el filtro activo (p. ej. «dudosos» + «dinero»). El badge `coinciden N` cuenta los segmentos que
  contienen el texto sin aplicar el filtro. `Enter` salta al primer resultado, `Esc` o `✕` limpian la búsqueda.
- **Exportar**: `TRANSCRIPT_revisado.srt` usa los tiempos EDITADOS, aplica el offset global, excluye
  los borrados, incluye los insertados, ordena por `start` y renumera desde 1. Antes de descargar
  avisa de los problemas detectados — subtítulos con `end ≤ start` (el SRT llevaría duración CERO,
  tal cual: no se inventa una duración), con solape, y vivos con texto vacío (que NO se exportarán).
  Cancelar no descarga nada; aceptar exporta igualmente. `correcciones.json` refleja textos,
  tiempos, insertados y borrados: por segmento `id`, `texto_original`, `texto_nuevo`,
  `start_original`, `start_nuevo`, `end_original`, `end_nuevo`, `insertado`, `borrado` (los tiempos
  van en segundos SIN offset; el SRT es quien lo aplica).
- **Descartar cambios guardados**: borra `localStorage` previa confirmación (también textos, tiempos,
  insertados, borrados y offset).

### Colores de las palabras

Cada palabra es un `<span>` coloreado según su probabilidad `p` (0–1) y muestra su `p` con
2 decimales en el tooltip al pasar el ratón:

| color | rango | significado |
|---|---|---|
| sin fondo (texto normal) | `p >= 0.85` | el transcriptor está seguro |
| fondo ámbar | `0.60 <= p < 0.85` | conviene mirarlo |
| fondo rojo | `p < 0.60` | muy probablemente mal; revísalo escuchando |

Si un segmento tiene alguna palabra en rojo, o `no_speech_prob > 0.5`, cuenta como **dudoso**
y aparece en el filtro «Solo dudosos» con la bandera correspondiente en su cabecera.

### Desfase global (offset)

El control **Offset** (ms, de −5000 a +5000 en pasos de 50) sirve para corregir un desfase
constante entre el audio y los subtítulos:

- **Desplaza el seguimiento en vivo**, así que puedes ajustarlo mientras escuchas: si el
  subtítulo se adelanta a la voz, sube el offset; si se retrasa, bájalo. Cuando el resaltado
  cae justo sobre lo que se oye, ese es el valor correcto.
- **Se aplica a todos los timestamps al exportar** (tanto en la cabecera de cada segmento,
  que muestra ya los tiempos con el offset, como en el SRT descargado).
- `,` y `.` lo mueven de 50 en 50 ms sin soltar el teclado, y **reset** lo devuelve a 0.

### Jog del audio (barra superior)

Junto al reproductor hay un control para moverse por el audio con precisión, porque la barra
nativa del `<audio>` es inútil para ajustar décimas en una película larga:

- **Deslizante de jog**: centrado en 0, de −5 s a +5 s con paso de 0,05 s. Al arrastrar, el audio
  se desplaza ESA cantidad **respecto a la posición que tenía al empezar el arrastre** (comportamiento
  de jog: empujas, escuchas, sueltas); al soltar, el mando vuelve al centro y la posición alcanzada
  se queda fija. Puedes arrastrar varias veces seguidas para acumular.
- **Botones discretos** a cada lado del deslizante: −1 s, −0,5 s, −0,1 s, +0,1 s, +0,5 s y +1 s;
  funcionan con el audio en marcha y en pausa.
- **Lectura de la posición** `HH:MM:SS,mmm` al lado, actualizada en vivo, para saber exactamente
  dónde estás.
- Mueve la reproducción del audio, NO los subtítulos (para eso está la perilla de cada timestamp).

### Atajos de teclado

| tecla | acción |
|---|---|
| `Espacio` | play / pausa |
| `J` | segmento siguiente |
| `K` | segmento anterior |
| `R` | marcar / desmarcar revisado |
| `,` | offset −50 ms |
| `.` | offset +50 ms |
| `←` / `→` | mover el audio −0,1 s / +0,1 s |
| `Shift`+`←` / `Shift`+`→` | mover el audio −1 s / +1 s |
| `Cmd/Ctrl`+`Z` | deshacer |
| `Shift`+`Cmd/Ctrl`+`Z` / `Ctrl`+`Y` | rehacer |

### Deshacer / Rehacer

Los botones **↶ Deshacer** y **↷ Rehacer** (barra superior) cubren TODAS las acciones que
modifican datos: editar texto, editar tiempos (escritos, perilla y ±100 ms), insertar, borrar,
restaurar, revertir tiempos, marcar/desmarcar revisado y cambiar el offset global.

- Deshabilitados cuando no hay nada que deshacer/rehacer; el tooltip dice QUÉ se va a
  deshacer/rehacer («editar texto del #42», «borrar #17», «insertar»…).
- Atajos: `Cmd/Ctrl+Z` deshacer, `Shift+Cmd/Ctrl+Z` y `Ctrl+Y` rehacer. Con el foco dentro de un
  campo de texto o de tiempo, `Cmd/Ctrl+Z` lo lleva el navegador (deshace la escritura del campo),
  no la pila.
- La escritura de texto se agrupa: teclear una frase genera UNA sola entrada (pausa de ~600 ms
  o perder el foco la cierra). Igual los ajustes de ±100 ms repetidos y el offset. Cada arrastre
  de la perilla es una sola entrada.
- Implementación: pila de instantáneas del estado persistible (textos, tiempos, revisados,
  borrados, insertados y offset), limitada a ~100 entradas; la pila de rehacer se vacía al
  ejecutar una acción nueva. La pila vive en MEMORIA: **no sobrevive a recargar la página**
  (lo que persiste es `localStorage`, que cada acción ya guarda por su cuenta). Tras deshacer o
  rehacer se reordena la lista por tiempo, se repinta, se recalculan los contadores y se guarda.

Los atajos se desactivan mientras el foco está dentro de un texto en edición o del campo de
búsqueda (en el texto, `Esc` para salir). Así puedes escribir espacios y `j`/`k`/`r` sin que
se disparen los atajos.

## Ficheros

- `index.html`, `app.js`, `style.css` — la interfaz (los tres se versionan).
- `fixture.json` — 8 segmentos inventados, con el esquema exacto de `pelicula_w_words.json`,
  para desarrollar sin esperar al transcriptor real (se versiona).
- `words.json` — **derivado, no versionado**: copia de `out/pelicula_w_words.json`.
- `audio.mp3` — **derivado, no versionado**: copia sin recodificar del audio fuente
  (192 kb/s, 44.1 kHz, estéreo).

## Notas sobre los datos reales

El `pelicula_w_words.json` actual no cubre toda la película: deja huecos entre segmentos
(alrededor de la mitad de la línea de tiempo). Por eso puede ocurrir que en un momento dado
no se resalte ningún segmento aunque el audio siga sonando — no es un fallo de la interfaz,
es un tramo sin transcribir. Los segmentos también varían mucho de duración (desde 0,1 s
hasta más de 6 minutos), así que algunos bloques largos se ven con decenas de palabras.
