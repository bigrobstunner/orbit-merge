(() => {
'use strict';
const { Engine, Bodies, Body, Composite, Events } = Matter;

// ---- Config -------------------------------------------------------------
// r = radius as a fraction of the danger-ring radius. pts = score when two
// of this tier merge. Re-theme the whole game by editing this list.
const TIERS = [
  { emoji: '✨', color: '#ffe08a', r: 0.100, pts: 1 },
  { emoji: '⭐', color: '#ffd166', r: 0.125, pts: 3 },
  { emoji: '🌟', color: '#ffb703', r: 0.155, pts: 6 },
  { emoji: '💫', color: '#c77dff', r: 0.190, pts: 10 },
  { emoji: '☄️', color: '#90e0ef', r: 0.230, pts: 15 },
  { emoji: '🌑', color: '#adb5bd', r: 0.272, pts: 21 },
  { emoji: '🌕', color: '#ffe066', r: 0.318, pts: 28 },
  { emoji: '🌍', color: '#48cae4', r: 0.368, pts: 36 },
  { emoji: '🪐', color: '#f4a261', r: 0.422, pts: 45 },
  { emoji: '☀️', color: '#ff8500', r: 0.480, pts: 55 },
  { emoji: '🌌', color: '#b298dc', r: 0.545, pts: 100 },
];
const MAX_TIER = TIERS.length - 1;
const SPAWN_MAX_TIER = 4;     // only tiers 0..4 come out of the launcher
const FIRE_COOLDOWN = 700;    // ms between shots
const LOSE_GRACE = 1400;      // ms a settled orb may sit beyond the ring
const NEW_ORB_GRACE = 1500;   // ms before a fresh shot can trigger loss
const SETTLED_SPEED = 1.6;    // orbs faster than this are still in flight
const G = 0.15;               // radial gravity, px per step^2
const DAMP = 0.992;           // per-step velocity damping (decays orbits)
const LAUNCH_SPEED = 13;      // px per step
const STEP = 1000 / 60;

// ---- Canvas / layout ----------------------------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, dpr = 1;
let C = { x: 0, y: 0 };       // planet center
let dangerR = 0, planetR = 0;
let launcher = { x: 0, y: 0 };
let stars = [];

function layout() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  C = { x: W / 2, y: H * 0.40 };
  dangerR = Math.min(W / 2 - 44, H * 0.27);
  // the planet swells with each level, leaving less room to work with
  planetR = Math.max(28, dangerR * 0.21) * (1 + 0.04 * Math.min(level - 1, 12));
  launcher = { x: W / 2, y: H - Math.max(96, H * 0.115) };

  stars = [];
  for (let i = 0; i < 130; i++) {
    stars.push({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.4 + 0.4,
      p: Math.random() * Math.PI * 2,
      s: 0.5 + Math.random() * 2,
    });
  }
}

// ---- Physics ------------------------------------------------------------
const engine = Engine.create();
engine.gravity.y = 0; // gravity is ours: radial, applied per step
const world = engine.world;
let planetBody = null;

function buildPlanet() {
  if (planetBody) Composite.remove(world, planetBody);
  planetBody = Bodies.circle(C.x, C.y, planetR, { isStatic: true, label: 'planet' });
  Composite.add(world, planetBody);
}

function orbRadius(tier) { return TIERS[tier].r * dangerR; }

function makeOrb(tier, x, y, vx, vy) {
  const r = orbRadius(tier);
  const body = Bodies.circle(x, y, r, {
    restitution: 0.05,
    friction: 0.9,
    frictionStatic: 1,
    frictionAir: 0, // damping is ours (DAMP), so the aim preview stays exact
    label: 'orb',
  });
  body.tier = tier;
  body.orbR = r;
  body.bornAt = performance.now();
  Body.setVelocity(body, { x: vx || 0, y: vy || 0 });
  Composite.add(world, body);
  return body;
}

function orbs() {
  return Composite.allBodies(world).filter(b => b.label === 'orb');
}

// The one non-standard piece: constant-magnitude gravity toward the planet,
// applied by hand each step so the trajectory preview can run the exact
// same math. Damping makes stray orbits decay onto the cluster.
function applyGravity() {
  for (const b of orbs()) {
    const dx = C.x - b.position.x, dy = C.y - b.position.y;
    const d = Math.hypot(dx, dy) || 1;
    Body.setVelocity(b, {
      x: (b.velocity.x + G * dx / d) * DAMP,
      y: (b.velocity.y + G * dy / d) * DAMP,
    });
  }
}

// ---- Game state ---------------------------------------------------------
let score = 0;
let best = +(localStorage.getItem('om-best') || 0);
let level = Math.max(1, +(localStorage.getItem('om-level') || 1));
let goalTier = 4;
let state = 'playing'; // 'playing' | 'clear' | 'over'
let nextReadyAt = 0;
let currentTier = 0, nextTier = 0;
let discovered = new Set([0]);
const pendingMerges = [];
const particles = [];
const popups = [];
let frame = 0;
let warning = false;

const $ = id => document.getElementById(id);
const scoreEl = $('score'), bestEl = $('best'), nextEl = $('next');
const overEl = $('over'), finalEl = $('finalScore'), bestNoteEl = $('bestNote');
const lvlEl = $('lvl'), overTitleEl = $('overTitle'), againEl = $('again');

function computeGoal() {
  goalTier = Math.min(4 + Math.floor((level - 1) / 2), MAX_TIER);
}

function updateLevelHud() {
  lvlEl.textContent = 'LVL ' + level + ' · GOAL ' + TIERS[goalTier].emoji;
  document.querySelectorAll('#chain span').forEach((s, i) => {
    s.classList.toggle('goal', i === goalTier);
  });
}

function randSpawnTier() { return Math.floor(Math.random() * (SPAWN_MAX_TIER + 1)); }

function rollQueue() {
  currentTier = randSpawnTier();
  nextTier = randSpawnTier();
  nextEl.textContent = TIERS[nextTier].emoji;
}

function addScore(pts, x, y) {
  score += pts;
  scoreEl.textContent = score;
  popups.push({ x, y, txt: '+' + pts, t0: performance.now() });
}

function markDiscovered(tier) {
  if (discovered.has(tier)) return;
  discovered.add(tier);
  const el = document.querySelectorAll('#chain span')[tier];
  if (el) el.classList.add('found');
}

// ---- Merging ------------------------------------------------------------
function queueMerge(a, b) {
  if (a.dead || b.dead || a.tier !== b.tier) return;
  a.dead = b.dead = true;
  pendingMerges.push([a, b]);
}

Events.on(engine, 'collisionStart', ev => {
  for (const { bodyA, bodyB } of ev.pairs) {
    if (bodyA.label === 'orb' && bodyB.label === 'orb' && bodyA.tier === bodyB.tier) {
      queueMerge(bodyA, bodyB);
    }
  }
});

function mergeSweep() {
  const os = orbs().filter(b => !b.dead);
  for (let i = 0; i < os.length; i++) {
    for (let j = i + 1; j < os.length; j++) {
      const a = os[i], b = os[j];
      if (a.tier !== b.tier || a.dead || b.dead) continue;
      const dx = a.position.x - b.position.x, dy = a.position.y - b.position.y;
      const touch = a.orbR + b.orbR + 1;
      if (dx * dx + dy * dy <= touch * touch) queueMerge(a, b);
    }
  }
}

function processMerges() {
  while (pendingMerges.length) {
    const [a, b] = pendingMerges.shift();
    let mx = (a.position.x + b.position.x) / 2;
    let my = (a.position.y + b.position.y) / 2;
    const tier = a.tier;
    Composite.remove(world, a);
    Composite.remove(world, b);
    burst(mx, my, TIERS[tier].color, tier === MAX_TIER ? 70 : 14 + tier * 3);
    addScore(TIERS[tier].pts, mx, my);
    playMerge(tier);
    if (tier < MAX_TIER) {
      const nt = tier + 1;
      const r = orbRadius(nt);
      // keep the new orb outside the planet surface
      const dx = mx - C.x, dy = my - C.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < planetR + r) {
        mx = C.x + dx / d * (planetR + r + 1);
        my = C.y + dy / d * (planetR + r + 1);
      }
      const o = makeOrb(nt, mx, my);
      o.popAt = performance.now();
      markDiscovered(nt);
      if (nt >= goalTier && state === 'playing') levelClear();
    }
  }
}

function levelClear() {
  state = 'clear';
  const bonus = 20 * level;
  score += bonus;
  scoreEl.textContent = score;
  playLevelClear();
  if (score > best) {
    best = score;
    localStorage.setItem('om-best', best);
  }
  bestEl.textContent = 'BEST ' + best;
  overTitleEl.textContent = 'Level ' + level + ' Clear! 🎉';
  finalEl.textContent = score;
  bestNoteEl.textContent = '+' + bonus + ' level bonus';
  againEl.textContent = 'Next Level';
  overEl.classList.remove('hidden');
}

// ---- Aiming & firing ----------------------------------------------------
let aiming = false;
let aimPt = { x: 0, y: 0 };

canvas.addEventListener('pointerdown', e => {
  if (state !== 'playing') return;
  unlockAudio();
  aiming = true;
  aimPt = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener('pointermove', e => {
  if (aiming) aimPt = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener('pointerup', () => {
  if (!aiming || state !== 'playing') return;
  aiming = false;
  fireToward(aimPt.x, aimPt.y);
});

function fireToward(tx, ty) {
  const now = performance.now();
  if (now < nextReadyAt) return false;
  const dx = tx - launcher.x, dy = ty - launcher.y;
  const d = Math.hypot(dx, dy);
  if (d < 15) return false; // ignore stray taps on the launcher itself
  nextReadyAt = now + FIRE_COOLDOWN;
  makeOrb(currentTier, launcher.x, launcher.y - orbRadius(currentTier) * 0.2,
    dx / d * LAUNCH_SPEED, dy / d * LAUNCH_SPEED);
  playFire();
  currentTier = nextTier;
  nextTier = randSpawnTier();
  nextEl.textContent = TIERS[nextTier].emoji;
  return true;
}

// Trajectory preview: the same integrator as applyGravity, run ahead.
function previewPath(tx, ty) {
  const dx = tx - launcher.x, dy = ty - launcher.y;
  const d = Math.hypot(dx, dy);
  if (d < 15) return [];
  let px = launcher.x, py = launcher.y - orbRadius(currentTier) * 0.2;
  let vx = dx / d * LAUNCH_SPEED, vy = dy / d * LAUNCH_SPEED;
  const r = orbRadius(currentTier);
  const pts = [];
  const os = orbs();
  for (let i = 0; i < 130; i++) {
    const gx = C.x - px, gy = C.y - py;
    const gd = Math.hypot(gx, gy) || 1;
    vx = (vx + G * gx / gd) * DAMP;
    vy = (vy + G * gy / gd) * DAMP;
    px += vx;
    py += vy;
    if (i % 3 === 0) pts.push({ x: px, y: py });
    if (gd < planetR + r) break; // would land on the planet
    let hit = false;
    for (const o of os) {
      const ox = o.position.x - px, oy = o.position.y - py;
      if (ox * ox + oy * oy < (o.orbR + r) * (o.orbR + r)) { hit = true; break; }
    }
    if (hit) break;
  }
  return pts;
}

// ---- Lose check ---------------------------------------------------------
function checkLose(now) {
  let danger = false;
  for (const o of orbs()) {
    if (now - o.bornAt < NEW_ORB_GRACE) continue;
    const d = Math.hypot(o.position.x - C.x, o.position.y - C.y);
    const speed = Math.hypot(o.velocity.x, o.velocity.y);
    const outside = d + o.orbR > dangerR;
    if (outside && speed < SETTLED_SPEED) {
      danger = true;
      if (!o.overSince) o.overSince = now;
      else if (now - o.overSince > LOSE_GRACE) return gameOver();
    } else {
      o.overSince = null;
      if (!outside && d + o.orbR > dangerR - 30) danger = true;
    }
  }
  warning = danger;
}

function gameOver() {
  state = 'over';
  playGameOver();
  overTitleEl.textContent = 'Game Over';
  finalEl.textContent = score;
  if (score > best) {
    best = score;
    localStorage.setItem('om-best', best);
    bestNoteEl.textContent = '🎉 New best score!';
  } else {
    bestNoteEl.textContent = 'Best: ' + best;
  }
  bestEl.textContent = 'BEST ' + best;
  againEl.textContent = 'Try Again';
  overEl.classList.remove('hidden');
}

// Rebuild the board for the current level: swollen planet + a ring of debris
// orbs. Debris tiers alternate 0/1/2 so no two touching pieces can merge.
function resetBoard() {
  orbs().forEach(b => Composite.remove(world, b));
  pendingMerges.length = 0;
  particles.length = 0;
  popups.length = 0;
  state = 'playing';
  nextReadyAt = 0;
  aiming = false;
  computeGoal();
  layout();
  buildPlanet();
  const n = Math.min(1 + level, 10);
  for (let i = 0; i < n; i++) {
    const t = (i === n - 1 && n % 3 === 1) ? 1 : i % 3;
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const d = planetR + orbRadius(t) + 2;
    makeOrb(t, C.x + Math.cos(a) * d, C.y + Math.sin(a) * d);
  }
  for (let i = 0; i < 90; i++) tickPhysics(); // settle debris before play
  rollQueue();
  updateLevelHud();
  overEl.classList.add('hidden');
}

againEl.addEventListener('click', () => {
  if (state === 'clear') {
    level++;
    localStorage.setItem('om-level', level);
  } else {
    score = 0;
    scoreEl.textContent = '0';
  }
  resetBoard();
});

// ---- Effects ------------------------------------------------------------
function burst(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 1.5 + Math.random() * 4;
    particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color });
  }
}

// ---- Sound (synthesized, no assets) ------------------------------------
let audioCtx = null;
let muted = localStorage.getItem('om-muted') === '1';
const muteBtn = $('mute');
muteBtn.textContent = muted ? '🔇' : '🔊';
muteBtn.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('om-muted', muted ? '1' : '0');
  muteBtn.textContent = muted ? '🔇' : '🔊';
});

function unlockAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function tone(freq, dur, type, gain, glide) {
  if (muted || !audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + dur);
}

function playFire() { tone(500, 0.12, 'sine', 0.09, 900); }
function playMerge(tier) {
  tone(320 + tier * 70, 0.18, 'sine', 0.16, 640 + tier * 140);
  if (tier === MAX_TIER) { tone(523, 0.5, 'triangle', 0.2, 1568); }
}
function playGameOver() { tone(340, 0.6, 'sawtooth', 0.1, 80); }
function playLevelClear() {
  [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.2, 'triangle', 0.18), i * 110));
}

// ---- Rendering ----------------------------------------------------------
function drawOrb(x, y, angle, tier, r, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  if (scale !== 1) ctx.scale(scale, scale);
  const c = TIERS[tier];
  const glow = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.45);
  glow.addColorStop(0, c.color + '55');
  glow.addColorStop(0.7, c.color + '22');
  glow.addColorStop(1, c.color + '00');
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.45, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();
  const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
  grad.addColorStop(0, '#ffffff33');
  grad.addColorStop(0.4, c.color + '38');
  grad.addColorStop(1, c.color + '30');
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = c.color + '88';
  ctx.lineWidth = Math.max(1.5, r * 0.06);
  ctx.stroke();
  ctx.font = `${Math.round(r * 1.2)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(c.emoji, 0, r * 0.05);
  ctx.restore();
}

function drawPlanet(now) {
  const breathe = 1 + Math.sin(now / 900) * 0.012;
  ctx.save();
  ctx.translate(C.x, C.y);
  ctx.scale(breathe, breathe);
  const glow = ctx.createRadialGradient(0, 0, planetR * 0.4, 0, 0, planetR * 2.2);
  glow.addColorStop(0, 'rgba(123, 92, 214, .35)');
  glow.addColorStop(1, 'rgba(123, 92, 214, 0)');
  ctx.beginPath();
  ctx.arc(0, 0, planetR * 2.2, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();
  const grad = ctx.createRadialGradient(-planetR * 0.35, -planetR * 0.35, planetR * 0.1, 0, 0, planetR);
  grad.addColorStop(0, '#b8a4f0');
  grad.addColorStop(1, '#6c4fc4');
  ctx.beginPath();
  ctx.arc(0, 0, planetR, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  // sleepy face
  ctx.strokeStyle = '#2d1b5e';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  const e = planetR * 0.22;
  ctx.beginPath();
  ctx.arc(-e * 1.4, -e * 0.4, e * 0.55, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(e * 1.4, -e * 0.4, e * 0.55, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, e * 0.9, e * 0.5, 0.1 * Math.PI, 0.9 * Math.PI);
  ctx.stroke();
  // Lisa's crown
  ctx.save();
  ctx.rotate(-0.3);
  ctx.translate(0, -planetR * 1.04);
  const cw = planetR * 0.56, ch = planetR * 0.36;
  ctx.fillStyle = '#ffd166';
  ctx.beginPath();
  ctx.moveTo(-cw / 2, 0);
  ctx.lineTo(-cw / 2, -ch * 0.55);
  ctx.lineTo(-cw / 6, -ch * 0.25);
  ctx.lineTo(0, -ch);
  ctx.lineTo(cw / 6, -ch * 0.25);
  ctx.lineTo(cw / 2, -ch * 0.55);
  ctx.lineTo(cw / 2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

function render(now) {
  ctx.fillStyle = '#0b0d2a';
  ctx.fillRect(0, 0, W, H);

  // starfield
  for (const s of stars) {
    ctx.globalAlpha = 0.35 + 0.5 * (0.5 + Math.sin(now / 1000 * s.s + s.p) / 2);
    ctx.fillStyle = '#e8e4ff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // danger ring
  const flash = warning && state === 'playing' && Math.floor(now / 250) % 2 === 0;
  ctx.setLineDash([10, 12]);
  ctx.strokeStyle = flash ? 'rgba(255, 90, 110, .95)' : (warning ? 'rgba(255, 90, 110, .55)' : 'rgba(178, 152, 220, .4)');
  ctx.lineWidth = flash ? 3 : 2;
  ctx.beginPath();
  ctx.arc(C.x, C.y, dangerR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  drawPlanet(now);

  // orbs
  for (const o of orbs()) {
    let scale = 1;
    if (o.popAt) {
      const t = (now - o.popAt) / 160;
      scale = t >= 1 ? 1 : 0.5 + 0.5 * t + 0.18 * Math.sin(t * Math.PI);
      if (t >= 1) o.popAt = null;
    }
    drawOrb(o.position.x, o.position.y, o.angle, o.tier, o.orbR, scale);
  }

  // aim preview
  if (aiming && state === 'playing' && now >= nextReadyAt) {
    const pts = previewPath(aimPt.x, aimPt.y);
    ctx.fillStyle = '#ffd166';
    pts.forEach((p, i) => {
      ctx.globalAlpha = 0.25 + 0.75 * (1 - i / pts.length);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5 - 2.5 * (i / pts.length), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  // launcher pad + held orb
  ctx.save();
  ctx.translate(launcher.x, launcher.y);
  ctx.strokeStyle = 'rgba(178, 152, 220, .7)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 10, 26, 1.15 * Math.PI, 1.85 * Math.PI);
  ctx.stroke();
  ctx.restore();
  if (state === 'playing' && performance.now() >= nextReadyAt) {
    drawOrb(launcher.x, launcher.y - orbRadius(currentTier) * 0.2, 0, currentTier, orbRadius(currentTier), 1);
  }

  // particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.life -= 0.022;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5 * p.life + 1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // score popups
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    const t = (now - p.t0) / 900;
    if (t >= 1) { popups.splice(i, 1); continue; }
    ctx.globalAlpha = 1 - t;
    ctx.font = '800 20px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f2ecff';
    ctx.fillText(p.txt, p.x, p.y - t * 40);
  }
  ctx.globalAlpha = 1;
}

// ---- Main loop ----------------------------------------------------------
let lastT = performance.now();
let acc = 0;

function tickPhysics() {
  applyGravity();
  Engine.update(engine, STEP);
}

function loop(now) {
  requestAnimationFrame(loop);
  acc += Math.min(now - lastT, 100);
  lastT = now;
  while (acc >= STEP) {
    if (state === 'playing') tickPhysics();
    acc -= STEP;
  }
  if (state === 'playing') {
    processMerges();
    if (++frame % 30 === 0) { mergeSweep(); processMerges(); }
    checkLose(now);
  }
  render(now);
}

// ---- Boot ---------------------------------------------------------------
function boot() {
  const chainEl = $('chain');
  chainEl.innerHTML = '';
  TIERS.forEach((t, i) => {
    const s = document.createElement('span');
    s.textContent = t.emoji;
    if (i === 0) s.classList.add('found');
    chainEl.appendChild(s);
  });
  bestEl.textContent = 'BEST ' + best;
  resetBoard();
  if (!localStorage.getItem('om-welcomed')) {
    $('welcome').classList.remove('hidden');
  }
  $('begin').addEventListener('click', () => {
    localStorage.setItem('om-welcomed', '1');
    $('welcome').classList.add('hidden');
    unlockAudio();
  });
  requestAnimationFrame(loop);
}

window.addEventListener('resize', () => { layout(); buildPlanet(); });

if ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Debug hook for automated testing; harmless in production.
window.__dbg = {
  fire: (tx, ty) => fireToward(tx, ty),
  spawnAt: (tier, x, y) => makeOrb(tier, x, y),
  orbs: () => orbs().map(o => ({
    tier: o.tier,
    x: Math.round(o.position.x),
    y: Math.round(o.position.y),
    d: Math.round(Math.hypot(o.position.x - C.x, o.position.y - C.y)),
  })),
  geom: () => ({ C, dangerR, planetR, launcher }),
  score: () => score,
  state: () => state,
  level: () => level,
  goalTier: () => goalTier,
  setLevel(n) { level = Math.max(1, n | 0); localStorage.setItem('om-level', level); resetBoard(); },
  restart: resetBoard,
  aim(x, y, on) { aiming = !!on; aimPt = { x, y }; },
  // Drive the simulation synchronously (rAF pauses in hidden tabs).
  step(ms) {
    const steps = Math.round(ms / STEP);
    for (let i = 0; i < steps; i++) {
      tickPhysics();
      processMerges();
      if (i % 30 === 0) { mergeSweep(); processMerges(); }
    }
    checkLose(performance.now());
  },
};

boot();
})();
