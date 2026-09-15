/* Revisión de subtítulos — JS vanilla, sin dependencias.
   Esquema de entrada (fijo):
   { audio, duration, language, segments:[
       { id, start, end, text, avg_logprob, no_speech_prob, compression_ratio,
         words:[{ w, s, e, p }] } ] }                                        */
'use strict';

const STORAGE_KEY = 'subtitulado-review-v1';

const audio    = document.getElementById('audio');
const listEl   = document.getElementById('list');
const bannerEl = document.getElementById('banner');
const offsetEl = document.getElementById('offset');
const offNowEl = document.getElementById('offNow');
const srcNameEl= document.getElementById('srcName');
const srcInfoEl= document.getElementById('srcInfo');
const cRevEl   = document.getElementById('cRev');
const cDudEl   = document.getElementById('cDud');
const cVisEl   = document.getElementById('cVis');
const cBuscaEl = document.getElementById('cBusca');
const buscarEl = document.getElementById('buscar');
const fileEl   = document.getElementById('fileInput');

const state = {
  segs: [],          // segmentos normalizados, ordenados por start
  src: '—',
  duration: null,
  edits: {},         // id -> texto editado
  reviewed: new Set(),
  offsetMs: 0,
  filter: 'all',
  q: '',             // consulta de búsqueda, ya plegada (sin acentos, minúsculas)
  cursor: 0,         // índice del segmento "actual" para J/K/R
  activeId: null,
  saveTimer: null,
};

/* ------------------------------------------------------------------ utils */

function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const ms = Math.round(t * 1000);
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  const s  = Math.floor((ms % 60000) / 1000);
  const z  = ms % 1000;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' +
         String(s).padStart(2, '0') + ',' + String(z).padStart(3, '0');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const off = () => state.offsetMs / 1000;
const clampT = t => Math.max(0, t);

/* minúsculas sin acentos, para la búsqueda */
function fold(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function passFilter(s) {
  if (state.filter === 'dudosos' && !isDud(s)) return false;
  if (state.filter === 'pendientes' && state.reviewed.has(String(s.id))) return false;
  if (state.q && !s.fold.includes(state.q)) return false;
  return true;
}

const visibleSegs = () => state.segs.filter(passFilter);

function banner(msg, kind) {
  bannerEl.className = 'banner' + (kind ? ' ' + kind : '');
  bannerEl.textContent = msg;
  bannerEl.classList.toggle('hidden', !msg);
}

function isDud(s) {
  if (s.nsp > 0.5) return true;
  return s.words.some(w => w.p < 0.6);
}

function lowCount(s) { return s.words.filter(w => w.p < 0.6).length; }

/* recalcula el texto plegado (búsqueda) tras cambios masivos */
function refreshFold() {
  state.segs.forEach(s => { s.fold = fold(s.text); });
}

function textOf(s) {
  return Object.prototype.hasOwnProperty.call(state.edits, s.id) ? state.edits[s.id] : s.text;
}

/* --------------------------------------------------------------- carga */

function normalize(raw) {
  const norm = x => String(x).replace(/\s+/g, ' ').trim();
  const segs = (raw && Array.isArray(raw.segments) ? raw.segments : []).map((s, i) => {
    const words = Array.isArray(s.words) && s.words.length
      ? s.words.map(w => ({
          w: String(w.w != null ? w.w : '').trim(),
          s: Number(w.s) || 0,
          e: Number(w.e) || Number(w.s) || 0,
          p: typeof w.p === 'number' ? w.p : Number(w.p) || 0,
        }))
      : [{ w: String(s.text || '').trim(), s: Number(s.start) || 0,
           e: Number(s.end) || 0, p: 1 }];
    const joined = words.map(w => w.w).join(' ');
    const text = String(s.text != null ? s.text : joined);
    return {
      id: s.id != null ? s.id : i + 1,
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: text,
      nsp: Number(s.no_speech_prob) || 0,
      aligned: norm(joined) === norm(text),
      fold: fold(text),
      words,
    };
  });
  segs.sort((a, b) => a.start - b.start);
  return segs;
}

function applyData(raw, srcLabel) {
  state.segs = normalize(raw);
  state.src = srcLabel;
  state.duration = Number(raw && raw.duration) || null;
  state.activeId = null;
  state.cursor = 0;
  restore();
  srcNameEl.textContent = srcLabel;
  srcInfoEl.textContent = state.segs.length + ' segmentos · ' +
    (state.duration ? (state.duration / 60).toFixed(1) + ' min' : 'duración ?');
  render();
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}

async function boot() {
  let raw = null, src = '';
  try {
    raw = await fetchJson('words.json');
    src = 'words.json';
    banner('Cargado words.json — ' + (raw.segments || []).length + ' segmentos.', 'ok');
  } catch (e1) {
    try {
      raw = await fetchJson('fixture.json');
      src = 'fixture.json';
      banner('AVISO: no hay words.json (' + e1.message + ') — usando el FIXTURE de prueba ' +
             'review/fixture.json, con texto INVENTADO. Carga el fichero real con "Cargar words.json…".');
    } catch (e2) {
      banner('ERROR: no se pudo cargar words.json ni fixture.json (' + e2.message +
             '). Usa "Cargar words.json…" para abrir el fichero a mano.', 'err');
      return;
    }
  }
  applyData(raw, src);
}

/* ---------------------------------------------------------- persistencia */

function save() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        edits: state.edits,
        reviewed: [...state.reviewed],
        offsetMs: state.offsetMs,
      }));
    } catch (e) { /* cuota llena / modo privado: se ignora */ }
  }, 250);
}

function restore() {
  state.edits = {};
  state.reviewed = new Set();
  state.offsetMs = 0;
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { raw = null; }
  if (raw && typeof raw === 'object') {
    if (raw.edits && typeof raw.edits === 'object') {
      for (const s of state.segs) {
        if (typeof raw.edits[s.id] === 'string') state.edits[s.id] = raw.edits[s.id];
      }
      // ediciones huérfanas (de otro fichero) no se conservan
    }
    if (Array.isArray(raw.reviewed)) {
      const ids = new Set(state.segs.map(s => String(s.id)));
      raw.reviewed.forEach(id => { if (ids.has(String(id))) state.reviewed.add(String(id)); });
    }
    if (Number.isFinite(raw.offsetMs)) state.offsetMs = raw.offsetMs;
  }
  offsetEl.value = state.offsetMs;
  offNowEl.textContent = (state.offsetMs > 0 ? '+' : '') + state.offsetMs + ' ms';
}

/* ------------------------------------------------------------- render */

function render(keepScroll) {
  const keep = keepScroll ? listEl.scrollTop : 0;

  const vis = visibleSegs();

  if (!state.segs.length) {
    listEl.innerHTML = '<div class="empty">Sin segmentos cargados.</div>';
  } else if (!vis.length) {
    listEl.innerHTML = '<div class="empty">' +
      (state.q ? 'Ningún segmento coincide con «' + esc(buscarEl.value) + '»' +
                 (state.filter === 'all' ? '.' : ' con el filtro activo.') + ' ' +
                 '<button class="btn" id="clearSearch">Limpiar búsqueda</button>'
               : 'Ningún segmento en este filtro.') + '</div>';
  } else {
    const o = off();
    const parts = vis.map(s => {
      const a = clampT(s.start + o), b = clampT(s.end + o);
      const edited = Object.prototype.hasOwnProperty.call(state.edits, s.id);
      const rev = state.reviewed.has(String(s.id));
      const dud = isDud(s);
      const low = lowCount(s);

      const colored = !edited && s.aligned;
      const body = colored
        ? s.words.map((w, i) => {
            const cls = w.p >= 0.85 ? '' : (w.p >= 0.6 ? ' mid' : ' low');
            return '<span class="w' + cls + '" data-i="' + i +
                   '" data-s="' + w.s + '" title="p = ' + w.p.toFixed(2) +
                   ' · ' + w.s.toFixed(2) + '–' + w.e.toFixed(2) + ' s">' + esc(w.w) + '</span>';
          }).join(' ')
        : esc(textOf(s));

      const flags = [];
      if (rev) flags.push('<span class="flag-rev">✓ revisado</span>');
      if (s.nsp > 0.5) flags.push('<span class="flag-nsp">no_speech ' + s.nsp.toFixed(2) + '</span>');
      if (low && s.aligned) flags.push('<span class="flag-low">' + low + ' palabra' + (low > 1 ? 's' : '') + ' &lt;0.60</span>');
      if (!s.aligned) flags.push('<span class="flag-warn" title="El campo text y la lista de palabras no coinciden: se muestra y se exporta el campo text, sin colores por palabra.">texto ≠ palabras</span>');

      return '<article class="seg' + (dud ? ' dud' : '') + (rev ? ' reviewed' : '') +
             '" data-id="' + esc(s.id) + '">' +
        '<div class="seg-head">' +
          '<div class="row1"><span class="id">#' + esc(s.id) + '</span>' +
          '<button class="btn play" data-act="play" title="Ir aquí">▶</button></div>' +
          '<span class="ts">' + fmtTime(a) + ' --&gt; ' + fmtTime(b) + '</span>' +
          '<span class="dur">dur ' + (b - a).toFixed(2) + ' s' + (o ? ' (offset ' + state.offsetMs + ' ms)' : '') + '</span>' +
          '<span class="flags">' + flags.join(' ') + '</span>' +
        '</div>' +
        '<div class="seg-body">' +
          '<div class="seg-text' + (edited ? ' edited' : '') + '" contenteditable="true" ' +
            'spellcheck="false" role="textbox" aria-label="texto del segmento ' + esc(s.id) + '">' +
            body + '</div>' +
        '</div>' +
        '<div class="seg-actions">' +
          '<button class="btn" data-act="rev">' + (rev ? 'desmarcar' : 'revisado') + '</button>' +
        '</div>' +
      '</article>';
    });
    listEl.innerHTML = parts.join('');

    if (state.activeId != null) {
      const cur = listEl.querySelector('.seg[data-id="' + cssEsc(String(state.activeId)) + '"]');
      if (cur) cur.classList.add('active');
    }
  }

  if (keepScroll) listEl.scrollTop = keep;
  // el DOM se ha reconstruido: el resaltado en vivo debe volver a aplicarse
  lastActive = undefined; lastWord = undefined; lastWordEl = null;
  updateCounters();
}

function cssEsc(s) { return s.replace(/["\\]/g, '\\$&'); }

function updateCounters() {
  const total = state.segs.length;
  const rev = state.segs.filter(s => state.reviewed.has(String(s.id))).length;
  const dud = state.segs.filter(isDud).length;
  const vis = visibleSegs().length;
  cRevEl.textContent = 'revisados ' + rev + ' / ' + total;
  cDudEl.textContent = 'dudosos ' + dud;
  cDudEl.classList.toggle('has', dud > 0);
  cVisEl.textContent = 'visibles ' + vis;
  if (state.q) {
    const n = state.segs.filter(s => s.fold.includes(state.q)).length;
    cBuscaEl.textContent = 'coinciden ' + n;
    cBuscaEl.classList.remove('hidden');
  } else {
    cBuscaEl.classList.add('hidden');
  }
}

/* -------------------------------------------------------- reproducción */

function seekTo(t, play) {
  const d = audio.duration;
  let x = clampT(t);
  if (isFinite(d) && d > 0) x = Math.min(x, d);
  try { audio.currentTime = x; } catch (e) { /* metadata aún no lista */ }
  if (play) audio.play().catch(() => {});
}

function segById(id) { return state.segs.find(s => String(s.id) === String(id)); }

function playSeg(id) {
  const s = segById(id);
  if (!s) return;
  state.cursor = state.segs.indexOf(s);
  seekTo(s.start + off(), true);
}

function togglePlay() {
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

function nav(dir) {
  if (!state.segs.length) return;
  const i = Math.min(state.segs.length - 1, Math.max(0, state.cursor + dir));
  state.cursor = i;
  const s = state.segs[i];
  const keepPlaying = !audio.paused;
  seekTo(s.start + off(), keepPlaying);
  showSegment(s.id);
}

function showSegment(id) {
  const el = listEl.querySelector('.seg[data-id="' + cssEsc(String(id)) + '"]');
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function toggleReviewed(id) {
  if (id == null) return;
  const k = String(id);
  if (state.reviewed.has(k)) state.reviewed.delete(k); else state.reviewed.add(k);
  save();
  render(true);
}

function currentId() {
  if (state.activeId != null) return state.activeId;
  const focused = document.activeElement && document.activeElement.closest &&
                  document.activeElement.closest('.seg');
  if (focused) return focused.dataset.id;
  const s = state.segs[state.cursor];
  return s ? s.id : null;
}

function editingNow() {
  const a = document.activeElement;
  return !!(a && a.closest && a.closest('.seg-text'));
}

/* --------------------------------------------- seguimiento en vivo (rAF) */

let lastActive = undefined, lastWord = undefined, lastWordEl = null;

function tick() {
  requestAnimationFrame(tick);
  if (document.hidden || !state.segs.length) return;

  const t = audio.currentTime, o = off();
  let act = null;
  for (let i = 0; i < state.segs.length; i++) {
    const s = state.segs[i];
    if (t >= s.start + o - 0.001 && t <= s.end + o + 0.001) { act = s; break; }
  }

  if (act !== lastActive) {
    if (lastActive) {
      const p = listEl.querySelector('.seg[data-id="' + cssEsc(String(lastActive.id)) + '"]');
      if (p) p.classList.remove('active');
    }
    if (act) {
      state.activeId = act.id;
      state.cursor = state.segs.indexOf(act);
      const el = listEl.querySelector('.seg[data-id="' + cssEsc(String(act.id)) + '"]');
      if (el) {
        el.classList.add('active');
        if (!editingNow()) ensureVisible(el);
      }
    } else {
      state.activeId = null;
    }
    lastActive = act;
    lastWord = undefined;
  }

  // subrayado de la palabra que suena
  let wKey = null;
  if (act) {
    const idx = act.words.findIndex(w => t >= w.s + o - 0.001 && t <= w.e + o + 0.001);
    wKey = idx >= 0 ? act.id + ':' + idx : null;
  }
  if (wKey !== lastWord || (wKey && !lastWordEl)) {
    if (lastWordEl) lastWordEl.classList.remove('playing');
    lastWordEl = null;
    if (wKey) {
      const el = listEl.querySelector('.seg[data-id="' + cssEsc(String(act.id)) +
                                      '"] .w[data-i="' + wKey.split(':')[1] + '"]');
      if (el) { el.classList.add('playing'); lastWordEl = el; }
    }
    lastWord = wKey;
  }
}

function ensureVisible(el) {
  const vh = listEl.clientHeight, margin = 70, pad = 8;
  const top = el.offsetTop, h = el.offsetHeight, st = listEl.scrollTop;
  if (top >= st && top + h <= st + vh) return;          // ya está entero a la vista: no tocar
  if (h + 2 * margin > vh) {                            // no cabe con márgenes: alinear arriba
    listEl.scrollTop = Math.max(0, top - pad);
    return;
  }
  listEl.scrollTop = Math.max(0, top < st + margin ? top - margin
                                                  : top + h + margin - vh);
}

/* --------------------------------------------------------------- filtros */

function setFilter(f) {
  state.filter = f;
  document.querySelectorAll('#filters .filt').forEach(b =>
    b.classList.toggle('on', b.dataset.filter === f));
  render(true);
}

/* --------------------------------------------------------------- offset */

function setOffset(ms, fromInput) {
  const v = Math.max(-5000, Math.min(5000, Math.round(Number(ms) || 0)));
  state.offsetMs = v;
  if (!fromInput) offsetEl.value = v;
  offNowEl.textContent = (v > 0 ? '+' : '') + v + ' ms';
  save();
  render(true);
}

/* -------------------------------------------------------------- export */

function download(name, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function buildSrt() {
  const o = off();
  let n = 0;
  const out = [];
  for (const s of state.segs) {
    const txt = textOf(s).trim();
    if (!txt) continue;
    let a = clampT(s.start + o);
    let b = clampT(s.end + o);
    if (b < a) b = a;
    n++;
    out.push(String(n));
    out.push(fmtTime(a) + ' --> ' + fmtTime(b));
    out.push(txt);
    out.push('');
  }
  return out.join('\n');
}

function buildCorrections() {
  const arr = [];
  for (const s of state.segs) {
    if (!Object.prototype.hasOwnProperty.call(state.edits, s.id)) continue;
    const nuevo = state.edits[s.id];
    if (nuevo === s.text) continue;
    arr.push({ id: s.id, original: s.text, nuevo: nuevo });
  }
  return arr;
}

/* --------------------------------------------------------------- eventos */

listEl.addEventListener('click', e => {
  if (e.target && e.target.id === 'clearSearch') { setQuery(''); return; }
  const act = e.target.closest('[data-act]');
  if (act) {
    const seg = act.closest('.seg');
    if (!seg) return;
    if (act.dataset.act === 'play') playSeg(seg.dataset.id);
    else if (act.dataset.act === 'rev') toggleReviewed(seg.dataset.id);
    return;
  }
  const w = e.target.closest('.w');
  if (w) {                                   // click en palabra -> a su inicio
    const seg = w.closest('.seg');
    if (seg) {
      const s = segById(seg.dataset.id);
      state.cursor = state.segs.indexOf(s);
      seekTo(Number(w.dataset.s) + off(), false);
    }
    return;
  }
  const seg = e.target.closest('.seg');
  if (seg) playSeg(seg.dataset.id);           // click en el segmento -> start + play
});

listEl.addEventListener('input', e => {
  const box = e.target.closest && e.target.closest('.seg-text');
  if (!box) return;
  const seg = box.closest('.seg');
  if (!seg) return;
  const id = segById(seg.dataset.id).id;
  const txt = box.textContent.replace(/\u00a0/g, ' ');
  state.edits[id] = txt;
  const cur = segById(seg.dataset.id);
  if (cur) cur.fold = fold(txt);
  box.classList.add('edited');
  if (!state.reviewed.has(String(id))) {
    state.reviewed.add(String(id));
    const el = seg.querySelector('.flags');
    const btn = seg.querySelector('[data-act="rev"]');
    if (btn) btn.textContent = 'desmarcar';
    seg.classList.add('reviewed');
    if (el) el.insertAdjacentHTML('afterbegin', '<span class="flag-rev">✓ revisado</span> ');
  }
  save();
  updateCounters();
});

document.addEventListener('keydown', e => {
  const a = document.activeElement;
  const editable = a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  if (editable) {
    if (e.key === 'Escape' && a.blur) a.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case ' ': case 'Spacebar': e.preventDefault(); togglePlay(); break;
    case 'j': case 'J':        e.preventDefault(); nav(1); break;   // vim: j = bajar = siguiente
    case 'k': case 'K':        e.preventDefault(); nav(-1); break;  // vim: k = subir = anterior
    case 'r': case 'R':        e.preventDefault(); toggleReviewed(currentId()); break;
    case ',':                  e.preventDefault(); setOffset(state.offsetMs - 50); break;
    case '.':                  e.preventDefault(); setOffset(state.offsetMs + 50); break;
  }
});

offsetEl.addEventListener('input', () => setOffset(offsetEl.value, true));
offsetEl.addEventListener('change', () => setOffset(offsetEl.value));
document.getElementById('offMinus').addEventListener('click', () => setOffset(state.offsetMs - 50));
document.getElementById('offPlus').addEventListener('click',  () => setOffset(state.offsetMs + 50));
document.getElementById('offReset').addEventListener('click', () => setOffset(0));

document.querySelectorAll('#filters .filt').forEach(b =>
  b.addEventListener('click', () => setFilter(b.dataset.filter)));

/* --------------------------------------------------------------- búsqueda */

function setQuery(raw, keepFocus) {
  buscarEl.value = raw;
  state.q = fold(String(raw).trim());
  render(true);
  if (keepFocus) buscarEl.focus();
}

buscarEl.addEventListener('input', () => {
  state.q = fold(buscarEl.value.trim());
  render(true);
});
buscarEl.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); setQuery(''); buscarEl.blur(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const first = state.segs.find(passFilter);
    if (first) playSeg(first.id);
  }
});
document.getElementById('buscarClear').addEventListener('click', () => setQuery(''));

document.getElementById('expSrt').addEventListener('click', () => {
  download('TRANSCRIPT_revisado.srt', buildSrt(), 'application/x-subrip');
});
document.getElementById('expJson').addEventListener('click', () => {
  const arr = buildCorrections();
  download('correcciones.json', JSON.stringify(arr, null, 2), 'application/json');
  banner(arr.length
    ? 'Correcciones exportadas: ' + arr.length + ' segmento' + (arr.length > 1 ? 's' : '') + ' cambiado' + (arr.length > 1 ? 's' : '') + '.'
    : 'No hay correcciones que exportar (ningún texto editado).', arr.length ? 'ok' : '');
});

document.getElementById('discard').addEventListener('click', () => {
  if (!confirm('¿Descartar TODOS los cambios guardados (ediciones, marcas de revisado y offset)?\n\nEsta acción no se puede deshacer.')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  state.edits = {};
  state.reviewed = new Set();
  state.offsetMs = 0;
  refreshFold();
  offsetEl.value = 0;
  offNowEl.textContent = '0 ms';
  render();
});

fileEl.addEventListener('change', () => {
  const f = fileEl.files && fileEl.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const raw = JSON.parse(String(r.result));
      if (!raw || !Array.isArray(raw.segments)) throw new Error('falta el array "segments"');
      applyData(raw, f.name);
      banner('Cargado ' + f.name + ' — ' + raw.segments.length + ' segmentos.', 'ok');
    } catch (e) {
      banner('ERROR al leer ' + f.name + ': ' + e.message, 'err');
    }
  };
  r.onerror = () => banner('ERROR al leer ' + f.name, 'err');
  r.readAsText(f);
  fileEl.value = '';
});

audio.addEventListener('error', () => {
  banner('ERROR: no se pudo cargar review/audio.mp3. Genera el fichero con: ' +
         'ffmpeg -i "0708.MP3.mpeg" -c:a copy review/audio.mp3', 'err');
});
audio.addEventListener('loadedmetadata', () => {
  srcInfoEl.textContent = state.segs.length + ' segmentos · audio ' +
    (audio.duration / 60).toFixed(1) + ' min';
});

/* ---------------------------------------------------------------- init */

setFilter('all');
boot();
requestAnimationFrame(tick);
