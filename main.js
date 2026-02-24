(() => {
  'use strict';

  // ===== Warfare (D-Day baseline → RB01 rules engine alignment) =====
  // This build intentionally keeps the "Warfare" UI calm/legible while
  // tightening the mechanics to the rules spec you provided.

  const GAME_NAME = 'Bannerfall';
  const BUILD_ID = (window.POLEMO_BUILD_ID || window.POLEMO_BUILD || 'DEV');

  // --- Board shape (157-hex "island")
  // Rows are r=0..10, each row is a contiguous run of q.
  const DEFAULT_ROWS = [
    { qStart: 2, len: 12 }, // r=0
    { qStart: 1, len: 13 }, // r=1
    { qStart: 1, len: 14 }, // r=2
    { qStart: 0, len: 15 }, // r=3
    { qStart: 0, len: 16 }, // r=4
    { qStart: -1, len: 17 }, // r=5
    { qStart: 0, len: 16 }, // r=6
    { qStart: 0, len: 15 }, // r=7
    { qStart: 1, len: 14 }, // r=8
    { qStart: 1, len: 13 }, // r=9
    { qStart: 2, len: 12 }, // r=10
  ];

  // --- Terrain
  const TERRAIN_DEFS = [
    { id: 'clear', label: 'Clear' },
    { id: 'hills', label: 'Hills' },
    { id: 'woods', label: 'Woods' },
    { id: 'rough', label: 'Rough' },
    { id: 'water', label: 'Water' },
  ];

  // --- Core rules constants
  const ACT_LIMIT = 3; // activations per turn
  const COMMAND_RADIUS = 3; // hex distance

  // Dice faces: 5–6 = Hit, 4 = Retreat.
  const DIE_HIT = new Set([5, 6]);
  const DIE_RETREAT = 4;

  // --- Units (RB01 canonical)
  // HP is mutable; UP is fixed strategic value.
  // Quality affects COMMAND DEPENDENCE only (no dice bonuses in RB01).
  const UNIT_DEFS = [
    // id, label, abbrev, symbol, MP, maxHP, UP
    { id: 'inf', label: 'Infantry', abbrev: 'INF', symbol: 'INF', move: 1, hp: 3, up: 3, meleeDice: 2, ranged: null },
    { id: 'cav', label: 'Cavalry', abbrev: 'CAV', symbol: 'CAV', move: 2, hp: 2, up: 4, meleeDice: 3, ranged: null },
    { id: 'skr', label: 'Skirmishers', abbrev: 'SKR', symbol: 'SKR', move: 2, hp: 2, up: 2, meleeDice: 2, ranged: { 2: 1 } }, // fixed range 2
    { id: 'arc', label: 'Archers', abbrev: 'ARC', symbol: '➶', move: 1, hp: 2, up: 2, meleeDice: 1, ranged: { 2: 2, 3: 1 } }, // range 2–3 only
    { id: 'gen', label: 'General', abbrev: 'GEN', symbol: '★', move: 2, hp: 2, up: 5, meleeDice: 1, ranged: null },
  ];

  const UNIT_BY_ID = new Map(UNIT_DEFS.map(u => [u.id, u]));

  const QUALITY_ORDER = ['green', 'regular', 'veteran'];

  // Odd-r offset neighbors (pointy-top).
  const NEIGH_EVEN = [[+1, 0], [0, -1], [-1, -1], [-1, 0], [-1, +1], [0, +1]];
  const NEIGH_ODD = [[+1, 0], [+1, -1], [0, -1], [-1, 0], [0, +1], [+1, +1]];

  // --- DOM
  const elCanvas = document.getElementById('c');
  const ctx = elCanvas.getContext('2d');

  const elHudTitle = document.getElementById('hudTitle');
  const elHudMeta = document.getElementById('hudMeta');
  const elHudLast = document.getElementById('hudLast');

  const elModeBtn = document.getElementById('modeBtn');
  const elToolUnits = document.getElementById('toolUnits');
  const elToolTerrain = document.getElementById('toolTerrain');

  const elSideBlue = document.getElementById('sideBlue');
  const elSideRed = document.getElementById('sideRed');

  const elTypeBtns = document.getElementById('typeBtns');
  const elEraseBtn = document.getElementById('eraseBtn');

  const elQualityGreen = document.getElementById('qGreen');
  const elQualityRegular = document.getElementById('qRegular');
  const elQualityVeteran = document.getElementById('qVeteran');

  const elTerrainBtns = document.getElementById('terrainBtns');

  const elScenarioSel = document.getElementById('scenarioSel');
  const elLoadScenarioBtn = document.getElementById('loadScenarioBtn');
  const elClearUnitsBtn = document.getElementById('clearUnitsBtn');

  const elVictorySel = document.getElementById('victorySel');
  const elEndTurnBtn = document.getElementById('endTurnBtn');

  // --- State
  const state = {
    mode: 'edit', // 'edit' | 'play'
    tool: 'units', // 'units' | 'terrain'

    editSide: 'blue',
    editType: 'inf',
    editQuality: 'green',
    editErase: false,
    editTerrain: 'clear',

    // Play
    turn: 1,
    side: 'blue',
    actsUsed: 0,
    actedUnitIds: new Set(),

    // Visual toggles
    showCommand: true,
    terrainTheme: 'vivid',

    selectedKey: null,

    // Current activation context (only while a unit is selected in Play)
    act: null, // { unitId, committed, moved, attacked, inCommandStart }

    victoryMode: 'clear',
    initialUP: { blue: 0, red: 0 },
    capturedUP: { blue: 0, red: 0 },

    gameOver: false,
    winner: null,

    // Minimal "event trace" (future UI can display this without changing rules)
    events: [],

    last: 'Booting…',
  };

  // --- Board model
  function key(q, r) { return `${q},${r}`; }

  function buildBoardFromRows(rows) {
    const active = [];
    const activeSet = new Set();
    let minQ = Infinity, maxQ = -Infinity, minR = Infinity, maxR = -Infinity;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let q = row.qStart; q < row.qStart + row.len; q++) {
        const k = key(q, r);
        active.push({ q, r, k, terrain: 'clear', cx: 0, cy: 0, neigh: [] });
        activeSet.add(k);
        minQ = Math.min(minQ, q);
        maxQ = Math.max(maxQ, q);
        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
      }
    }

    const byKey = new Map(active.map(h => [h.k, h]));

    // Precompute ACTIVE neighbors (movement & adjacency checks)
    for (const h of active) {
      const deltas = (h.r & 1) ? NEIGH_ODD : NEIGH_EVEN;
      h.neigh = [];
      for (const [dq, dr] of deltas) {
        const nk = key(h.q + dq, h.r + dr);
        if (activeSet.has(nk)) h.neigh.push(nk);
      }
    }

    return { active, activeSet, byKey, minQ, maxQ, minR, maxR };
  }

  const board = buildBoardFromRows(DEFAULT_ROWS);

  // Units live in a Map keyed by hex key.
  const unitsByHex = new Map();
  let nextUnitId = 1;

  // --- Scenarios (tiny demos)
  // We keep the existing demos as placeholders; we can retune them into
  // "Even Lines / Encirclement / Corridor" once RB01 feels solid.
  const SCENARIOS = {
    'Empty (Island)': {
      terrain: [],
      units: [],
    },
    'Demo A — Line Clash': {
      terrain: [],
      units: [
        // Blue
        { q: 2, r: 5, side: 'blue', type: 'gen', quality: 'green' },
        { q: 3, r: 4, side: 'blue', type: 'inf', quality: 'green' },
        { q: 3, r: 6, side: 'blue', type: 'inf', quality: 'green' },
        { q: 4, r: 5, side: 'blue', type: 'cav', quality: 'regular' },
        { q: 2, r: 4, side: 'blue', type: 'arc', quality: 'green' },
        { q: 2, r: 6, side: 'blue', type: 'skr', quality: 'green' },

        // Red
        { q: 13, r: 5, side: 'red', type: 'gen', quality: 'green' },
        { q: 12, r: 4, side: 'red', type: 'inf', quality: 'green' },
        { q: 12, r: 6, side: 'red', type: 'inf', quality: 'green' },
        { q: 11, r: 5, side: 'red', type: 'cav', quality: 'regular' },
        { q: 13, r: 4, side: 'red', type: 'arc', quality: 'green' },
        { q: 13, r: 6, side: 'red', type: 'skr', quality: 'green' },
      ],
    },
    'Demo B — Center Push': {
      terrain: [],
      units: [
        { q: 4, r: 4, side: 'blue', type: 'gen', quality: 'green' },
        { q: 4, r: 5, side: 'blue', type: 'inf', quality: 'regular' },
        { q: 5, r: 6, side: 'blue', type: 'cav', quality: 'green' },
        { q: 3, r: 6, side: 'blue', type: 'arc', quality: 'green' },

        { q: 11, r: 6, side: 'red', type: 'gen', quality: 'green' },
        { q: 10, r: 5, side: 'red', type: 'inf', quality: 'regular' },
        { q: 9, r: 4, side: 'red', type: 'cav', quality: 'green' },
        { q: 12, r: 4, side: 'red', type: 'arc', quality: 'green' },
      ],
    },
    'Demo C — Skirmisher Screen': {
      terrain: [],
      units: [
        { q: 2, r: 5, side: 'blue', type: 'gen', quality: 'green' },
        { q: 3, r: 5, side: 'blue', type: 'inf', quality: 'green' },
        { q: 4, r: 5, side: 'blue', type: 'cav', quality: 'green' },
        { q: 3, r: 4, side: 'blue', type: 'skr', quality: 'regular' },
        { q: 3, r: 6, side: 'blue', type: 'skr', quality: 'regular' },
        { q: 1, r: 5, side: 'blue', type: 'arc', quality: 'green' },

        { q: 13, r: 5, side: 'red', type: 'gen', quality: 'green' },
        { q: 12, r: 5, side: 'red', type: 'inf', quality: 'green' },
        { q: 11, r: 5, side: 'red', type: 'cav', quality: 'green' },
        { q: 12, r: 4, side: 'red', type: 'skr', quality: 'regular' },
        { q: 12, r: 6, side: 'red', type: 'skr', quality: 'regular' },
        { q: 14, r: 5, side: 'red', type: 'arc', quality: 'green' },
      ],
    },
  };

  // --- Geometry helpers
  function toAxial(q, r) {
    // Convert odd-r offset (q=col, r=row) to axial (x,z) where z=r.
    const x = q - ((r - (r & 1)) / 2);
    const z = r;
    return { x, z };
  }

  function axialDistance(aq, ar, bq, br) {
    const a = toAxial(aq, ar);
    const b = toAxial(bq, br);
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    const dy = (-a.x - a.z) - (-b.x - b.z);
    return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  }

  // --- Canvas layout
  let R = 28; // will be recalculated
  let HEX_W = 0;
  let HEX_H = 0;
  let STEP_Y = 0;
  let ORIGIN_X = 0;
  let ORIGIN_Y = 0;

  function resize() {
    // Canvas fills left pane.
    const wrap = document.getElementById('canvasWrap');
    const rect = wrap.getBoundingClientRect();
    elCanvas.width = Math.floor(rect.width * devicePixelRatio);
    elCanvas.height = Math.floor(rect.height * devicePixelRatio);
    elCanvas.style.width = `${Math.floor(rect.width)}px`;
    elCanvas.style.height = `${Math.floor(rect.height)}px`;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    // Fit board.
    const cols = (board.maxQ - board.minQ + 1);
    const rows = (board.maxR - board.minR + 1);
    const availW = rect.width;
    const availH = rect.height;

    // For pointy-top hexes with odd-r offset:
    // width ≈ sqrt(3)*R*(cols + 0.5)
    // height ≈ R*((rows-1)*1.5 + 2)
    const rByW = availW / (Math.sqrt(3) * (cols + 0.5));
    const rByH = availH / (((rows - 1) * 1.5) + 2);
    R = Math.max(18, Math.min(42, Math.floor(Math.min(rByW, rByH))));

    HEX_W = Math.sqrt(3) * R;
    HEX_H = 2 * R;
    STEP_Y = 1.5 * R;

    const boardW = HEX_W * (cols + 0.5);
    const boardH = R * (((rows - 1) * 1.5) + 2);

    ORIGIN_X = (availW - boardW) / 2 + HEX_W / 2;
    ORIGIN_Y = (availH - boardH) / 2 + R;

    for (const h of board.active) {
      const x = ORIGIN_X + (h.q - board.minQ) * HEX_W + ((h.r & 1) ? (HEX_W / 2) : 0);
      const y = ORIGIN_Y + (h.r - board.minR) * STEP_Y;
      h.cx = x;
      h.cy = y;
    }

    draw();
  }

  function hexPath(cx, cy) {
    const p = new Path2D();
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 180) * (60 * i - 30); // pointy top
      const x = cx + R * Math.cos(ang);
      const y = cy + R * Math.sin(ang);
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    }
    p.closePath();
    return p;
  }

  function hexCorners(cx, cy) {
    // Corner order matches hexPath (i=0..5, angle = 60*i - 30)
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 180) * (60 * i - 30);
      pts.push({
        x: cx + R * Math.cos(ang),
        y: cy + R * Math.sin(ang),
      });
    }
    return pts;
  }

  function edgeCornerIdx(dir) {
    // Neighbor order is [E, NE, NW, W, SW, SE]
    switch (dir) {
      case 0: return [0, 1]; // E
      case 1: return [5, 0]; // NE
      case 2: return [4, 5]; // NW
      case 3: return [3, 4]; // W
      case 4: return [2, 3]; // SW
      case 5: return [1, 2]; // SE
      default: return [0, 1];
    }
  }

  function commandOutlinePath(genKey) {
    const g = board.byKey.get(genKey);
    if (!g) return null;

    // Command area = all active hexes within COMMAND_RADIUS.
    const inside = new Set();
    for (const h of board.active) {
      if (axialDistance(h.q, h.r, g.q, g.r) <= COMMAND_RADIUS) inside.add(h.k);
    }

    const path = new Path2D();

    for (const h of board.active) {
      if (!inside.has(h.k)) continue;

      const corners = hexCorners(h.cx, h.cy);
      const deltas = (h.r & 1) ? NEIGH_ODD : NEIGH_EVEN;

      for (let dir = 0; dir < 6; dir++) {
        const [dq, dr] = deltas[dir];
        const nk = key(h.q + dq, h.r + dr);

        // Only draw boundary edges: inside → outside.
        if (inside.has(nk)) continue;

        const [a, b] = edgeCornerIdx(dir);
        path.moveTo(corners[a].x, corners[a].y);
        path.lineTo(corners[b].x, corners[b].y);
      }
    }

    return path;
  }

  function pickHex(px, py) {
    let best = null;
    let bestD2 = Infinity;
    for (const h of board.active) {
      const dx = px - h.cx;
      const dy = py - h.cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = h;
      }
    }
    if (!best) return null;
    if (bestD2 > (R * R * 0.95)) return null;
    return best;
  }

  // --- Rendering
  // Terrain is intentionally a *tint* over a shared base, not a repaint.
  // That keeps the board calm while still making woods/hills/rough/water read instantly.
  const TERRAIN_THEMES = {
    // Classic tabletop parchment: subtle but readable.
    classic: {
      base: '#f4f2ea',
      grid: 'rgba(0,0,0,0.35)',
      tint: {
        hills: 'rgba(183, 131, 43, 0.18)',  // warm ochre
        woods: 'rgba(36, 122, 63, 0.20)',   // deep green
        rough: 'rgba(107, 84, 70, 0.16)',   // brown-grey
        water: 'rgba(30, 90, 170, 0.20)',   // river blue
      },
    },
    // Vivid Dusk: more saturation without turning the map into a neon quilt.
    vivid: {
      base: '#f4f2ea',
      grid: 'rgba(0,0,0,0.35)',
      tint: {
        hills: 'rgba(183, 131, 43, 0.26)',
        woods: 'rgba(36, 122, 63, 0.28)',
        rough: 'rgba(107, 84, 70, 0.22)',
        water: 'rgba(30, 90, 170, 0.28)',
      },
    },
    // Dark UI chrome option (kept because some people love it).
    dusk: {
      base: '#2f2d28',
      grid: 'rgba(255,255,255,0.14)',
      tint: {
        hills: 'rgba(183, 131, 43, 0.14)',
        woods: 'rgba(36, 122, 63, 0.16)',
        rough: 'rgba(107, 84, 70, 0.13)',
        water: 'rgba(30, 90, 170, 0.16)',
      },
    },
  };

  const TERRAIN_THEME_ORDER = ['vivid', 'classic', 'dusk'];

  function terrainTheme() {
    const theme = state.terrainTheme || 'vivid';
    return TERRAIN_THEMES[theme] || TERRAIN_THEMES.vivid;
  }

  function terrainBaseFill() {
    return terrainTheme().base || '#f4f2ea';
  }

  function terrainTint(t) {
    if (!t || t === 'clear') return null;
    const pal = terrainTheme();
    return (pal.tint && pal.tint[t]) ? pal.tint[t] : null;
  }

  function gridStroke() {
    return terrainTheme().grid || '#111';
  }
function unitColors(side) {
    return side === 'blue'
      ? { fill: '#0b3d91', stroke: '#8fb4ff', text: '#eaf2ff' }
      : { fill: '#7a1111', stroke: '#ff9a9a', text: '#ffecec' };
  }

  function qualityStroke(q) {
    switch (q) {
      case 'veteran': return '#d7b84b';
      case 'regular': return '#d0d0d0';
      default: return '#57d26a';
    }
  }

  function draw() {
    ctx.clearRect(0, 0, elCanvas.width, elCanvas.height);

    // Background
    ctx.fillStyle = '#0b0b0d';
    ctx.fillRect(0, 0, elCanvas.width, elCanvas.height);

    // Hexes
    for (const h of board.active) {
      const p = hexPath(h.cx, h.cy);
      ctx.fillStyle = terrainBaseFill();
      ctx.fill(p);

      const tint = terrainTint(h.terrain);
      if (tint) {
        ctx.fillStyle = tint;
        ctx.fill(p);
      }

      // Outline
      ctx.strokeStyle = gridStroke();
      ctx.lineWidth = 2;
      ctx.stroke(p);

      // Overlays
      const k = h.k;
      if (state.mode === 'play' && state.selectedKey) {
        if (state._moveTargets?.has(k)) {
          ctx.strokeStyle = '#4aa3ff';
          ctx.lineWidth = 3;
          ctx.setLineDash([6, 6]);
          ctx.stroke(p);
          ctx.setLineDash([]);
        }
        if (state._attackTargets?.has(k)) {
          ctx.strokeStyle = '#ff5050';
          ctx.lineWidth = 3;
          ctx.setLineDash([6, 6]);
          ctx.stroke(p);
          ctx.setLineDash([]);
        }
      }

      // Hover
      if (state._hoverKey === k) {
        ctx.strokeStyle = '#ffffff55';
        ctx.lineWidth = 3;
        ctx.stroke(p);
      }
    }

    // Command radius outlines (truthy, but calm): dotted orange perimeter.
    if (state.mode === 'play' && state.showCommand) {
      for (const [hk, u] of unitsByHex) {
        if (u.type !== 'gen') continue;

        const p = commandOutlinePath(hk);
        if (!p) continue;

        const isSel = (state.selectedKey === hk);
        const isTurnSide = (u.side === state.side);
        const alpha = isSel ? 0.95 : (isTurnSide ? 0.80 : 0.30);
        // Thicker + slightly darker so the command perimeter reads clearly.
        const lw = (isSel ? 3 : (isTurnSide ? 2.25 : 1.75)) * 2;

        ctx.save();
        ctx.strokeStyle = `rgba(210, 118, 0, ${alpha})`;
        ctx.lineWidth = lw;
        ctx.setLineDash([4, 6]);
        ctx.lineCap = 'round';
        ctx.stroke(p);
        ctx.restore();
      }
    }

    // Units
    for (const [hk, u] of unitsByHex) {
      const h = board.byKey.get(hk);
      if (!h) continue;

      const isPlay = (state.mode === 'play') && !state.gameOver;
      const isTurnSide = isPlay && (u.side === state.side);
      const isSpent = isTurnSide && state.actedUnitIds.has(u.id);
      const isCmdLocked = isTurnSide && !isSpent && (state.actsUsed < ACT_LIMIT) &&
        (!unitIgnoresCommand(u)) && (u.quality === 'green') && (!inCommandAt(hk, u.side));

      // Visual friction: spent units and unorderable greens read as "not available".
      // - spent: dim
      // - green out-of-command: dim + dashed orange ring
      const alpha = isSpent ? 0.38 : (isCmdLocked ? 0.48 : 1.0);

      const c = unitColors(u.side);

      ctx.save();
      ctx.globalAlpha = alpha;

      // Token disc
      ctx.beginPath();
      ctx.arc(h.cx, h.cy, R * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = c.fill;
      ctx.fill();

      // Token ring (quality)
      ctx.lineWidth = Math.max(2, Math.floor(R * 0.12));
      ctx.strokeStyle = qualityStroke(u.quality);
      ctx.stroke();

      // Selection ring
      if (state.selectedKey === hk) {
        ctx.beginPath();
        ctx.arc(h.cx, h.cy, R * 0.70, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      // Text (BIG)
      const def = UNIT_BY_ID.get(u.type);
      // Make 3-letter blocks (INF/CAV/SKR) ~15–20% smaller for better balance
      // against single-glyph tokens (2605, 27b6).
      const textScale = (u.type === 'inf' || u.type === 'cav' || u.type === 'skr') ? 0.83 : 1.0;
      const glyphScale = (u.type === 'arc') ? 2.5 : 1.0;
      const fontPx = Math.floor(R * 0.55 * textScale * glyphScale);
      ctx.font = `700 ${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = c.text;
      const glyphY = h.cy + ((u.type === 'arc') ? -Math.floor(R * 0.10) : 1);
      ctx.fillText(def.symbol, h.cx, glyphY);
      // HP pips (tiny)
      const pipR = Math.max(2, Math.floor(R * 0.07));
      const startX = h.cx - (pipR * 2) * (def.hp - 1) * 0.5;
      const y = h.cy + R * 0.78;
      for (let i = 0; i < def.hp; i++) {
        ctx.beginPath();
        ctx.arc(startX + i * (pipR * 2), y, pipR, 0, Math.PI * 2);
        ctx.fillStyle = (i < u.hp) ? '#fff' : '#ffffff33';
        ctx.fill();
      }

      ctx.restore();

      // Extra indicator: green out-of-command can't be activated (dashed orange ring).
      if (isCmdLocked) {
        ctx.beginPath();
        ctx.arc(h.cx, h.cy, R * 0.64, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255, 157, 0, 0.9)';
        ctx.setLineDash([3, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // --- UI helpers
  function setActive(btn, isActive) {
    btn.classList.toggle('active', isActive);
  }

  function log(msg) {
    state.last = msg;
    elHudLast.textContent = msg;

    state.events.push({ t: Date.now(), msg });
    if (state.events.length > 50) state.events.shift();
  }

  function totals(side) {
    let up = 0;
    let hp = 0;
    let gens = 0;
    let units = 0;

    for (const u of unitsByHex.values()) {
      if (u.side !== side) continue;
      const def = UNIT_BY_ID.get(u.type);
      up += def.up;
      hp += u.hp;
      units += 1;
      if (u.type === 'gen') gens += 1;
    }

    return { up, hp, gens, units };
  }

  function updateHud() {
    const blue = totals('blue');
    const red = totals('red');

    elHudTitle.textContent = `${GAME_NAME}  BUILD ${BUILD_ID}`;

    const mode = state.mode.toUpperCase();
    const meta = [
      `MODE=${mode}`,
      `TERRAIN=${(state.terrainTheme || 'vivid').toUpperCase()}`,
      `TURN=${state.side.toUpperCase()}#${state.turn}`,
      `ACT=${state.actsUsed}/${ACT_LIMIT}`,
      `ACTIVE=${board.active.length}`,
      `UNITS=${unitsByHex.size}`,
      `FORCES: B ${blue.up}u/${blue.hp}hp • R ${red.up}u/${red.hp}hp`,
      `CAP: B ${state.capturedUP.blue}u • R ${state.capturedUP.red}u`,
      `VICTORY=${state.victoryMode.toUpperCase()}`,
    ];
    elHudMeta.textContent = meta.join('  ·  ');

    elModeBtn.textContent = state.mode === 'edit' ? 'To Play' : 'To Edit';
    setActive(elToolUnits, state.tool === 'units');
    setActive(elToolTerrain, state.tool === 'terrain');

    setActive(elSideBlue, state.editSide === 'blue');
    setActive(elSideRed, state.editSide === 'red');

    // Type buttons
    for (const b of elTypeBtns.querySelectorAll('button[data-type]')) {
      setActive(b, state.editType === b.dataset.type);
    }
    setActive(elEraseBtn, state.editErase);

    // Quality buttons
    setActive(elQualityGreen, state.editQuality === 'green');
    setActive(elQualityRegular, state.editQuality === 'regular');
    setActive(elQualityVeteran, state.editQuality === 'veteran');

    // Terrain buttons
    for (const b of elTerrainBtns.querySelectorAll('button[data-terrain]')) {
      setActive(b, state.editTerrain === b.dataset.terrain);
    }

    elEndTurnBtn.disabled = (state.mode !== 'play') || state.gameOver;

    draw();
  }

  // --- Rules helpers
  function isOccupied(hk) {
    return unitsByHex.has(hk);
  }

  function terrainMoveCost(unitType, terrainId) {
    if (terrainId === 'water') return Infinity;
    if (terrainId === 'clear') return 1;

    // hills/woods/rough
    return (unitType === 'cav') ? 3 : 2;
  }

  function isEngaged(hexKey, side) {
    const h = board.byKey.get(hexKey);
    if (!h) return false;

    for (const nk of h.neigh) {
      const u = unitsByHex.get(nk);
      if (u && u.side !== side) return true;
    }

    return false;
  }

  function friendlyGeneralKeys(side) {
    const out = [];
    for (const [hk, u] of unitsByHex) {
      if (u.side === side && u.type === 'gen') out.push(hk);
    }
    return out;
  }

  function inCommandAt(hexKey, side) {
    const gens = friendlyGeneralKeys(side);
    if (gens.length === 0) return false;

    const h = board.byKey.get(hexKey);
    if (!h) return false;

    for (const gk of gens) {
      const gh = board.byKey.get(gk);
      if (!gh) continue;
      const d = axialDistance(h.q, h.r, gh.q, gh.r);
      if (d <= COMMAND_RADIUS) return true;
    }
    return false;
  }

  function unitIgnoresCommand(u) {
    if (u.type === 'gen') return true;
    if (u.type === 'cav') return true;
    if (u.quality === 'veteran') return true;
    return false;
  }

  function unitCanActivate(u, hexKey) {
    if (state.mode !== 'play') return false;
    if (state.gameOver) return false;
    if (u.side !== state.side) return false;
    if (state.actsUsed >= ACT_LIMIT) return false;
    if (state.actedUnitIds.has(u.id)) return false;

    // Green INF/ARC/SKR out-of-command cannot be activated at all.
    if (!unitIgnoresCommand(u) && u.quality === 'green') {
      const cmd = inCommandAt(hexKey, u.side);
      if (!cmd) return false;
    }

    return true;
  }

  function activationBlockReason(u, hexKey) {
    if (state.mode !== 'play') return 'Not in Play mode.';
    if (state.gameOver) return 'Game over.';
    if (u.side !== state.side) return null; // stay calm; don’t narrate enemy clicks
    if (state.actsUsed >= ACT_LIMIT) return 'No activations left — End Turn.';
    if (state.actedUnitIds.has(u.id)) return 'Already acted this turn.';

    if (!unitIgnoresCommand(u) && u.quality === 'green') {
      const cmd = inCommandAt(hexKey, u.side);
      if (!cmd) return `Out of command: Green units need a GEN within ${COMMAND_RADIUS}.`;
    }

    return null;
  }

  function unitCanMoveThisActivation(u, actCtx, startKey) {
    // Engagement makes the line sticky.
    const engaged = isEngaged(startKey, u.side);

    // Skirmishers have a special disengage.
    if (engaged) {
      return u.type === 'skr';
    }

    // Command dependence
    if (unitIgnoresCommand(u)) return true;

    // Regular INF/ARC/SKR require command to move.
    if (u.quality === 'regular') return !!actCtx.inCommandStart;

    // Green INF/ARC/SKR require command to move (but if green, activation gating already enforced).
    return !!actCtx.inCommandStart;
  }

  // --- Movement (MP + terrain costs)
  function computeMoveTargets(fromKey, u, actCtx) {
    const def = UNIT_BY_ID.get(u.type);
    const mp = def.move;

    // If movement isn't allowed, return empty set.
    if (!unitCanMoveThisActivation(u, actCtx, fromKey)) return new Set();

    const engaged = isEngaged(fromKey, u.side);

    // Skirmisher disengage: exactly 1 hex to a destination not adjacent to ANY enemy.
    if (u.type === 'skr' && engaged) {
      const out = new Set();
      const h = board.byKey.get(fromKey);
      if (!h) return out;

      for (const nk of h.neigh) {
        if (isOccupied(nk)) continue;
        const nh = board.byKey.get(nk);
        if (!nh) continue;

        const cost = terrainMoveCost(u.type, nh.terrain);
        if (!Number.isFinite(cost) || cost > mp) continue;

        // Must end NOT adjacent to any enemy.
        if (isEngaged(nk, u.side)) continue;

        out.add(nk);
      }

      return out;
    }

    // Normal movement: least-cost reachability within MP budget.
    const out = new Set();
    const best = new Map();

    // Tiny board → a simple priority queue is fine.
    const pq = [{ k: fromKey, c: 0 }];
    best.set(fromKey, 0);

    while (pq.length) {
      // pop min cost
      pq.sort((a, b) => a.c - b.c);
      const cur = pq.shift();
      if (!cur) break;

      const h = board.byKey.get(cur.k);
      if (!h) continue;

      for (const nk of h.neigh) {
        if (isOccupied(nk)) continue;
        const nh = board.byKey.get(nk);
        if (!nh) continue;

        const stepCost = terrainMoveCost(u.type, nh.terrain);
        if (!Number.isFinite(stepCost)) continue; // water/impassable

        const nc = cur.c + stepCost;
        if (nc > mp) continue;

        const prevBest = best.get(nk);
        if (prevBest !== undefined && nc >= prevBest) continue;

        best.set(nk, nc);
        out.add(nk);
        pq.push({ k: nk, c: nc });
      }
    }

    return out;
  }

  // --- Attacks (melee + ranged)
  function attackDiceFor(attackerKey, defenderKey, attackerUnit) {
    const atkHex = board.byKey.get(attackerKey);
    const defHex = board.byKey.get(defenderKey);
    if (!atkHex || !defHex) return null;

    const dist = axialDistance(atkHex.q, atkHex.r, defHex.q, defHex.r);
    if (dist < 1) return null;

    const engaged = isEngaged(attackerKey, attackerUnit.side);
    const atkDef = UNIT_BY_ID.get(attackerUnit.type);

    // Melee at range 1 is always possible.
    if (dist === 1) {
      return { kind: 'melee', dist, dice: atkDef.meleeDice };
    }

    // Beyond range 1 requires ranged capability and NOT being engaged.
    if (engaged) return null;
    if (!atkDef.ranged) return null;

    const dice = atkDef.ranged[dist];
    if (!dice) return null;

    return { kind: 'ranged', dist, dice };
  }

  function computeAttackTargets(attackerKey, u) {
    const targets = new Set();

    for (const [hk, enemy] of unitsByHex) {
      if (enemy.side === u.side) continue;
      const prof = attackDiceFor(attackerKey, hk, u);
      if (prof) targets.add(hk);
    }

    return targets;
  }

  // --- Combat resolution
  function rollD6() {
    return 1 + Math.floor(Math.random() * 6);
  }

  function retreatPick(attackerKey, defenderKey) {
    // Choose retreat direction purely by geometry (maximizes distance), then
    // if the chosen hex is invalid (off-board/water/occupied), retreat converts to a hit.

    const aHex = board.byKey.get(attackerKey);
    const dHex = board.byKey.get(defenderKey);
    if (!aHex || !dHex) return null;

    const curDist = axialDistance(aHex.q, aHex.r, dHex.q, dHex.r);

    const deltas = (dHex.r & 1) ? NEIGH_ODD : NEIGH_EVEN;

    let bestKey = null;
    let bestDist = curDist;

    for (const [dq, dr] of deltas) {
      const nq = dHex.q + dq;
      const nr = dHex.r + dr;
      const nd = axialDistance(aHex.q, aHex.r, nq, nr);
      if (nd > bestDist) {
        bestDist = nd;
        bestKey = key(nq, nr);
      }
    }

    if (!bestKey) return null;

    // Validate the chosen retreat hex.
    if (!board.activeSet.has(bestKey)) return null;

    const bh = board.byKey.get(bestKey);
    if (!bh) return null;

    if (bh.terrain === 'water') return null;
    if (isOccupied(bestKey)) return null;

    return bestKey;
  }

  function consumeActivation(unitId) {
    state.actsUsed = Math.min(ACT_LIMIT, state.actsUsed + 1);
    state.actedUnitIds.add(unitId);
  }

  function destroyUnit(defenderKey, defenderUnit, attackerSide) {
    const defDef = UNIT_BY_ID.get(defenderUnit.type);

    unitsByHex.delete(defenderKey);

    state.capturedUP[attackerSide] += defDef.up;

    log(`☠️ ${defenderUnit.side.toUpperCase()} ${defDef.abbrev} destroyed (+${defDef.up}u).`);
  }

  function resolveAttack(attackerKey, defenderKey) {
    const atk = unitsByHex.get(attackerKey);
    const defU = unitsByHex.get(defenderKey);
    if (!atk || !defU) return;
    if (state.gameOver) return;

    const prof = attackDiceFor(attackerKey, defenderKey, atk);
    if (!prof) {
      log('Illegal attack.');
      return;
    }

    // Terrain defensive modifier: defender in woods => -1 die (min 1)
    const defHex = board.byKey.get(defenderKey);
    let dice = prof.dice;
    if (defHex && defHex.terrain === 'woods') {
      dice = Math.max(1, dice - 1);
    }

    const rolls = [];
    for (let i = 0; i < dice; i++) rolls.push(rollD6());

    const atkDef = UNIT_BY_ID.get(atk.type);
    const defDef = UNIT_BY_ID.get(defU.type);

    const hits = rolls.filter(v => DIE_HIT.has(v)).length;
    const retreats = rolls.filter(v => v === DIE_RETREAT).length;

    const tag = `${atk.side.toUpperCase()} ${atkDef.abbrev}`;
    const vs = `${defU.side.toUpperCase()} ${defDef.abbrev}`;
    log(`${tag} ${prof.kind}→${vs} (d${prof.dist}) [${rolls.join(', ')}]`);

    // Pass 1: apply hits
    if (hits > 0) {
      defU.hp -= hits;
      log(`Hits: ${hits} → ${vs} HP=${Math.max(0, defU.hp)}.`);
    }

    if (defU.hp <= 0) {
      destroyUnit(defenderKey, defU, atk.side);
      checkVictory();
      updateHud();
      return;
    }

    // Pass 2: resolve retreats one at a time
    for (let i = 0; i < retreats; i++) {
      const curDef = unitsByHex.get(defenderKey);
      if (!curDef) break;

      const step = retreatPick(attackerKey, defenderKey);
      if (!step) {
        curDef.hp -= 1;
        log(`Retreat blocked → 1 hit. ${vs} HP=${Math.max(0, curDef.hp)}.`);
        if (curDef.hp <= 0) {
          destroyUnit(defenderKey, curDef, atk.side);
          break;
        }
      } else {
        unitsByHex.delete(defenderKey);
        unitsByHex.set(step, curDef);
        defenderKey = step;
        log(`Retreat → ${step}`);
      }
    }

    checkVictory();
    updateHud();
  }

  // --- Victory
  function checkVictory() {
    if (state.mode !== 'play') return;

    const b = totals('blue');
    const r = totals('red');

    let blueWins = false;
    let redWins = false;

    if (state.victoryMode === 'annihilation') {
      blueWins = r.units === 0;
      redWins = b.units === 0;
    } else if (state.victoryMode === 'decapitation') {
      blueWins = r.gens === 0;
      redWins = b.gens === 0;
    } else {
      // Clear victory: capture at least half of opponent starting UP, rounded up.
      const needBlue = Math.ceil(state.initialUP.red / 2);
      const needRed = Math.ceil(state.initialUP.blue / 2);

      blueWins = state.capturedUP.blue >= needBlue;
      redWins = state.capturedUP.red >= needRed;
    }

    if (blueWins && redWins) {
      // If multiple victory conditions ever trigger simultaneously, the acting player wins.
      state.gameOver = true;
      state.winner = state.side;
      log(`Game over: ${state.side.toUpperCase()} wins (simultaneous victory).`);
    } else if (blueWins) {
      state.gameOver = true;
      state.winner = 'blue';
      log('Game over: BLUE wins.');
    } else if (redWins) {
      state.gameOver = true;
      state.winner = 'red';
      log('Game over: RED wins.');
    }
  }

  // --- Mode transitions
  function clearSelection() {
    state.selectedKey = null;
    state.act = null;
    state._moveTargets = null;
    state._attackTargets = null;
  }

  function enterEdit() {
    state.mode = 'edit';
    state.tool = 'units';

    state.gameOver = false;
    state.winner = null;

    clearSelection();

    log('Edit: place units / paint terrain.');
    updateHud();
  }

  function enterPlay() {
    state.mode = 'play';
    state.turn = 1;
    state.side = 'blue';
    state.actsUsed = 0;
    state.actedUnitIds = new Set();

    state.gameOver = false;
    state.winner = null;

    // Lock initial UP for Clear Victory.
    state.initialUP.blue = totals('blue').up;
    state.initialUP.red = totals('red').up;

    // Reset capture tally.
    state.capturedUP.blue = 0;
    state.capturedUP.red = 0;

    clearSelection();

    log('Play: click a friendly unit. Blue goes first.');
    updateHud();
  }

  // --- Editing actions
  function normalizeQuality(type, quality) {
    // Baseline: generals display as Green.
    if (type === 'gen') return 'green';
    if (!QUALITY_ORDER.includes(quality)) return 'green';
    return quality;
  }

  function placeOrReplaceUnit(hexKey) {
    const h = board.byKey.get(hexKey);
    if (!h) return;

    if (state.editErase) {
      if (unitsByHex.delete(hexKey)) log(`Erased unit at ${hexKey}`);
      updateHud();
      return;
    }

    const type = state.editType;
    const def = UNIT_BY_ID.get(type);
    if (!def) return;

    const quality = normalizeQuality(type, state.editQuality);

    const existing = unitsByHex.get(hexKey);
    if (existing) {
      existing.side = state.editSide;
      existing.type = type;
      existing.quality = quality;
      existing.hp = def.hp;
      log(`Replaced at ${hexKey} → ${state.editSide} ${def.abbrev}`);
    } else {
      unitsByHex.set(hexKey, {
        id: nextUnitId++,
        side: state.editSide,
        type,
        quality,
        hp: def.hp,
      });
      log(`Placed ${state.editSide} ${def.abbrev} at ${hexKey}`);
    }

    updateHud();
  }

  function paintTerrain(hexKey) {
    const h = board.byKey.get(hexKey);
    if (!h) return;
    h.terrain = state.editTerrain;
    log(`Terrain ${state.editTerrain} at ${hexKey}`);
    updateHud();
  }

  function clearUnits() {
    unitsByHex.clear();
    nextUnitId = 1;
    log('Cleared all units.');
    updateHud();
  }

  function resetTerrain() {
    for (const h of board.active) h.terrain = 'clear';
  }

  function loadScenario(name) {
    const sc = SCENARIOS[name];
    if (!sc) return;

    enterEdit();
    clearUnits();
    resetTerrain();

    // Terrain paint
    for (const t of (sc.terrain || [])) {
      const k = key(t.q, t.r);
      const h = board.byKey.get(k);
      if (!h) continue;
      h.terrain = t.terrain;
    }

    // Units
    for (const u of (sc.units || [])) {
      const k = key(u.q, u.r);
      if (!board.activeSet.has(k)) continue;
      const def = UNIT_BY_ID.get(u.type);
      if (!def) continue;
      unitsByHex.set(k, {
        id: nextUnitId++,
        side: u.side,
        type: u.type,
        quality: normalizeQuality(u.type, u.quality || 'green'),
        hp: def.hp,
      });
    }

    log(`Loaded scenario: ${name}`);
    updateHud();
  }

  // --- Turn handling
  function endTurn() {
    if (state.mode !== 'play') return;
    if (state.gameOver) return;

    state.side = (state.side === 'blue') ? 'red' : 'blue';
    if (state.side === 'blue') state.turn += 1;

    state.actsUsed = 0;
    state.actedUnitIds = new Set();

    clearSelection();

    log(`Turn ${state.turn}: ${state.side.toUpperCase()}.`);
    updateHud();
  }

  // --- Play interaction
  function selectUnit(hexKey) {
    const u = unitsByHex.get(hexKey);
    if (!u) return;

    if (!unitCanActivate(u, hexKey)) return;

    const inCmd = unitIgnoresCommand(u) ? true : inCommandAt(hexKey, u.side);

    state.selectedKey = hexKey;
    state.act = {
      unitId: u.id,
      committed: false,
      moved: false,
      attacked: false,
      inCommandStart: inCmd,
    };

    // Precompute targets
    state._moveTargets = computeMoveTargets(hexKey, u, state.act);
    state._attackTargets = computeAttackTargets(hexKey, u);

    const def = UNIT_BY_ID.get(u.type);
    const engaged = isEngaged(hexKey, u.side);
    const notes = [];

    if (engaged) {
      if (u.type === 'skr') notes.push('Engaged: SKR may disengage 1 hex.');
      else notes.push('Engaged: cannot move.');
    } else if (!unitIgnoresCommand(u) && u.quality === 'regular' && !inCmd) {
      notes.push('Out of command: cannot move (can attack).');
    }

    log(`Selected ${u.side.toUpperCase()} ${def.abbrev}.${notes.length ? ' ' + notes.join(' ') : ''}`);
    updateHud();
  }

  function moveSelectedTo(destKey) {
    const fromKey = state.selectedKey;
    if (!fromKey || !state.act) return;

    const u = unitsByHex.get(fromKey);
    if (!u) return;

    if (state.act.moved || state.act.attacked) {
      log('Illegal move (already acted).');
      return;
    }

    if (!state._moveTargets || !state._moveTargets.has(destKey)) {
      log('Illegal move.');
      return;
    }

    // Commit activation on the FIRST real action.
    if (!state.act.committed) {
      consumeActivation(u.id);
      state.act.committed = true;
    }

    unitsByHex.delete(fromKey);
    unitsByHex.set(destKey, u);
    state.selectedKey = destKey;
    state.act.moved = true;

    log(`Moved to ${destKey}.`);

    // After moving, you may make at most ONE attack (same activation).
    state._moveTargets = null;
    state._attackTargets = computeAttackTargets(destKey, u);

    updateHud();
  }

  function attackFromSelection(targetKey) {
    const attackerKey = state.selectedKey;
    if (!attackerKey || !state.act) return;

    const atk = unitsByHex.get(attackerKey);
    if (!atk) return;

    if (state.act.attacked) {
      log('Illegal attack (already attacked).');
      return;
    }

    // Validate target exists and is enemy.
    const enemy = unitsByHex.get(targetKey);
    if (!enemy || enemy.side === atk.side) {
      log('Illegal attack target.');
      return;
    }

    if (!state._attackTargets || !state._attackTargets.has(targetKey)) {
      log('Illegal attack.');
      return;
    }

    // Commit activation on the FIRST real action.
    if (!state.act.committed) {
      consumeActivation(atk.id);
      state.act.committed = true;
    }

    resolveAttack(attackerKey, targetKey);

    state.act.attacked = true;

    // End activation after attack.
    clearSelection();
    updateHud();
  }

  function passSelected() {
    if (state.mode !== 'play') return;
    if (!state.selectedKey || !state.act) return;

    const u = unitsByHex.get(state.selectedKey);
    if (!u) return;

    if (state.act.committed) {
      log('Pass not available (already committed).');
      return;
    }

    consumeActivation(u.id);
    state.act.committed = true;
    log(`Pass: ${u.side.toUpperCase()} ${UNIT_BY_ID.get(u.type).abbrev}.`);

    clearSelection();
    updateHud();
  }

  function clickPlay(hexKey) {
    const clickedUnit = unitsByHex.get(hexKey);

    // If nothing selected: try to select.
    if (!state.selectedKey) {
      if (clickedUnit) {
        const reason = activationBlockReason(clickedUnit, hexKey);
        if (reason) {
          log(reason);
          updateHud();
          return;
        }
        if (unitCanActivate(clickedUnit, hexKey)) selectUnit(hexKey);
      }
      return;
    }

    const selKey = state.selectedKey;
    const selUnit = unitsByHex.get(selKey);
    if (!selUnit) {
      clearSelection();
      updateHud();
      return;
    }

    // Clicking the selected hex toggles deselect.
    if (hexKey === selKey) {
      clearSelection();
      log('Deselected.');
      updateHud();
      return;
    }

    // Attack
    if (clickedUnit && clickedUnit.side !== selUnit.side && state._attackTargets?.has(hexKey)) {
      attackFromSelection(hexKey);
      return;
    }

    // Move
    if (!clickedUnit && state._moveTargets?.has(hexKey)) {
      moveSelectedTo(hexKey);
      return;
    }

    // Switch selection to another friendly (forfeits any optional post-move attack)
    if (clickedUnit && clickedUnit.side === state.side) {
      clearSelection();
      const reason = activationBlockReason(clickedUnit, hexKey);
      if (reason) {
        log(reason);
        updateHud();
        return;
      }
      if (unitCanActivate(clickedUnit, hexKey)) selectUnit(hexKey);
      return;
    }
  }

  // --- Events
  elCanvas.addEventListener('mousemove', (e) => {
    const rect = elCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const h = pickHex(x, y);
    state._hoverKey = h ? h.k : null;
    draw();
  });

  elCanvas.addEventListener('mouseleave', () => {
    state._hoverKey = null;
    draw();
  });

  elCanvas.addEventListener('click', (e) => {
    const rect = elCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const h = pickHex(x, y);
    if (!h) return;

    if (state.mode === 'edit') {
      if (state.tool === 'terrain') paintTerrain(h.k);
      else placeOrReplaceUnit(h.k);
    } else {
      clickPlay(h.k);
    }
  });

  // Keyboard: P = pass with selected unit
  window.addEventListener('keydown', (e) => {
    if (e.key === 'p' || e.key === 'P') {
      if (state.mode === 'play' && state.selectedKey) {
        e.preventDefault();
        passSelected();
      }
    }

    // Toggle command radius overlay
    if (e.key === 'c' || e.key === 'C') {
      if (state.mode === 'play') {
        state.showCommand = !state.showCommand;
        log(`Command radius: ${state.showCommand ? 'ON' : 'OFF'}.`);
        updateHud();
      }
    }
    // Toggle terrain palette (visual only)
    if (e.key === 't' || e.key === 'T') {
      const cur = state.terrainTheme || 'vivid';
      const i = TERRAIN_THEME_ORDER.indexOf(cur);
      state.terrainTheme = TERRAIN_THEME_ORDER[(i + 1) % TERRAIN_THEME_ORDER.length];
      log(`Terrain palette: ${state.terrainTheme.toUpperCase()}.`);
      updateHud();
    }
  });

  window.addEventListener('resize', resize);

  elModeBtn.addEventListener('click', () => {
    if (state.mode === 'edit') enterPlay();
    else enterEdit();
  });

  elToolUnits.addEventListener('click', () => { state.tool = 'units'; updateHud(); });
  elToolTerrain.addEventListener('click', () => { state.tool = 'terrain'; updateHud(); });

  elSideBlue.addEventListener('click', () => { state.editSide = 'blue'; updateHud(); });
  elSideRed.addEventListener('click', () => { state.editSide = 'red'; updateHud(); });

  elTypeBtns.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-type]');
    if (!btn) return;
    state.editType = btn.dataset.type;
    state.editErase = false;
    if (state.editType === 'gen') state.editQuality = 'green';
    updateHud();
  });

  elEraseBtn.addEventListener('click', () => { state.editErase = !state.editErase; updateHud(); });

  elQualityGreen.addEventListener('click', () => { state.editQuality = 'green'; updateHud(); });
  elQualityRegular.addEventListener('click', () => { state.editQuality = 'regular'; updateHud(); });
  elQualityVeteran.addEventListener('click', () => { state.editQuality = 'veteran'; updateHud(); });

  elTerrainBtns.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-terrain]');
    if (!btn) return;
    state.editTerrain = btn.dataset.terrain;
    updateHud();
  });

  elVictorySel.addEventListener('change', () => {
    state.victoryMode = elVictorySel.value;
    updateHud();
  });

  elEndTurnBtn.addEventListener('click', endTurn);

  elClearUnitsBtn.addEventListener('click', () => { enterEdit(); clearUnits(); });

  elLoadScenarioBtn.addEventListener('click', () => { loadScenario(elScenarioSel.value); });

  // --- Populate scenario & victory dropdowns
  function populateScenarioSelect() {
    elScenarioSel.innerHTML = '';
    for (const name of Object.keys(SCENARIOS)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      elScenarioSel.appendChild(opt);
    }
    elScenarioSel.value = 'Empty (Island)';
  }

  function populateVictorySelect() {
    elVictorySel.innerHTML = '';
    const modes = [
      { id: 'clear', label: 'Clear Victory (halve UP)' },
      { id: 'decapitation', label: 'Decapitation (kill all generals)' },
      { id: 'annihilation', label: 'Annihilation (kill all units)' },
    ];
    for (const m of modes) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      elVictorySel.appendChild(opt);
    }
    elVictorySel.value = 'clear';
    state.victoryMode = 'clear';
  }

  function boot() {
    populateScenarioSelect();
    populateVictorySelect();

    loadScenario('Empty (Island)');
    enterEdit();

    log(`Booted ${GAME_NAME}. Active hexes=${board.active.length}. Edit: place units. Then To Play.`);
    updateHud();
    resize();
  }

  boot();
})();
