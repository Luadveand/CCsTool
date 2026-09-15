#!/usr/bin/env python3
"""srt_tools.py — post-proceso de SRTs generados por Whisper (stdlib pura).

Subcomandos:
  clean <entrada.srt> <salida.srt>   elimina segmentos degenerados
  stats <archivo.srt> [--total N]    métricas en una línea TSV
"""
import sys
import os
import re
import unicodedata

AUDIO_DEFAULT = 5434.54

TS_RE = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*"
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)

# Lista negra de alucinaciones típicas (texto ya normalizado, sin tildes)
BLACKLIST_PHRASES = [
    "suscribete al canal",
    "suscribete",
    "gracias por ver",
    "subtitulos por",
    "subtitulado por",
    "amara org",
]
# Contención sobre el texto en minúsculas SIN limpiar signos
BLACKLIST_CONTAINS = ["www", ".com"]


def fail(msg):
    sys.stderr.write(f"ERROR: {msg}\n")
    sys.exit(1)


def _to_s(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000.0


def fmt_ts(t):
    ms = int(round(t * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_srt(path):
    if not os.path.isfile(path):
        fail(f"el archivo de entrada no existe: {path}")
    with open(path, encoding="utf-8-sig") as f:  # utf-8-sig consume el BOM si existe
        raw = f.read()
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    segs = []
    for block in raw.split("\n\n"):
        lines = [l for l in block.split("\n") if l.strip()]
        ti = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if ti is None:
            continue  # bloque sin timestamps: no es un subtítulo
        m = TS_RE.search(lines[ti])
        if not m:
            continue  # línea de tiempo malformada: ignorar bloque
        start = _to_s(m.group(1), m.group(2), m.group(3), m.group(4))
        end = _to_s(m.group(5), m.group(6), m.group(7), m.group(8))
        text = "\n".join(lines[ti + 1:]).strip()
        # conservar bloques sin texto: cuentan en stats; clean los descarta
        segs.append(
            {"start": start, "end": end, "text": text,
             "words": len(text.split()), "dur": end - start}
        )
    return segs


def normalize(text):
    t = unicodedata.normalize("NFKD", text)
    t = "".join(c for c in t if not unicodedata.combining(c))  # quita tildes
    t = t.lower()
    t = "".join(c if (c.isalnum() or c == " ") else " " for c in t)  # sin signos
    return " ".join(t.split())


def collapse_loop(text):
    """Colapsa palabra/frase corta repetida >3 veces consecutivas a una aparición.
    Devuelve (texto_nuevo, True si recortó)."""
    words = text.split()
    changed = False
    while True:
        out, i, n = [], 0, len(words)
        hit = False
        while i < n:
            best = None
            for L in range(min(10, n - i), 0, -1):
                unit = words[i:i + L]
                k = 1
                while i + (k + 1) * L <= n and words[i + k * L:i + (k + 1) * L] == unit:
                    k += 1
                if k > 3:
                    best, bestk = L, k
                    break
            if best:
                out.extend(words[i:i + best])
                i += best * bestk
                hit = True
            else:
                out.append(words[i])
                i += 1
        if hit:
            changed = True
            words = out
        else:
            break
    return " ".join(words), changed


def collapse_rachas(segs):
    """N>=3 segmentos consecutivos con texto idéntico -> primero con end extendido.
    Devuelve (lista_nueva, nº_de_rachas_colapsadas, nº_de_segmentos_fusionados)."""
    out, i, rachas, fused = [], 0, 0, 0
    while i < len(segs):
        j = i
        while j + 1 < len(segs) and normalize(segs[j + 1]["text"]) == normalize(segs[i]["text"]):
            j += 1
        if j - i + 1 >= 3:
            s = dict(segs[i])
            s["end"] = segs[j]["end"]
            s["dur"] = s["end"] - s["start"]
            out.append(s)
            rachas += 1
            fused += j - i
            i = j + 1
        else:
            out.append(segs[i])
            i += 1
    return out, rachas, fused


def write_srt(segs, path):
    with open(path, "w", encoding="utf-8") as f:
        for i, s in enumerate(segs, 1):
            f.write(f"{i}\n{fmt_ts(s['start'])} --> {fmt_ts(s['end'])}\n{s['text']}\n\n")


def cmd_clean(entrada, salida):
    segs = parse_srt(entrada)
    n_in = len(segs)

    # 1) colapsar bucles internos
    bucles = 0
    for s in segs:
        nuevo, recortado = collapse_loop(s["text"])
        if recortado:
            bucles += 1
        s["text"] = nuevo
        s["words"] = len(nuevo.split())

    # 2) descartes y recortes por segmento
    #    Ventanas largas con pocas palabras (>=10 s, <=6): la densidad distingue
    #    alucinación de diálogo real estirado por el VAD sobre música:
    #      < 0.05 palabras/s -> basura (saludos/CTA sobre música) -> descartar
    #      >= 0.05           -> diálogo real en ventana inflada -> conservar
    #                          y recortar end a start + palabras/2.5 + 1.5 s
    #    (La repetición del texto NO descarta: los motivos reales se repiten,
    #    p. ej. "Ellos mataron a mi Carmelo." en la escena inicial y a 01:14.)
    kept, n_empty, n_black, n_low, n_clip = [], 0, 0, 0, 0
    for s in segs:
        if not s["text"]:
            n_empty += 1
            continue
        low = s["text"].lower()
        norm = normalize(s["text"])
        if any(norm == p for p in BLACKLIST_PHRASES) or any(c in low for c in BLACKLIST_CONTAINS):
            n_black += 1
            continue
        if s["dur"] >= 10.0 and s["words"] <= 6:
            if s["words"] / s["dur"] < 0.05:
                n_low += 1
                continue
            nuevo_end = s["start"] + s["words"] / 2.5 + 1.5
            if nuevo_end < s["end"]:
                s["end"] = nuevo_end
                s["dur"] = nuevo_end - s["start"]
                n_clip += 1
        kept.append(s)

    # 3) colapsar rachas de textos idénticos
    kept, rachas, fused = collapse_rachas(kept)

    write_srt(kept, salida)
    sys.stderr.write(
        f"segmentos_entrada={n_in}\n"
        f"descartados_sin_texto={n_empty}\n"
        f"descartados_baja_densidad={n_low} (>=10s, <=6 pal, <0.05 pal/s)\n"
        f"recortados_ventana_inflada={n_clip} (unicos conservados, end=start+palabras/2.5+1.5)\n"
        f"descartados_por_lista_negra={n_black}\n"
        f"rachas_colapsadas={rachas} (fusionados={fused})\n"
        f"bucles_recortados={bucles}\n"
        f"segmentos_salida={len(kept)}\n"
    )


def cmd_stats(path, total):
    segs = parse_srt(path)
    n = len(segs)
    words = sum(s["words"] for s in segs)
    covered = sum(s["dur"] for s in segs)
    pct = covered / total * 100.0 if total else 0.0
    n25 = sum(1 for s in segs if s["dur"] >= 25.0)
    susp = [s for s in segs if s["dur"] >= 10.0 and s["words"] <= 6]
    short = [s for s in segs if s["dur"] < 5.0]
    wps = (sum(s["words"] for s in short) / sum(s["dur"] for s in short)) if short else 0.0
    streak = streak_max = 0
    prev = None
    for s in segs:
        streak = streak + 1 if s["text"] == prev else 1
        streak_max = max(streak_max, streak)
        prev = s["text"]
    print(
        "\t".join(str(x) for x in (
            n, words, f"{covered:.1f}", f"{pct:.1f}", n25, len(susp), f"{wps:.2f}", streak_max
        ))
    )
    sys.stderr.write(
        "columnas: segmentos\\tpalabras\\tduracion_cubierta_s\\tpct_cobertura"
        "\\tn_seg>=25s\\tn_seg>=10s<=6pal\\twps_seg<5s\\tmax_racha_identica\n"
    )


def cmd_compare(a_path, b_path, bucket):
    """Tabla por tramos: palabras y segundos cubiertos de A vs B."""
    a = parse_srt(a_path)
    b = parse_srt(b_path)

    def collect(segs):
        acc = {}
        for s in segs:
            t0 = int(s["start"] // bucket) * bucket
            w, c = acc.get(t0, (0, 0.0))
            b1 = t0 + bucket
            cov = min(s["end"], b1) - max(s["start"], t0)
            acc[t0] = (w + s["words"], c + max(0.0, cov))
        return acc

    ba, bb = collect(a), collect(b)
    last = max(max(ba, default=0), max(bb, default=0))
    print(f"{'inicio':>8} {'pal_A':>6} {'pal_B':>6} {'delta(A-B)':>10} {'cub_A':>8} {'cub_B':>8}")
    twa = twb = 0
    tca = tcb = 0.0
    for t0 in range(0, int(last + bucket), int(bucket)):
        wa, ca = ba.get(t0, (0, 0.0))
        wb, cb = bb.get(t0, (0, 0.0))
        h, rem = divmod(t0, 3600)
        m, sec = divmod(rem, 60)
        print(f"{h:02d}:{m:02d}:{sec:02d} {wa:6d} {wb:6d} {wa - wb:10d} {ca:8.1f} {cb:8.1f}")
        twa += wa; twb += wb; tca += ca; tcb += cb
    print("-" * 52)
    print(f"{'TOTAL':>8} {twa:6d} {twb:6d} {twa - twb:10d} {tca:8.1f} {tcb:8.1f}")
    sys.stderr.write(
        "columnas: palabras y segundos cubiertos por tramo de "
        f"{bucket}s; segmentos asignados por su inicio, cobertura recortada al tramo\n"
    )


def _vtt_ts(t):
    ms = int(round(t * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def _hms(t):
    h, rem = divmod(int(t), 3600)
    m, sec = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}"


def cmd_emit(entrada, prefijo):
    """Escribe <prefijo>.txt, <prefijo>.vtt y <prefijo>_legible.txt desde un SRT."""
    segs = parse_srt(entrada)
    with open(prefijo + ".txt", "w", encoding="utf-8") as f:
        for s in segs:
            f.write(s["text"] + "\n")
    with open(prefijo + ".vtt", "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        for i, s in enumerate(segs, 1):
            f.write(f"{i}\n{_vtt_ts(s['start'])} --> {_vtt_ts(s['end'])}\n{s['text']}\n\n")
    # transcript legible: bloques de 5 min, párrafos por hueco >= 2 s
    bucket = 300
    blocks = {}
    for s in segs:
        t0 = int(s["start"] // bucket) * bucket
        blocks.setdefault(t0, []).append(s)
    with open(prefijo + "_legible.txt", "w", encoding="utf-8") as f:
        for t0 in sorted(blocks):
            f.write(f"## [{_hms(t0)} - {_hms(t0 + bucket)}]\n")
            prev_end = None
            paragraphs = []
            for s in sorted(blocks[t0], key=lambda x: x["start"]):
                texto = " ".join(s["text"].split())
                if prev_end is not None and s["start"] - prev_end < 2.0 and paragraphs:
                    paragraphs[-1] += " " + texto
                else:
                    paragraphs.append(texto)
                prev_end = s["end"]
            f.write("\n\n".join(paragraphs) + "\n\n")
    sys.stderr.write(
        f"emit: {len(segs)} segmentos -> {prefijo}.txt, {prefijo}.vtt, "
        f"{prefijo}_legible.txt ({len(blocks)} bloques de {bucket}s)\n"
    )


def main():
    argv = sys.argv[1:]
    if not argv:
        fail("uso: srt_tools.py {clean|stats|compare|emit} ...; ver --help en el docstring")
    cmd = argv[0]
    if cmd == "clean" and len(argv) == 3:
        cmd_clean(argv[1], argv[2])
    elif cmd == "stats" and len(argv) >= 2:
        total = AUDIO_DEFAULT
        args = argv[1:]
        if "--total" in args:
            k = args.index("--total")
            try:
                total = float(args[k + 1])
            except (IndexError, ValueError):
                fail("--total necesita un número (p. ej. --total 5434.54)")
            args = args[:k] + args[k + 2:]
        if len(args) != 1:
            fail("uso: srt_tools.py stats <archivo.srt> [--total N]")
        cmd_stats(args[0], total)
    elif cmd == "compare" and len(argv) >= 3:
        bucket = 300
        args = argv[1:]
        if "--bucket" in args:
            k = args.index("--bucket")
            try:
                bucket = float(args[k + 1])
            except (IndexError, ValueError):
                fail("--bucket necesita un número de segundos (p. ej. --bucket 300)")
            args = args[:k] + args[k + 2:]
        if len(args) != 2:
            fail("uso: srt_tools.py compare <a.srt> <b.srt> [--bucket 300]")
        cmd_compare(args[0], args[1], bucket)
    elif cmd == "emit" and len(argv) == 3:
        cmd_emit(argv[1], argv[2])
    else:
        fail("uso: srt_tools.py clean <entrada.srt> <salida.srt> | stats <archivo.srt> [--total N] | compare <a.srt> <b.srt> [--bucket 300] | emit <entrada.srt> <prefijo_salida>")
if __name__ == "__main__":
    main()
