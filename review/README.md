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
  campo editable (Enter o blur confirma, `Esc` cancela). Acepta `00:01:23,450`, `1:23`, `83.5`…
  A cada lado hay botones **−/+ de 100 ms** (visibles al pasar el ratón por el segmento; mantener
  pulsado repite el ajuste) que no mueven el audio. El botón **↺ revertir tiempos** (aparece solo si
  has tocado los tiempos) devuelve `start`/`end` a los valores del JSON original.
- **Marcar con el cursor («Inicio aquí» / «Fin aquí»)**: botones en cada segmento (y atajos `I`/`O`
  sobre el segmento activo) que fijan su `start`/`end` al instante **REAL del audio** en ese momento.
  Lo que se guarda es `currentTime − offset` (tiempo de subtítulo), de modo que al exportar con el
  offset aplicado el timestamp cae exactamente donde marcaste: con offset +300 ms y el audio en
  1234,5 s, se guarda 1234,2 s y el SRT exporta `00:20:34,500`.
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

### Atajos de teclado

| tecla | acción |
|---|---|
| `Espacio` | play / pausa |
| `J` | segmento siguiente |
| `K` | segmento anterior |
| `R` | marcar / desmarcar revisado |
| `I` | «Inicio aquí»: fijar el `start` del segmento activo al instante actual del audio |
| `O` | «Fin aquí»: fijar el `end` del segmento activo al instante actual del audio |
| `,` | offset −50 ms |
| `.` | offset +50 ms |

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
