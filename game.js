(() => {
'use strict';
const { Engine, Bodies, Body, Composite, Events } = Matter;

// ---- Config -------------------------------------------------------------
// r = radius as a fraction of the danger-ring radius. pts = score when two
// of this tier merge. Re-theme the whole game by editing this list.
const TIERS = [
  { emoji: '✨', color: '#9be7ff', r: 0.100, pts: 1 },
  { emoji: '⭐', color: '#ffd166', r: 0.125, pts: 3 },
  { emoji: '💫', color: '#c77dff', r: 0.155, pts: 6 },
  { emoji: '🌟', color: '#ff9f43', r: 0.190, pts: 10 },
  { emoji: '☄️', color: '#63e6be', r: 0.230, pts: 15 },
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
const DAMP = 0.9895;          // per-step velocity damping (decays orbits)
const LAUNCH_SPEED = 14.5;    // px per step
const STEP = 1000 / 60;
const COMBO_WINDOW = 1800;    // sim-ms between merges that keeps a combo alive
const INV_CAP = 3;            // max held of each special

// ---- Worlds: one theme per decade of levels -----------------------------
const WORLDS = [
  { key: 'calm',       label: '' },
  { key: 'heavy',      label: 'HEAVY WORLD' },
  { key: 'light',      label: 'LIGHT WORLD' },
  { key: 'drift',      label: 'DRIFTING WORLD' },
  { key: 'moon',       label: 'MOON WORLD' },
  { key: 'binary',     label: 'BINARY WORLD' },
  { key: 'heavymoon',  label: 'HEAVY MOON' },
  { key: 'driftlight', label: 'LIGHT DRIFT' },
  { key: 'binarymoon', label: 'BINARY MOON' },
  { key: 'gauntlet',   label: 'THE GAUNTLET' },
];

function levelConfig(lv) {
  const p = (lv - 1) % 10;
  const dec = Math.min(Math.floor((lv - 1) / 10), 9);
  const k = WORLDS[dec].key;
  return {
    goalTier: Math.min(4 + Math.floor(p / 3) + (p === 9 ? 1 : 0) + (dec >= 6 ? 1 : 0), 9),
    collapse: p === 9 && dec >= 1, // boss levels: the sky slowly contracts
    debris: Math.min(2 + Math.floor(lv / 2), 12),
    debrisMaxTier: Math.min(2 + Math.floor(dec / 2), 4),
    planetScale: 1 + Math.min(0.30, dec * 0.04 + p * 0.008),
    gMul: k.includes('heavy') ? 1.3 : (k.includes('light') ? 0.75 : 1),
    drift: k.includes('drift') || k === 'gauntlet',
    moon: k.includes('moon'),
    binary: k.includes('binary') || k === 'gauntlet',
    label: WORLDS[dec].label,
  };
}

// ---- Canvas / layout ----------------------------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, dpr = 1;
let C = { x: 0, y: 0 };       // ring center
let dangerR = 0, planetR = 0;
let launcher = { x: 0, y: 0 };
let stars = [];
let level = Math.max(1, +(localStorage.getItem('om-level') || 1));
let cfg = levelConfig(level);

function layout() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  C = { x: W / 2, y: H * 0.40 };
  dangerR = Math.min(W / 2 - 44, H * 0.27);
  planetR = Math.max(28, dangerR * 0.21) * cfg.planetScale;
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
let planets = [];   // [{ body, r, main }]
let moon = null;
let simTime = 0;    // deterministic clock advanced per physics step

const PLANET_SKINS = [
  { top: '#b8a4f0', bottom: '#6c4fc4', glow: '123, 92, 214' },
  { top: '#9fe3f0', bottom: '#3d9dbf', glow: '80, 180, 220' },
];

function buildPlanets() {
  planets.forEach(p => Composite.remove(world, p.body));
  if (moon) { Composite.remove(world, moon); moon = null; }
  planets = [];
  if (cfg.binary) {
    const r = planetR * 0.72;
    for (let i = 0; i < 2; i++) {
      const b = Bodies.circle(C.x, C.y, r, { isStatic: true, label: 'planet' });
      planets.push({ body: b, r, main: i === 0 });
      Composite.add(world, b);
    }
  } else {
    const b = Bodies.circle(C.x, C.y, planetR, { isStatic: true, label: 'planet' });
    planets.push({ body: b, r: planetR, main: true });
    Composite.add(world, b);
  }
  if (cfg.moon) {
    moon = Bodies.circle(C.x, C.y - dangerR * 0.74, planetR * 0.38, { isStatic: true, label: 'moon' });
    Composite.add(world, moon);
  }
  positionCelestials();
}

// Moving bodies (drift, binary orbit, moon) run off simTime so the physics
// stays deterministic under __dbg.step and pauses cleanly with the game.
function positionCelestials() {
  if (cfg.binary) {
    const a = simTime * 0.00012;
    const off = dangerR * 0.34;
    const dx = Math.cos(a) * off, dy = Math.sin(a) * off;
    Body.setPosition(planets[0].body, { x: C.x + dx, y: C.y + dy });
    Body.setPosition(planets[1].body, { x: C.x - dx, y: C.y - dy });
  } else if (planets.length) {
    const dx = cfg.drift ? Math.sin(simTime * 0.00025) * dangerR * 0.22 : 0;
    Body.setPosition(planets[0].body, { x: C.x + dx, y: C.y });
  }
  if (moon) {
    const a = simTime * 0.0004;
    Body.setPosition(moon, {
      x: C.x + Math.cos(a) * dangerR * 0.74,
      y: C.y + Math.sin(a) * dangerR * 0.74,
    });
  }
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

function makeSpecial(kind, x, y, vx, vy) {
  const b = makeOrb(1, x, y, vx, vy);
  b.tier = -1;
  b.special = kind; // 'wild' | 'smash'
  return b;
}

function orbs() {
  return Composite.allBodies(world).filter(b => b.label === 'orb');
}

function gravityAccel(px, py) {
  let ax = 0, ay = 0;
  for (const p of planets) {
    const dx = p.body.position.x - px, dy = p.body.position.y - py;
    const d = Math.hypot(dx, dy) || 1;
    ax += dx / d;
    ay += dy / d;
  }
  const g = G * cfg.gMul / planets.length;
  return { x: ax * g, y: ay * g };
}

function applyGravity() {
  for (const b of orbs()) {
    const a = gravityAccel(b.position.x, b.position.y);
    Body.setVelocity(b, {
      x: (b.velocity.x + a.x) * DAMP,
      y: (b.velocity.y + a.y) * DAMP,
    });
  }
}

function tickPhysics() {
  simTime += STEP;
  positionCelestials();
  if (cfg.collapse && state === 'playing' && !settling) {
    ringTarget = Math.max(dangerR * 0.70, ringTarget - 1.1 * STEP / 1000);
  }
  ringR += (ringTarget - ringR) * 0.08;
  applyGravity();
  Engine.update(engine, STEP);
}

// ---- Game state ---------------------------------------------------------
let score = 0;
let best = +(localStorage.getItem('om-best') || 0);
let state = 'playing'; // 'playing' | 'clear' | 'over'
let nextReadyAt = 0;
let currentTier = 0, nextTier = 0;
let currentMystery = false, nextMystery = false;
let discovered = new Set([0]);
let settling = false; // silent merges while debris settles at level start
const pendingMerges = [];
const pendingSpecials = [];
const particles = [];
const popups = [];
const splashes = [];
let frame = 0;
let warning = false;
let comboCount = 0, comboLastAt = -1e9;
let shakeUntil = 0, shakeAmp = 0;
// The catch area is alive: merges push ringTarget outward (capped at dangerR),
// Sky Collapse bosses pull it back in. ringR eases toward ringTarget.
let ringR = 0, ringTarget = 0;
let ringGrowAt = -1e9;
let ringFlashUntil = 0;
let forcedMystery = null; // test hook: next mystery resolution uses this roll
let moodType = 'sleep', moodUntil = 0;
const MOOD_PRIORITY = { sleep: 0, worry: 1, happy: 2, wow: 3 };

let inv = { wild: 0, smash: 0 };
try {
  const saved = JSON.parse(localStorage.getItem('om-inv') || '{}');
  inv.wild = Math.min(INV_CAP, saved.wild | 0);
  inv.smash = Math.min(INV_CAP, saved.smash | 0);
} catch (e) { /* fresh inventory */ }
let armed = null;

const $ = id => document.getElementById(id);
const scoreEl = $('score'), bestEl = $('best'), nextEl = $('next');
const overEl = $('over'), finalEl = $('finalScore'), bestNoteEl = $('bestNote');
const lvlEl = $('lvl'), worldEl = $('world'), overTitleEl = $('overTitle'), againEl = $('again');
const pwEls = { wild: $('pwWild'), smash: $('pwSmash') };

function randSpawnTier() { return Math.floor(Math.random() * (SPAWN_MAX_TIER + 1)); }

const MYSTERY_CHANCE = 0.08;

function rollQueue() {
  currentTier = randSpawnTier();
  nextTier = randSpawnTier();
  currentMystery = false;
  nextMystery = Math.random() < MYSTERY_CHANCE;
  updateNextChip();
}

function updateNextChip() {
  nextEl.textContent = nextMystery ? '❓' : TIERS[nextTier].emoji;
  if (nextMystery) tip('mystery', 'A Mystery Orb ❓ is coming. Nobody knows what it does until it touches something...');
}

function ringGrow(amt) {
  ringTarget = Math.min(dangerR, ringTarget + amt);
  ringGrowAt = performance.now();
}

function addScore(pts, x, y, combo) {
  score += pts;
  scoreEl.textContent = score;
  popups.push({ x, y, txt: '+' + pts + (combo > 1 ? ' x' + combo : ''), t0: performance.now() });
}

function splash(txt) {
  splashes.push({ txt, t0: performance.now() });
}

function shake(amp) {
  shakeAmp = Math.min(10, amp);
  shakeUntil = performance.now() + 280;
}

function setMood(t, ms) {
  const now = performance.now();
  if (moodUntil > now && MOOD_PRIORITY[t] < MOOD_PRIORITY[moodType]) return;
  moodType = t;
  moodUntil = now + ms;
}

function currentMood(now) {
  if (moodUntil > now) return moodType;
  return warning ? 'worry' : 'sleep';
}

function markDiscovered(tier) {
  if (discovered.has(tier)) return;
  discovered.add(tier);
  const el = document.querySelectorAll('#chain span')[tier];
  if (el) el.classList.add('found');
}

function updateLevelHud() {
  lvlEl.textContent = 'LVL ' + level + ' · GOAL ' + TIERS[cfg.goalTier].emoji;
  worldEl.textContent = cfg.label;
  document.querySelectorAll('#chain span').forEach((s, i) => {
    s.classList.toggle('goal', i === cfg.goalTier);
  });
}

// ---- First-time tips ----------------------------------------------------
// Each tip shows once ever, right when its mechanic first appears.
let seenTips = new Set();
try { seenTips = new Set(JSON.parse(localStorage.getItem('om-tips') || '[]')); } catch (e) { /* fresh */ }
const tipQueue = [];
let tipTimer = null;
const tipEl = $('tip'), tipTextEl = $('tipText');

function tip(id, text) {
  if (seenTips.has(id)) return;
  seenTips.add(id);
  localStorage.setItem('om-tips', JSON.stringify([...seenTips]));
  tipQueue.push(text);
  if (tipEl.classList.contains('hidden')) showNextTip();
}

function showNextTip() {
  clearTimeout(tipTimer);
  const text = tipQueue.shift();
  if (!text) { tipEl.classList.add('hidden'); return; }
  tipTextEl.textContent = text;
  tipEl.classList.remove('hidden');
  tipTimer = setTimeout(showNextTip, 8000);
}

tipEl.addEventListener('click', showNextTip);

// ---- Specials inventory -------------------------------------------------
function saveInv() { localStorage.setItem('om-inv', JSON.stringify(inv)); }

function updatePw() {
  for (const kind of ['wild', 'smash']) {
    const el = pwEls[kind];
    el.querySelector('b').textContent = inv[kind];
    el.classList.toggle('empty', inv[kind] === 0);
    el.classList.toggle('armed', armed === kind);
  }
}

function earnSpecial(kind) {
  if (inv[kind] >= INV_CAP) return;
  inv[kind]++;
  saveInv();
  updatePw();
  splash(kind === 'wild' ? '🌈 WILD ORB EARNED' : '💥 SMASHER EARNED');
  if (kind === 'wild') tip('wild', 'You earned a Wild Orb 🌈. Tap it next to the launcher, then fire. It merges with whatever it touches.');
  else tip('smash', 'You earned a Smasher 💥. Tap it next to the launcher, then fire. It destroys whatever it hits.');
}

for (const kind of ['wild', 'smash']) {
  pwEls[kind].addEventListener('click', () => {
    if (state !== 'playing' || !inv[kind]) return;
    armed = armed === kind ? null : kind;
    updatePw();
  });
}

// ---- Combos & merging ---------------------------------------------------
function bumpCombo() {
  comboCount = (simTime - comboLastAt <= COMBO_WINDOW) ? comboCount + 1 : 1;
  comboLastAt = simTime;
  if (comboCount === 2) tip('combo', 'Combo! Merges within 2 seconds of each other multiply your score. Chain them for wild rewards.');
  if (comboCount === 4) earnSpecial('wild');
  if (comboCount === 6) earnSpecial('smash');
  if (comboCount >= 3) {
    splash('COMBO x' + comboCount);
    shake(3 + comboCount);
    setMood('happy', 1600);
  }
  return comboCount;
}

function queueMerge(a, b) {
  if (a.dead || b.dead || a.tier !== b.tier) return;
  a.dead = b.dead = true;
  pendingMerges.push([a, b]);
}

Events.on(engine, 'collisionStart', ev => {
  for (const { bodyA, bodyB } of ev.pairs) {
    const s = bodyA.special ? bodyA : (bodyB.special ? bodyB : null);
    if (s) {
      const other = s === bodyA ? bodyB : bodyA;
      if (other.special || s.dead || other.dead) continue;
      if (other.label === 'orb') {
        s.dead = other.dead = true;
        pendingSpecials.push([s, other]);
      } else {
        s.dead = true;
        pendingSpecials.push([s, null]);
      }
      continue;
    }
    if (bodyA.label === 'orb' && bodyB.label === 'orb' && bodyA.tier === bodyB.tier) {
      queueMerge(bodyA, bodyB);
    }
  }
});

function mergeSweep() {
  const os = orbs().filter(b => !b.dead && !b.special);
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

function clampOutsidePlanets(x, y, r) {
  for (const p of planets) {
    const dx = x - p.body.position.x, dy = y - p.body.position.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < p.r + r) {
      x = p.body.position.x + dx / d * (p.r + r + 1);
      y = p.body.position.y + dy / d * (p.r + r + 1);
    }
  }
  return { x, y };
}

// One merge resolution: effects, combo scoring, next-tier spawn, goal check.
// Used by same-tier merges and by wild-orb hits.
function completeMerge(tier, mx, my) {
  if (settling) {
    if (tier < MAX_TIER) {
      const pos = clampOutsidePlanets(mx, my, orbRadius(tier + 1));
      makeOrb(tier + 1, pos.x, pos.y);
    }
    return;
  }
  burst(mx, my, TIERS[tier].color, tier === MAX_TIER ? 70 : 14 + tier * 3);
  ringGrow(2 + tier * 1.1);
  tip('ring', 'See the gold ripple? Every merge pushes the ring outward. Bigger merges push harder.');
  const combo = bumpCombo();
  addScore(TIERS[tier].pts * combo, mx, my, combo);
  playMerge(tier, combo);
  if (tier === MAX_TIER) {
    setMood('wow', 3000);
    splash('DOUBLE GALAXY!');
    shake(9);
    return;
  }
  const nt = tier + 1;
  const pos = clampOutsidePlanets(mx, my, orbRadius(nt));
  const o = makeOrb(nt, pos.x, pos.y);
  o.popAt = performance.now();
  markDiscovered(nt);
  if (nt >= 5) setMood('happy', 1500);
  if (nt === MAX_TIER) { setMood('wow', 3000); splash('GALAXY!'); shake(8); }
  if (nt >= cfg.goalTier && state === 'playing') levelClear();
}

function processMerges() {
  while (pendingMerges.length) {
    const [a, b] = pendingMerges.shift();
    const mx = (a.position.x + b.position.x) / 2;
    const my = (a.position.y + b.position.y) / 2;
    const tier = a.tier;
    Composite.remove(world, a);
    Composite.remove(world, b);
    completeMerge(tier, mx, my);
  }
  while (pendingSpecials.length) {
    const [s, other] = pendingSpecials.shift();
    const sx = s.position.x, sy = s.position.y;
    Composite.remove(world, s);
    if (s.special === 'mystery') {
      if (other) other.dead = false; // most outcomes leave the touched orb alive
      resolveMystery(other, sx, sy);
      continue;
    }
    if (!other) {
      // hit a planet or the moon: wild fizzles into a sparkle, smasher poofs
      if (s.special === 'wild') {
        const pos = clampOutsidePlanets(sx, sy, orbRadius(0));
        const o = makeOrb(0, pos.x, pos.y);
        o.popAt = performance.now();
        burst(sx, sy, '#ffffff', 10);
      } else {
        burst(sx, sy, '#ff6b6b', 16);
      }
      continue;
    }
    const t = other.tier;
    const ox = other.position.x, oy = other.position.y;
    Composite.remove(world, other);
    if (s.special === 'wild') {
      burst(ox, oy, '#ffffff', 24);
      completeMerge(t, ox, oy);
    } else {
      burst(ox, oy, '#ff6b6b', 30);
      addScore(5, ox, oy, 1);
      shake(6);
      playSmash();
    }
  }
}

// Mystery outcomes: reveal 45% / wild 25% / boom 12% / star gift 10% / jackpot 8%
function resolveMystery(other, sx, sy) {
  let roll = forcedMystery !== null ? forcedMystery : Math.random();
  forcedMystery = null;
  if (!other && roll >= 0.45 && roll < 0.82) roll = 0.2; // partner-needing outcomes fall back to reveal
  if (roll < 0.45) {
    const t = 1 + Math.floor(Math.random() * 4);
    const pos = clampOutsidePlanets(sx, sy, orbRadius(t));
    const o = makeOrb(t, pos.x, pos.y);
    o.popAt = performance.now();
    splash('MYSTERY: ' + TIERS[t].emoji);
    burst(sx, sy, '#c77dff', 16);
  } else if (roll < 0.70) {
    const t = other.tier, ox = other.position.x, oy = other.position.y;
    Composite.remove(world, other);
    splash('MYSTERY: WILD!');
    burst(ox, oy, '#ffffff', 22);
    completeMerge(t, ox, oy);
  } else if (roll < 0.82) {
    splash('MYSTERY: BOOM!');
    const targets = orbs().filter(o => !o.special && !o.dead)
      .map(o => ({ o, d: Math.hypot(o.position.x - sx, o.position.y - sy) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    for (const { o } of targets) {
      burst(o.position.x, o.position.y, '#ff6b6b', 18);
      addScore(5, o.position.x, o.position.y, 1);
      Composite.remove(world, o);
    }
    shake(8);
    playSmash();
  } else if (roll < 0.92) {
    splash('MYSTERY: +75');
    addScore(75, sx, sy, 1);
    burst(sx, sy, '#ffd166', 26);
  } else {
    const t = 6;
    const pos = clampOutsidePlanets(sx, sy, orbRadius(t));
    const o = makeOrb(t, pos.x, pos.y);
    o.popAt = performance.now();
    markDiscovered(t);
    splash('JACKPOT! 🌕');
    setMood('wow', 3000);
    shake(8);
    burst(sx, sy, '#ffe066', 40);
    if (t >= cfg.goalTier && state === 'playing') levelClear();
  }
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
  const vx = dx / d * LAUNCH_SPEED, vy = dy / d * LAUNCH_SPEED;
  if (armed && inv[armed] > 0) {
    const kind = armed;
    inv[kind]--;
    saveInv();
    armed = null;
    updatePw();
    makeSpecial(kind, launcher.x, launcher.y - orbRadius(1) * 0.2, vx, vy);
    playFire();
    return true; // specials do not consume the regular queue
  }
  if (currentMystery) {
    makeSpecial('mystery', launcher.x, launcher.y - orbRadius(1) * 0.2, vx, vy);
  } else {
    makeOrb(currentTier, launcher.x, launcher.y - orbRadius(currentTier) * 0.2, vx, vy);
  }
  playFire();
  currentTier = nextTier;
  currentMystery = nextMystery;
  nextTier = randSpawnTier();
  nextMystery = Math.random() < MYSTERY_CHANCE;
  updateNextChip();
  return true;
}

// Trajectory preview: the same integrator as applyGravity, run ahead.
function previewPath(tx, ty) {
  const dx = tx - launcher.x, dy = ty - launcher.y;
  const d = Math.hypot(dx, dy);
  if (d < 15) return [];
  const r = (armed || currentMystery) ? orbRadius(1) : orbRadius(currentTier);
  let px = launcher.x, py = launcher.y - r * 0.2;
  let vx = dx / d * LAUNCH_SPEED, vy = dy / d * LAUNCH_SPEED;
  const pts = [];
  const os = orbs();
  for (let i = 0; i < 200; i++) {
    const a = gravityAccel(px, py);
    vx = (vx + a.x) * DAMP;
    vy = (vy + a.y) * DAMP;
    px += vx;
    py += vy;
    if (i % 3 === 0) pts.push({ x: px, y: py });
    let hit = false;
    for (const p of planets) {
      const gx = p.body.position.x - px, gy = p.body.position.y - py;
      if (Math.hypot(gx, gy) < p.r + r) { hit = true; break; }
    }
    if (!hit && moon) {
      const gx = moon.position.x - px, gy = moon.position.y - py;
      if (Math.hypot(gx, gy) < moon.circleRadius + r) hit = true;
    }
    if (!hit) {
      for (const o of os) {
        const ox = o.position.x - px, oy = o.position.y - py;
        if (ox * ox + oy * oy < (o.orbR + r) * (o.orbR + r)) { hit = true; break; }
      }
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
    const outside = d + o.orbR > ringR;
    if (outside && speed < SETTLED_SPEED) {
      danger = true;
      if (!o.overSince) o.overSince = now;
      else if (now - o.overSince > LOSE_GRACE) return gameOver();
    } else {
      o.overSince = null;
      if (!outside && d + o.orbR > ringR - 30) danger = true;
    }
  }
  if (danger) tip('danger', 'Careful! An orb resting outside the ring for too long ends the run.');
  warning = danger;
}

function levelClear() {
  state = 'clear';
  ringFlashUntil = performance.now() + 1500;
  splash('LEVEL CLEAR!');
  shake(7);
  setMood('wow', 3500);
  playLevelClear();
  for (let i = 0; i < 6; i++) { // fireworks around the cluster
    const a = (i / 6) * Math.PI * 2;
    burst(C.x + Math.cos(a) * ringR * 0.6, C.y + Math.sin(a) * ringR * 0.6,
      i % 2 ? '#ffd166' : '#c77dff', 22);
  }
  const bonus = 20 * level;
  score += bonus;
  scoreEl.textContent = score;
  earnSpecial('smash');
  if (score > best) {
    best = score;
    localStorage.setItem('om-best', best);
  }
  bestEl.textContent = 'BEST ' + best;
  setTimeout(() => {
    if (state !== 'clear') return; // board was reset while celebrating
    overTitleEl.textContent = 'Level ' + level + ' Clear! 🎉';
    finalEl.textContent = score;
    bestNoteEl.textContent = '+' + bonus + ' level bonus';
    againEl.textContent = 'Next Level';
    overEl.classList.remove('hidden');
  }, 1400);
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

// Rebuild the board for the current level: world modifiers, planet(s), and a
// ring of debris whose tiers cycle so no two touching pieces can merge.
function resetBoard() {
  orbs().forEach(b => Composite.remove(world, b));
  pendingMerges.length = 0;
  pendingSpecials.length = 0;
  particles.length = 0;
  popups.length = 0;
  splashes.length = 0;
  state = 'playing';
  nextReadyAt = 0;
  aiming = false;
  armed = null;
  comboCount = 0;
  comboLastAt = -1e9;
  cfg = levelConfig(level);
  layout();
  ringR = ringTarget = dangerR * 0.80;
  ringGrowAt = -1e9;
  buildPlanets();
  const n = cfg.debris;
  const cycle = cfg.debrisMaxTier + 1;
  for (let i = 0; i < n; i++) {
    let t = i % cycle;
    if (i === n - 1 && t === 0) t = 1; // avoid same-tier wrap neighbors
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const d = planetR + orbRadius(t) + 6;
    makeOrb(t, C.x + Math.cos(a) * d, C.y + Math.sin(a) * d);
  }
  settling = true;
  for (let i = 0; i < 120; i++) { tickPhysics(); processMerges(); }
  settling = false;
  rollQueue();
  updateLevelHud();
  updatePw();
  overEl.classList.add('hidden');
  splash('LEVEL ' + level + (cfg.label ? ' · ' + cfg.label : '') + (cfg.collapse ? ' · SKY COLLAPSE!' : ''));
  if (cfg.label) tip('world', 'New world! The physics change every 10 levels. The label under your score says what you are flying in.');
  if (cfg.collapse) tip('collapse', 'SKY COLLAPSE! The ring is shrinking on this boss level. Merging pushes it back out.');
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
function playMerge(tier, combo) {
  const boost = (combo - 1) * 45;
  tone(320 + tier * 70 + boost, 0.18, 'sine', 0.16, 640 + tier * 140 + boost);
  if (tier === MAX_TIER) { tone(523, 0.5, 'triangle', 0.2, 1568); }
}
function playSmash() { tone(180, 0.22, 'sawtooth', 0.16, 55); }
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
  grad.addColorStop(0.4, c.color + '55');
  grad.addColorStop(1, c.color + '45');
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = c.color + 'cc';
  ctx.lineWidth = Math.max(2.5, r * 0.08);
  ctx.stroke();
  ctx.font = `${Math.round(r * 1.2)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(c.emoji, 0, r * 0.05);
  ctx.restore();
}

const SPECIAL_LOOKS = {
  wild:    { glow: '255, 255, 255', fill: 'rgba(255,255,255,.22)', glyph: '🌈' },
  smash:   { glow: '255, 107, 107', fill: 'rgba(255,107,107,.22)', glyph: '💥' },
  mystery: { glow: '199, 125, 255', fill: 'rgba(199,125,255,.25)', glyph: '❓' },
};

function drawSpecialOrb(x, y, kind, r, now) {
  const look = SPECIAL_LOOKS[kind];
  ctx.save();
  ctx.translate(x, y);
  const glow = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.5);
  glow.addColorStop(0, `rgba(${look.glow}, .4)`);
  glow.addColorStop(1, `rgba(${look.glow}, 0)`);
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.5, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = look.fill;
  ctx.fill();
  ctx.strokeStyle = kind === 'smash' ? '#ff6b6b' : `hsl(${(now / 6) % 360} 85% 70%)`;
  ctx.lineWidth = Math.max(2, r * 0.12);
  ctx.stroke();
  ctx.font = `${Math.round(r * 1.1)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(look.glyph, 0, r * 0.05);
  ctx.restore();
}

function drawFace(r, mood) {
  const e = r * 0.22;
  ctx.strokeStyle = '#2d1b5e';
  ctx.lineWidth = Math.max(2, r * 0.055);
  ctx.lineCap = 'round';
  if (mood === 'sleep') {
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * e * 1.4, -e * 0.4, e * 0.55, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, e * 0.9, e * 0.5, 0.1 * Math.PI, 0.9 * Math.PI);
    ctx.stroke();
    return;
  }
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(s * e * 1.4, -e * 0.5, mood === 'wow' ? e * 0.62 : e * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s * e * 1.4, -e * 0.45, mood === 'wow' ? e * 0.3 : e * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = '#2d1b5e';
    ctx.fill();
  }
  if (mood === 'happy') {
    ctx.beginPath();
    ctx.arc(0, e * 0.7, e * 0.65, 0.08 * Math.PI, 0.92 * Math.PI);
    ctx.stroke();
  } else if (mood === 'wow') {
    ctx.beginPath();
    ctx.arc(0, e * 1.0, e * 0.45, 0, Math.PI * 2);
    ctx.stroke();
  } else { // worry
    ctx.beginPath();
    ctx.moveTo(-e * 0.5, e * 1.05);
    ctx.quadraticCurveTo(0, e * 0.7, e * 0.5, e * 1.05);
    ctx.stroke();
  }
}

function drawCrown(r) {
  ctx.save();
  ctx.rotate(-0.3);
  ctx.translate(0, -r * 1.04);
  const cw = r * 0.56, ch = r * 0.36;
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
}

function drawPlanet(p, now, mood) {
  const skin = PLANET_SKINS[p.main ? 0 : 1];
  const breathe = 1 + Math.sin(now / 900) * 0.012;
  ctx.save();
  ctx.translate(p.body.position.x, p.body.position.y);
  ctx.scale(breathe, breathe);
  const glow = ctx.createRadialGradient(0, 0, p.r * 0.4, 0, 0, p.r * 2.2);
  glow.addColorStop(0, `rgba(${skin.glow}, .35)`);
  glow.addColorStop(1, `rgba(${skin.glow}, 0)`);
  ctx.beginPath();
  ctx.arc(0, 0, p.r * 2.2, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();
  const grad = ctx.createRadialGradient(-p.r * 0.35, -p.r * 0.35, p.r * 0.1, 0, 0, p.r);
  grad.addColorStop(0, skin.top);
  grad.addColorStop(1, skin.bottom);
  ctx.beginPath();
  ctx.arc(0, 0, p.r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  drawFace(p.r, mood);
  if (p.main) drawCrown(p.r);
  ctx.restore();
}

function drawMoon() {
  if (!moon) return;
  const r = moon.circleRadius;
  ctx.save();
  ctx.translate(moon.position.x, moon.position.y);
  const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
  grad.addColorStop(0, '#e8e8f0');
  grad.addColorStop(1, '#9aa0b4');
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.fillStyle = 'rgba(80, 86, 110, .35)';
  for (const [cx, cy, cr] of [[-r * 0.3, -r * 0.1, r * 0.22], [r * 0.25, r * 0.3, r * 0.16], [r * 0.1, -r * 0.4, r * 0.12]]) {
    ctx.beginPath();
    ctx.arc(cx, cy, cr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function render(now) {
  ctx.fillStyle = '#0b0d2a';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  if (now < shakeUntil) {
    ctx.translate((Math.random() - 0.5) * shakeAmp, (Math.random() - 0.5) * shakeAmp);
  }

  // starfield
  for (const s of stars) {
    ctx.globalAlpha = 0.35 + 0.5 * (0.5 + Math.sin(now / 1000 * s.s + s.p) / 2);
    ctx.fillStyle = '#e8e4ff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // danger ring (dynamic radius; gold during celebration)
  const flash = warning && state === 'playing' && Math.floor(now / 250) % 2 === 0;
  ctx.setLineDash([10, 12]);
  ctx.strokeStyle = now < ringFlashUntil ? 'rgba(255, 209, 102, .95)'
    : flash ? 'rgba(255, 90, 110, .95)'
    : (warning ? 'rgba(255, 90, 110, .55)' : 'rgba(178, 152, 220, .4)');
  ctx.lineWidth = flash || now < ringFlashUntil ? 3 : 2;
  ctx.beginPath();
  ctx.arc(C.x, C.y, ringR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  const gt = (now - ringGrowAt) / 500;
  if (gt >= 0 && gt < 1) { // growth ripple
    ctx.globalAlpha = 1 - gt;
    ctx.strokeStyle = 'rgba(255, 209, 102, .8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(C.x, C.y, ringR + gt * 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const mood = currentMood(now);
  for (const p of planets) drawPlanet(p, now, mood);
  drawMoon();

  // orbs (+ flight trails for fast ones)
  for (const o of orbs()) {
    if (o.special) {
      drawSpecialOrb(o.position.x, o.position.y, o.special, o.orbR, now);
      continue;
    }
    const speed = Math.hypot(o.velocity.x, o.velocity.y);
    if (speed > 5 && frame % 2 === 0) {
      particles.push({ x: o.position.x, y: o.position.y, vx: 0, vy: 0, life: 0.35, color: TIERS[o.tier].color });
    }
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
    if (armed || currentMystery) {
      drawSpecialOrb(launcher.x, launcher.y - orbRadius(1) * 0.2, armed || 'mystery', orbRadius(1), now);
    } else {
      drawOrb(launcher.x, launcher.y - orbRadius(currentTier) * 0.2, 0, currentTier, orbRadius(currentTier), 1);
    }
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

  // splash banners
  for (let i = splashes.length - 1; i >= 0; i--) {
    const s = splashes[i];
    const t = (now - s.t0) / 1500;
    if (t >= 1) { splashes.splice(i, 1); continue; }
    const sc = Math.min(1, t * 4);
    ctx.save();
    ctx.translate(C.x, C.y - dangerR - 36 - i * 30);
    ctx.scale(sc, sc);
    ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    ctx.font = '800 24px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd166';
    ctx.shadowColor = 'rgba(255, 209, 102, .6)';
    ctx.shadowBlur = 14;
    ctx.fillText(s.txt, 0, 0);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ---- Main loop ----------------------------------------------------------
let lastT = performance.now();
let acc = 0;

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
  const AIM_TIP = 'Touch and drag to aim. The gold dots show how your shot will curve. Release to fire.';
  if (!localStorage.getItem('om-welcomed')) {
    $('welcome').classList.remove('hidden');
  } else {
    tip('aim', AIM_TIP);
  }
  $('begin').addEventListener('click', () => {
    localStorage.setItem('om-welcomed', '1');
    $('welcome').classList.add('hidden');
    unlockAudio();
    tip('aim', AIM_TIP);
  });
  requestAnimationFrame(loop);
}

window.addEventListener('resize', () => { layout(); buildPlanets(); });

if ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Debug hook for automated testing; harmless in production.
window.__dbg = {
  fire: (tx, ty) => fireToward(tx, ty),
  spawnAt: (tier, x, y) => makeOrb(tier, x, y),
  spawnSpecialAt: (kind, x, y, vx, vy) => makeSpecial(kind, x, y, vx || 0, vy || 0),
  orbs: () => orbs().map(o => ({
    tier: o.tier,
    special: o.special || null,
    x: Math.round(o.position.x),
    y: Math.round(o.position.y),
    d: Math.round(Math.hypot(o.position.x - C.x, o.position.y - C.y)),
  })),
  geom: () => ({ C, dangerR, planetR, launcher }),
  planets: () => planets.map(p => ({ x: Math.round(p.body.position.x), y: Math.round(p.body.position.y), r: Math.round(p.r), main: p.main })),
  moon: () => moon ? { x: Math.round(moon.position.x), y: Math.round(moon.position.y) } : null,
  config: () => cfg,
  ring: () => ({ r: Math.round(ringR), target: Math.round(ringTarget), cap: Math.round(dangerR) }),
  forceMystery(v) { forcedMystery = v; },
  armMystery() { currentMystery = true; },
  resetTips() { seenTips.clear(); localStorage.removeItem('om-tips'); },
  tipVisible: () => !tipEl.classList.contains('hidden') ? tipTextEl.textContent : null,
  score: () => score,
  state: () => state,
  level: () => level,
  combo: () => comboCount,
  mood: () => currentMood(performance.now()),
  inv: () => ({ ...inv }),
  setInv(w, s) { inv.wild = w; inv.smash = s; saveInv(); updatePw(); },
  arm(kind) { armed = kind; updatePw(); },
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
