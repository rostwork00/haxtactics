"use strict";

/* =========================================================================
   HAXTACTICS — tactics board
   ========================================================================= */

/* ---------- Field presets (proportional units) --------------------------- */
const FIELD_PRESETS = {
  classic:  { w: 420, h: 200, goalDepth: 8,  goalHeight: 60 },
  big:      { w: 800, h: 400, goalDepth: 14, goalHeight: 130 },
  small:    { w: 250, h: 130, goalDepth: 6,  goalHeight: 50 },
  training: { w: 500, h: 260, goalDepth: 10, goalHeight: 80 },
};

// Field themes are now driven by the UI theme (light / dark).
// Apple-clean: subtle lines, no neon glow, ample contrast.
const FIELD_THEMES = {
  light: {
    bg:         "#FAF6E9",          // light milky cream — sidebar stays the accent
    line:       "rgba(24,22,18,0.55)",
    lineGlow:   null,
    netColor:   "rgba(24,22,18,0.28)",
    leftPost:   "#E5484D",
    rightPost:  "#4F7CFF",
    fieldHint:  "rgba(255, 255, 255, 0.55)",
    stripBg:    "rgba(24,22,18,0.025)",
    stripLine:  "rgba(24,22,18,0.07)",
    rail:       "rgba(24,22,18,0.05)",
  },
  dark: {
    bg:         "#1E1E22",
    line:       "rgba(244,243,238,0.55)",
    lineGlow:   null,
    netColor:   "rgba(244,243,238,0.28)",
    leftPost:   "#FF6168",
    rightPost:  "#6E8DFF",
    fieldHint:  "rgba(255, 255, 255, 0.012)",
    stripBg:    "rgba(255,255,255,0.018)",
    stripLine:  "rgba(255,255,255,0.06)",
    rail:       "rgba(255,255,255,0.05)",
  },
};

/* ---------- Team arrow color base hues (HSL) ---------------------------- */
const ARROW_BASE_HUE = {
  red:  0,
  blue: 215,
  ball: 185,
};

// Refined team colors — slightly desaturated for Apple-clean feel.
const PIECE_STYLES = {
  red:  { stroke: "#E5484D", inner: "#FCA8AB" },
  blue: { stroke: "#4F7CFF", inner: "#A8BEFF" },
  ball: { stroke: "#F4F3EE", inner: "#CBC9C2" },
};

// Resolved per-render so pieces match the field bg on light theme:
// red/blue keep their colored stroke but the interior is the field color,
// giving a hollow-ring look. The ball stays dark to remain visible.
function pieceStyleFor(kind) {
  if (state.themeKey === "light") {
    if (kind === "ball") return { stroke: "#181614", inner: "#3b3a36" };
    const fieldBg = FIELD_THEMES.light.bg;
    if (kind === "red")  return { stroke: "#E5484D", inner: fieldBg };
    if (kind === "blue") return { stroke: "#4F7CFF", inner: fieldBg };
  }
  return PIECE_STYLES[kind];
}

/* ---------- Dispenser configuration ------------------------------------- */
const DISPENSER_CAPACITY = 8;        // visible items in red/blue magazines
const BALL_CAPACITY = 3;
const SPRING_K = 0.22;               // stiffness
const SPRING_D = 0.70;               // damping (0..1, higher = more bouncy)

/* ---------- Annotation defaults ----------------------------------------- */
const ANNOTATION_FONTS = ["Inter", "JetBrains Mono", "Georgia", "Courier New"];
const ANNOTATION_COLORS = [
  "#FF8A4C", "#E5484D", "#4F7CFF", "#22D3EE",
  "#4ADE80", "#FACC15", "#F4F3EE", "#181614",
];

/* ---------- State -------------------------------------------------------- */
const state = {
  canvas: null,
  ctx: null,
  dpr: 1,
  cssW: 0,
  cssH: 0,

  fieldKey: "classic",
  themeKey: "dark",          // "light" | "dark" — driven by <html data-theme>
  themeTween: null,         // { from, to, t0, dur } during transitions
  accent: "#FF8A4C",         // resolved from CSS --accent if present

  // ---- Steps (planned plays) ------------------------------------------
  mode: "sandbox",          // "sandbox" — free play (multi-arrow, no clip) | "steps" — step editor
  steps: [],                // [{ id, moves: [{pieceId,kind,label,fromFx,fromFy,toFx,toFy}] }]
  maxRadius: { player: 0.20, ball: 0.20 * 1.7 },  // as fraction of field width
  playing: null,            // { restore, stepIdx, timer } during playback
  stepIdCounter: 0,

  pieces: [],          // field pieces
  nextId: 1,
  history: [],         // [{ type: 'arrow'|'move', piece, ... }] for undo

  hover: null,
  drag: null,          // { piece, dx, dy }
  drawing: null,       // { piece, endX, endY }
  mouse: { x: 0, y: 0 },

  dispensers: [],      // [{ kind, anchorX, anchorY, dirX, items: [...] }]

  fieldRect: null,
  bottomStripH: 110,

  // ---- Annotations (mode-agnostic; hidden during playback) -----------
  tool: "select",      // "select" | "line" | "circle" | "arrow" | "text"
  annotations: [],     // [{ type, ...geom, color, width, font, fontSize, text }]
  annotationDraft: null, // { type, startX, startY, endX, endY, color, width }
  annotationStyle: {
    // initial color is set in init() based on the active theme
    // (black on light, white on dark)
    color:    "#181614",
    width:    3,
    font:     "Inter",
    fontSize: 18,
  },
  textEditing: null,   // { inputEl, m } while typing a text annotation
  exporting: false,    // suppress dispensers/UI artifacts during PNG capture

  // ---- Annotation selection / drag (Select tool) ---------------------
  selectedAnnotation: null,
  hoverAnnotation:    null,
  draggingAnnotation: null, // { annotation, lastMx, lastMy, before }
};

/* ---------- Utility ------------------------------------------------------ */
function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function pieceRadiusFor(kind) {
  if (!state.fieldRect) return 10;
  const base = Math.min(state.fieldRect.w, state.fieldRect.h);
  return (kind === "ball" ? 0.017 : 0.033) * base;
}

function dispenserRadiusFor(kind) {
  return kind === "ball" ? 6 : 12;
}

function hitTestPiece(x, y) {
  for (let i = state.pieces.length - 1; i >= 0; i--) {
    const p = state.pieces[i];
    if (dist(x, y, p.x, p.y) <= p.r + 2) return p;
  }
  return null;
}

function hitTestDispenserFront(x, y) {
  for (const d of state.dispensers) {
    if (d.items.length === 0) continue;
    const front = d.items[0];
    if (dist(x, y, front.x, front.y) <= front.r + 2) return { dispenser: d, item: front };
  }
  return null;
}

/* ---------- Layout ------------------------------------------------------- */
function computeFieldRect() {
  const preset = FIELD_PRESETS[state.fieldKey];
  const sideMargin = 60;
  const topMargin = state.topInset || 30;
  const stripeY = state.cssH - state.bottomStripH;
  const availW = state.cssW - sideMargin * 2;
  const availH = stripeY - topMargin - (state.bottomToolbarH || 0) - 12;
  const scale = Math.min(availW / preset.w, availH / preset.h);
  const w = preset.w * scale;
  const h = preset.h * scale;
  const x = (state.cssW - w) / 2;
  const y = topMargin + (availH - h) / 2;
  return { x, y, w, h, scale, preset };
}

function dispenserSlotPos(d, index) {
  const spacing = (dispenserRadiusFor(d.kind) * 2) + 8;
  return {
    x: d.anchorX + d.dirX * index * spacing,
    y: d.anchorY,
  };
}

function resize() {
  const c = state.canvas;
  const rect = c.getBoundingClientRect();
  state.cssW = rect.width;
  state.cssH = rect.height;
  state.dpr = window.devicePixelRatio || 1;
  c.width = Math.round(rect.width * state.dpr);
  c.height = Math.round(rect.height * state.dpr);
  state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

  // Allow each variant's HTML to declare reserved space at top/bottom
  // (where floating UI sits) via CSS vars on <body>.
  const cs = getComputedStyle(document.body);
  const strip = parseFloat(cs.getPropertyValue("--canvas-bottom-strip"));
  const topInset = parseFloat(cs.getPropertyValue("--canvas-top-inset"));
  const bottomTools = parseFloat(cs.getPropertyValue("--canvas-bottom-toolbar"));
  state.bottomStripH = isFinite(strip) && strip > 0 ? strip : 110;
  state.topInset = isFinite(topInset) && topInset > 0 ? topInset : 30;
  state.bottomToolbarH = isFinite(bottomTools) && bottomTools >= 0 ? bottomTools : 0;

  layoutDispensers();
  snapDispenserItems();

  // Setting canvas.width/height clears the pixel buffer. If we wait for
  // the next requestAnimationFrame, the user sees an empty canvas for
  // ~16 ms — visible as a "blank flash" during sidebar collapse/expand,
  // because ResizeObserver fires on every transition frame. Repaint
  // synchronously here so the frame is never empty.
  if (state.ctx && state.cssW > 0 && state.cssH > 0) {
    state.fieldRect = computeFieldRect();
    updatePieceScreenCoords();
    drawField();
    drawArrows();
    drawPieces();
    drawAnnotations();
    if (!state.exporting) drawDispensers();
  }
}

function snapDispenserItems() {
  for (const d of state.dispensers) {
    for (let i = 0; i < d.items.length; i++) {
      const slot = dispenserSlotPos(d, i);
      d.items[i].x = slot.x;
      d.items[i].y = slot.y;
      d.items[i].vx = 0;
      d.items[i].vy = 0;
    }
  }
}

function updatePieceScreenCoords() {
  const f = state.fieldRect;
  for (const p of state.pieces) {
    p.x = f.x + p.fx * f.w;
    p.y = f.y + p.fy * f.h;
    p.r = pieceRadiusFor(p.kind);
  }
}

/* ---------- Piece motion animations (tween + flick momentum) -------- */
// shotEase: accelerates from rest, overshoots target by ~12%, settles back.
// Gives the piece a "projected forward" feel when sent along an arrow.
function shotEase(t) {
  if (t >= 1) return 1;
  const peak = 0.62;       // when we reach maximum overshoot
  const overshoot = 1.12;  // 12% past destination
  const smoothstep = (u) => u * u * (3 - 2 * u);
  if (t < peak) {
    return overshoot * smoothstep(t / peak);
  }
  const u = (t - peak) / (1 - peak);
  return overshoot + (1 - overshoot) * smoothstep(u);
}

function tickPieceAnimations() {
  const now = performance.now();
  for (const p of state.pieces) {
    const a = p.anim;
    if (!a) continue;
    if (a.kind === "tween") {
      const raw = Math.min(1, (now - a.t0) / a.dur);
      const e = (a.ease || easeInOutCubic)(raw);
      p.fx = a.fromFx + (a.toFx - a.fromFx) * e;
      p.fy = a.fromFy + (a.toFy - a.fromFy) * e;
      if (raw >= 1) { p.fx = a.toFx; p.fy = a.toFy; p.anim = null; }
    } else if (a.kind === "momentum") {
      p.fx += a.vx;
      p.fy += a.vy;
      a.vx *= 0.85;
      a.vy *= 0.85;
      if (Math.hypot(a.vx, a.vy) < 0.0006) p.anim = null;
      p.fx = Math.max(-0.05, Math.min(1.05, p.fx));
      p.fy = Math.max(-0.05, Math.min(1.05, p.fy));
    }
  }
}

function layoutDispensers() {
  const y = state.cssH - state.bottomStripH / 2;
  // Red dispenser: front (item 0) on right side of left half, extends left
  const redAnchorX = state.cssW * 0.5 - 110;
  // Ball: small group right of center
  const ballAnchorX = state.cssW * 0.5;
  // Blue: front on left side of right half, extends right
  const blueAnchorX = state.cssW * 0.5 + 110;

  if (state.dispensers.length === 0) {
    state.dispensers = [
      { kind: "red",  anchorX: redAnchorX,  anchorY: y, dirX: -1, items: [] },
      { kind: "ball", anchorX: ballAnchorX, anchorY: y, dirX: -1, items: [] },
      { kind: "blue", anchorX: blueAnchorX, anchorY: y, dirX: +1, items: [] },
    ];
    fillDispenser(state.dispensers[0], DISPENSER_CAPACITY);
    fillDispenser(state.dispensers[1], BALL_CAPACITY);
    fillDispenser(state.dispensers[2], DISPENSER_CAPACITY);
  } else {
    state.dispensers[0].anchorX = redAnchorX;
    state.dispensers[0].anchorY = y;
    state.dispensers[1].anchorX = ballAnchorX;
    state.dispensers[1].anchorY = y;
    state.dispensers[2].anchorX = blueAnchorX;
    state.dispensers[2].anchorY = y;
  }
}

function fillDispenser(d, count) {
  for (let i = 0; i < count; i++) {
    const slot = dispenserSlotPos(d, i);
    d.items.push({
      kind: d.kind,
      r: dispenserRadiusFor(d.kind),
      x: slot.x, y: slot.y,
      vx: 0, vy: 0,
    });
  }
}

function refillDispenser(d) {
  // add a new item off-screen behind the last existing slot, so it springs in
  const idx = d.items.length;
  const targetSlot = dispenserSlotPos(d, idx);
  const offX = targetSlot.x + d.dirX * 80;
  d.items.push({
    kind: d.kind,
    r: dispenserRadiusFor(d.kind),
    x: offX, y: targetSlot.y,
    vx: 0, vy: 0,
  });
}

/* ---------- Theme tween (Apple-clean fade between light/dark) ---------- */
function parseColor(c) {
  if (!c) return [0,0,0,0];
  if (c.startsWith("#")) {
    const hex = c.slice(1);
    const n = hex.length === 3
      ? hex.split("").map(h => parseInt(h+h,16))
      : [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
    return [n[0],n[1],n[2],1];
  }
  const m = c.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(",").map(s => parseFloat(s));
    return [parts[0]||0, parts[1]||0, parts[2]||0, parts[3]==null?1:parts[3]];
  }
  return [0,0,0,1];
}
function lerpColor(a, b, t) {
  const A = parseColor(a), B = parseColor(b);
  const r = A[0] + (B[0]-A[0])*t;
  const g = A[1] + (B[1]-A[1])*t;
  const bl = A[2] + (B[2]-A[2])*t;
  const al = A[3] + (B[3]-A[3])*t;
  return `rgba(${r|0},${g|0},${bl|0},${al})`;
}
function easeInOutCubic(t) {
  return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
}
function activeTheme() {
  if (!state.themeTween) return FIELD_THEMES[state.themeKey];
  const { from, to, t0, dur } = state.themeTween;
  const raw = Math.min(1, (performance.now() - t0) / dur);
  const t = easeInOutCubic(raw);
  if (raw >= 1) { state.themeTween = null; return FIELD_THEMES[to]; }
  const A = FIELD_THEMES[from], B = FIELD_THEMES[to];
  return {
    bg: lerpColor(A.bg, B.bg, t),
    line: lerpColor(A.line, B.line, t),
    lineGlow: null,
    netColor: lerpColor(A.netColor, B.netColor, t),
    leftPost: lerpColor(A.leftPost, B.leftPost, t),
    rightPost: lerpColor(A.rightPost, B.rightPost, t),
    fieldHint: lerpColor(A.fieldHint, B.fieldHint, t),
    stripBg: lerpColor(A.stripBg, B.stripBg, t),
    stripLine: lerpColor(A.stripLine, B.stripLine, t),
    rail: lerpColor(A.rail, B.rail, t),
  };
}
function setUITheme(next, { animate = true } = {}) {
  if (next !== "light" && next !== "dark") return;
  if (state.themeKey === next) return;
  if (animate) {
    state.themeTween = { from: state.themeKey, to: next, t0: performance.now(), dur: 380 };
  }
  state.themeKey = next;

  // If the user is still on a theme-default annotation color (i.e. hasn't
  // explicitly picked something), swap it to the new theme's default so
  // black text doesn't end up invisible on a dark canvas (or vice versa).
  const THEME_DEFAULTS = ["#181614", "#F4F3EE"];
  const newDefault = next === "dark" ? "#F4F3EE" : "#181614";
  if (THEME_DEFAULTS.includes(state.annotationStyle.color)) {
    state.annotationStyle.color = newDefault;
    notifyStepsChange();
  }
}

/* ---------- Field rendering --------------------------------------------- */
function drawField() {
  const ctx = state.ctx;
  const theme = activeTheme();
  const { x, y, w, h, scale, preset } = state.fieldRect;

  // outer background
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, state.cssW, state.cssH);

  // subtle field tint (no full fill — only outlines per request)
  ctx.fillStyle = theme.fieldHint;
  ctx.fillRect(x, y, w, h);

  ctx.save();
  ctx.lineWidth = Math.max(1.5, scale * 1.4);
  ctx.strokeStyle = theme.line;
  if (theme.lineGlow) {
    ctx.shadowColor = theme.lineGlow;
    ctx.shadowBlur = 10;
  }

  // outer rectangle
  ctx.strokeRect(x, y, w, h);

  // halfway line
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y);
  ctx.lineTo(x + w / 2, y + h);
  ctx.stroke();

  // center circle
  const cr = Math.min(w, h) * 0.13;
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h / 2, cr, 0, Math.PI * 2);
  ctx.stroke();

  // center dot
  ctx.shadowBlur = 0;
  ctx.fillStyle = theme.line;
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h / 2, Math.max(2, scale * 0.8), 0, Math.PI * 2);
  ctx.fill();

  // goal areas (rectangles in front of goals)
  const gaW = preset.goalDepth * scale * 2.5;
  const gaH = preset.goalHeight * scale * 1.4;
  if (theme.lineGlow) {
    ctx.shadowColor = theme.lineGlow;
    ctx.shadowBlur = 10;
  }
  ctx.strokeRect(x, y + (h - gaH) / 2, gaW, gaH);
  ctx.strokeRect(x + w - gaW, y + (h - gaH) / 2, gaW, gaH);
  ctx.restore();

  drawGoal(x, y, w, h, preset, scale, theme, "left");
  drawGoal(x, y, w, h, preset, scale, theme, "right");
}

function drawGoal(x, y, w, h, preset, scale, theme, side) {
  const ctx = state.ctx;
  const gw = preset.goalDepth * scale;
  const gh = preset.goalHeight * scale;
  const gx = side === "left" ? x - gw : x + w;
  const gy = y + (h - gh) / 2;

  // net clipped to the goal box only
  ctx.save();
  ctx.beginPath();
  ctx.rect(gx, gy, gw, gh);
  ctx.clip();

  ctx.strokeStyle = theme.netColor;
  ctx.lineWidth = 1;
  const step = Math.max(5, scale * 3);
  ctx.beginPath();
  for (let i = -gh; i <= gw + gh; i += step) {
    ctx.moveTo(gx + i, gy);
    ctx.lineTo(gx + i + gh, gy + gh);
    ctx.moveTo(gx + i, gy + gh);
    ctx.lineTo(gx + i + gh, gy);
  }
  ctx.stroke();
  ctx.restore();

  // goal frame (back + top + bottom)
  ctx.save();
  ctx.strokeStyle = theme.netColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (side === "left") {
    ctx.moveTo(x, gy);
    ctx.lineTo(gx, gy);
    ctx.lineTo(gx, gy + gh);
    ctx.lineTo(x, gy + gh);
  } else {
    ctx.moveTo(x + w, gy);
    ctx.lineTo(gx + gw, gy);
    ctx.lineTo(gx + gw, gy + gh);
    ctx.lineTo(x + w, gy + gh);
  }
  ctx.stroke();
  ctx.restore();

  // post (colored, on goal line)
  ctx.save();
  ctx.strokeStyle = side === "left" ? theme.leftPost : theme.rightPost;
  ctx.lineWidth = Math.max(2, scale * 1.6);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(side === "left" ? x : x + w, gy);
  ctx.lineTo(side === "left" ? x : x + w, gy + gh);
  ctx.stroke();
  ctx.restore();
}

/* ---------- Pieces ------------------------------------------------------- */
const LABEL_CHARS = "123456789abcdefghijklmnopqrstuvwxyz";

function nextLabelFor(kind) {
  const used = new Set(
    state.pieces.filter(p => p.kind === kind && p.label).map(p => p.label)
  );
  for (const c of LABEL_CHARS) if (!used.has(c)) return c;
  return "?";
}

function addPiece(kind, screenX, screenY) {
  if (!state.fieldRect) state.fieldRect = computeFieldRect();
  const f = state.fieldRect;
  // Clamp the *spawn* position into the field so dispenser grabs don't
  // place pieces inside the dispenser strip itself. Subsequent drags stay
  // unclamped — users can still move pieces into goal pockets later.
  const r = pieceRadiusFor(kind);
  const margin = r + 4;
  const sx = Math.max(f.x + margin, Math.min(f.x + f.w - margin, screenX));
  const sy = Math.max(f.y + margin, Math.min(f.y + f.h - margin, screenY));
  const fx = (sx - f.x) / f.w;
  const fy = (sy - f.y) / f.h;
  const piece = {
    id: state.nextId++,
    kind,
    fx, fy,
    stepStartFx: fx,   // origin for the current pending step
    stepStartFy: fy,
    x: sx,
    y: sy,
    r,
    style: PIECE_STYLES[kind],
    label: kind === "ball" ? null : nextLabelFor(kind),
    arrows: [],
    anim: null,
  };
  state.pieces.push(piece);
  notifyStepsChange();
  return piece;
}

function removePiece(piece) {
  const i = state.pieces.indexOf(piece);
  if (i >= 0) state.pieces.splice(i, 1);
  state.history = state.history.filter(e => e.piece !== piece);
  notifyStepsChange();
}

function drawPiece(p, ctx) {
  // resolve style live so it reacts to theme changes (esp. ball)
  const style = pieceStyleFor(p.kind);
  // hover halo
  if (state.hover === p) {
    ctx.save();
    ctx.strokeStyle = style.inner;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  if (p.kind === "ball") {
    // ball: solid filled disc with subtle ring for definition
    ctx.save();
    ctx.fillStyle = style.stroke;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Refined: thinner outline, subtle inner fill tint for legibility on either theme.
  const lw = Math.max(1.5, p.r * 0.16);

  // soft inner fill — surface-tinted so labels remain readable on both themes
  ctx.save();
  ctx.fillStyle = state.themeKey === "light" ? "#FFFFFF" : "#17171A";
  ctx.globalAlpha = 0.92;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.r - lw / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // main outline (crisp)
  ctx.save();
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.r - lw / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // label (number / letter) — JetBrains Mono for tactical readout vibe
  if (p.label) {
    ctx.save();
    ctx.fillStyle = style.stroke;
    ctx.font = `600 ${Math.round(p.r * 1.05)}px "JetBrains Mono", "SF Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(p.label, p.x, p.y + p.r * 0.05);
    ctx.restore();
  }
}

function drawPieces() {
  for (const p of state.pieces) drawPiece(p, state.ctx);
}

/* ---------- Dispensers --------------------------------------------------- */
function updateDispenserPhysics() {
  for (const d of state.dispensers) {
    for (let i = 0; i < d.items.length; i++) {
      const it = d.items[i];
      const slot = dispenserSlotPos(d, i);
      // spring toward slot
      const ax = (slot.x - it.x) * SPRING_K;
      const ay = (slot.y - it.y) * SPRING_K;
      it.vx = (it.vx + ax) * SPRING_D;
      it.vy = (it.vy + ay) * SPRING_D;
      it.x += it.vx;
      it.y += it.vy;
    }
  }
}

function drawDispensers() {
  const ctx = state.ctx;
  const theme = activeTheme();
  // strip background hint
  ctx.save();
  ctx.fillStyle = theme.stripBg;
  ctx.fillRect(0, state.cssH - state.bottomStripH, state.cssW, state.bottomStripH);
  ctx.strokeStyle = theme.stripLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, state.cssH - state.bottomStripH + 0.5);
  ctx.lineTo(state.cssW, state.cssH - state.bottomStripH + 0.5);
  ctx.stroke();
  ctx.restore();

  // dispenser tracks (subtle rail behind items) + label
  for (const d of state.dispensers) {
    const r = dispenserRadiusFor(d.kind);
    const capacity = d.kind === "ball" ? BALL_CAPACITY : DISPENSER_CAPACITY;
    const last = dispenserSlotPos(d, capacity - 1);
    const front = dispenserSlotPos(d, 0);
    ctx.save();
    ctx.strokeStyle = theme.rail;
    ctx.lineWidth = r * 2 + 6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(front.x, front.y);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    ctx.restore();

    // front marker (small notch indicating where you grab from)
    ctx.save();
    ctx.strokeStyle = pieceStyleFor(d.kind).stroke;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    const notchX = front.x + d.dirX * (r + 9);
    ctx.beginPath();
    ctx.moveTo(notchX, front.y - r - 1);
    ctx.lineTo(notchX, front.y + r + 1);
    ctx.stroke();
    ctx.restore();
  }

  // items
  for (const d of state.dispensers) {
    for (let i = 0; i < d.items.length; i++) {
      const it = d.items[i];
      const isFront = i === 0;
      drawDispenserItem(it, ctx, isFront);
    }
  }
}

function drawDispenserItem(it, ctx, isFront) {
  const style = pieceStyleFor(it.kind);

  // front item highlighted
  if (isFront) {
    ctx.save();
    ctx.strokeStyle = style.inner;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(it.x, it.y, it.r + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  if (it.kind === "ball") {
    // solid filled ball
    ctx.save();
    if (!isFront) ctx.globalAlpha = 0.55;
    ctx.fillStyle = style.stroke;
    ctx.beginPath();
    ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const lw = Math.max(2, it.r * 0.22);

  ctx.save();
  if (!isFront) ctx.globalAlpha = 0.55;
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(it.x, it.y, it.r - lw / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function grabFromDispenser(d, m) {
  // remove front, shift rest forward (their slot indices change)
  d.items.shift();
  // refill at the back so dispenser stays full
  const cap = d.kind === "ball" ? BALL_CAPACITY : DISPENSER_CAPACITY;
  if (d.items.length < cap) refillDispenser(d);

  // spawn a new piece on the field, sized for field
  const piece = addPiece(d.kind, m.x, m.y);
  // start drag immediately
  state.drag = { piece, dx: 0, dy: 0 };
  state.canvas.style.cursor = "grabbing";
}

/* ---------- Arrows ------------------------------------------------------- */
function arrowColorAt(kind, index, total) {
  const hue = ARROW_BASE_HUE[kind] ?? 0;
  const t = total <= 1 ? 0 : index / (total - 1);
  const lightness = 82 - t * 56;   // 82% (light) → 26% (dark)
  const saturation = 55 + t * 40;  // 55% → 95%
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function drawStraightArrow(x1, y1, x2, y2, color, opts = {}) {
  const ctx = state.ctx;
  const width = opts.width ?? 4;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 4) return;

  const ang = Math.atan2(dy, dx);
  const headLen = Math.min(width * 5.0, len * 0.6);
  const headW = width * 1.35;

  // shaft (stop before arrowhead tip so head looks clean)
  const shaftEndX = x2 - Math.cos(ang) * headLen * 0.75;
  const shaftEndY = y2 - Math.sin(ang) * headLen * 0.75;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  if (opts.glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
  }
  if (opts.dashed) {
    ctx.setLineDash([8, 6]);
    ctx.globalAlpha = 0.75;
  }

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(shaftEndX, shaftEndY);
  ctx.stroke();

  if (!opts.dashed) {
    // arrowhead triangle
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - Math.cos(ang) * headLen + Math.cos(ang + Math.PI / 2) * headW,
      y2 - Math.sin(ang) * headLen + Math.sin(ang + Math.PI / 2) * headW
    );
    ctx.lineTo(
      x2 - Math.cos(ang) * headLen - Math.cos(ang + Math.PI / 2) * headW,
      y2 - Math.sin(ang) * headLen - Math.sin(ang + Math.PI / 2) * headW
    );
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

// Build the chain of arrows that traces every saved-step move for one
// piece, in order. Used to keep cumulative arrows visible in steps mode
// after saves, deletes, and natural playback completion.
function buildCumulativeArrowsForPiece(piece) {
  const arrows = [];
  for (const step of state.steps) {
    const m = step.moves.find(x => x.pieceId === piece.id);
    if (!m) continue;
    if (Math.hypot(m.toFx - m.fromFx, m.toFy - m.fromFy) > 0.001) {
      arrows.push({
        fx1: m.fromFx, fy1: m.fromFy,
        fx2: m.toFx,   fy2: m.toFy,
        width: 3.25, glow: false,
      });
    }
  }
  return arrows;
}

function drawArrows() {
  const f = state.fieldRect;
  for (const p of state.pieces) {
    const total = p.arrows.length;
    for (let i = 0; i < p.arrows.length; i++) {
      const a = p.arrows[i];
      const x1 = f.x + a.fx1 * f.w;
      const y1 = f.y + a.fy1 * f.h;
      // intermediate arrows extend their tip to the next arrow's start
      // (i.e. the actual past piece position) so the chain has no gaps.
      // the last arrow lands at the piece's current position — pull its
      // tip back to the circle edge so the arrowhead is visible instead
      // of being hidden under the player.
      let x2, y2;
      if (i < total - 1) {
        const next = p.arrows[i + 1];
        x2 = f.x + next.fx1 * f.w;
        y2 = f.y + next.fy1 * f.h;
      } else {
        const tipX = f.x + a.fx2 * f.w;
        const tipY = f.y + a.fy2 * f.h;
        const dxL = tipX - x1, dyL = tipY - y1;
        const lenL = Math.hypot(dxL, dyL);
        if (lenL > p.r + 4) {
          x2 = tipX - (dxL / lenL) * (p.r + 2);
          y2 = tipY - (dyL / lenL) * (p.r + 2);
        } else {
          x2 = tipX; y2 = tipY;
        }
      }
      drawStraightArrow(x1, y1, x2, y2, arrowColorAt(p.kind, i, total),
        { width: a.width, glow: a.glow });
    }
  }
  if (state.drawing) {
    const d = state.drawing;
    const piece = d.piece;
    // Movement-radius circle + endpoint clip apply only in steps mode.
    let ex = d.endX, ey = d.endY;
    if (state.mode === "steps") {
      drawMovementRadius(piece);
      const ddx = ex - piece.x, ddy = ey - piece.y;
      const llen = Math.hypot(ddx, ddy);
      const maxPx = maxRadiusPx(piece.kind);
      if (llen > maxPx && llen > 0) {
        const k = maxPx / llen;
        ex = piece.x + ddx * k;
        ey = piece.y + ddy * k;
      }
    }
    const dx = ex - piece.x, dy = ey - piece.y;
    const len = Math.hypot(dx, dy);
    if (len > piece.r + 4) {
      const tipBack = piece.r + 2;
      const tipX = ex - (dx / len) * tipBack;
      const tipY = ey - (dy / len) * tipBack;
      drawGhostPieceAt(piece, ex, ey);
      const futureTotal = piece.arrows.length + 1;
      const previewColor = arrowColorAt(piece.kind, piece.arrows.length, futureTotal);
      drawStraightArrow(piece.x, piece.y, tipX, tipY, previewColor,
        { width: 3, dashed: true });
    }
  }
}

function drawMovementRadius(piece) {
  const ctx = state.ctx;
  const r = maxRadiusPx(piece.kind);
  if (r <= 0) return;
  ctx.save();
  // Use theme-aware accent tint, soft.
  ctx.strokeStyle = state.themeKey === "light"
    ? "rgba(244,119,59,0.32)"
    : "rgba(255,138,76,0.36)";
  ctx.fillStyle = state.themeKey === "light"
    ? "rgba(244,119,59,0.05)"
    : "rgba(255,138,76,0.04)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.arc(piece.x, piece.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawGhostPieceAt(piece, gx, gy) {
  const ctx = state.ctx;
  const r = piece.r;
  const style = pieceStyleFor(piece.kind);
  ctx.save();
  ctx.globalAlpha = 0.35;
  if (piece.kind === "ball") {
    ctx.fillStyle = style.stroke;
    ctx.beginPath();
    ctx.arc(gx, gy, r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const lw = Math.max(1.5, r * 0.16);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = lw;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(gx, gy, r - lw / 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function finalizeArrow(drawing) {
  const { piece, endX, endY } = drawing;
  const oldX = piece.x, oldY = piece.y;
  const oldFx = piece.fx, oldFy = piece.fy;
  let dx = endX - oldX, dy = endY - oldY;
  let len = Math.hypot(dx, dy);
  if (len < piece.r * 1.5) return;

  let ex = endX, ey = endY;
  // In steps mode: clip to per-piece movement radius.
  if (state.mode === "steps") {
    const maxPx = maxRadiusPx(piece.kind);
    if (len > maxPx) {
      const k = maxPx / len;
      ex = oldX + dx * k;
      ey = oldY + dy * k;
      dx = ex - oldX;
      dy = ey - oldY;
      len = maxPx;
    }
  }

  // arrow tip ends just outside piece edge at destination so the piece doesn't cover it
  const tipBack = piece.r + 2;
  const tipX = ex - (dx / len) * tipBack;
  const tipY = ey - (dy / len) * tipBack;

  const f = state.fieldRect;
  const arrow = {
    fx1: (oldX - f.x) / f.w,
    fy1: (oldY - f.y) / f.h,
    fx2: (tipX - f.x) / f.w,
    fy2: (tipY - f.y) / f.h,
    width: 3.25,
    glow: false,
  };
  // In steps mode: keep the cumulative saved-step arrows visible and add
  // the new pending arrow on top. In sandbox: free-form chain.
  if (state.mode === "steps") {
    piece.arrows = [...buildCumulativeArrowsForPiece(piece), arrow];
  } else {
    piece.arrows.push(arrow);
  }
  state.history.push({ type: "arrow", piece, arrow });

  // Animate piece along the arrow path with overshoot easing.
  const newFx = (ex - f.x) / f.w;
  const newFy = (ey - f.y) / f.h;
  const distFrac = Math.hypot(newFx - oldFx, newFy - oldFy);
  const dur = Math.min(480, Math.max(220, distFrac * 620));
  piece.anim = {
    kind: "tween",
    fromFx: oldFx, fromFy: oldFy,
    toFx: newFx,   toFy: newFy,
    t0: performance.now(),
    dur,
    ease: shotEase,
  };
  piece.fx = oldFx;
  piece.fy = oldFy;
  notifyStepsChange();
}

function undoLast() {
  while (state.history.length) {
    const last = state.history.pop();
    if (last.type === "annotation") {
      // Undo of an add — remove it.
      const idx = state.annotations.indexOf(last.annotation);
      if (idx >= 0) {
        state.annotations.splice(idx, 1);
        if (state.selectedAnnotation === last.annotation) state.selectedAnnotation = null;
        notifyStepsChange();
        return;
      }
      continue;
    }
    if (last.type === "annotation-delete") {
      // Undo of a delete — reinsert at original index.
      const idx = Math.max(0, Math.min(last.index, state.annotations.length));
      state.annotations.splice(idx, 0, last.annotation);
      state.selectedAnnotation = last.annotation;
      notifyStepsChange();
      return;
    }
    if (last.type === "annotation-move") {
      // Skip if the annotation has since been deleted; try next entry.
      if (!state.annotations.includes(last.annotation)) continue;
      applyAnnotationSnapshot(last.annotation, last.before);
      state.selectedAnnotation = last.annotation;
      notifyStepsChange();
      return;
    }
    if (!state.pieces.includes(last.piece)) continue;
    if (last.type === "arrow") {
      const idx = last.piece.arrows.indexOf(last.arrow);
      if (idx >= 0) {
        last.piece.arrows.splice(idx, 1);
        animatePieceTo(last.piece, last.arrow.fx1, last.arrow.fy1);
        return;
      }
    } else if (last.type === "move") {
      animatePieceTo(last.piece, last.prevFx, last.prevFy);
      return;
    }
  }
}

function animatePieceTo(piece, toFx, toFy) {
  const fromFx = piece.fx, fromFy = piece.fy;
  const dist = Math.hypot(toFx - fromFx, toFy - fromFy);
  if (dist < 0.001) { piece.fx = toFx; piece.fy = toFy; return; }
  piece.anim = {
    kind: "tween",
    fromFx, fromFy,
    toFx, toFy,
    t0: performance.now(),
    dur: Math.min(420, Math.max(180, dist * 600)),
    ease: easeInOutCubic,
  };
}

/* ---------- Steps: helpers ---------------------------------------------- */
function maxRadiusPx(kind) {
  if (!state.fieldRect) return 0;
  const base = state.fieldRect.w;
  const frac = kind === "ball" ? state.maxRadius.ball : state.maxRadius.player;
  return frac * base;
}

function notifyStepsChange() {
  // Debounced via microtask so a burst of operations only fires once.
  if (notifyStepsChange._q) return;
  notifyStepsChange._q = true;
  queueMicrotask(() => {
    notifyStepsChange._q = false;
    window.dispatchEvent(new CustomEvent("hax-state-changed"));
  });
}

/* ---------- Steps: save / clear / delete -------------------------------- */
function saveStep() {
  if (state.playing) return;
  if (state.mode !== "steps") return;
  // Snap any in-flight tween to its end so save captures the final positions.
  state.pieces.forEach(p => {
    if (p.anim && p.anim.kind === "tween") {
      p.fx = p.anim.toFx; p.fy = p.anim.toFy;
    }
    p.anim = null;
  });
  // Use the piece's actual current position as destination — this captures
  // both arrow-driven moves and free drag-moves uniformly, and guarantees
  // step N+1's `from` equals step N's `to` (no jumps at step transitions).
  const moves = state.pieces.map(p => ({
    pieceId: p.id,
    kind: p.kind,
    label: p.label,
    fromFx: p.stepStartFx, fromFy: p.stepStartFy,
    toFx: p.fx, toFy: p.fy,
  }));
  // Skip pure-noop steps (nothing planned, nobody moved).
  const anyMove = moves.some(m =>
    Math.hypot(m.toFx - m.fromFx, m.toFy - m.fromFy) > 0.001);
  if (!anyMove) return;

  state.steps.push({ id: ++state.stepIdCounter, moves });
  // Commit: each piece's new stepStart is its current resting position;
  // arrows snap to the cumulative saved-step chain so the user keeps
  // seeing every move so far.
  state.pieces.forEach(p => {
    p.stepStartFx = p.fx;
    p.stepStartFy = p.fy;
    p.arrows = buildCumulativeArrowsForPiece(p);
  });
  state.history = [];
  notifyStepsChange();
}

function clearPendingArrows() {
  if (state.playing) return;
  state.pieces.forEach(p => {
    // Drop the pending arrow but keep the cumulative saved-step trail.
    p.arrows = buildCumulativeArrowsForPiece(p);
    p.fx = p.stepStartFx;
    p.fy = p.stepStartFy;
    p.anim = null;
  });
  state.history = [];
  notifyStepsChange();
}

function deleteStep(idx) {
  if (state.playing) return;
  if (idx < 0 || idx >= state.steps.length) return;
  state.steps.splice(idx, 1);
  // Re-anchor surviving steps so chain remains continuous.
  for (let i = Math.max(0, idx); i < state.steps.length; i++) {
    const prev = i > 0 ? state.steps[i - 1] : null;
    const cur = state.steps[i];
    cur.moves.forEach(m => {
      if (prev) {
        const pm = prev.moves.find(x => x.pieceId === m.pieceId);
        if (pm) { m.fromFx = pm.toFx; m.fromFy = pm.toFy; }
      }
    });
  }
  // Reset live pieces to the last step's end (or to current stepStart if no steps).
  if (state.steps.length > 0) {
    const last = state.steps[state.steps.length - 1];
    state.pieces.forEach(p => {
      const m = last.moves.find(x => x.pieceId === p.id);
      if (m) {
        p.fx = m.toFx; p.fy = m.toFy;
        p.stepStartFx = m.toFx; p.stepStartFy = m.toFy;
        p.anim = null;
      }
      // Rebuild every piece's cumulative trail against the trimmed chain.
      p.arrows = buildCumulativeArrowsForPiece(p);
    });
  } else {
    state.pieces.forEach(p => { p.arrows = []; });
  }
  notifyStepsChange();
}

function clearAllSteps() {
  if (state.playing) return;
  state.steps = [];
  state.pieces.forEach(p => {
    p.stepStartFx = p.fx;
    p.stepStartFy = p.fy;
    p.arrows = [];
    p.anim = null;
  });
  notifyStepsChange();
}

/* ---------- Steps: playback --------------------------------------------- */
function playSteps() {
  if (state.playing || state.steps.length === 0) return;

  const restore = state.pieces.map(p => ({
    piece: p,
    fx: p.fx, fy: p.fy,
    arrows: [...p.arrows],
    stepStartFx: p.stepStartFx, stepStartFy: p.stepStartFy,
    anim: p.anim,
  }));

  // Hide all sandbox/pending arrows during playback (animation has no lines).
  state.pieces.forEach(p => { p.arrows = []; p.anim = null; });

  // Reset every piece to step 0's "from" if it has a record there.
  state.steps[0].moves.forEach(m => {
    const p = state.pieces.find(x => x.id === m.pieceId);
    if (p) { p.fx = m.fromFx; p.fy = m.fromFy; }
  });

  state.playing = { restore, stepIdx: -1, timer: null };
  notifyStepsChange();
  playNextStep();
}

const BALL_SPEED   = 0.65;  // field-widths per second (constant)
const PLAYER_SPEED = 0.55;  // used only when a step has no ball move

function playNextStep() {
  if (!state.playing) return;
  const idx = ++state.playing.stepIdx;
  state.playing.currentIdx = idx;
  if (idx >= state.steps.length) {
    finishPlayback(false);
    return;
  }
  const step = state.steps[idx];
  const now = performance.now();

  // Step duration is dictated by the ball (constant speed). If no ball
  // moves in this step, fall back to the longest player move at player speed.
  let dur = 500;
  const ballMove = step.moves.find(m => m.kind === "ball" &&
    Math.hypot(m.toFx - m.fromFx, m.toFy - m.fromFy) > 0.001);
  if (ballMove) {
    const d = Math.hypot(ballMove.toFx - ballMove.fromFx, ballMove.toFy - ballMove.fromFy);
    dur = Math.max(420, (d / BALL_SPEED) * 1000);
  } else {
    let maxD = 0;
    step.moves.forEach(m => {
      const d = Math.hypot(m.toFx - m.fromFx, m.toFy - m.fromFy);
      if (d > maxD) maxD = d;
    });
    dur = maxD > 0 ? Math.max(420, (maxD / PLAYER_SPEED) * 1000) : 500;
  }

  step.moves.forEach(m => {
    const p = state.pieces.find(x => x.id === m.pieceId);
    if (!p) return;
    p.fx = m.fromFx; p.fy = m.fromFy;
    p.anim = {
      kind: "tween",
      fromFx: m.fromFx, fromFy: m.fromFy,
      toFx: m.toFx,     toFy: m.toFy,
      t0: now,
      dur,
      ease: m.kind === "ball" ? (t => t) : easeInOutCubic,
    };
  });

  notifyStepsChange();
  state.playing.timer = setTimeout(playNextStep, dur + 60);
}

// restorePositions = true → Stop button: rewind pieces and their arrows
//                            to the state captured at the start of playback.
// restorePositions = false → natural end (ran past the last step):
//                            leave pieces at the last step's destination
//                            and overlay the last step's move as an arrow
//                            so the user sees what just played.
function finishPlayback(restorePositions = true) {
  if (!state.playing) return;
  if (state.playing.timer) clearTimeout(state.playing.timer);

  if (restorePositions) {
    state.playing.restore.forEach(r => {
      r.piece.fx = r.fx; r.piece.fy = r.fy;
      r.piece.arrows = r.arrows;
      r.piece.stepStartFx = r.stepStartFx;
      r.piece.stepStartFy = r.stepStartFy;
      r.piece.anim = null;
    });
  } else {
    // Snap any in-flight tween to its endpoint (in case a frame was
    // dropped between the last anim tick and this callback), restore
    // stepStart anchors but leave fx/fy at the last step's destination.
    state.playing.restore.forEach(r => {
      const a = r.piece.anim;
      if (a && a.kind === "tween") {
        r.piece.fx = a.toFx; r.piece.fy = a.toFy;
      }
      r.piece.stepStartFx = r.stepStartFx;
      r.piece.stepStartFy = r.stepStartFy;
      r.piece.anim = null;
    });
    // Overlay every saved step as a cumulative arrow trail on each piece.
    state.pieces.forEach(p => {
      p.arrows = buildCumulativeArrowsForPiece(p);
    });
  }

  state.playing = null;
  notifyStepsChange();
}

/* ---------- Steps: PNG export -------------------------------------------- */
function exportSnapshotPNG() {
  // Render the latest state synchronously, *without* the dispenser strip,
  // so the snapshot reliably shows pending arrows + annotations.
  // Doing this inline (instead of trusting the rAF loop's frame) also avoids
  // a race where toDataURL captures a frame that hasn't drawn the arrows yet.
  try {
    state.exporting = true;
    state.fieldRect = computeFieldRect();
    updatePieceScreenCoords();
    drawField();
    drawArrows();
    drawPieces();
    drawAnnotations();
    const url = state.canvas.toDataURL("image/png");
    state.exporting = false;

    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);
    a.href = url;
    a.download = `haxtactics-snapshot-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    state.exporting = false;
    console.error("PNG export failed:", e);
  }
}

// Render and download a PNG for a specific step. Pieces are placed at the
// step's end positions and every saved step from 0 up to stepIdx is drawn
// as a cumulative arrow chain — so step 4's PNG carries arrows from steps
// 1-4. Live state is restored before returning.
function exportStepPNG(stepIdx) {
  if (!Number.isInteger(stepIdx) || stepIdx < 0 || stepIdx >= state.steps.length) return;

  const saved = state.pieces.map(p => ({
    piece: p,
    fx: p.fx, fy: p.fy,
    arrows: [...p.arrows],
    anim: p.anim,
  }));
  const savedExporting = state.exporting;

  try {
    // Apply cumulative moves up to and including stepIdx for every piece.
    state.pieces.forEach(p => {
      let endFx = p.fx, endFy = p.fy;
      const arrows = [];
      for (let i = 0; i <= stepIdx; i++) {
        const m = state.steps[i].moves.find(x => x.pieceId === p.id);
        if (!m) continue;
        if (Math.hypot(m.toFx - m.fromFx, m.toFy - m.fromFy) > 0.001) {
          arrows.push({
            fx1: m.fromFx, fy1: m.fromFy,
            fx2: m.toFx,   fy2: m.toFy,
            width: 3.25, glow: false,
          });
        }
        endFx = m.toFx; endFy = m.toFy;
      }
      p.fx = endFx; p.fy = endFy;
      p.arrows = arrows;
      p.anim = null;
    });

    state.exporting = true;
    state.fieldRect = computeFieldRect();
    updatePieceScreenCoords();
    drawField();
    drawArrows();
    drawPieces();
    drawAnnotations();
    const url = state.canvas.toDataURL("image/png");

    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `haxtactics-step${stepIdx + 1}-${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    console.error("Per-step PNG export failed:", e);
  } finally {
    state.exporting = savedExporting;
    saved.forEach(s => {
      s.piece.fx = s.fx;
      s.piece.fy = s.fy;
      s.piece.arrows = s.arrows;
      s.piece.anim = s.anim;
    });
  }
}

/* ---------- Annotations -------------------------------------------------- */
function drawAnnotations() {
  // Hidden during playback (so the animation isn't cluttered) and during
  // the static state otherwise — they're always painted on top of arrows
  // and pieces in both sandbox and steps modes.
  if (state.playing) return;
  const ctx = state.ctx;
  const f = state.fieldRect;
  for (const a of state.annotations) {
    if      (a.type === "line")   drawLineAnno(ctx, f, a);
    else if (a.type === "arrow")  drawArrowAnno(ctx, f, a);
    else if (a.type === "circle") drawCircleAnno(ctx, f, a);
    else if (a.type === "text")   drawTextAnno(ctx, f, a);
    else if (a.type === "pencil") drawPencilAnno(ctx, f, a);
  }
  // Hover/selection highlights — never appear in the PNG export (we still
  // call drawAnnotations during export, but selection only shows in
  // select-tool mode).
  if (!state.exporting && state.tool === "select") {
    if (state.hoverAnnotation && state.hoverAnnotation !== state.selectedAnnotation) {
      drawAnnotationSelectionBox(ctx, f, state.hoverAnnotation, "hover");
    }
    if (state.selectedAnnotation) {
      drawAnnotationSelectionBox(ctx, f, state.selectedAnnotation, "selected");
    }
  }
  if (state.annotationDraft) drawAnnotationDraftPreview(ctx, state.annotationDraft);
}

function drawLineAnno(ctx, f, a) {
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.lineWidth = a.width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(f.x + a.fx1 * f.w, f.y + a.fy1 * f.h);
  ctx.lineTo(f.x + a.fx2 * f.w, f.y + a.fy2 * f.h);
  ctx.stroke();
  ctx.restore();
}
function drawArrowAnno(ctx, f, a) {
  const x1 = f.x + a.fx1 * f.w, y1 = f.y + a.fy1 * f.h;
  const x2 = f.x + a.fx2 * f.w, y2 = f.y + a.fy2 * f.h;
  drawStraightArrow(x1, y1, x2, y2, a.color, { width: a.width });
}
function drawCircleAnno(ctx, f, a) {
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.lineWidth = a.width;
  ctx.beginPath();
  ctx.arc(f.x + a.fx * f.w, f.y + a.fy * f.h, a.rNorm * f.w, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
function drawTextAnno(ctx, f, a) {
  ctx.save();
  ctx.fillStyle = a.color;
  const px = Math.max(8, a.fontSize);
  ctx.font = `600 ${px}px "${a.font}", "Inter", system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(a.text, f.x + a.fx * f.w, f.y + a.fy * f.h);
  ctx.restore();
}

function drawPencilAnno(ctx, f, a) {
  if (!a.points || a.points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.lineWidth = a.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  // Smooth the polyline by drawing quadratic curves through the midpoints.
  // Each stored point acts as a control, the midpoint as the segment end.
  const p0 = a.points[0];
  ctx.moveTo(f.x + p0.fx * f.w, f.y + p0.fy * f.h);
  for (let i = 1; i < a.points.length - 1; i++) {
    const p = a.points[i];
    const q = a.points[i + 1];
    const cx = f.x + p.fx * f.w;
    const cy = f.y + p.fy * f.h;
    const mx = f.x + ((p.fx + q.fx) / 2) * f.w;
    const my = f.y + ((p.fy + q.fy) / 2) * f.h;
    ctx.quadraticCurveTo(cx, cy, mx, my);
  }
  const last = a.points[a.points.length - 1];
  ctx.lineTo(f.x + last.fx * f.w, f.y + last.fy * f.h);
  ctx.stroke();
  ctx.restore();
}

function drawAnnotationDraftPreview(ctx, d) {
  ctx.save();
  ctx.strokeStyle = d.color;
  ctx.fillStyle = d.color;
  ctx.lineWidth = d.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (d.type === "pencil") {
    // Solid stroke for pencil — dashed would look noisy on a free curve.
    if (d.points && d.points.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(d.points[0].x, d.points[0].y);
      for (let i = 1; i < d.points.length; i++) {
        ctx.lineTo(d.points[i].x, d.points[i].y);
      }
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  ctx.setLineDash([8, 6]);
  ctx.globalAlpha = 0.85;
  if (d.type === "line") {
    ctx.beginPath();
    ctx.moveTo(d.startX, d.startY);
    ctx.lineTo(d.endX, d.endY);
    ctx.stroke();
  } else if (d.type === "arrow") {
    ctx.setLineDash([]);
    drawStraightArrow(d.startX, d.startY, d.endX, d.endY, d.color, { width: d.width });
  } else if (d.type === "circle") {
    const cx = (d.startX + d.endX) / 2;
    const cy = (d.startY + d.endY) / 2;
    const r  = Math.hypot(d.endX - d.startX, d.endY - d.startY) / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------- Annotation hit-test, move, selection ----------------------- */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function annotationContains(a, x, y) {
  const f = state.fieldRect;
  if (!f) return false;
  const tol = Math.max(8, (a.width || 4) + 4);
  if (a.type === "line" || a.type === "arrow") {
    const x1 = f.x + a.fx1 * f.w, y1 = f.y + a.fy1 * f.h;
    const x2 = f.x + a.fx2 * f.w, y2 = f.y + a.fy2 * f.h;
    return distToSegment(x, y, x1, y1, x2, y2) <= tol;
  }
  if (a.type === "circle") {
    const cx = f.x + a.fx * f.w, cy = f.y + a.fy * f.h;
    const r  = a.rNorm * f.w;
    // Ring hit-test: clicks pass through the interior so overlapping
    // pieces stay reachable. Only the ring (within `tol` of the edge)
    // is grabbable.
    return Math.abs(Math.hypot(x - cx, y - cy) - r) <= tol;
  }
  if (a.type === "pencil") {
    if (!a.points || a.points.length < 2) return false;
    for (let i = 1; i < a.points.length; i++) {
      const x1 = f.x + a.points[i-1].fx * f.w, y1 = f.y + a.points[i-1].fy * f.h;
      const x2 = f.x + a.points[i].fx   * f.w, y2 = f.y + a.points[i].fy   * f.h;
      if (distToSegment(x, y, x1, y1, x2, y2) <= tol) return true;
    }
    return false;
  }
  if (a.type === "text") {
    const ctx = state.ctx;
    ctx.save();
    ctx.font = `600 ${Math.max(8, a.fontSize)}px "${a.font}", "Inter", system-ui, sans-serif`;
    const m = ctx.measureText(a.text);
    ctx.restore();
    const x0 = f.x + a.fx * f.w, y0 = f.y + a.fy * f.h;
    const w = m.width, h = a.fontSize * 1.25;
    return x >= x0 - 4 && x <= x0 + w + 4 && y >= y0 - 4 && y <= y0 + h + 4;
  }
  return false;
}

function hitTestAnnotation(x, y) {
  // Topmost (last drawn) wins.
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    if (annotationContains(state.annotations[i], x, y)) return state.annotations[i];
  }
  return null;
}

function moveAnnotation(a, dfx, dfy) {
  if (a.type === "line" || a.type === "arrow") {
    a.fx1 += dfx; a.fy1 += dfy;
    a.fx2 += dfx; a.fy2 += dfy;
  } else if (a.type === "circle" || a.type === "text") {
    a.fx += dfx; a.fy += dfy;
  } else if (a.type === "pencil") {
    for (const p of a.points) { p.fx += dfx; p.fy += dfy; }
  }
}

function snapshotAnnotation(a) {
  if (a.type === "line" || a.type === "arrow") {
    return { fx1: a.fx1, fy1: a.fy1, fx2: a.fx2, fy2: a.fy2 };
  }
  if (a.type === "circle" || a.type === "text") {
    return { fx: a.fx, fy: a.fy };
  }
  if (a.type === "pencil") {
    return { points: a.points.map(p => ({ fx: p.fx, fy: p.fy })) };
  }
  return null;
}

function applyAnnotationSnapshot(a, snap) {
  if (!snap) return;
  if (snap.points) {
    a.points = snap.points.map(p => ({ fx: p.fx, fy: p.fy }));
    return;
  }
  for (const k of Object.keys(snap)) a[k] = snap[k];
}

function deleteAnnotation(ann) {
  const idx = state.annotations.indexOf(ann);
  if (idx < 0) return;
  state.annotations.splice(idx, 1);
  state.history.push({ type: "annotation-delete", annotation: ann, index: idx });
  if (state.selectedAnnotation === ann) state.selectedAnnotation = null;
  if (state.hoverAnnotation === ann) state.hoverAnnotation = null;
  notifyStepsChange();
}

function drawAnnotationSelectionBox(ctx, f, a, mode /* "selected" | "hover" */) {
  ctx.save();
  ctx.strokeStyle = mode === "selected" ? "rgba(255,138,76,0.95)" : "rgba(255,138,76,0.45)";
  ctx.lineWidth = mode === "selected" ? 1.5 : 1;
  ctx.setLineDash(mode === "selected" ? [5, 4] : [2, 4]);

  if (a.type === "circle") {
    const cx = f.x + a.fx * f.w, cy = f.y + a.fy * f.h;
    const r  = a.rNorm * f.w + 6;
    ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
    return;
  }
  if (a.type === "text") {
    ctx.font = `600 ${Math.max(8, a.fontSize)}px "${a.font}", "Inter", system-ui, sans-serif`;
    const m = ctx.measureText(a.text);
    const x0 = f.x + a.fx * f.w, y0 = f.y + a.fy * f.h;
    ctx.strokeRect(x0 - 4, y0 - 4, m.width + 8, a.fontSize * 1.25 + 8);
    ctx.restore();
    return;
  }

  // line / arrow / pencil — axis-aligned bounding box around their points
  let minX, minY, maxX, maxY;
  if (a.type === "line" || a.type === "arrow") {
    minX = Math.min(a.fx1, a.fx2); maxX = Math.max(a.fx1, a.fx2);
    minY = Math.min(a.fy1, a.fy2); maxY = Math.max(a.fy1, a.fy2);
  } else if (a.type === "pencil") {
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    for (const p of a.points) {
      if (p.fx < minX) minX = p.fx; if (p.fx > maxX) maxX = p.fx;
      if (p.fy < minY) minY = p.fy; if (p.fy > maxY) maxY = p.fy;
    }
  } else { ctx.restore(); return; }
  const x = f.x + minX * f.w - 6;
  const y = f.y + minY * f.h - 6;
  const w = (maxX - minX) * f.w + 12;
  const h = (maxY - minY) * f.h + 12;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function startAnnotationDraft(m) {
  state.annotationDraft = {
    type: state.tool,
    startX: m.x, startY: m.y,
    endX:   m.x, endY:   m.y,
    color: state.annotationStyle.color,
    width: state.annotationStyle.width,
    // pencil tool accumulates a path; other tools only need start/end
    points: state.tool === "pencil" ? [{ x: m.x, y: m.y }] : null,
  };
}

function finalizeAnnotationDraft() {
  const d = state.annotationDraft;
  state.annotationDraft = null;
  if (!d || !state.fieldRect) return;
  const f = state.fieldRect;
  const dx = d.endX - d.startX, dy = d.endY - d.startY;
  const len = Math.hypot(dx, dy);

  let ann;
  if (d.type === "circle") {
    if (len < 4) return;
    const cx = (d.startX + d.endX) / 2;
    const cy = (d.startY + d.endY) / 2;
    ann = {
      type: "circle",
      fx:    (cx - f.x) / f.w,
      fy:    (cy - f.y) / f.h,
      rNorm: (len / 2) / f.w,
      color: d.color,
      width: d.width,
    };
  } else if (d.type === "pencil") {
    if (!d.points || d.points.length < 2) return;
    // Decimate slightly to keep storage and rendering cheap on long strokes.
    const minDist = 1.5;
    const pts = [d.points[0]];
    for (let i = 1; i < d.points.length; i++) {
      const last = pts[pts.length - 1];
      if (Math.hypot(d.points[i].x - last.x, d.points[i].y - last.y) >= minDist) {
        pts.push(d.points[i]);
      }
    }
    if (pts[pts.length - 1] !== d.points[d.points.length - 1]) {
      pts.push(d.points[d.points.length - 1]);
    }
    if (pts.length < 2) return;
    ann = {
      type: "pencil",
      points: pts.map(p => ({
        fx: (p.x - f.x) / f.w,
        fy: (p.y - f.y) / f.h,
      })),
      color: d.color,
      width: d.width,
    };
  } else if (d.type === "line" || d.type === "arrow") {
    if (len < 4) return;
    ann = {
      type:  d.type,
      fx1:   (d.startX - f.x) / f.w,
      fy1:   (d.startY - f.y) / f.h,
      fx2:   (d.endX   - f.x) / f.w,
      fy2:   (d.endY   - f.y) / f.h,
      color: d.color,
      width: d.width,
    };
  }
  if (ann) {
    state.annotations.push(ann);
    state.history.push({ type: "annotation", annotation: ann });
    notifyStepsChange();
  }
}

function startTextEdit(m) {
  // Commit any in-progress text first so a second click doesn't drop work.
  commitTextEdit();
  const stage = state.canvas.parentElement;
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type and press Enter";
  input.className = "hax-text-input";
  // The canvas is the stage's only positioned child, so canvas-local
  // coords (m.x, m.y) are already stage-local coords here.
  Object.assign(input.style, {
    position:   "absolute",
    left:       m.x + "px",
    top:        m.y + "px",
    zIndex:     "20",
    background: "rgba(11,15,23,0.78)",
    color:      state.annotationStyle.color,
    border:     "1px solid rgba(255,255,255,0.18)",
    borderRadius: "6px",
    padding:    "4px 8px",
    outline:    "none",
    fontFamily: `"${state.annotationStyle.font}", "Inter", system-ui, sans-serif`,
    fontSize:   state.annotationStyle.fontSize + "px",
    fontWeight: "600",
    minWidth:   "120px",
    boxShadow:  "0 6px 18px rgba(0,0,0,0.35)",
  });
  stage.appendChild(input);
  input.focus();

  state.textEditing = {
    input,
    m,
    style: { ...state.annotationStyle },
  };

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter")  { e.preventDefault(); commitTextEdit(); }
    if (e.key === "Escape") { e.preventDefault(); cancelTextEdit(); }
  });
  input.addEventListener("blur", () => {
    // Defer so that mousedown's commit takes precedence (avoids double commit).
    const me = state.textEditing;
    setTimeout(() => {
      if (state.textEditing === me) commitTextEdit();
    }, 0);
  });
}

function commitTextEdit() {
  const ed = state.textEditing;
  if (!ed) return;
  const text = ed.input.value.trim();
  ed.input.remove();
  state.textEditing = null;
  if (!text || !state.fieldRect) return;
  const f = state.fieldRect;
  const ann = {
    type: "text",
    fx:   (ed.m.x - f.x) / f.w,
    fy:   (ed.m.y - f.y) / f.h,
    text,
    color:    ed.style.color,
    font:     ed.style.font,
    fontSize: ed.style.fontSize,
  };
  state.annotations.push(ann);
  state.history.push({ type: "annotation", annotation: ann });
  notifyStepsChange();
}

function cancelTextEdit() {
  if (state.textEditing && state.textEditing.input) {
    state.textEditing.input.remove();
  }
  state.textEditing = null;
}

function updateToolCursor() {
  if (!state.canvas) return;
  switch (state.tool) {
    case "line":
    case "circle":
    case "arrow":
    case "pencil": state.canvas.style.cursor = "crosshair"; break;
    case "text":   state.canvas.style.cursor = "text"; break;
    default:       state.canvas.style.cursor = "default";
  }
}

/* ---------- Input -------------------------------------------------------- */
function getMousePos(e) {
  const r = state.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onMouseDown(e) {
  if (state.playing) return;
  const m = getMousePos(e);

  // Annotation tools take over the left button completely (any tool
  // other than "select"). Right-click stays available for piece arrows.
  if (state.tool !== "select" && e.button === 0) {
    // preventDefault keeps focus on the text input we're about to create
    // (otherwise the default mousedown moves focus away → input blurs →
    // its commit-on-blur handler fires with empty value and the input
    // immediately disappears).
    e.preventDefault();
    if (state.tool === "text") {
      startTextEdit(m);
    } else {
      startAnnotationDraft(m);
    }
    return;
  }

  if (e.button === 0) {
    // left button — first check dispenser front, then field pieces
    const disp = hitTestDispenserFront(m.x, m.y);
    if (disp) {
      grabFromDispenser(disp.dispenser, m);
      if (state.drag) state.drag.skipUndo = true;
      return;
    }
    const target = hitTestPiece(m.x, m.y);
    if (target) {
      target.anim = null;
      state.drag = {
        piece: target,
        dx: m.x - target.x,
        dy: m.y - target.y,
        startFx: target.fx,
        startFy: target.fy,
        lastTime: 0,
        vx: 0, vy: 0,
        skipUndo: false,
      };
      state.canvas.style.cursor = "grabbing";
      // Picking up a piece clears any annotation selection.
      if (state.selectedAnnotation) {
        state.selectedAnnotation = null;
        notifyStepsChange();
      }
      return;
    }

    // No piece under cursor — try grabbing an annotation (move / select).
    const annHit = hitTestAnnotation(m.x, m.y);
    if (annHit) {
      state.selectedAnnotation = annHit;
      state.draggingAnnotation = {
        annotation: annHit,
        lastMx: m.x,
        lastMy: m.y,
        before: snapshotAnnotation(annHit),
        moved: false,
      };
      state.canvas.style.cursor = "grabbing";
      notifyStepsChange();
      return;
    }

    // Clicked empty canvas — clear any annotation selection.
    if (state.selectedAnnotation) {
      state.selectedAnnotation = null;
      notifyStepsChange();
    }
  } else if (e.button === 2) {
    const target = hitTestPiece(m.x, m.y);
    if (target) {
      target.anim = null;
      // In steps mode: a new arrow replaces the old one (piece reverts to stepStart).
      // In sandbox mode: arrows chain naturally, leave existing alone.
      if (state.mode === "steps" && target.arrows.length > 0) {
        target.arrows = [];
        target.fx = target.stepStartFx;
        target.fy = target.stepStartFy;
        target.x  = state.fieldRect.x + target.fx * state.fieldRect.w;
        target.y  = state.fieldRect.y + target.fy * state.fieldRect.h;
      }
      state.drawing = { piece: target, endX: m.x, endY: m.y };
    }
  }
}

function onMouseMove(e) {
  if (state.playing) {
    state.hover = null;
    state.canvas.style.cursor = "default";
    return;
  }
  const m = getMousePos(e);
  state.mouse = m;

  if (state.annotationDraft) {
    state.annotationDraft.endX = m.x;
    state.annotationDraft.endY = m.y;
    if (state.annotationDraft.type === "pencil") {
      const pts = state.annotationDraft.points;
      const last = pts[pts.length - 1];
      // Only push when the cursor has moved a meaningful distance — avoids
      // gigantic point arrays and ugly micro-jitter in the stored path.
      if (Math.hypot(m.x - last.x, m.y - last.y) >= 2) {
        pts.push({ x: m.x, y: m.y });
      }
    }
    return;
  }

  if (state.draggingAnnotation) {
    const f = state.fieldRect;
    const d = state.draggingAnnotation;
    const dfx = (m.x - d.lastMx) / f.w;
    const dfy = (m.y - d.lastMy) / f.h;
    if (Math.hypot(m.x - d.lastMx, m.y - d.lastMy) > 0) {
      moveAnnotation(d.annotation, dfx, dfy);
      d.lastMx = m.x;
      d.lastMy = m.y;
      d.moved = true;
    }
    return;
  }

  if (state.drag) {
    const f = state.fieldRect;
    const sx = m.x - state.drag.dx;
    const sy = m.y - state.drag.dy;
    const newFx = (sx - f.x) / f.w;
    const newFy = (sy - f.y) / f.h;
    // Track recent velocity in field-coords-per-frame (~16ms) for flick momentum.
    const now = performance.now();
    const last = state.drag.lastTime;
    if (last) {
      const dt = Math.max(1, now - last);
      const scale = 16 / dt;
      // Smooth velocity slightly so a single jitter doesn't dominate.
      const vx = (newFx - state.drag.piece.fx) * scale;
      const vy = (newFy - state.drag.piece.fy) * scale;
      state.drag.vx = (state.drag.vx || 0) * 0.4 + vx * 0.6;
      state.drag.vy = (state.drag.vy || 0) * 0.4 + vy * 0.6;
    }
    state.drag.lastTime = now;
    state.drag.piece.fx = newFx;
    state.drag.piece.fy = newFy;
    state.drag.piece.x = sx;
    state.drag.piece.y = sy;
    state.drag.piece.anim = null;
    return;
  }
  if (state.drawing) {
    state.drawing.endX = m.x;
    state.drawing.endY = m.y;
    return;
  }

  // When an annotation tool is active, never show grab/piece hover —
  // the tool defines the cursor.
  if (state.tool !== "select") {
    state.hover = null;
    state.hoverAnnotation = null;
    updateToolCursor();
    return;
  }

  const overDisp = hitTestDispenserFront(m.x, m.y);
  if (overDisp) {
    state.hover = null;
    state.hoverAnnotation = null;
    state.canvas.style.cursor = "grab";
    return;
  }
  state.hover = hitTestPiece(m.x, m.y);
  // If no piece under cursor, try annotation hover (lower priority than pieces).
  state.hoverAnnotation = state.hover ? null : hitTestAnnotation(m.x, m.y);
  if (state.hoverAnnotation) {
    state.canvas.style.cursor = "grab";
    return;
  }
  state.canvas.style.cursor = state.hover ? "grab" : "default";
}

function onMouseUp(e) {
  if (state.playing) return;
  if (e.button === 0 && state.annotationDraft) {
    finalizeAnnotationDraft();
    updateToolCursor();
    return;
  }
  if (e.button === 0 && state.draggingAnnotation) {
    const dA = state.draggingAnnotation;
    if (dA.moved) {
      state.history.push({
        type:       "annotation-move",
        annotation: dA.annotation,
        before:     dA.before,
      });
    }
    state.draggingAnnotation = null;
    state.canvas.style.cursor = state.hoverAnnotation ? "grab" : "default";
    notifyStepsChange();
    return;
  }
  if (e.button === 0 && state.drag) {
    const d = state.drag;
    if (!d.skipUndo) {
      const moved = Math.hypot(d.piece.fx - d.startFx, d.piece.fy - d.startFy);
      if (moved > 0.004) {
        state.history.push({
          type: "move",
          piece: d.piece,
          prevFx: d.startFx,
          prevFy: d.startFy,
        });
      }
    }
    // In steps mode: drag invalidates any pending arrow (the drag now
    // defines the destination). stepStart is preserved so the drag is
    // recorded into the next saved step — otherwise replaying the next
    // step would jump from old stepStart to drag-destination.
    // In sandbox mode: drag is free positioning, don't disturb arrows.
    if (state.mode === "steps") {
      d.piece.arrows = [];
    }

    // Flick momentum (kept for feel during free positioning).
    const vx = d.vx || 0, vy = d.vy || 0;
    const speed = Math.hypot(vx, vy);
    if (speed > 0.006) {
      const maxV = 0.025;
      const f = speed > maxV ? maxV / speed : 1;
      d.piece.anim = { kind: "momentum", vx: vx * f * 0.55, vy: vy * f * 0.55 };
    }
    state.drag = null;
    state.canvas.style.cursor = state.hover ? "grab" : "default";
    notifyStepsChange();
  } else if (e.button === 2 && state.drawing) {
    finalizeArrow(state.drawing);
    state.drawing = null;
  }
}

function onContextMenu(e) { e.preventDefault(); }

function onDoubleClick(e) {
  const m = getMousePos(e);
  const target = hitTestPiece(m.x, m.y);
  if (target) { removePiece(target); return; }
  // No piece — fall through to annotations so users can delete them via 2×LMB
  // (same shortcut they already use to remove pieces).
  if (state.tool === "select") {
    const annHit = hitTestAnnotation(m.x, m.y);
    if (annHit) deleteAnnotation(annHit);
  }
}

function onKeyDown(e) {
  // Skip shortcuts while user is typing inside an input/textarea/select.
  const tag = e.target && e.target.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

  // Ctrl/Cmd+Z — undo. Uses e.code so it works on non-Latin layouts.
  if (!typing && (e.ctrlKey || e.metaKey) && e.code === "KeyZ" && !e.shiftKey) {
    e.preventDefault();
    undoLast();
    return;
  }
  // Delete / Backspace — delete selected annotation.
  if (!typing && (e.key === "Delete" || e.key === "Backspace") && state.selectedAnnotation) {
    e.preventDefault();
    deleteAnnotation(state.selectedAnnotation);
    return;
  }
  // Escape — clear annotation selection.
  if (!typing && e.key === "Escape" && state.selectedAnnotation) {
    e.preventDefault();
    state.selectedAnnotation = null;
    notifyStepsChange();
    return;
  }
}

/* ---------- UI wiring ---------------------------------------------------- */
function wireUI() {
  const fp = document.getElementById("field-preset");
  if (fp) fp.addEventListener("change", (e) => {
    state.fieldKey = e.target.value;
  });
  const ft = document.getElementById("field-theme");
  if (ft) ft.addEventListener("change", (e) => {
    document.documentElement.dataset.theme = e.target.value === "light" ? "light" : "dark";
  });
  document.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const a = btn.dataset.action;
      if (a === "undo") undoLast();
      else if (a === "clear-arrows") {
        state.pieces.forEach(p => { p.arrows = []; });
        state.history = [];
        notifyStepsChange();
      } else if (a === "reset") {
        state.pieces = [];
        state.history = [];
        state.steps = [];
        state.annotations = [];
        state.selectedAnnotation = null;
        state.hoverAnnotation = null;
        cancelTextEdit();
        setupDefaultLineup();
        notifyStepsChange();
      } else if (a === "toggle-theme") {
        const next = state.themeKey === "light" ? "dark" : "light";
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem("hax_theme_v1", next); } catch {}
      }
    });
  });
  // Listen for UI-driven theme changes via <html data-theme>
  const htmlEl = document.documentElement;
  const syncThemeFromAttr = (animate = true) => {
    const v = htmlEl.dataset.theme === "light" ? "light" : "dark";
    setUITheme(v, { animate });
  };
  syncThemeFromAttr(false);
  // Initial annotation color must match the active theme. setUITheme()
  // only swaps colors on theme *changes*, so we do the first pick here
  // (covers the "same theme as default initial" case where no change fires).
  state.annotationStyle.color = state.themeKey === "dark" ? "#F4F3EE" : "#181614";
  const mo = new MutationObserver(() => syncThemeFromAttr(true));
  mo.observe(htmlEl, { attributes: true, attributeFilter: ["data-theme"] });

  // expose for inline UI
  window.HAX = {
    setTheme: (v) => { htmlEl.dataset.theme = v; },
    toggleTheme: () => {
      const next = state.themeKey === "light" ? "dark" : "light";
      htmlEl.dataset.theme = next;
    },
    state,
    counts: () => ({
      red:   state.pieces.filter(p => p.kind === "red").length,
      blue:  state.pieces.filter(p => p.kind === "blue").length,
      ball:  state.pieces.filter(p => p.kind === "ball").length,
      arrows: state.pieces.reduce((n, p) => n + p.arrows.length, 0),
    }),

    // Steps API
    steps:        () => state.steps,
    stepCount:    () => state.steps.length,
    pendingMoves: () => state.pieces.reduce((n, p) => n + p.arrows.length, 0),
    saveStep,
    clearPendingArrows,
    clearAllSteps,
    deleteStep,
    playSteps,
    stopPlayback: finishPlayback,
    isPlaying:    () => !!state.playing,
    playingStep:  () => state.playing ? state.playing.stepIdx : -1,
    exportPNG:    exportSnapshotPNG,
    exportStepPNG,

    // Mode
    getMode:      () => state.mode,
    setMode:      (v) => {
      const next = v === "sandbox" ? "sandbox" : "steps";
      if (state.mode === next) return;
      state.mode = next;
      if (next === "steps") {
        // Entering steps mode: keep the most recent sandbox arrow as the
        // pending move for the next step, surface every prior saved step
        // as cumulative arrows on top of it, and re-anchor stepStart.
        state.pieces.forEach(p => {
          const pending = p.arrows.length > 0 ? p.arrows[p.arrows.length - 1] : null;
          const cumulative = buildCumulativeArrowsForPiece(p);
          p.arrows = pending ? [...cumulative, pending] : cumulative;
          if (pending) {
            p.stepStartFx = pending.fx1;
            p.stepStartFy = pending.fy1;
          } else {
            p.stepStartFx = p.fx;
            p.stepStartFy = p.fy;
          }
        });
      } else {
        // Entering sandbox: no special prep — user can keep arrows.
      }
      notifyStepsChange();
    },

    // Radius settings
    getRadius:    () => ({ player: state.maxRadius.player, ball: state.maxRadius.ball }),
    setPlayerRadius: (v) => {
      const cl = Math.max(0.04, Math.min(0.6, +v || 0));
      state.maxRadius.player = cl;
      state.maxRadius.ball   = cl * 1.7;
      notifyStepsChange();
    },

    // Annotation tools
    getTool: () => state.tool,
    setTool: (t) => {
      const allowed = ["select", "line", "circle", "arrow", "text", "pencil"];
      if (!allowed.includes(t)) return;
      state.tool = t;
      cancelTextEdit();
      state.annotationDraft = null;
      // Selection only makes sense in select mode — drop it when switching
      // to a creation tool so the highlight doesn't linger.
      if (t !== "select") {
        state.selectedAnnotation = null;
        state.hoverAnnotation = null;
      }
      updateToolCursor();
      notifyStepsChange();
    },
    getAnnotationStyle: () => ({ ...state.annotationStyle }),
    setAnnotationStyle: (patch) => {
      Object.assign(state.annotationStyle, patch || {});
      notifyStepsChange();
    },
    clearAnnotations: () => {
      state.annotations = [];
      state.history = state.history.filter(h =>
        h.type !== "annotation" &&
        h.type !== "annotation-move" &&
        h.type !== "annotation-delete"
      );
      state.selectedAnnotation = null;
      state.hoverAnnotation = null;
      cancelTextEdit();
      notifyStepsChange();
    },
    annotationCount: () => state.annotations.length,
    annotationFonts:  ANNOTATION_FONTS,
    annotationColors: ANNOTATION_COLORS,
  };
  window.addEventListener("keydown", onKeyDown);
}

/* ---------- Render loop ------------------------------------------------- */
function render() {
  state.fieldRect = computeFieldRect();
  tickPieceAnimations();
  updatePieceScreenCoords();
  updateDispenserPhysics();

  drawField();
  drawArrows();
  drawPieces();
  drawAnnotations();
  if (!state.exporting) drawDispensers();

  requestAnimationFrame(render);
}

function setupDefaultLineup() {
  if (!state.fieldRect) state.fieldRect = computeFieldRect();
  const f = state.fieldRect;
  const count = 4;
  for (let i = 0; i < count; i++) {
    const fy = (i + 1) / (count + 1);
    const py = f.y + fy * f.h;
    addPiece("red",  f.x + 0.25 * f.w, py);
    addPiece("blue", f.x + 0.75 * f.w, py);
  }
  // Default lineup: a ball at center, useful for drawing first plays.
  addPiece("ball", f.x + 0.5 * f.w, f.y + 0.5 * f.h);
}

/* ---------- Bootstrap --------------------------------------------------- */
function init() {
  state.canvas = document.getElementById("board");
  state.ctx = state.canvas.getContext("2d");
  resize();
  window.addEventListener("resize", resize);

  // ResizeObserver — catches layout changes like sidebar collapse / focus mode
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(resize).observe(state.canvas);
  }

  state.canvas.addEventListener("mousedown", onMouseDown);
  state.canvas.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  state.canvas.addEventListener("contextmenu", onContextMenu);
  state.canvas.addEventListener("dblclick", onDoubleClick);

  wireUI();
  setupDefaultLineup();

  requestAnimationFrame(render);
}

document.addEventListener("DOMContentLoaded", init);
