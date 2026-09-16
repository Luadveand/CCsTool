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
const cTimeEl = document.getElementById('cTime');
const cDelEl  = document.getElementById('cDel');
const cBuscaEl = document.getElementById('cBusca');
const buscarEl = document.getElementById('buscar');
const fileEl   = document.getElementById('fileInput');

const state = {
  segs: [],          // segmentos normalizados, ordenados por start
  src: '—',
  duration: null,
  edits: {},         // id -> texto editado
  timeEdits: {},     // id -> { start, end } tiempos editados (persistencia y revertir)
  deleted: new Set(),// ids borrados (persisten como borrados)
  inserts: [],       // segmentos insertados por el usuario
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
  if (state.filter === 'borrados') {
    if (!s.deleted) return false;
    return !state.q || s.fold.includes(state.q);
  }
  if (s.deleted) return false;
  if (state.filter === 'dudosos' && !isDud(s)) return false;
  if (state.filter === 'pendientes' && state.reviewed.has(String(s.id))) return false;
  if (state.filter === 'tiempo' && !(s.tissues && s.tissues.length)) return false;
  if (state.q && !s.fold.includes(state.q)) return false;
  return true;
}

const alive = s => !s.deleted;

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


/* --------------------------------------------------- tiempos por segmento */

/* Parseo tolerante: acepta "HH:MM:SS,mmm" / "HH:MM:SS.mmm", "M:SS", "MM:SS",
   "SS.mmm" (con , o .) y segundos sueltos. Devuelve NaN si no se entiende. */
function parseTime(str) {
  const t = String(str).trim().replace(',', '.');
  if (!t) return NaN;
  if (/^\d+(?:\.\d+)?$/.test(t)) return parseFloat(t);
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) return NaN;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const frac = m[4] ? Number('0.' + m[4]) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + frac;
}

const eqT = (a, b) => Math.abs(a - b) < 1e-6;

/* Fija start o end (en la línea temporal de los SUBTÍTULOS, sin offset),
   reordena la lista y repinta. Devuelve true si cambió algo. */
function setSegTime(seg, which, t) {
  if (!seg || !isFinite(t)) return false;
  t = clampT(t);
  const before = which === 'start' ? seg.start : seg.end;
  if (eqT(before, t)) return false;
  if (which === 'start') seg.start = t; else seg.end = t;
  if (eqT(seg.start, seg.start0) && eqT(seg.end, seg.end0)) delete state.timeEdits[seg.id];
  else state.timeEdits[seg.id] = { start: seg.start, end: seg.end };
  resortSegs();
  save();
  render(true);
  return true;
}

function resortSegs() {
  state.segs.sort((a, b) => a.start - b.start);   // sort ES2019 = estable
}

/* Ajuste fino ±100 ms sobre start o end. */
function nudge(id, act) {
  const seg = segById(id);
  if (!seg) return;
  const which = act.charAt(0) === 's' ? 'start' : 'end';
  const cur = which === 'start' ? seg.start : seg.end;
  setSegTime(seg, which, cur + (act.charAt(act.length - 1) === '-' ? -0.1 : 0.1));
}

/* «Inicio aquí» / «Fin aquí»: se marca el instante REAL del audio, así que el
   tiempo guardado es currentTime - offset; al exportar se vuelve a sumar el
   offset y el resultado cae exactamente donde el usuario lo marcó. */
function markHere(id, which) {
  const seg = segById(id);
  if (!seg) return;
  setSegTime(seg, which, clampT(audio.currentTime - off()));
}

/* Revertir los tiempos de un segmento a los originales del JSON. */
function revertTimes(id) {
  const seg = segById(id);
  if (!seg) return;
  seg.start = seg.start0;
  seg.end = seg.end0;
  delete state.timeEdits[seg.id];
  resortSegs();
  save();
  render(true);
}

/* Borrar un segmento: se marca como borrado (no se pierde nada) y se saca
   del render, del seguimiento en vivo y del SRT. Se puede deshacer desde
   el filtro «Borrados». Persiste entre recargas. */
function deleteSeg(id) {
  const seg = segById(id);
  if (!seg || seg.deleted) return;
  const n = state.segs.filter(s => s.deleted).length;
  if (!confirm('¿Borrar el subtítulo #' + seg.id + '?\n\nEl borrado persiste al recargar y se puede deshacer desde el filtro «Borrados».')) return;
  seg.deleted = true;
  state.deleted.add(String(id));
  if (state.activeId === seg.id) state.activeId = null;
  save();
  render(true);
  banner('Subtítulo #' + seg.id + ' borrado. (' + (n + 1) + ' borrados en total) — se puede restaurar en el filtro «Borrados».');
}

/* Deshacer un borrado: el segmento vuelve a la lista, al SRT y al conteo. */
function restoreSeg(id) {
  const seg = segById(id);
  if (!seg || !seg.deleted) return;
  seg.deleted = false;
  state.deleted.delete(String(id));
  save();
  render(true);
  banner('Subtítulo #' + seg.id + ' restaurado.');
}

/* Segmento nuevo, vacío y sin words: se muestra y se exporta como texto
   plano (aligned=false evita el coloreado por confianza). */
function makeInsert(spec) {
  const ids = state.segs.map(s => Number(s.id)).filter(Number.isFinite);
  const id = spec && spec.id != null && !segById(spec.id) ? spec.id
           : (ids.length ? Math.max(...ids) : 0) + 1;
  return {
    id,
    start: Number(spec && spec.start) || 0,
    end: Number(spec && spec.end) || 0,
    start0: Number(spec && spec.start) || 0,
    end0: Number(spec && spec.end) || 0,
    text: String(spec && spec.text) || '',
    nsp: 0,
    aligned: false,
    fold: fold(String(spec && spec.text) || ''),
    words: [],
    inserted: true,
  };
}

/* «+ Insertar aquí»: subtitular en la posición actual del audio (2 s). */
function insertHere() {
  const t = clampT(audio.currentTime - off());
  const seg = makeInsert({ start: t, end: t + 2, text: '' });
  state.segs.push(seg);
  state.inserts.push(seg);
  resortSegs();
  state.cursor = state.segs.indexOf(seg);
  state.activeId = seg.id;
  save();
  render(true);
  showSegment(seg.id);
  banner('Subtítulo nuevo #' + seg.id + ' en ' + fmtTime(t) + ' — escribe su texto y ajusta los tiempos.');
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
      start0: Number(s.start) || 0,
      end0: Number(s.end) || 0,
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
  srcInfoEl.textContent = state.segs.filter(alive).length + ' segmentos · ' +
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
        timeEdits: state.timeEdits,
        reviewed: [...state.reviewed],
        offsetMs: state.offsetMs,
        deleted: [...state.deleted],
        inserts: state.inserts,
      }));
    } catch (e) { /* cuota llena / modo privado: se ignora */ }
  }, 250);
}

function restore() {
  state.edits = {};
  state.timeEdits = {};
  state.reviewed = new Set();
  state.offsetMs = 0;
  state.deleted = new Set();
  state.inserts = [];
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { raw = null; }
  if (raw && typeof raw === 'object') {
    // 1) borrados e insertados primero: los edits/reviewed de un insertado
    //    solo se pueden aplicar cuando el segmento ya existe.
    if (Array.isArray(raw.deleted)) {
      raw.deleted.forEach(id => {
        const seg = segById(id);
        if (seg) { seg.deleted = true; state.deleted.add(String(id)); }
      });
    }
    if (Array.isArray(raw.inserts)) {
      for (const ins of raw.inserts) {
        if (!ins || !segById(ins.id)) {
          const seg = makeInsert(ins);
          if (seg) { state.inserts.push(seg); state.segs.push(seg); }
        }
      }
    }
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
    if (raw.timeEdits && typeof raw.timeEdits === 'object') {
      for (const s of state.segs) {
        const te = raw.timeEdits[s.id];
        if (te && Number.isFinite(te.start) && Number.isFinite(te.end)) {
          state.timeEdits[s.id] = { start: te.start, end: te.end };
          s.start = te.start;
          s.end = te.end;
        }
      }
    }
    if (Number.isFinite(raw.offsetMs)) state.offsetMs = raw.offsetMs;
  }
  resortSegs();
  offsetEl.value = state.offsetMs;
  offNowEl.textContent = (state.offsetMs > 0 ? '+' : '') + state.offsetMs + ' ms';
}

/* ------------------------------------------------------------- render */

function render(keepScroll) {
  const t0 = performance.now();
  const keep = keepScroll ? listEl.scrollTop : 0;

  const vis = visibleSegs();

  // integridad temporal: se calcula para TODOS los segmentos vivos (ordenados
  // por start), no solo los visibles, para que el contador y el filtro cuadren.
  for (const s of state.segs) s.tissues = [];
  const vivos = state.segs.filter(alive);
  for (let i = 0; i < vivos.length; i++) {
    vivos[i].tissues = timeIssues(vivos[i], vivos[i - 1], vivos[i + 1]);
  }

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
      if (s.inserted) flags.push('<span class="flag-ins">nuevo</span>');
      if (s.nsp > 0.5) flags.push('<span class="flag-nsp">no_speech ' + s.nsp.toFixed(2) + '</span>');
      if (s.deleted) flags.push('<span class="flag-del">borrado</span>');
      if (s.tissues && s.tissues.length) {
        flags.push('<span class="flag-time" title="Problemas de tiempo: ' +
                   esc(s.tissues.join('; ')) + '">' + esc(s.tissues.join(' · ')) + '</span>');
      }
      return '<article class="seg' + (dud ? ' dud' : '') + (rev ? ' reviewed' : '') +
             (s.deleted ? ' deleted' : '') +
             '" data-id="' + esc(s.id) + '">' +
        '<div class="seg-head">' +
          '<div class="row1"><span class="id">#' + esc(s.id) + '</span>' +
          '<button class="btn play" data-act="play" title="Ir aquí">▶</button></div>' +
          '<span class="ts">' +
            '<button class="btn nudge" data-act="start-" title="inicio −100 ms">−</button>' +
            '<span class="tsv" data-t="start" title="inicio — click para editar">' + fmtTime(a) + '</span>' +
            '<button class="btn nudge" data-act="start+" title="inicio +100 ms">+</button>' +
            ' --&gt; ' +
            '<button class="btn nudge" data-act="end-" title="fin −100 ms">−</button>' +
            '<span class="tsv" data-t="end" title="fin — click para editar">' + fmtTime(b) + '</span>' +
            '<button class="btn nudge" data-act="end+" title="fin +100 ms">+</button>' +
          '</span>' +
          '<span class="dur">dur ' + (b - a).toFixed(2) + ' s' + (o ? ' (offset ' + state.offsetMs + ' ms)' : '') + '</span>' +
          '<span class="flags">' + flags.join(' ') + '</span>' +
        '</div>' +
        '<div class="seg-body">' +
          '<div class="seg-text' + (edited ? ' edited' : '') + '" contenteditable="true" ' +
            'spellcheck="false" role="textbox" aria-label="texto del segmento ' + esc(s.id) + '">' +
            body + '</div>' +
        '</div>' +
        '<div class="seg-actions">' +
          '<button class="btn aux" data-act="set-ini" title="Fijar inicio al instante actual (I)">Inicio aquí</button>' +
          (state.timeEdits[s.id]
            ? '<button class="btn aux" data-act="revert" title="Devolver start/end a los valores del JSON">↺ revertir tiempos</button>'
            : '') +
          (s.deleted
            ? '<button class="btn" data-act="restore" title="Deshacer el borrado">Restaurar</button>'
            : '<button class="btn aux danger" data-act="del" title="Borrar este subtítulo">borrar</button>') +
          '<button class="btn aux" data-act="set-fin" title="Fijar fin al instante actual (O)">Fin aquí</button>' +
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
  state.lastRenderMs = performance.now() - t0;
}


/* ---------- integridad temporal (visible, no bloquea la edición) ---------- */

const MIN_DUR = 1, MAX_DUR = 6, MAX_CPS = 21;

/* prev/next son los vecinos del array completo ordenado por start. */
function timeIssues(s, prev, next) {
  const issues = [];
  const dur = s.end - s.start;
  if (dur <= 0) {
    issues.push('end ≤ start');
  } else {
    if (dur < MIN_DUR) issues.push('dur ' + dur.toFixed(2) + ' s < 1 s');
    if (dur > MAX_DUR) issues.push('dur ' + dur.toFixed(2) + ' s > 6 s');
    const cps = textOf(s).replace(/\s+/g, '').length / dur;
    if (cps > MAX_CPS) issues.push(cps.toFixed(1) + ' cps > ' + MAX_CPS);
  }
  if (prev && prev.end > s.start + 1e-9) issues.push('solapa el anterior');
  if (next && s.end > next.start + 1e-9) issues.push('solapa el siguiente');
  return issues;
}
function cssEsc(s) { return s.replace(/["\\]/g, '\\$&'); }
function updateCounters() {
  const total = state.segs.filter(alive).length;
  const rev = state.segs.filter(s => alive(s) && state.reviewed.has(String(s.id))).length;
  const dud = state.segs.filter(s => alive(s) && isDud(s)).length;
  const vis = visibleSegs().length;
  cRevEl.textContent = 'revisados ' + rev + ' / ' + total;
  cDudEl.textContent = 'dudosos ' + dud;
  cDudEl.classList.toggle('has', dud > 0);
  cVisEl.textContent = 'visibles ' + vis;
  const cPro = state.segs.filter(s => alive(s) && s.tissues && s.tissues.length).length;
  cTimeEl.textContent = cPro + ' con problemas de tiempo';
  cTimeEl.classList.toggle('has', cPro > 0);
  const nDel = state.segs.filter(s => s.deleted).length;
  cDelEl.textContent = 'borrados ' + nDel;
  cDelEl.classList.toggle('hidden', !nDel);
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
  let i = state.cursor;
  for (let paso = 0; paso < state.segs.length; paso++) {
    i = Math.min(state.segs.length - 1, Math.max(0, i + dir));
    if (alive(state.segs[i])) break;
    if ((dir > 0 && i === state.segs.length - 1) || (dir < 0 && i === 0)) break;
  }
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
  return !!(a && a.closest && a.closest('.seg-text, .tin'));
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
    if (alive(s) && t >= s.start + o - 0.001 && t <= s.end + o + 0.001) { act = s; break; }
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
  const orden = state.segs.filter(alive).slice().sort((a, b) => a.start - b.start);
  for (const s of orden) {
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

/* correcciones.json: refleja textos, tiempos, insertados y borrados.
   start/end "original" = los del JSON; "nuevo" = los tiempos efectivos
   (aún SIN offset; el SRT es quien lo aplica). */
function buildCorrections() {
  const arr = [];
  for (const s of state.segs) {
    const te = state.timeEdits[s.id];
    const txtEdit = Object.prototype.hasOwnProperty.call(state.edits, s.id) && state.edits[s.id] !== s.text;
    const borrado = !alive(s);
    const insertado = !!s.inserted;
    if (!txtEdit && !te && !borrado && !insertado) continue;
    arr.push({
      id: s.id,
      texto_original: s.text,
      texto_nuevo: textOf(s),
      start_original: s.start0,
      end_original: s.end0,
      start_nuevo: s.start,
      end_nuevo: s.end,
      insertado,
      borrado,
    });
  }
  return arr;
}

/* --------------------------------------------------------------- eventos */

listEl.addEventListener('click', e => {
  if (e.target && e.target.id === 'clearSearch') { setQuery(''); return; }
  const act = e.target.closest('[data-act]');
  if (act) {
    if (act.classList.contains('nudge')) return;   // los nudges se llevan el pointerdown
    const seg = act.closest('.seg');
    if (!seg) return;
    if (act.dataset.act === 'play') playSeg(seg.dataset.id);
    else if (act.dataset.act === 'rev') toggleReviewed(seg.dataset.id);
    else if (act.dataset.act === 'set-ini') markHere(seg.dataset.id, 'start');
    else if (act.dataset.act === 'set-fin') markHere(seg.dataset.id, 'end');
    else if (act.dataset.act === 'del') deleteSeg(seg.dataset.id);
    else if (act.dataset.act === 'revert') revertTimes(seg.dataset.id);
    else if (act.dataset.act === 'restore') restoreSeg(seg.dataset.id);
    return;
  }
  const tsv = e.target.closest('.tsv');       // click en un timestamp -> editar
  if (tsv) {
    const segEl = tsv.closest('.seg');
    const seg = segEl && segById(segEl.dataset.id);
    if (seg) {
      const inp = document.createElement('input');
      inp.className = 'tin';
      inp.dataset.t = tsv.dataset.t;
      inp.value = tinDisplay(seg, tsv.dataset.t);
      tsv.replaceWith(inp);
      inp.focus();
      inp.select();
    }
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
  if (seg && !e.target.closest('.tin')) playSeg(seg.dataset.id);  // click en el segmento -> start + play
  // (dentro de un campo de tiempo no se salta de sitio: hay que poder editar sin perder el audio)
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

/* ---- campos de tiempo (.tin): commit en change/Enter, rechazo visual ---- */

function tinDisplay(seg, which) {
  return fmtTime(clampT((which === 'start' ? seg.start : seg.end) + off()));
}

function commitTimeInput(tin) {
  const segEl = tin.closest('.seg');
  const seg = segEl && segById(segEl.dataset.id);
  if (!seg) return;
  const which = tin.dataset.t;
  const raw = tin.value;
  const v = parseTime(raw);
  if (!isFinite(v)) {
    // rechazo: se restaura el valor anterior con aviso visual
    tin.value = tinDisplay(seg, which);
    tin.classList.add('bad');
    setTimeout(() => tin.classList.remove('bad'), 1400);
    banner('Tiempo inválido: «' + raw + '». Formas válidas: 00:01:23,450 · 1:23 · 83.5');
    setTimeout(() => { if (bannerEl.textContent.indexOf('Tiempo inválido') === 0) banner(''); }, 4000);
    return;
  }
  // el usuario escribe en tiempo CON offset (lo que ve); se guarda SIN offset
  if (!setSegTime(seg, which, v - off())) render(true);  // sin cambio: recupera el span
}

listEl.addEventListener('change', e => {
  const tin = e.target.closest && e.target.closest('.tin');
  if (tin) commitTimeInput(tin);
});

listEl.addEventListener('keydown', e => {
  const tin = e.target.closest && e.target.closest('.tin');
  if (!tin) return;
  if (e.key === 'Enter') { e.preventDefault(); tin.blur(); }   // blur dispara change
  else if (e.key === 'Escape') {
    const segEl = tin.closest('.seg');
    const seg = segEl && segById(segEl.dataset.id);
    if (seg) tin.value = tinDisplay(seg, tin.dataset.t);
    tin.blur();
  }
});

/* ---- ajuste fino: mantener pulsado repite el nudge ---- */

let nudgeHold = null;

listEl.addEventListener('pointerdown', e => {
  const b = e.target.closest && e.target.closest('.nudge');
  if (!b) return;
  e.preventDefault();                      // no robar el foco ni arrastrar
  const seg = b.closest('.seg');
  if (!seg) return;
  const act = b.dataset.act;
  nudge(seg.dataset.id, act);
  nudgeHold = setTimeout(() => {
    nudgeHold = setInterval(() => {
      const s = segById(seg.dataset.id);
      if (!s) { clearInterval(nudgeHold); return; }
      const cur = act.charAt(0) === 's' ? s.start : s.end;
      setSegTime(s, act.charAt(0) === 's' ? 'start' : 'end', cur + (act.endsWith('-') ? -0.1 : 0.1));
    }, 120);
  }, 400);
  const stop = () => {
    clearTimeout(nudgeHold); clearInterval(nudgeHold);
    nudgeHold = null;
    document.removeEventListener('pointerup', stop);
    document.removeEventListener('pointercancel', stop);
  };
  document.addEventListener('pointerup', stop);
  document.addEventListener('pointercancel', stop);
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
    case 'i': case 'I':        e.preventDefault(); markHere(currentId(), 'start'); break;
    case 'o': case 'O':        e.preventDefault(); markHere(currentId(), 'end'); break;
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
  // aviso previo, sin bloquear: problemas que el SRT llevará (o esconderá)
  const vivos = state.segs.filter(alive)
    .map(s => ({ s, txt: textOf(s).trim() }))
    .sort((a, b) => a.s.start - b.s.start);
  const zero = [], overlap = [], empty = [];
  for (let i = 0; i < vivos.length; i++) {
    const it = vivos[i];
    if (!it.txt) { empty.push(it.s); continue; }
    if (it.s.end <= it.s.start) zero.push(it.s);
    const next = vivos[i + 1];
    if (next && it.s.end > next.s.start + 1e-9) overlap.push(it.s);
  }
  const idList = arr => arr.length ? ' (' + arr.slice(0, 6).map(s => '#' + s.id).join(', ') +
    (arr.length > 6 ? ', …' : '') + ')' : '';
  let msg = '';
  if (zero.length) msg += '· ' + zero.length + ' subtítulo' + (zero.length > 1 ? 's' : '') +
    ' con end ≤ start: el SRT llevará duración CERO' + idList(zero) + '.\n';
  if (overlap.length) msg += '· ' + overlap.length + ' con solape con el siguiente.\n';
  if (empty.length) msg += '· ' + empty.length + ' vivo' + (empty.length > 1 ? 's' : '') +
    ' con texto vacío, que NO se exportará' + idList(empty) + '.\n';
  if (msg && !confirm('Avisos del SRT a exportar:\n\n' + msg +
      '\n¿Exportar igualmente? (Cancelar = no se descarga nada)')) return;
  download('TRANSCRIPT_revisado.srt', buildSrt(), 'application/x-subrip');
});
document.getElementById('expJson').addEventListener('click', () => {
  const arr = buildCorrections();
  download('correcciones.json', JSON.stringify(arr, null, 2), 'application/json');
  banner(arr.length
    ? 'Correcciones exportadas: ' + arr.length + ' segmento' + (arr.length > 1 ? 's' : '') +
      ' con cambios (texto, tiempos, insertados o borrados).'
    : 'No hay correcciones que exportar (ningún texto ni tiempo editado, ni insertados ni borrados).', arr.length ? 'ok' : '');
});

document.getElementById('discard').addEventListener('click', () => {
  if (!confirm('¿Descartar TODOS los cambios guardados (textos, tiempos, insertados, borrados, marcas de revisado y offset)?\n\nEsta acción no se puede deshacer.')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  state.edits = {};
  state.timeEdits = {};
  state.reviewed = new Set();
  state.offsetMs = 0;
  state.deleted = new Set();
  state.inserts = [];
  for (const s of state.segs) {
    s.deleted = false;
    s.start = s.start0;
    s.end = s.end0;
  }
  state.segs = state.segs.filter(s => !s.inserted);
  resortSegs();
  refreshFold();
  offsetEl.value = 0;
  offNowEl.textContent = '0 ms';
  render();
});

document.getElementById('insertHere').addEventListener('click', () => insertHere());

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
  srcInfoEl.textContent = state.segs.filter(alive).length + ' segmentos · audio ' +
    (audio.duration / 60).toFixed(1) + ' min';
});

/* ---------------------------------------------------------------- init */

setFilter('all');
boot();
requestAnimationFrame(tick);
