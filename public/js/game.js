import * as THREE from 'three';
import { MAP } from './map.js';
import { Network } from './network.js';

const CFG = window.GAME_CONFIG;
const EYE = 1.7, PLAYER_R = 0.45;

// ---------------- Scene ----------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x141a26);
scene.fog = new THREE.Fog(0x141a26, 40, 110);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 500);
camera.rotation.order = 'YXZ';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.getElementById('game').appendChild(renderer.domElement);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(40, 80, 20);
scene.add(sun);

// ---------------- Map ----------------
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(MAP.bounds.x * 2, MAP.bounds.z * 2),
  new THREE.MeshLambertMaterial({ color: 0x2a3140 })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

MAP.boxes.forEach(b => {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(b.w, b.h, b.d),
    new THREE.MeshLambertMaterial({ color: b.color })
  );
  mesh.position.set(b.x, b.y, b.z);
  scene.add(mesh);
});

// bomb site marker
const siteRing = new THREE.Mesh(
  new THREE.RingGeometry(MAP.bombSite.r - 0.4, MAP.bombSite.r, 48),
  new THREE.MeshBasicMaterial({
    color: 0xffaa00, side: THREE.DoubleSide, transparent: true, opacity: 0.7,
  })
);
siteRing.rotation.x = -Math.PI / 2;
siteRing.position.set(MAP.bombSite.x, 0.02, MAP.bombSite.z);
scene.add(siteRing);

function spawnMarker(s, color) {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(2.5, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(s.x, 0.03, s.z);
  scene.add(m);
}
spawnMarker(MAP.spawnT,  0xff4444);
spawnMarker(MAP.spawnCT, 0x4488ff);

// ---------------- Local player ----------------
const player = {
  pos: new THREE.Vector3(MAP.spawnCT.x, EYE, MAP.spawnCT.z),
  vel: new THREE.Vector3(),
  yaw: 0, pitch: 0,
  hp: 100, alive: true, team: CFG.team,
  hasBomb: false,
};
if (CFG.team === 't') {
  player.pos.set(MAP.spawnT.x, EYE, MAP.spawnT.z);
  player.yaw = Math.PI;
}

// ---------------- Input ----------------
const KEYS = {};
addEventListener('keydown', e => {
  KEYS[e.code] = true;
  if (e.code === 'KeyE') tryActionStart();
});
addEventListener('keyup', e => {
  KEYS[e.code] = false;
  if (e.code === 'KeyE') tryActionEnd();
});

addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  player.yaw   -= e.movementX * 0.0022;
  player.pitch -= e.movementY * 0.0022;
  const lim = Math.PI / 2 - 0.02;
  player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
});

addEventListener('mousedown', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  if (e.button === 0) shoot();
});

// pointer lock
const promptEl = document.getElementById('pointerLockPrompt');
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
promptEl.addEventListener('click', () => renderer.domElement.requestPointerLock());
document.addEventListener('pointerlockchange', () => {
  promptEl.classList.toggle('hidden', document.pointerLockElement === renderer.domElement);
});

// ---------------- Others ----------------
const others = {};
function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 30px Tahoma';
  ctx.textAlign = 'center';
  ctx.fillText(text, 128, 42);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  spr.scale.set(2, 0.5, 1);
  return spr;
}

function createPlayerMesh(team) {
  const g = new THREE.Group();
  const color = team === 't' ? 0xff6644 : 0x4488ff;
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.4, 1.0, 4, 10),
    new THREE.MeshLambertMaterial({ color })
  );
  body.position.y = 1.0;
  g.add(body);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 12, 12),
    new THREE.MeshLambertMaterial({ color: 0xf0c090 })
  );
  head.position.y = 1.75;
  g.add(head);
  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.12, 0.9),
    new THREE.MeshLambertMaterial({ color: 0x222222 })
  );
  gun.position.set(0.35, 1.45, -0.5);
  g.add(gun);
  return g;
}

function ensureOther(p) {
  if (others[p.id]) return others[p.id];
  const group = createPlayerMesh(p.team);
  scene.add(group);
  const label = makeLabel(p.name);
  scene.add(label);
  others[p.id] = { group, label, team: p.team, alive: true };
  return others[p.id];
}

// ---------------- Effects ----------------
const tracers = [];
function spawnTracer(origin, dir, color = 0xffff99) {
  const len = 60;
  const end = origin.clone().add(dir.clone().multiplyScalar(len));
  const geo = new THREE.BufferGeometry().setFromPoints([origin, end]);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  tracers.push({ line, life: 0.08 });
}

// ---------------- Bomb mesh ----------------
let bombMesh = null;
function updateBomb(bomb) {
  if (!bomb) {
    if (bombMesh) { scene.remove(bombMesh); bombMesh = null; }
    return;
  }
  if (!bombMesh) {
    bombMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.4, 0.6),
      new THREE.MeshLambertMaterial({ color: 0x111111, emissive: 0xff2200, emissiveIntensity: 0.5 })
    );
    scene.add(bombMesh);
  }
  bombMesh.position.set(bomb.x, 0.2, bomb.z);
}

// ---------------- Movement & collision ----------------
function resolveCollision(x, z) {
  const r = PLAYER_R;
  for (const b of MAP.boxes) {
    const hw = b.w / 2 + r;
    const hd = b.d / 2 + r;
    if (x > b.x - hw && x < b.x + hw && z > b.z - hd && z < b.z + hd) {
      if (b.y - b.h / 2 < 2.0) {
        const dxL = x - (b.x - hw);
        const dxR = (b.x + hw) - x;
        const dzL = z - (b.z - hd);
        const dzR = (b.z + hd) - z;
        const m = Math.min(dxL, dxR, dzL, dzR);
        if (m === dxL) x = b.x - hw;
        else if (m === dxR) x = b.x + hw;
        else if (m === dzL) z = b.z - hd;
        else z = b.z + hd;
      }
    }
  }
  x = Math.max(-MAP.bounds.x + r, Math.min(MAP.bounds.x - r, x));
  z = Math.max(-MAP.bounds.z + r, Math.min(MAP.bounds.z - r, z));
  return { x, z };
}

function updatePlayer(dt) {
  if (!player.alive) return;
  if (gameState === 'waiting' || gameState === 'freeze' || gameState === 'ended') return;

  const input = new THREE.Vector3();
  if (KEYS['KeyW']) input.z -= 1;
  if (KEYS['KeyS']) input.z += 1;
  if (KEYS['KeyA']) input.x -= 1;
  if (KEYS['KeyD']) input.x += 1;
  if (KEYS['ShiftLeft'] || KEYS['ShiftRight']) input.multiplyScalar(0.5);

  if (input.lengthSq() > 0) input.normalize();

  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, player.yaw, 0));
  input.applyQuaternion(q);

  const speed = 7;
  const vx = input.x * speed;
  const vz = input.z * speed;

  const nx = player.pos.x + vx * dt;
  const nz = player.pos.z + vz * dt;
  const r = resolveCollision(nx, nz);
  player.pos.x = r.x;
  player.pos.z = r.z;
  player.pos.y = EYE;
}

// ---------------- Shooting ----------------
let lastShoot = 0;
function shoot() {
  if (!player.alive) return;
  if (gameState !== 'live' && gameState !== 'planted') return;
  const now = performance.now();
  if (now - lastShoot < 110) return;
  lastShoot = now;

  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  net.send({ type: 'shoot', dx: dir.x, dy: dir.y, dz: dir.z });

  const origin = new THREE.Vector3(player.pos.x, player.pos.y - 0.1, player.pos.z);
  spawnTracer(origin, dir);
}

// ---------------- Plant / Defuse ----------------
let actionActive = false;

function tryActionStart() {
  if (!player.alive) return;
  if (document.pointerLockElement !== renderer.domElement) return;

  if (player.team === 't' && player.hasBomb && gameState === 'live') {
    const d = Math.hypot(player.pos.x - MAP.bombSite.x, player.pos.z - MAP.bombSite.z);
    if (d < MAP.bombSite.r) {
      actionActive = true;
      net.send({ type: 'plant_start' });
      showHint('در حال کارگذاری بمب...');
    } else {
      showHint('باید داخل محل بمب باشی', 1500);
    }
  }

  if (player.team === 'ct' && gameState === 'planted' && lastBomb) {
    const d = Math.hypot(player.pos.x - lastBomb.x, player.pos.z - lastBomb.z);
    if (d < 1.8) {
      actionActive = true;
      net.send({ type: 'defuse_start' });
      showHint('در حال خنثی‌سازی بمب...');
    } else {
      showHint('نزدیک بمب برو', 1500);
    }
  }
}

function tryActionEnd() {
  if (!actionActive) return;
  actionActive = false;
  net.send({ type: player.team === 't' ? 'plant_cancel' : 'defuse_cancel' });
  hideHint();
}

// ---------------- HUD ----------------
const hud = {
  timer: document.getElementById('timer'),
  scoreT: document.getElementById('scoreT'),
  scoreCT: document.getElementById('scoreCT'),
  hp: document.getElementById('health'),
  team: document.getElementById('teamLabel'),
  bombStatus: document.getElementById('bombStatus'),
  center: document.getElementById('centerMsg'),
  hint: document.getElementById('hint'),
  progressBar: document.getElementById('progressBar'),
  progressFill: document.getElementById('progressFill'),
  chat: document.getElementById('chat'),
};

let hintTimer = 0;
function showHint(text, ms = 0) {
  hud.hint.textContent = text;
  hud.hint.classList.add('show');
  if (ms) {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, ms);
  }
}
function hideHint() { hud.hint.classList.remove('show'); }

// ---------------- Game state ----------------
let myId = null;
let gameState = 'waiting';
let stateEndsAt = 0;
let lastBomb = null;

// ✅ این خط برای Node.js تغییر کرده
const net = new Network(
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host
);

net.on('welcome', () => {
  net.send({ type: 'join', name: CFG.name, team: CFG.team });
});

net.on('joined', msg => {
  myId = msg.id;
  player.team = msg.team;
  player.pos.set(msg.spawn.x, EYE, msg.spawn.z);
  hud.team.textContent = msg.team === 't' ? 'تروریست' : 'ضدتروریست';
  hud.team.style.color = msg.team === 't' ? '#ff6b45' : '#4599ff';
});

net.on('error', msg => {
  hud.center.textContent = msg.msg || 'خطا';
});

net.on('snapshot', msg => {
  gameState = msg.state;
  stateEndsAt = msg.endsAt;
  hud.scoreT.textContent = msg.scores.t;
  hud.scoreCT.textContent = msg.scores.ct;
  lastBomb = msg.bomb;

  const seen = new Set();
  for (const p of msg.players) {
    if (p.id === myId) {
      player.hp = p.hp;
      player.alive = p.alive;
      player.hasBomb = p.hasBomb;
      continue;
    }
    seen.add(p.id);
    const o = ensureOther(p);
    o.alive = p.alive;
    o.group.visible = p.alive;
    o.label.visible = p.alive;
    o.group.position.set(p.x, p.y - EYE, p.z);
    o.group.rotation.y = p.ry;
    o.label.position.set(p.x, p.y + 0.6, p.z);
  }

  for (const id in others) {
    if (!seen.has(Number(id))) {
      scene.remove(others[id].group);
      scene.remove(others[id].label);
      delete others[id];
    }
  }

  updateBomb(msg.bomb);

  hud.hp.textContent = player.hp;
  hud.hp.style.color = player.hp > 50 ? '#7dff9a' : player.hp > 20 ? '#ffb347' : '#ff5a5a';

  if (msg.bomb) {
    const t = Math.max(0, (msg.bomb.endsAt - Date.now()) / 1000);
    hud.bombStatus.textContent = `💣 بمب کار گذاشته شد — ${t.toFixed(1)}s${msg.bomb.defusing ? ' (خنثی‌سازی...)' : ''}`;
  } else if (player.hasBomb) {
    hud.bombStatus.textContent = '🎒 شما بمب دارید — برای کارگذاری E را نگه دار';
  } else if (player.team === 't') {
    hud.bombStatus.textContent = 'دنبال بمب‌گذار باشید';
  } else {
    hud.bombStatus.textContent = '';
  }

  if (msg.planting) {
    hud.progressBar.classList.add('active');
    hud.progressFill.style.background = '#ffb347';
    hud.progressFill.style.width = Math.min(100, msg.planting.progress * 100) + '%';
  } else if (msg.bomb && msg.bomb.defusing) {
    hud.progressBar.classList.add('active');
    hud.progressFill.style.background = '#4dff88';
    hud.progressFill.style.width = Math.min(100, msg.bomb.defuseProgress * 100) + '%';
  } else {
    hud.progressBar.classList.remove('active');
  }

  if (gameState === 'waiting') {
    hud.center.textContent = 'در انتظار بازیکنان...';
  } else if (gameState === 'freeze') {
    const t = Math.max(0, (stateEndsAt - Date.now()) / 1000);
    hud.center.textContent = `آماده شوید... ${t.toFixed(0)}`;
  } else {
    hud.center.textContent = player.alive ? '' : 'شما مرده‌اید — تا شروع راند بعد صبر کنید';
  }
});

net.on('shoot', msg => {
  if (msg.id === myId) return;
  const origin = new THREE.Vector3(msg.ox, msg.oy, msg.oz);
  const dir = new THREE.Vector3(msg.dx, msg.dy, msg.dz);
  spawnTracer(origin, dir, 0xffaa66);
});

net.on('hit', msg => {
  if (msg.by === myId) flashHitMarker();
});

net.on('round_end', msg => {
  const text = msg.winner === 't' ? 'تروریست‌ها بردند!' : 'ضدتروریست‌ها بردند!';
  const reason = {
    bomb_exploded: 'بمب منفجر شد',
    defused: 'بمب خنثی شد',
    elimination: 'حذف تیم مقابل',
    time: 'زمان تمام شد',
  }[msg.reason] || '';
  hud.center.textContent = `${text}  (${reason})`;
});

net.on('round_start', () => {
  hud.center.textContent = '';
});

net.on('chat', msg => {
  const div = document.createElement('div');
  div.className = 'chat-' + msg.team;
  div.textContent = `[${msg.team === 't' ? 'T' : 'CT'}] ${msg.from}: ${msg.msg}`;
  hud.chat.appendChild(div);
  hud.chat.scrollTop = hud.chat.scrollHeight;
  while (hud.chat.children.length > 12) hud.chat.removeChild(hud.chat.firstChild);
});

const crosshair = document.getElementById('crosshair');
function flashHitMarker() {
  crosshair.style.filter = 'drop-shadow(0 0 6px #ff4444)';
  setTimeout(() => crosshair.style.filter = '', 120);
}

// ---------------- Main loop ----------------
const clock = new THREE.Clock();
let lastSend = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  if (document.pointerLockElement === renderer.domElement) {
    updatePlayer(dt);
  }

  camera.position.copy(player.pos);
  camera.rotation.y = player.yaw;
  camera.rotation.x = player.pitch;

  const now = performance.now();
  if (now - lastSend > 50 && myId !== null) {
    lastSend = now;
    net.send({
      type: 'state',
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      rx: player.pitch, ry: player.yaw,
    });
  }

  if (gameState === 'live' || gameState === 'planted' || gameState === 'freeze') {
    const t = Math.max(0, (stateEndsAt - Date.now()) / 1000);
    hud.timer.textContent = t.toFixed(0);
  } else {
    hud.timer.textContent = '--';
  }

  for (let i = tracers.length - 1; i >= 0; i--) {
    tracers[i].life -= dt;
    tracers[i].line.material.opacity = Math.max(0, tracers[i].life / 0.08);
    if (tracers[i].life <= 0) {
      scene.remove(tracers[i].line);
      tracers.splice(i, 1);
    }
  }

  renderer.render(scene, camera);
}

// ---------------- Boot ----------------
net.connect()
  .then(() => animate())
  .catch(err => {
    hud.center.textContent = 'اتصال به سرور ناموفق بود';
    console.error(err);
  });

addEventListener('keydown', e => {
  if (e.code === 'KeyT' && document.pointerLockElement) {
    document.exitPointerLock();
    const msg = prompt('پیام:');
    if (msg) net.send({ type: 'chat', msg });
    setTimeout(() => renderer.domElement.requestPointerLock(), 50);
  }
});
