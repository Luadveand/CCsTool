#!/usr/bin/env python3
"""srt_tools.py — post-proceso de SRTs generados por Whisper (stdlib pura).

Subcomandos:
  clean <entrada.srt> <salida.srt>   elimina segmentos degenerados
  stats <archivo.srt> [--total N]    métricas en una línea TSV
  resync <words.json> <salida.srt>   reconstruye el SRT desde timestamps por palabra
"""
import sys
import os
import json
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


LOW_CONF = 0.6     # confianza media por debajo de la cual un grupo se descarta
ISOL_INTRA = 10.0  # hueco intra-segmento que delata interpolación de Whisper
                   # (medido: artefactos reales >= 10.5 s, pausas dramáticas
                   # reales <= 9.7 s; ver reporte, imprime el hueco medido)
MAX_CPS = 21.0     # velocidad de lectura máxima (caracteres por segundo)

ARTICLES = {"el", "la", "los", "las", "un", "una", "unos", "unas",
            "mi", "mis", "tu", "tus", "su", "sus", "nuestro", "nuestra",
            "nuestros", "nuestras", "este", "esta", "estos", "estas",
            "ese", "esa", "esos", "esas", "aquel", "aquella",
            "aquellos", "aquellas"}
CONJ_PREP = {"y", "e", "o", "u", "pero", "que", "de", "del", "en", "con",
             "para", "por", "como", "cuando", "si", "porque", "a", "ni",
             "sino", "mientras", "desde", "hasta", "tras", "sobre",
             "entre", "sin", "ante", "bajo", "según"}


NO_SPACE_BEFORE = set("-%'’)],.:;!?")
NO_SPACE_AFTER = set("([¿¡'’")


def _group_text(g):
    """Une los tokens; los que van pegados al anterior no llevan espacio."""
    out = ""
    for w in g:
        tok = w["w"].strip()
        if not tok:
            continue
        if out and (tok[0] in NO_SPACE_BEFORE or out[-1] in NO_SPACE_AFTER):
            out += tok
        else:
            out += (" " if out else "") + tok
    return out


def _group_conf(g):
    return sum(x.get("p") or 0.0 for x in g) / len(g)


def _split_lines(text, max_chars):
    """1-2 líneas equilibradas sin romper sintagma (nunca tras artículo)."""
    if len(text) <= max_chars:
        return text
    words = text.split(" ")
    in_lim = []   # cortes con ambas líneas <= max_chars
    for i in range(1, len(words)):
        left, right = " ".join(words[:i]), " ".join(words[i:])
        if len(left) > max_chars or len(right) > max_chars:
            continue
        prev_w = words[i - 1].lower().rstrip(",;:.?!…")
        next_w = words[i].lower().rstrip(",;:.?!…")
        if prev_w in ARTICLES:
            continue  # nunca cortar entre artículo y sustantivo
        score = abs(len(left) - len(right))
        if words[i - 1].endswith(","):
            score -= 30  # cortar tras coma
        if next_w in CONJ_PREP:
            score -= 25  # cortar antes de conjunción/preposición
        if prev_w in CONJ_PREP:
            score += 40  # dejar conjunción/preposición colgando es feo
        in_lim.append((score, i))
    if not in_lim:  # todos los cortes posibles parten un artículo: el más equilibrado
        for i in range(1, len(words)):
            left, right = " ".join(words[:i]), " ".join(words[i:])
            if len(left) <= max_chars and len(right) <= max_chars:
                in_lim.append((abs(len(left) - len(right)), i))
    if in_lim:
        i = min(in_lim)[1]
        return " ".join(words[:i]) + "\n" + " ".join(words[i:])
    # sin punto de corte válido (palabra enorme): el más equilibrado posible
    best = min(range(1, len(words)),
               key=lambda i: abs(len(" ".join(words[:i])) - len(" ".join(words[i:]))))
    return " ".join(words[:best]) + "\n" + " ".join(words[best:])


def _fits(a, b, max_chars, max_dur):
    """La fusión a+b cabe en 2 líneas de max_chars y en max_dur."""
    return (_fits_2lines(_group_text(a) + " " + _group_text(b), max_chars)
            and b[-1]["e"] - a[0]["s"] <= max_dur)


def _fits_2lines(text, max_chars):
    """El texto cabe en 2 líneas de max_chars con algún punto de corte."""
    if len(text) <= max_chars:
        return True
    words = text.split(" ")
    for i in range(1, len(words)):
        if (len(" ".join(words[:i])) <= max_chars
                and len(" ".join(words[i:])) <= max_chars):
            return True
    return False


def _overflow_cut(cur, nw, max_chars):
    """Al desbordar 2 líneas, retrocede al punto preferente que deje ambas
    mitades factibles: fuerte > coma > antes de conjunción/preposición,
    nunca dejando un artículo al final. Devuelve j (palabras a conservar)."""
    cands = []
    for j in range(1, len(cur)):
        left, right = _group_text(cur[:j]), _group_text(cur[j:]) + " " + nw
        if not _fits_2lines(left, max_chars) or not _fits_2lines(right, max_chars):
            continue
        tail = cur[j - 1]["w"].rstrip()
        nxt_w = cur[j]["w"].strip().lower().rstrip(",;:.?!…")
        score = abs(len(left) - len(right))
        if tail[-1:] in ".?!…":
            score -= 50
        elif tail[-1:] == ",":
            score -= 40
        if nxt_w in CONJ_PREP:
            score -= 25
        if tail.rstrip(",;:.?!…").lower() in ARTICLES:
            score += 100
        cands.append((score, j))
    return min(cands)[1] if cands else None


def _reloc_conf(reloc):
    ps = [r["p"] for r in reloc]
    return sum(ps) / len(ps) if ps else 0.0


def _attach_reloc(group, text, at_front, max_chars, reloc):
    """Recoloca text (timestamp corrupto, no aporta al rango temporal) en group.

    Si el texto no cabe en 2 líneas, divide el grupo en dos subtítulos
    consecutivos usando SOLO el rango temporal real de sus palabras.
    Devuelve la lista de grupos resultante (1 o 2).
    """
    base = _group_text(group)
    cand = (text + " " + base) if at_front else (base + " " + text)
    if not _fits_2lines(cand, max_chars):
        for j in range(1, len(group)):
            t1, t2 = _group_text(group[:j]), _group_text(group[j:])
            c1 = (text + " " + t1) if at_front else t1
            c2 = t2 if at_front else (t2 + " " + text)
            if _fits_2lines(c1, max_chars) and _fits_2lines(c2, max_chars):
                g1, g2 = group[:j], group[j:]
                if at_front:
                    g1.insert(0, {"w": text, "s": g1[0]["s"], "e": g1[0]["s"],
                                  "p": _reloc_conf(reloc), "reloc": reloc})
                else:
                    g2.append({"w": text, "s": g2[-1]["e"], "e": g2[-1]["e"],
                               "p": _reloc_conf(reloc), "reloc": reloc})
                return [g1, g2]
    # cabe (o nada cabe y se prefiere desbordar a mutilar): pegar al grupo
    if at_front:
        group.insert(0, {"w": text, "s": group[0]["s"], "e": group[0]["s"],
                         "p": _reloc_conf(reloc), "reloc": reloc})
    else:
        group.append({"w": text, "s": group[-1]["e"], "e": group[-1]["e"],
                      "p": _reloc_conf(reloc), "reloc": reloc})
    return [group]



def cmd_resync(words_path, salida, max_chars=42, max_dur=6.0, max_gap=1.2,
               min_dur=1.0, orphan_gap=3.0, merge_gap=3.0, report_path=None):
    """Construye el SRT desde cero a partir de los timestamps por palabra.

    Convenciones de subtitulado: hasta 2 líneas por subtítulo (max_chars es
    POR LÍNEA), corte preferente en puntuación fuerte, min_dur de pantalla,
    fusión de grupos cortos con el vecino más cercano y control de 21 cps.
    NUNCA se descarta texto de alta confianza: la única regla de descarte es
    conf < 0.6. Una palabra separada del resto de las palabras de SU PROPIO
    segmento por > ISOL_INTRA s tiene el timestamp interpolado (corrupto),
    pero el texto es bueno: se RECOLOCA fusionándola con el grupo de su
    segmento (delante si precede, detrás si sigue) sin aportar su timestamp.
    Lo demás se emite, por aislado que esté, y los grupos aislados se listan
    en el informe para revisión humana.
    Nada de duraciones inventadas: start = s de la primera palabra del grupo,
    end = e de la última (salida extensión mínima que respeta al siguiente).
    """
    try:
        with open(words_path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        fail(f"no puedo leer {words_path}: {e}")

    # 1) por segmento: las palabras interpoladas (hueco > ISOL_INTRA con el
    #    resto de su propio segmento) se recolocan en el grupo de su segmento
    #    (delante si preceden, detrás si siguen); el resto se agrupa: corte
    #    por hueco, capacidad de 2 líneas, max_dur, puntuación fuerte (corte
    #    pendiente hasta durar min_dur) y coma si los cps se disparan
    descartados = []  # (motivo, start, end, texto, detalle) — solo conf_baja
    groups = []
    for seg in data.get("segments", []):
        raw = []
        for w in seg.get("words") or []:
            if not (w.get("w") or "").strip():
                continue
            if w.get("s") is None or w.get("e") is None or w["e"] < w["s"]:
                continue
            raw.append(w)
        front, back = [], []
        if len(raw) >= 2:
            iso, core = [], []
            for i, w in enumerate(raw):
                gp = (w["s"] - raw[i - 1]["e"]) if i > 0 else None
                gn = (raw[i + 1]["s"] - w["e"]) if i + 1 < len(raw) else None
                if (gp is None or gp > ISOL_INTRA) and (gn is None or gn > ISOL_INTRA):
                    iso.append(w)
                else:
                    core.append(w)
            if core:
                first_s = core[0]["s"]
                front = [w for w in iso if w["s"] < first_s]
                back = [w for w in iso if w["s"] >= first_s]
            else:
                core, front, back = [raw[0]], [], raw[1:]
        else:
            core = raw
        if not core:
            continue
        base = len(groups)
        cur = [core[0]]
        pending_cut = False  # hubo . ? ! … y el grupo aún dura < min_dur
        for w in core[1:]:
            prev = cur[-1]
            dur = prev["e"] - cur[0]["s"]
            chars_ok = _fits_2lines(_group_text(cur) + " " + w["w"].strip(), max_chars)
            tail = prev["w"].rstrip()[-1:]
            if tail in ".?!…":
                pending_cut = True
            comma_cps = (tail == "," and dur >= min_dur
                         and len(_group_text(cur)) / dur > MAX_CPS)
            cut = (w["s"] - prev["e"] > max_gap
                   or not chars_ok
                   or w["e"] - cur[0]["s"] > max_dur
                   or (pending_cut and dur >= min_dur)
                   or comma_cps)
            if cut:
                j = None
                if not chars_ok:
                    # desborde: re-cortar en un punto preferente del propio grupo
                    j = _overflow_cut(cur, w["w"].strip(), max_chars)
                if j:
                    groups.append(cur[:j])
                    cur = cur[j:]
                else:
                    groups.append(cur)
                    cur = []
                cur.append(w)
                pending_cut = cur[-1]["w"].rstrip()[-1:] in ".?!…"
            else:
                cur.append(w)
        groups.append(cur)

        # recolocación: las palabras interpoladas se fusionan con el grupo de
        # su propio segmento (delante/detrás) sin aportar timestamp corrupto
        for at_front, ws in ((True, front), (False, back)):
            if not ws:
                continue
            text = " ".join(w["w"].strip() for w in ws)
            reloc = [{"s": w["s"], "e": w["e"], "w": w["w"].strip(),
                      "p": w.get("p") or 0.0} for w in ws]
            target = base if at_front else len(groups) - 1
            groups[target:target + 1] = _attach_reloc(
                groups[target], text, at_front, max_chars, reloc)

    # 2) grupos < min_dur: fusionar con el vecino de hueco menor (si caben
    #    en 2 líneas y max_dur); si no hay fusión posible, extender end a
    #    start + min_dur sin invadir al siguiente
    i = 0
    while i < len(groups):
        g = groups[i]
        if g[-1]["e"] - g[0]["s"] >= min_dur:
            i += 1
            continue
        prev = groups[i - 1] if i > 0 else None
        nxt = groups[i + 1] if i + 1 < len(groups) else None
        opts = []
        if prev and _fits(prev, g, max_chars, max_dur):
            opts.append((g[0]["s"] - prev[-1]["e"], -1))
        if nxt and _fits(g, nxt, max_chars, max_dur):
            opts.append((nxt[0]["s"] - g[-1]["e"], 1))
        if opts:
            _, side = min(opts)
            if side < 0:
                groups[i - 1].extend(g)
                del groups[i]
            else:
                g.extend(groups[i + 1])
                del groups[i + 1]
        else:
            i += 1
    for i, g in enumerate(groups):
        target = g[0]["s"] + min_dur
        if g[-1]["e"] < target:
            next_start = groups[i + 1][0]["s"] if i + 1 < len(groups) else None
            if next_start is None or target <= next_start:
                g[-1] = dict(g[-1], e=target)

    # 3) fusión sintáctica: dos grupos consecutivos se funden si el primero
    #    no cierra frase (sin puntuación fuerte ni coma), el segundo empieza
    #    por minúscula, el hueco < merge_gap y la unión cabe en 2 líneas y
    #    en max_dur. Iterativo hasta estabilizar.
    merges = []  # pares fusionados: (start, end, texto resultante)
    changed = True
    while changed:
        changed = False
        i = 0
        while i + 1 < len(groups):
            a, b = groups[i], groups[i + 1]
            tail = a[-1]["w"].rstrip()[-1:]
            first_alpha = next((c for c in b[0]["w"].strip() if c.isalpha()), "")
            gap = b[0]["s"] - a[-1]["e"]
            if (tail not in ".?!…:" and tail != ","
                    and first_alpha and first_alpha.islower()
                    and gap < merge_gap
                    and _fits(a, b, max_chars, max_dur)):
                a.extend(b)
                del groups[i + 1]
                merges.append((a[0]["s"], a[-1]["e"], _group_text(a)))
                changed = True
            else:
                i += 1

    subs = []
    aislados = []
    recolocados = []  # (ts_corrupto, ts_final, palabra, subtitulo_completo)
    for i, g in enumerate(groups):
        conf = _group_conf(g)
        if conf < LOW_CONF:
            descartados.append(
                ("conf_baja", g[0]["s"], g[-1]["e"], _group_text(g), f"conf={conf:.2f}"))
            continue
        gp = (g[0]["s"] - groups[i - 1][-1]["e"]) if i > 0 else None
        gn = (groups[i + 1][0]["s"] - g[-1]["e"]) if i + 1 < len(groups) else None
        if ((gp is None or gp > orphan_gap) and (gn is None or gn > orphan_gap)):
            aislados.append((g, gp, gn))
        sub_text = _split_lines(_group_text(g), max_chars)
        for w in g:
            for r in w.get("reloc") or []:
                recolocados.append(
                    ((r["s"], r["e"]), (g[0]["s"], g[-1]["e"]), r["w"], sub_text))
        subs.append(
            {
                "start": g[0]["s"],
                "end": g[-1]["e"],
                "text": sub_text,
                "conf": conf,
            }
        )
    write_srt(subs, salida)

    # 3) informe
    durs = [s["end"] - s["start"] for s in subs]
    media = sum(durs) / len(durs) if durs else 0.0
    buckets = {"<1s": 0, "1-2s": 0, "2-3s": 0, "3-5s": 0, "5-6s": 0, ">6s": 0}
    for d in durs:
        k = "<1s" if d < 1 else "1-2s" if d < 2 else "2-3s" if d < 3 \
            else "3-5s" if d < 5 else "5-6s" if d <= 6 else ">6s"
        buckets[k] += 1
    over_cps = [
        (s, len(s["text"].replace("\n", " ")) / (s["end"] - s["start"]))
        for s in subs if s["end"] > s["start"]
        and len(s["text"].replace("\n", " ")) / (s["end"] - s["start"]) > MAX_CPS
    ]
    descartados.sort(key=lambda d: d[1])
    n_conf = len(descartados)
    if report_path is None:
        report_path = os.path.join(os.path.dirname(salida) or ".", "resync_report.txt")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(f"total_subtitulos={len(subs)}\n")
        f.write(f"duracion_media={media:.2f}s\n")
        f.write("distribucion_duraciones:\n")
        for k in ("<1s", "1-2s", "2-3s", "3-5s", "5-6s", ">6s"):
            f.write(f"  {k}: {buckets[k]}\n")
        f.write(f"exceden_{MAX_CPS:.0f}cps={len(over_cps)}\n")
        f.write(f"descartados={len(descartados)} (conf_baja={n_conf})\n")
        f.write("fusiones_sintacticas (timestamp_resultante | texto):\n")
        for s0, e0, texto in merges:
            f.write(f"  {fmt_ts(s0)} --> {fmt_ts(e0)} | {texto}\n")
        f.write(f"recolocados={len(recolocados)}\n")
        f.write("recolocados (ts_corrupto | ts_asignado | palabra | subtitulo):\n")
        for (os0, oe0), (fs0, fe0), palabra, stext in recolocados:
            f.write(
                f"  {fmt_ts(os0)} --> {fmt_ts(oe0)} | {fmt_ts(fs0)} --> {fmt_ts(fe0)}"
                f" | {palabra} | {stext.replace(chr(10), ' / ')}\n"
            )
        f.write("descartados (motivo | timestamp | texto | detalle):\n")
        for motivo, s0, e0, texto, detalle in descartados:
            f.write(
                f"  {motivo} | {fmt_ts(s0)} --> {fmt_ts(e0)} |"
                f" {texto.replace(chr(10), ' ')} | {detalle}\n"
            )
        f.write("aislados_conservados (timestamp | texto | hueco_prev | hueco_next | conf):\n")
        for g, gp, gn in aislados:
            f.write(
                f"  {fmt_ts(g[0]['s'])} --> {fmt_ts(g[-1]['e'])} | {_group_text(g)}"
                f" | prev={'∅' if gp is None else f'{gp:.2f}s'}"
                f" | next={'∅' if gn is None else f'{gn:.2f}s'}"
                f" | conf={_group_conf(g):.2f}\n"
            )
    sys.stderr.write(
        f"subtitulos={len(subs)}\n"
        f"duracion_media={media:.2f}s\n"
        f"exceden_{MAX_CPS:.0f}cps={len(over_cps)}\n"
        f"descartados={len(descartados)} (conf_baja={n_conf})\n"
        f"recolocados={len(recolocados)}\n"
        f"fusiones_sintacticas={len(merges)}\n"
        f"aislados_conservados={len(aislados)}\n"
        f"informe={report_path}\n"
    )



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
    #      >= 0.05           -> diálogo real en ventana inflada -> conservar tal cual
    #    (El recorte de estas ventanas ya NO usa una fórmula sintética: los límites
    #    reales los fija el subcomando `resync` con timestamps por palabra.)
    #    (La repetición del texto NO descarta: los motivos reales se repiten,
    #    p. ej. "Ellos mataron a mi Carmelo." en la escena inicial y a 01:14.)
    kept, n_empty, n_black, n_low = [], 0, 0, 0
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
            # conservar sin recorte sintético: `resync` fija el end real
        kept.append(s)

    # 3) colapsar rachas de textos idénticos
    kept, rachas, fused = collapse_rachas(kept)

    write_srt(kept, salida)
    sys.stderr.write(
        f"segmentos_entrada={n_in}\n"
        f"descartados_sin_texto={n_empty}\n"
        f"descartados_baja_densidad={n_low} (>=10s, <=6 pal, <0.05 pal/s)\n"
        f"ventanas_infladas_conservadas_sin_recorte_sintetico (los límites reales los fija resync)\n"
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
            # una línea POR SUBTÍTULO: las 2 líneas del SRT se unen con espacio
            f.write(" ".join(s["text"].split("\n")) + "\n")
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
    elif cmd == "resync" and len(argv) >= 3:
        defaults = {"--max-chars": (42, int), "--max-dur": (6.0, float),
                    "--max-gap": (1.2, float), "--min-dur": (1.0, float),
                    "--orphan-gap": (3.0, float), "--merge-gap": (3.0, float)}
        args = argv[1:]
        report = None
        if "--report" in args:
            k = args.index("--report")
            try:
                report = args[k + 1]
            except IndexError:
                fail("--report necesita una ruta (p. ej. --report out/resync_report.txt)")
            del args[k:k + 2]
        for flag in defaults:
            if flag not in args:
                continue
            k = args.index(flag)
            cast = defaults[flag][1]
            try:
                defaults[flag] = (cast(args[k + 1]), cast)
            except (IndexError, ValueError):
                fail(f"{flag} necesita un número (p. ej. {flag} {defaults[flag][0]})")
            del args[k:k + 2]
        if len(args) != 2:
            fail("uso: srt_tools.py resync <words.json> <salida.srt> [--max-chars 42] [--max-dur 6.0] [--max-gap 1.2] [--min-dur 1.0] [--orphan-gap 3.0] [--merge-gap 3.0] [--report out/resync_report.txt]")
        cmd_resync(args[0], args[1],
                   defaults["--max-chars"][0], defaults["--max-dur"][0],
                   defaults["--max-gap"][0], defaults["--min-dur"][0],
                   defaults["--orphan-gap"][0], defaults["--merge-gap"][0], report)
    elif cmd == "emit" and len(argv) == 3:
        cmd_emit(argv[1], argv[2])
    else:
        fail("uso: srt_tools.py clean <entrada.srt> <salida.srt> | stats <archivo.srt> [--total N] | compare <a.srt> <b.srt> [--bucket 300] | emit <entrada.srt> <prefijo_salida> | resync <words.json> <salida.srt> [--max-chars 42] [--max-dur 6.0] [--max-gap 1.2] [--min-dur 1.0] [--orphan-gap 3.0] [--merge-gap 3.0] [--report out/resync_report.txt]")
if __name__ == "__main__":
    main()
