/* BF_DOM_SAFETY_NET_V1
   Prevent “Missing element …” from blanking the board.
   If code requests a selector like "#someId" and it’s missing, we create a stub and keep going.
*/
function bfAutoCreate(selector) {
  const sel = (selector == null) ? "" : String(selector);
  const idRaw = sel.startsWith("#") ? sel.slice(1) : sel;
  const id = idRaw.trim().replace(/[^\w\-:.]/g, "");
  const lid = id.toLowerCase();

  // Choose a reasonable tag
  let tag = "div";
  if (lid.endsWith("btn") || lid.includes("button")) tag = "button";
  else if (lid.includes("canvas")) tag = "canvas";
  else if (lid.includes("input")) tag = "input";
  else if (lid.includes("select")) tag = "select";

  // Prefer a sensible parent when possible
  const boardHost =
    document.querySelector("#boardHost, #boardWrap, #boardArea, #board, #game, #main") || null;

  let parent = document.body;
  if (lid.includes("board") || lid.includes("canvas")) parent = boardHost || document.body;

  // Create or reuse
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement(tag);
    el.id = id;
    if (tag === "button" && !el.textContent) el.textContent = id;
    parent.appendChild(el);
  }

  console.warn("BF: auto-created missing element:", sel, "->", "#" + id);
  return el;
}


'use strict';

/*
  Bannerfall — BF9 (Calibration build)
  - RB01: unit may activate only once per turn (spent state)
  - 3 activations per turn
  - Editor: shape/terrain/units + export/import JSON + demo setup
  - UI: historical token shapes + quality outline + 2 lines of text (TYPE + HP)
  - Board: stretched wide hex (17 center row, 12 top/bottom)
*/

const GAME_NAME = 'Bannerfall';
const BUILD_ID  = 'BF9';

const CONFIG = {
  hexSize: 34,
  horizRadius: 8,   // r=0 width=17
  vertRadius:  5,   // total rows = 11, top/bottom width=12
  actsPerTurn: 3,

  terrain: {
    clear: { fill: 'rgba(255,255,255,0.05)' },
    hills: { fill: 'rgba(200,170,110,0.24)' },
    woods: { fill: 'rgba(120,200,140,0.24)' },
    rough: { fill: 'rgba(180,180,190,0.22)' },
    water: { fill: 'rgba(120,170,255,0.28)' },
  },

  // RB01 movement costs
  moveCost: {
    clear: { INF:1, CAV:1, SKR:1, ARC:1, GEN:1 },
    hills: { INF:2, CAV:3, SKR:2, ARC:2, GEN:2 },
    woods: { INF:2, CAV:3, SKR:2, ARC:2, GEN:2 },
    rough: { INF:2, CAV:3, SKR:2, ARC:2, GEN:2 },
    water: { INF:Infinity, CAV:Infinity, SKR:Infinity, ARC:Infinity, GEN:Infinity },
  },

  // RB01 stats
  unitStats: {
    INF: { hp:3, up:3, mp:1 },
    CAV: { hp:2, up:4, mp:2 },
    SKR: { hp:2, up:2, mp:2 },
    ARC: { hp:2, up:2, mp:1 },
    GEN: { hp:2, up:5, mp:2 }, // per your requirement
  },

  // UI tuning
  ui: {
    bg: '#0b0b0e',
    gridStroke: 'rgba(255,255,255,0.10)',   // brighter than before
    activeStroke: 'rgba(255,255,255,0.14)', // ≈30%+ bump vs very-dark
    activeFill: 'rgba(255,255,255,0.04)',
    moveStroke: 'rgba(120,170,255,0.55)',
    pathStroke: 'rgba(140,200,255,0.35)',
    selectStroke: 'rgba(255,220,120,0.70)',
    selectSpentStroke: 'rgba(220,220,235,0.45)',
    hoverStroke: 'rgba(180,200,255,0.45)',
  },

  // Token encoding (historical, simple)
  sideFill: {
    blue: 'rgba(70,150,255,0.74)',
    red:  'rgba(255,90,90,0.70)',
  },

  // Quality outline = the rank ring
  qualityStroke: {
    green:   'rgba(80,220,140,0.95)',  // emerald
    regular: 'rgba(210,210,220,0.95)', // silver
    veteran: 'rgba(240,200,90,0.95)',  // gold
  },
};

const HEX_DIRS = [
  { q:  1, r:  0 },
  { q:  1, r: -1 },
  { q:  0, r: -1 },
  { q: -1, r:  0 },
  { q: -1, r:  1 },
  { q:  0, r:  1 },
];

const VALID_SIDES = new Set(['blue','red']);
const VALID_TYPES = new Set(['INF','CAV','SKR','ARC','GEN']);
const VALID_QUALS = new Set(['green','regular','veteran']);
const VALID_TERR = new Set(Object.keys(CONFIG.terrain));

const state = {
  buildId: BUILD_ID,
  htmlBuild: '?',
  buildMismatch: false,

  mode: 'edit',          // default to edit so you can place units immediately
  tool: 'shape',
  terrainBrush: 'woods',
  unitBrush: { side: 'blue', type: 'INF', quality: 'regular' },

  turn: { side: 'blue', number: 1, actsLeft: CONFIG.actsPerTurn },

  board: {
    active: new Set(),
    terrain: new Map(), // key -> terrainId
  },

  units: new Map(), // key -> unit object

  selection: {
    key: null,            // selected unit position key
    moveTargets: new Set(),
    moveCost: new Map(),
    movePrev: new Map(),
    hoverPath: null,
    hoverCost: null,
  },

  ui: {
    hoverHex: null,
    painting: false,
    lastPaintKey: null,
  },

  log: [],
  lastEvent: 'boot',
};

const view = { ox: 0, oy: 0, size: CONFIG.hexSize };

// ---------- DOM helpers ----------
function $(id){
  const el = document.getElementById(id);
  if (!el) return bfAutoCreate(id);
  return el;
}

function getHtmlBuild(){
  const meta = document.querySelector('meta[name="bannerfall-build"]');
  return meta ? (meta.getAttribute('content') || '(empty)') : '(missing)';
}

function setStatusLine(txt){
  $('statusLine').textContent = txt;
}

function nowStamp(){
  try { return new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }); }
  catch { return String(Date.now()); }
}

function logEvent(msg){
  const line = `${nowStamp()} ${msg}`;
  state.log.unshift(line);
  if (state.log.length > 80) state.log.pop();
  state.lastEvent = msg;
  syncLogUI();
}

// ---------- hex math ----------
function hexKey(q, r){ return `${q},${r}`; }
function parseKey(k){
  const [qs, rs] = k.split(',');
  return { q: Number(qs), r: Number(rs) };
}

function isWithinFrame(q, r){
  const R = CONFIG.horizRadius;
  const V = CONFIG.vertRadius;
  if (r < -V || r > V) return false;
  const qMin = Math.max(-R, -r - R);
  const qMax = Math.min( R, -r + R);
  return q >= qMin && q <= qMax;
}

function makeFrameHexes(){
  const R = CONFIG.horizRadius;
  const V = CONFIG.vertRadius;
  const out = [];
  for (let r = -V; r <= V; r++){
    const qMin = Math.max(-R, -r - R);
    const qMax = Math.min( R, -r + R);
    for (let q = qMin; q <= qMax; q++) out.push({ q, r });
  }
  out.sort((a,b) => (a.r - b.r) || (a.q - b.q));
  return out;
}

function axialToPixel(q, r, size){
  const x = size * Math.sqrt(3) * (q + r / 2);
  const y = size * (3/2) * r;
  return { x, y };
}

function pixelToAxial(x, y, size){
  const q = (Math.sqrt(3)/3 * x - 1/3 * y) / size;
  const r = (2/3 * y) / size;
  return { q, r };
}

function axialRound(fracQ, fracR){
  // cube coords: x=q, z=r, y=-x-z
  const x = fracQ;
  const z = fracR;
  const y = -x - z;

  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const dx = Math.abs(rx - x);
  const dy = Math.abs(ry - y);
  const dz = Math.abs(rz - z);

  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;

  return { q: rx, r: rz };
}

function hexCorners(cx, cy, size){
  const pts = [];
  for (let i = 0; i < 6; i++){
    const angle = (Math.PI/180) * (60*i - 30);
    pts.push({ x: cx + size*Math.cos(angle), y: cy + size*Math.sin(angle) });
  }
  return pts;
}

function drawHexPath(ctx, pts){
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

function resizeCanvas(canvas, ctx){
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function computeLayout(frameHexes, canvas){
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const h of frameHexes){
    const p = axialToPixel(h.q, h.r, CONFIG.hexSize);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  const islandW = (maxX - minX) + CONFIG.hexSize * 2;
  const islandH = (maxY - minY) + CONFIG.hexSize * 2;

  view.ox = (w - islandW) / 2 + CONFIG.hexSize - minX;
  view.oy = (h - islandH) / 2 + CONFIG.hexSize - minY;
  view.size = CONFIG.hexSize;
}

function getCanvasPoint(ev, canvas){
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function pickHexAt(canvasX, canvasY){
  const localX = canvasX - view.ox;
  const localY = canvasY - view.oy;
  const frac = pixelToAxial(localX, localY, view.size);
  const h = axialRound(frac.q, frac.r);
  if (!isWithinFrame(h.q, h.r)) return null;
  return h;
}

// ---------- terrain + movement ----------
function getTerrainId(k){ return state.board.terrain.get(k) || 'clear'; }
function setTerrainId(k, tid){
  if (tid === 'clear') state.board.terrain.delete(k);
  else state.board.terrain.set(k, tid);
}

function moveCost(type, terrainId){
  const row = CONFIG.moveCost[terrainId] || CONFIG.moveCost.clear;
  const c = row[type];
  return Number.isFinite(c) ? c : Infinity;
}

function clearMoveOverlay(){
  state.selection.moveTargets = new Set();
  state.selection.moveCost = new Map();
  state.selection.movePrev = new Map();
  state.selection.hoverPath = null;
  state.selection.hoverCost = null;
}

function computeReachable(startKey, unitType, mpBudget){
  const dist = new Map();
  const prev = new Map();
  const open = [];

  dist.set(startKey, 0);
  open.push({ k: startKey, c: 0 });

  while (open.length){
    // pick min cost entry
    let best = 0;
    for (let i = 1; i < open.length; i++){
      if (open[i].c < open[best].c) best = i;
    }
    const cur = open.splice(best, 1)[0];
    const curBest = dist.get(cur.k);
    if (curBest !== cur.c) continue;

    const { q, r } = parseKey(cur.k);
    for (const d of HEX_DIRS){
      const nk = hexKey(q + d.q, r + d.r);

      if (!state.board.active.has(nk)) continue;
      if (nk !== startKey && state.units.has(nk)) continue;

      const step = moveCost(unitType, getTerrainId(nk));
      if (!Number.isFinite(step)) continue;

      const nc = cur.c + step;
      if (nc > mpBudget) continue;

      const old = dist.get(nk);
      if (old === undefined || nc < old){
        dist.set(nk, nc);
        prev.set(nk, cur.k);
        open.push({ k: nk, c: nc });
      }
    }
  }

  const targets = new Set();
  for (const [k, c] of dist.entries()){
    if (k !== startKey && c <= mpBudget) targets.add(k);
  }
  return { targets, dist, prev };
}

function buildPath(prevMap, startKey, destKey){
  const path = [];
  let cur = destKey;
  while (cur && cur !== startKey){
    path.push(cur);
    cur = prevMap.get(cur);
  }
  if (cur !== startKey) return null;
  path.push(startKey);
  path.reverse();
  return path;
}

// ---------- unit rules (RB01 spent) ----------
function selectedUnit(){
  const k = state.selection.key;
  if (!k) return null;
  return state.units.get(k) || null;
}

function isSpent(u){
  if (!u) return false;
  if (u.side !== state.turn.side) return false;
  return u.actedTurn === state.turn.number;
}

function canAct(u){
  if (!u) return false;
  if (state.mode !== 'play') return false;
  if (state.turn.actsLeft <= 0) return false;
  if (u.side !== state.turn.side) return false;
  if (isSpent(u)) return false;
  return true;
}

function recomputeMoveTargets(){
  clearMoveOverlay();

  const k = state.selection.key;
  const u = selectedUnit();
  if (!k || !u) return;

  if (!canAct(u)) return;

  const mp = CONFIG.unitStats[u.type].mp;
  const res = computeReachable(k, u.type, mp);
  state.selection.moveTargets = res.targets;
  state.selection.moveCost = res.dist;
  state.selection.movePrev = res.prev;
}

function clearSelection(){
  state.selection.key = null;
  clearMoveOverlay();
}

function selectHex(k){
  clearSelection();

  if (!k) {
    logEvent('select:clear');
    return;
  }
  const u = state.units.get(k);
  if (!u){
    logEvent(`select:empty ${k}`);
    return;
  }

  state.selection.key = k;

  const tag = (u.side === state.turn.side)
    ? (isSpent(u) ? 'spent' : 'ready')
    : 'enemy';

  logEvent(`select:${u.side} ${u.type} ${k} (${tag})`);
  recomputeMoveTargets();
}

function tryMove(destKey){
  const fromKey = state.selection.key;
  const u = selectedUnit();
  if (!fromKey || !u) return false;

  if (!canAct(u)){
    logEvent('move:blocked (cannotAct)');
    return false;
  }

  if (!state.selection.moveTargets.has(destKey)){
    logEvent(`move:blocked (unreachable) ${destKey}`);
    return false;
  }

  state.units.delete(fromKey);
  state.units.set(destKey, u);

  // spend act + mark unit spent
  state.turn.actsLeft = Math.max(0, state.turn.actsLeft - 1);
  u.actedTurn = state.turn.number;

  const c = state.selection.moveCost.get(destKey);
  logEvent(`MOVE ${u.side.toUpperCase()} ${u.type} ${fromKey} -> ${destKey} cost=${c} acts=${state.turn.actsLeft}`);

  // RB01: clear selection after committing activation (prevents chain-move)
  clearSelection();

  return true;
}

function passWithSelected(){
  const u = selectedUnit();
  if (!u) return;
  if (!canAct(u)){
    logEvent('pass:blocked (cannotAct)');
    return;
  }

  state.turn.actsLeft = Math.max(0, state.turn.actsLeft - 1);
  u.actedTurn = state.turn.number;
  logEvent(`PASS ${u.side.toUpperCase()} ${u.type} ${state.selection.key} acts=${state.turn.actsLeft}`);
  clearSelection();
}

function endTurn(){
  if (state.mode !== 'play'){
    logEvent('endTurn:blocked (not play)');
    return;
  }

  const prev = state.turn.side;
  const next = (prev === 'blue') ? 'red' : 'blue';

  state.turn.side = next;
  state.turn.number += 1;
  state.turn.actsLeft = CONFIG.actsPerTurn;

  clearSelection();
  logEvent(`TURN ${next.toUpperCase()} acts=${state.turn.actsLeft} tn=${state.turn.number}`);
}

// ---------- editor ----------
function toggleActive(q, r){
  const k = hexKey(q, r);
  if (state.board.active.has(k)){
    state.board.active.delete(k);
    state.board.terrain.delete(k);
    state.units.delete(k);
    if (state.selection.key === k) clearSelection();
    logEvent(`shape:off ${k}`);
  }else{
    state.board.active.add(k);
    logEvent(`shape:on ${k}`);
  }
}

function paintTerrain(q, r){
  const k = hexKey(q, r);
  if (!state.board.active.has(k)) return;
  setTerrainId(k, state.terrainBrush);
  logEvent(`terrain:${state.terrainBrush} ${k}`);
}

function placeUnit(q, r){
  const k = hexKey(q, r);
  if (!state.board.active.has(k)) return;

  if (state.units.has(k)){
    state.units.delete(k);
    logEvent(`unit:remove ${k}`);
    return;
  }

  const side = state.unitBrush.side;
  const type = state.unitBrush.type;

  let quality = state.unitBrush.quality;
  if (type === 'GEN') quality = 'green'; // hard rule

  const stats = CONFIG.unitStats[type];
  state.units.set(k, {
    side,
    type,
    quality,
    hp: stats.hp,
    up: stats.up,
    actedTurn: 0,
  });
  logEvent(`unit:place ${side} ${type} ${quality} ${k}`);
}

function clearUnits(resetTurn=true){
  const n = state.units.size;
  state.units.clear();
  clearSelection();
  logEvent(`units:clear (${n})`);

  if (resetTurn){
    state.turn.side = 'blue';
    state.turn.number = 1;
    state.turn.actsLeft = CONFIG.actsPerTurn;
    logEvent(`TURN BLUE acts=${state.turn.actsLeft} tn=${state.turn.number}`);
  }
}

function demoSetup(){
  clearUnits(true);

  const P = [
    // BLUE (bottom)
    { q: 0, r: 4, side:'blue', type:'GEN', quality:'green' },
    { q:-1, r: 3, side:'blue', type:'INF', quality:'regular' },
    { q: 0, r: 3, side:'blue', type:'INF', quality:'regular' },
    { q: 1, r: 3, side:'blue', type:'INF', quality:'regular' },
    { q: 0, r: 5, side:'blue', type:'ARC', quality:'regular' },
    { q:-3, r: 2, side:'blue', type:'CAV', quality:'regular' },
    { q: 3, r: 2, side:'blue', type:'CAV', quality:'regular' },
    { q:-2, r: 4, side:'blue', type:'SKR', quality:'regular' },
    { q: 2, r: 4, side:'blue', type:'SKR', quality:'regular' },

    // RED (top)
    { q: 0, r:-4, side:'red', type:'GEN', quality:'green' },
    { q:-1, r:-3, side:'red', type:'INF', quality:'regular' },
    { q: 0, r:-3, side:'red', type:'INF', quality:'regular' },
    { q: 1, r:-3, side:'red', type:'INF', quality:'regular' },
    { q: 0, r:-5, side:'red', type:'ARC', quality:'regular' },
    { q:-3, r:-2, side:'red', type:'CAV', quality:'regular' },
    { q: 3, r:-2, side:'red', type:'CAV', quality:'regular' },
    { q:-2, r:-4, side:'red', type:'SKR', quality:'regular' },
    { q: 2, r:-4, side:'red', type:'SKR', quality:'regular' },
  ];

  let placed = 0;
  for (const u of P){
    if (!isWithinFrame(u.q, u.r)) continue;
    const k = hexKey(u.q, u.r);
    if (!state.board.active.has(k)) continue;
    if (state.units.has(k)) continue;

    const stats = CONFIG.unitStats[u.type];
    const quality = (u.type === 'GEN') ? 'green' : u.quality;

    state.units.set(k, {
      side: u.side,
      type: u.type,
      quality,
      hp: stats.hp,
      up: stats.up,
      actedTurn: 0,
    });
    placed += 1;
  }

  logEvent(`demo:setup placed=${placed}`);
  setIoStatus(`Demo setup placed ${placed} units.`);
}

// ---------- scenario IO ----------
function scenarioFromState(){
  const active = Array.from(state.board.active);
  active.sort((a,b) => {
    const A = parseKey(a), B = parseKey(b);
    return (A.r - B.r) || (A.q - B.q);
  });

  const terrain = {};
  for (const [k, t] of state.board.terrain.entries()){
    if (state.board.active.has(k)) terrain[k] = t;
  }

  const units = [];
  for (const [k, u] of state.units.entries()){
    const { q, r } = parseKey(k);
    units.push({ q, r, side:u.side, type:u.type, quality:u.quality });
  }
  units.sort((a,b)=> (a.r-b.r)||(a.q-b.q)||a.side.localeCompare(b.side)||a.type.localeCompare(b.type));

  return {
    version: 1,
    game: GAME_NAME,
    build: BUILD_ID,
    savedAt: new Date().toISOString(),
    board: { active, terrain },
    units,
  };
}

function importScenario(obj){
  if (!obj || typeof obj !== 'object') throw new Error('JSON root must be an object.');
  if (!obj.board || typeof obj.board !== 'object') throw new Error('Missing board.');
  if (!Array.isArray(obj.board.active)) throw new Error('board.active must be an array.');

  const nextActive = new Set();
  for (const item of obj.board.active){
    if (typeof item !== 'string') continue;
    if (!item.includes(',')) continue;
    const { q, r } = parseKey(item);
    if (!Number.isFinite(q) || !Number.isFinite(r)) continue;
    if (!isWithinFrame(q, r)) continue;
    nextActive.add(hexKey(q, r));
  }
  if (nextActive.size === 0) throw new Error('Import produced zero active hexes.');

  const nextTerrain = new Map();
  const terr = obj.board.terrain || {};
  if (terr && typeof terr === 'object'){
    for (const [k, v] of Object.entries(terr)){
      const tid = String(v);
      if (!nextActive.has(k)) continue;
      if (!VALID_TERR.has(tid)) continue;
      if (tid === 'clear') continue;
      nextTerrain.set(k, tid);
    }
  }

  const nextUnits = new Map();
  const list = Array.isArray(obj.units) ? obj.units : [];
  for (const u of list){
    if (!u || typeof u !== 'object') continue;
    const q = Number(u.q), r = Number(u.r);
    const side = String(u.side||'');
    const type = String(u.type||'');
    let quality = String(u.quality||'');

    if (!Number.isFinite(q) || !Number.isFinite(r)) continue;
    const k = hexKey(q, r);
    if (!nextActive.has(k)) continue;
    if (!VALID_SIDES.has(side) || !VALID_TYPES.has(type)) continue;

    if (type === 'GEN') quality = 'green';
    if (!VALID_QUALS.has(quality)) quality = (type === 'GEN') ? 'green' : 'regular';

    const stats = CONFIG.unitStats[type];
    nextUnits.set(k, { side, type, quality, hp: stats.hp, up: stats.up, actedTurn: 0 });
  }

  state.board.active = nextActive;
  state.board.terrain = nextTerrain;
  state.units = nextUnits;

  clearSelection();

  state.turn.side = 'blue';
  state.turn.number = 1;
  state.turn.actsLeft = CONFIG.actsPerTurn;
  logEvent(`io:import ok active=${nextActive.size} terrain=${nextTerrain.size} units=${nextUnits.size}`);
  logEvent(`TURN BLUE acts=${state.turn.actsLeft} tn=${state.turn.number}`);

  setIoStatus(`Imported active=${nextActive.size} terrain=${nextTerrain.size} units=${nextUnits.size}`);
}

// ---------- UI sync ----------
function syncLogUI(){
  const box = $('logList');
  box.innerHTML = '';
  const n = Math.min(state.log.length, 26);
  for (let i = 0; i < n; i++){
    const div = document.createElement('div');
    div.className = 'logItem';
    div.textContent = state.log[i];
    box.appendChild(div);
  }
}

function syncSidebar(){
  $('modePlayBtn').classList.toggle('isActive', state.mode === 'play');
  $('modeEditBtn').classList.toggle('isActive', state.mode === 'edit');

  $('modeHint').textContent = (state.mode === 'play')
    ? 'Play mode (editor disabled)'
    : 'Edit mode (paint terrain, place units, sculpt board)';

  const editOn = (state.mode === 'edit');

  $('toolShape').disabled = !editOn;
  $('toolTerrain').disabled = !editOn;
  $('toolUnits').disabled = !editOn;

  $('toolShape').classList.toggle('isActive', editOn && state.tool === 'shape');
  $('toolTerrain').classList.toggle('isActive', editOn && state.tool === 'terrain');
  $('toolUnits').classList.toggle('isActive', editOn && state.tool === 'units');

  const toolHint = $('toolHint');
  if (!editOn) toolHint.textContent = 'Switch to Edit mode to use tools.';
  else if (state.tool === 'shape') toolHint.textContent = 'Shape: click hex to toggle active/inactive.';
  else if (state.tool === 'terrain') toolHint.textContent = 'Terrain: click or drag to paint.';
  else toolHint.textContent = 'Units: click empty hex to place; click a unit to remove.';

  // palettes
  for (const btn of document.querySelectorAll('.terrainBtn')){
    btn.disabled = !editOn;
    const t = btn.getAttribute('data-terrain') || 'clear';
    btn.classList.toggle('isActive', editOn && t === state.terrainBrush);
  }

  for (const btn of document.querySelectorAll('.unitBtn[data-side]')){
    btn.disabled = !editOn;
    const s = btn.getAttribute('data-side') || 'blue';
    btn.classList.toggle('isActive', editOn && s === state.unitBrush.side);
  }

  for (const btn of document.querySelectorAll('.unitBtn[data-utype]')){
    btn.disabled = !editOn;
    const t = btn.getAttribute('data-utype') || 'INF';
    btn.classList.toggle('isActive', editOn && t === state.unitBrush.type);
  }

  const typeIsGen = (state.unitBrush.type === 'GEN');
  for (const btn of document.querySelectorAll('.unitBtn[data-quality]')){
    const q = btn.getAttribute('data-quality') || 'regular';
    btn.disabled = !editOn || (typeIsGen && q !== 'green');
    btn.classList.toggle('isActive', editOn && (typeIsGen ? (q === 'green') : (q === state.unitBrush.quality)));
  }

  $('turnSideBadge').textContent = state.turn.side.toUpperCase();
  $('actsLeft').textContent = String(state.turn.actsLeft);

  // pass/end turn only make sense in play
  $('passBtn').disabled = !(state.mode === 'play' && !!selectedUnit() && canAct(selectedUnit()));
  $('endTurnBtn').disabled = !(state.mode === 'play');

  // import/export always allowed, but import will overwrite state (we allow it)
}

function setIoStatus(txt){
  $('ioStatus').textContent = txt;
}

// ---------- token drawing ----------
function roundedRectPath(ctx, x, y, w, h, r){
  const rr = Math.max(0, Math.min(r, w/2, h/2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function starPath(ctx, cx, cy, outerR, innerR, points=5){
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++){
    const a = (Math.PI / points) * i - Math.PI/2;
    const r = (i % 2 === 0) ? outerR : innerR;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function tokenPath(ctx, type, cx, cy, s){
  // s is a scale radius-ish
  if (type === 'INF'){
    const w = s * 1.45;
    const h = s * 1.05;
    roundedRectPath(ctx, cx - w/2, cy - h/2, w, h, Math.max(4, s*0.25));
    return;
  }

  if (type === 'ARC'){
    const a = s * 1.08;
    ctx.beginPath();
    ctx.moveTo(cx, cy - a);
    ctx.lineTo(cx + a * 0.95, cy + a * 0.95);
    ctx.lineTo(cx - a * 0.95, cy + a * 0.95);
    ctx.closePath();
    return;
  }

  if (type === 'SKR'){
    const a = s * 1.10;
    ctx.beginPath();
    ctx.moveTo(cx, cy - a);
    ctx.lineTo(cx + a, cy);
    ctx.lineTo(cx, cy + a);
    ctx.lineTo(cx - a, cy);
    ctx.closePath();
    return;
  }

  if (type === 'CAV'){
    // shield-ish pentagon (historical vibe, roomy interior)
    const w = s * 1.30;
    const h = s * 1.35;
    ctx.beginPath();
    ctx.moveTo(cx - w*0.55, cy - h*0.55);
    ctx.lineTo(cx + w*0.55, cy - h*0.55);
    ctx.lineTo(cx + w*0.65, cy + h*0.10);
    ctx.lineTo(cx,           cy + h*0.70);
    ctx.lineTo(cx - w*0.65, cy + h*0.10);
    ctx.closePath();
    return;
  }

  // GEN
  starPath(ctx, cx, cy, s*1.05, s*0.50, 5);
}

function drawUnit(ctx, cx, cy, unit){
  const s = CONFIG.hexSize * 0.58;
  const fill = CONFIG.sideFill[unit.side] || CONFIG.sideFill.blue;
  const stroke = CONFIG.qualityStroke[unit.quality] || CONFIG.qualityStroke.regular;

  ctx.save();

  // spent dims (for active side only in play mode)
  const spentNow = (state.mode === 'play' && unit.side === state.turn.side && unit.actedTurn === state.turn.number);
  ctx.globalAlpha = spentNow ? 0.62 : 1.0;

  tokenPath(ctx, unit.type, cx, cy, s);
  ctx.fillStyle = fill;
  ctx.fill();

  // quality outline ring
  ctx.lineWidth = 4;
  ctx.strokeStyle = stroke;
  ctx.stroke();

  // crisp inner edge (subtle)
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.30)';
  ctx.stroke();

  // text
  ctx.globalAlpha = spentNow ? 0.70 : 1.0;
  ctx.fillStyle = 'rgba(245,245,250,0.95)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = '800 11px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
  ctx.fillText(unit.type, cx, cy - 6);

  ctx.font = '800 10px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
  ctx.fillText(`HP ${unit.hp}`, cx, cy + 8);

  // spent slash (very explicit)
  if (spentNow){
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.moveTo(cx - s*0.95, cy - s*0.85);
    ctx.lineTo(cx + s*0.95, cy + s*0.85);
    ctx.stroke();
  }

  ctx.restore();
}

// ---------- render ----------
function render(canvas, ctx, frameHexes){
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = CONFIG.ui.bg;
  ctx.fillRect(0, 0, w, h);

  computeLayout(frameHexes, canvas);

  // Draw frame grid (for orientation)
  ctx.lineWidth = 1;
  ctx.strokeStyle = CONFIG.ui.gridStroke;
  for (const hex of frameHexes){
    const p = axialToPixel(hex.q, hex.r, CONFIG.hexSize);
    const cx = p.x + view.ox;
    const cy = p.y + view.oy;
    const pts = hexCorners(cx, cy, CONFIG.hexSize - 1);
    drawHexPath(ctx, pts);
    ctx.stroke();
  }

  // Active hexes (fill + terrain tint + brighter border)
  for (const k of state.board.active){
    const { q, r } = parseKey(k);
    const p = axialToPixel(q, r, CONFIG.hexSize);
    const cx = p.x + view.ox;
    const cy = p.y + view.oy;
    const pts = hexCorners(cx, cy, CONFIG.hexSize - 1);

    drawHexPath(ctx, pts);

    // base ground
    ctx.fillStyle = CONFIG.ui.activeFill;
    ctx.fill();

    // terrain tint (adds on top)
    const tid = getTerrainId(k);
    const t = CONFIG.terrain[tid] || CONFIG.terrain.clear;
    ctx.fillStyle = t.fill;
    ctx.fill();

    // border
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = CONFIG.ui.activeStroke;
    ctx.stroke();
  }

  // Move targets (play)
  if (state.mode === 'play' && state.selection.moveTargets.size > 0){
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = CONFIG.ui.moveStroke;
    for (const k of state.selection.moveTargets){
      const { q, r } = parseKey(k);
      const p = axialToPixel(q, r, CONFIG.hexSize);
      const pts = hexCorners(p.x + view.ox, p.y + view.oy, CONFIG.hexSize - 1);
      drawHexPath(ctx, pts);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Hover path preview (play)
  if (state.mode === 'play' && state.selection.hoverPath && state.selection.hoverPath.length >= 2){
    ctx.save();
    ctx.setLineDash([3, 7]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = CONFIG.ui.pathStroke;
    ctx.beginPath();
    for (let i = 0; i < state.selection.hoverPath.length; i++){
      const k = state.selection.hoverPath[i];
      const { q, r } = parseKey(k);
      const p = axialToPixel(q, r, CONFIG.hexSize);
      const cx = p.x + view.ox;
      const cy = p.y + view.oy;
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Units
  for (const [k, u] of state.units.entries()){
    const { q, r } = parseKey(k);
    const p = axialToPixel(q, r, CONFIG.hexSize);
    drawUnit(ctx, p.x + view.ox, p.y + view.oy, u);
  }

  // Selection ring (play)
  if (state.mode === 'play' && state.selection.key){
    const k = state.selection.key;
    const u = state.units.get(k);
    const { q, r } = parseKey(k);
    const p = axialToPixel(q, r, CONFIG.hexSize);
    const pts = hexCorners(p.x + view.ox, p.y + view.oy, CONFIG.hexSize - 1);

    ctx.lineWidth = 3;
    const spentSel = (u && isSpent(u));
    ctx.strokeStyle = spentSel ? CONFIG.ui.selectSpentStroke : CONFIG.ui.selectStroke;
    drawHexPath(ctx, pts);
    ctx.stroke();
  }

  // Hover ring (edit)
  if (state.mode === 'edit' && state.ui.hoverHex){
    const { q, r } = state.ui.hoverHex;
    const p = axialToPixel(q, r, CONFIG.hexSize);
    const pts = hexCorners(p.x + view.ox, p.y + view.oy, CONFIG.hexSize - 1);
    ctx.lineWidth = 2;
    ctx.strokeStyle = CONFIG.ui.hoverStroke;
    drawHexPath(ctx, pts);
    ctx.stroke();
  }

  // Status line truth probe
  const mismatchTxt = state.buildMismatch ? ' !!MISMATCH!!' : '';
  const sel = state.selection.key || '-';
  const u = selectedUnit();
  const selTag = u ? `${u.side.toUpperCase()} ${u.type} ${isSpent(u)?'SPENT':'READY'}` : '-';
  const mvN = state.selection.moveTargets.size;
  const hc = (state.selection.hoverCost != null) ? state.selection.hoverCost : '-';

  setStatusLine(
    `${GAME_NAME} | BUILD ${BUILD_ID} | HTML=${state.htmlBuild} JS=${BUILD_ID}${mismatchTxt} | ` +
    `MODE ${state.mode.toUpperCase()} | TURN ${state.turn.side.toUpperCase()} acts=${state.turn.actsLeft} tn=${state.turn.number} | ` +
    `sel=${sel} ${selTag} mvTargets=${mvN} hoverCost=${hc} | last=${state.lastEvent}`
  );
}

// ---------- boot + handlers ----------
function boot(){
  state.htmlBuild = getHtmlBuild();
  state.buildMismatch = (state.htmlBuild !== BUILD_ID);
  if (state.buildMismatch) logEvent(`WARN build mismatch HTML=${state.htmlBuild} JS=${BUILD_ID}`);

  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  const frameHexes = makeFrameHexes();

  // init active board: full stretched hex
  for (const h of frameHexes) state.board.active.add(hexKey(h.q, h.r));

  logEvent(`TURN BLUE acts=${state.turn.actsLeft} tn=${state.turn.number}`);

  function rerender(){
    resizeCanvas(canvas, ctx);
    render(canvas, ctx, frameHexes);
  }

  // Mode buttons
  $('modePlayBtn').addEventListener('click', () => {
    state.mode = 'play';
    clearSelection();
    logEvent('mode:play');
    syncSidebar();
    rerender();
  });
  $('modeEditBtn').addEventListener('click', () => {
    state.mode = 'edit';
    clearSelection();
    logEvent('mode:edit');
    syncSidebar();
    rerender();
  });

  // Tool buttons
  $('toolShape').addEventListener('click', () => { if (state.mode==='edit'){ state.tool='shape'; logEvent('tool:shape'); syncSidebar(); rerender(); } });
  $('toolTerrain').addEventListener('click', () => { if (state.mode==='edit'){ state.tool='terrain'; logEvent('tool:terrain'); syncSidebar(); rerender(); } });
  $('toolUnits').addEventListener('click', () => { if (state.mode==='edit'){ state.tool='units'; logEvent('tool:units'); syncSidebar(); rerender(); } });

  // Turn buttons
  $('passBtn').addEventListener('click', () => { passWithSelected(); syncSidebar(); rerender(); });
  $('endTurnBtn').addEventListener('click', () => { endTurn(); syncSidebar(); rerender(); });

  // Terrain palette
  for (const btn of document.querySelectorAll('.terrainBtn')){
    btn.addEventListener('click', () => {
      if (state.mode !== 'edit') return;
      const t = btn.getAttribute('data-terrain') || 'clear';
      if (!VALID_TERR.has(t)) return;
      state.terrainBrush = t;
      logEvent(`brush:${t}`);
      syncSidebar();
      rerender();
    });
  }

  // Unit palette: side/type/quality
  for (const btn of document.querySelectorAll('.unitBtn[data-side]')){
    btn.addEventListener('click', () => {
      if (state.mode !== 'edit') return;
      const s = btn.getAttribute('data-side') || 'blue';
      if (!VALID_SIDES.has(s)) return;
      state.unitBrush.side = s;
      logEvent(`ubSide:${s}`);
      syncSidebar();
      rerender();
    });
  }

  for (const btn of document.querySelectorAll('.unitBtn[data-utype]')){
    btn.addEventListener('click', () => {
      if (state.mode !== 'edit') return;
      const t = btn.getAttribute('data-utype') || 'INF';
      if (!VALID_TYPES.has(t)) return;
      state.unitBrush.type = t;
      if (t === 'GEN') state.unitBrush.quality = 'green';
      logEvent(`ubType:${t}`);
      syncSidebar();
      rerender();
    });
  }

  for (const btn of document.querySelectorAll('.unitBtn[data-quality]')){
    btn.addEventListener('click', () => {
      if (state.mode !== 'edit') return;
      const q = btn.getAttribute('data-quality') || 'regular';
      if (!VALID_QUALS.has(q)) return;
      if (state.unitBrush.type === 'GEN') return; // forced
      state.unitBrush.quality = q;
      logEvent(`ubQual:${q}`);
      syncSidebar();
      rerender();
    });
  }

  // Scenario buttons
  $('demoSetupBtn').addEventListener('click', () => {
    demoSetup();
    syncSidebar();
    rerender();
  });

  $('clearUnitsBtn').addEventListener('click', () => {
    clearUnits(true);
    syncSidebar();
    rerender();
    setIoStatus('Units cleared. Turn reset to BLUE.');
  });

  $('exportBtn').addEventListener('click', () => {
    const obj = scenarioFromState();
    const txt = JSON.stringify(obj, null, 2);
    $('ioBox').value = txt;
    setIoStatus(`Exported (${txt.length} chars).`);
    logEvent('io:export');
    rerender();
  });

  $('importBtn').addEventListener('click', () => {
    const txt = $('ioBox').value.trim();
    if (!txt){
      setIoStatus('Import failed: empty textbox.');
      return;
    }
    try{
      importScenario(JSON.parse(txt));
      syncSidebar();
      rerender();
    }catch(e){
      setIoStatus(`Import failed: ${String(e && e.message ? e.message : e)}`);
      logEvent('io:import error');
      rerender();
    }
  });

  // Mouse move: hover + play hover path + edit drag paint
  canvas.addEventListener('mousemove', (ev) => {
    const pt = getCanvasPoint(ev, canvas);
    const h = pickHexAt(pt.x, pt.y);

    // hover hex (edit)
    if (state.mode === 'edit'){
      state.ui.hoverHex = h;
      if (state.tool === 'terrain' && state.ui.painting && (ev.buttons & 1) === 1 && h){
        const k = hexKey(h.q, h.r);
        if (k !== state.ui.lastPaintKey){
          paintTerrain(h.q, h.r);
          state.ui.lastPaintKey = k;
        }
      }
      rerender();
      return;
    }

    // play hover path
    state.selection.hoverPath = null;
    state.selection.hoverCost = null;

    if (state.mode === 'play' && h && state.selection.key && state.selection.moveTargets.size > 0){
      const hk = hexKey(h.q, h.r);
      if (state.selection.moveTargets.has(hk)){
        const path = buildPath(state.selection.movePrev, state.selection.key, hk);
        if (path){
          state.selection.hoverPath = path;
          state.selection.hoverCost = state.selection.moveCost.get(hk) ?? null;
        }
      }
    }
    rerender();
  });

  canvas.addEventListener('mouseleave', () => {
    state.ui.hoverHex = null;
    state.ui.painting = false;
    state.ui.lastPaintKey = null;
    state.selection.hoverPath = null;
    state.selection.hoverCost = null;
    rerender();
  });

  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    const pt = getCanvasPoint(ev, canvas);
    const h = pickHexAt(pt.x, pt.y);
    if (!h) return;

    const k = hexKey(h.q, h.r);

    if (state.mode === 'play'){
      if (state.units.has(k)){
        selectHex(k);
      }else if (state.selection.moveTargets.has(k)){
        tryMove(k);
      }else{
        clearSelection();
        logEvent('select:clear');
      }
      syncSidebar();
      rerender();
      return;
    }

    // edit mode
    if (state.tool === 'shape'){
      toggleActive(h.q, h.r);
      syncSidebar();
      rerender();
      return;
    }

    if (state.tool === 'terrain'){
      state.ui.painting = true;
      state.ui.lastPaintKey = null;
      paintTerrain(h.q, h.r);
      state.ui.lastPaintKey = k;
      syncSidebar();
      rerender();
      return;
    }

    if (state.tool === 'units'){
      placeUnit(h.q, h.r);
      syncSidebar();
      rerender();
      return;
    }
  });

  window.addEventListener('mouseup', () => {
    if (state.ui.painting){
      state.ui.painting = false;
      state.ui.lastPaintKey = null;
      logEvent('paint:up');
    }
  });

  syncSidebar();
  rerender();

  window.BANNERFALL = { state, CONFIG };
}

window.addEventListener('DOMContentLoaded', () => {
  try{
    boot();
  }catch(err){
    console.error(err);
    const msg = (err && err.message) ? err.message : String(err);
    const el = document.getElementById('statusLine');
    if (el) el.textContent = `BOOT ERROR | BUILD ${BUILD_ID} | ${msg}`;
  }
});
