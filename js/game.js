/* ==========================================================
   NEON DRIFT // js/game.js
   赛道 / 物理 / 玩法 / 输入 / HUD / 主循环 / 调试参数
   ========================================================== */
(function (global) {
  'use strict';

  var CFG = global.SCENE.CFG;
  var L = CFG.segmentLength, N = CFG.segmentCount, TRACK = CFG.trackLength;
  var MAXSPEED = 12000;
  var KMH = 320 / MAXSPEED;
  var DIST_SCALE = 1 / 135000;
  var LANES = [-0.62, 0, 0.62];
  var CAR_COLORS = ['#28e7ff', '#ffd166', '#8a3bff', '#ff6b3d', '#7bff9b', '#f0f0ff', '#ff2d95'];
  var BEST_KEY = 'neonDrift.bestLap.v1';

  /* ---------------- DOM ---------------- */
  var D = {};
  function $(id) { return document.getElementById(id); }
  function cacheDom() {
    ['cabinet', 'screen', 'hud-lap', 'hud-best', 'hud-dist', 'hud-phase', 'phase-fill',
      'hud-score', 'hud-combo', 'hud-auto', 'hud-nitro-num', 'nitro-fill', 'hud-speed',
      'speed-fill', 'combo-toast', 'pickup-toast', 'touch', 'overlay-start', 'btn-start',
      'overlay-pause', 'btn-resume', 'btn-restart-p', 'overlay-help', 'btn-help-close'
    ].forEach(function (id) { D[id] = $(id); });
  }

  /* ---------------- 工具 ---------------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function pad(n, len) { var s = String(Math.floor(n)); while (s.length < len) s = '0' + s; return s; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
  function formatTime(sec) {
    if (sec === null || sec === undefined) return '--:--.--';
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60), cs = Math.floor((sec * 100) % 100);
    return pad(m, 2) + ':' + pad(s, 2) + '.' + pad(cs, 2);
  }
  function loadBest() {
    try { var v = parseFloat(localStorage.getItem(BEST_KEY)); return isFinite(v) && v > 0 ? v : null; }
    catch (e) { return null; }
  }
  function saveBest(v) { try { localStorage.setItem(BEST_KEY, String(v)); } catch (e) { } }
  function toast(el, text) {
    if (!el) return;
    el.textContent = text; el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  /* ---------------- 调试参数 ---------------- */
  var debug = { auto: false, night: false, pos: 0 };
  function parseDebug() {
    try {
      var p = new URLSearchParams(global.location.search);
      debug.auto = p.get('auto') === '1';
      debug.night = p.get('night') === '1';
      var raw = parseFloat(p.get('pos'));
      if (isFinite(raw) && raw > 0 && raw < 1) debug.pos = raw;
    } catch (e) { /* file:// 下有些环境可能不支持，忽略 */ }
  }

  /* ---------------- 全局状态 ---------------- */
  var G = {
    segments: [], traffic: [], notes: [], particles: [],
    position: 0, playerX: 0, speed: 0, speedRatio: 0, maxSpeed: MAXSPEED,
    totalDistance: 0, raceTime: 0, time: 0,
    lap: 1, lapStartTime: 0, bestLap: null,
    score: 0, combo: 1, comboTimer: 0,
    nitro: 0, nitroActive: false, nitroWasActive: false,
    driftIntensity: 0, driftVisual: 0, steerVisual: 0, steering: 0,
    braking: false, onBoost: false,
    dayFactor: 1, dayOffset: 0, parallax: 0,
    auto: false, paused: false, helpOpen: false, hudHidden: false,
    started: false, demo: true
  };

  var input = { gas: false, brake: false, left: false, right: false, drift: false, nitro: false };
  var held = { gas: false, brake: false, left: false, right: false, drift: false, nitro: false };

  /* ---------------- 赛道（周期函数保证首尾无缝） ---------------- */
  function hillAt(i) {
    var t = i / N, PI2 = Math.PI * 2;
    return 1500 * Math.sin(PI2 * 2 * t) + 820 * Math.sin(PI2 * 5 * t) + 260 * Math.sin(PI2 * 11 * t);
  }
  function curveAt(i) {
    var t = i / N, PI2 = Math.PI * 2;
    return 2.2 * Math.sin(PI2 * 2 * t) + 1.3 * Math.sin(PI2 * 5 * t) +
      0.75 * Math.sin(PI2 * 9 * t) + 0.35 * Math.sin(PI2 * 17 * t);
  }
  function buildTrack() {
    G.segments.length = 0;
    for (var i = 0; i < N; i++) {
      G.segments.push({
        index: i, curve: curveAt(i),
        p1: { world: { x: 0, y: hillAt(i), z: i * L }, camera: {}, screen: {} },
        p2: { world: { x: 0, y: hillAt(i + 1), z: (i + 1) * L }, camera: {}, screen: {} }
      });
    }
    global.SCENE.decorateTrack(G.segments);
  }
  function segAt(z) { return G.segments[((Math.floor(z / L) % N) + N) % N]; }

  /* ---------------- 车流 / 音符 / 粒子 ---------------- */
  function spawnCar(car, distance) {
    car = car || {};
    car.rel = distance === undefined ? rand(9000, CFG.drawDistance * L * .82) : distance;
    car.offset = pick(LANES) + rand(-.06, .06);
    car.speed = rand(3300, 7100);
    car.color = pick(CAR_COLORS);
    car.z = 0;
    car.prevRel = car.rel;
    return car;
  }
  function fillTraffic() {
    while (G.traffic.length < 16) G.traffic.push(spawnCar({}));
  }
  function spawnNote(note, distance) {
    note = note || {};
    note.rel = distance === undefined ? rand(11000, CFG.drawDistance * L * .75) : distance;
    note.offset = pick(LANES) + rand(-.05, .05);
    note.z = 0;
    note.seed = rand(0, 6.28);
    note.dead = false;
    return note;
  }
  function fillNotes() {
    while (G.notes.length < 11) G.notes.push(spawnNote({}));
  }
  function emit(n, color, x, y, spread, up) {
    for (var i = 0; i < n; i++) {
      if (G.particles.length > 190) break;
      G.particles.push({
        x: x + rand(-.02, .02), y: y + rand(-.01, .01),
        vx: rand(-spread, spread), vy: up ? rand(-.55, -.12) : rand(-.25, .25),
        gravity: .55, life: rand(.3, .75), max: .75,
        r: rand(1.6, 4.6), color: color
      });
    }
  }
  function updateParticles(dt) {
    for (var i = G.particles.length - 1; i >= 0; i--) {
      var p = G.particles[i];
      p.life -= dt;
      if (p.life <= 0) { G.particles.splice(i, 1); continue; }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
  }

  /* ---------------- 重置 ---------------- */
  function resetGame() {
    G.position = debug.pos * TRACK;
    G.totalDistance = G.position;
    G.playerX = 0; G.speed = 0; G.speedRatio = 0;
    G.raceTime = 0; G.lapStartTime = 0;
    G.lap = 1; G.bestLap = loadBest();
    G.score = 0; G.combo = 1; G.comboTimer = 0;
    G.nitro = 0; G.nitroActive = false; G.nitroWasActive = false;
    G.driftIntensity = 0; G.driftVisual = 0; G.steerVisual = 0; G.steering = 0;
    G.braking = false; G.onBoost = false; G.parallax = 0;
    G.auto = debug.auto;
    // night=1 时无论 ?pos= 跳到哪一段，开局都恰好处于深夜
    G.dayOffset = debug.night ? (1 - debug.pos) : 0;
    G.paused = false; G.helpOpen = false; G.demo = false;
    G.traffic.length = 0; G.notes.length = 0; G.particles.length = 0;
    fillTraffic(); fillNotes();
    for (var i = 0; i < G.traffic.length; i++) {
      G.traffic[i].rel = 3500 + i * (CFG.drawDistance * L * .72 / G.traffic.length) + rand(-800, 800);
    }
    for (var j = 0; j < G.notes.length; j++) {
      G.notes[j].rel = 6000 + j * (CFG.drawDistance * L * .65 / G.notes.length);
    }
    G.paused = false;
    global.AUDIO.setPaused(false);
    updateHUD(true);
  }

  /* ---------------- 输入 ---------------- */
  function computeInput(dt) {
    var inp = {
      gas: held.gas, brake: held.brake,
      steer: (held.right ? 1 : 0) - (held.left ? 1 : 0),
      drift: held.drift, nitro: held.nitro
    };
    if (G.auto) {
      inp.gas = true; inp.brake = false;
      inp.steer = autoSteer();
      var a = Math.abs(inp.steer);
      inp.drift = a > .42 && a < .85 && G.speed > MAXSPEED * .35 && G.nitro < 70;
      inp.nitro = G.nitro > 82;
    }
    return inp;
  }

  function autoSteer() {
    var base = Math.floor((G.position + CFG.playerZ) / L) % N, sum = 0, i, j, c;
    for (i = 0; i < 26; i++) sum += G.segments[(base + i) % N].curve;
    var avg = sum / 26;

    // 紧急避让：本车道前方近距离有车时，立刻切到最空的车道
    var danger = null;
    for (j = 0; j < G.traffic.length; j++) {
      c = G.traffic[j];
      if (c.rel > 0 && c.rel < 5600 && Math.abs(c.offset - G.playerX) < .42) {
        if (!danger || c.rel < danger.rel) danger = c;
      }
    }
    if (danger) {
      var escape = LANES[0], far = -1;
      for (i = 0; i < LANES.length; i++) {
        var clearance = Math.abs(LANES[i] - danger.offset);
        for (j = 0; j < G.traffic.length; j++) {
          c = G.traffic[j];
          if (c !== danger && c.rel > -600 && c.rel < 6500) {
            clearance = Math.min(clearance, Math.abs(LANES[i] - c.offset) + c.rel * .000012);
          }
        }
        if (clearance > far) { far = clearance; escape = LANES[i]; }
      }
      return clamp((escape - G.playerX) * 5.6, -1, 1);
    }

    // 常规：选择前方最空的车道，并抵消弯道离心力
    var bestLane = 0, bestClear = -1;
    for (i = 0; i < LANES.length; i++) {
      var clear = 99;
      for (j = 0; j < G.traffic.length; j++) {
        c = G.traffic[j];
        if (c.rel > 0 && c.rel < 11000) {
          var d = Math.abs(c.offset - LANES[i]) + c.rel * .000026;
          if (d < clear) clear = d;
        }
      }
      if (clear > bestClear) { bestClear = clear; bestLane = LANES[i]; }
    }
    var target = clamp(-avg * .10 + bestLane * .62, -.8, .8);
    return clamp((target - G.playerX) * 3.4, -1, 1);
  }

  function bindKeyboard() {
    global.addEventListener('keydown', function (e) {
      var c = e.code, k = e.key;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].indexOf(c) >= 0) e.preventDefault();
      if (!G.started) {
        if (c === 'Enter' || c === 'Space' || k === 'Enter' || k === ' ') { startGame(); return; }
      }
      switch (c) {
        case 'KeyW': case 'ArrowUp': held.gas = true; break;
        case 'KeyS': case 'ArrowDown': held.brake = true; break;
        case 'KeyA': case 'ArrowLeft': held.left = true; break;
        case 'KeyD': case 'ArrowRight': held.right = true; break;
        case 'ShiftLeft': case 'ShiftRight': held.drift = true; break;
        case 'Space': held.nitro = true; break;
      }
      if (k === '?') { if (!e.repeat) toggleHelp(); return; }
      if (!e.repeat) {
        if (c === 'KeyC') { toggleAuto(); }
        else if (c === 'KeyP') { togglePause(); }
        else if (c === 'KeyR') { restart(); }
        else if (c === 'KeyH') { toggleHud(); }
        else if (c === 'Slash') { toggleHelp(); }
        else if (c === 'Escape') {
          if (G.helpOpen) toggleHelp(); else if (G.paused) togglePause();
        }
      }
    });
    global.addEventListener('keyup', function (e) {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': held.gas = false; break;
        case 'KeyS': case 'ArrowDown': held.brake = false; break;
        case 'KeyA': case 'ArrowLeft': held.left = false; break;
        case 'KeyD': case 'ArrowRight': held.right = false; break;
        case 'ShiftLeft': case 'ShiftRight': held.drift = false; break;
        case 'Space': held.nitro = false; break;
      }
    });
    global.addEventListener('blur', function () {
      for (var k2 in held) held[k2] = false;
    });
  }

  function bindTouch() {
    var coarse = false;
    try { coarse = global.matchMedia('(pointer: coarse)').matches || ('ontouchstart' in global); }
    catch (e) { coarse = 'ontouchstart' in global; }
    if (coarse) D.cabinet.classList.add('touch-on');

    var btns = D.touch.querySelectorAll('[data-key]');
    Array.prototype.forEach.call(btns, function (btn) {
      var key = btn.getAttribute('data-key');
      function down(e) {
        e.preventDefault();
        if (['auto', 'pause', 'help'].indexOf(key) >= 0) {
          if (key === 'auto') toggleAuto(); else if (key === 'pause') togglePause(); else toggleHelp();
          return;
        }
        held[key] = true; btn.classList.add('held');
      }
      function up(e) {
        e.preventDefault(); held[key] = false; btn.classList.remove('held');
      }
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });
  }

  /* ---------------- 状态切换 ---------------- */
  function startGame() {
    if (G.started) return;
    G.started = true;
    D['overlay-start'].classList.add('hidden');
    global.AUDIO.start();                 // 仅在用户手势之后创建 AudioContext
    global.AUDIO.sfx('ui');
    resetGame();
  }
  function restart() {
    resetGame();
    D['overlay-pause'].classList.add('hidden');
    D['overlay-help'].classList.add('hidden');
    global.AUDIO.sfx('ui');
    toast(D['combo-toast'], 'RESTART');
  }
  function togglePause() {
    if (!G.started || G.helpOpen) return;
    G.paused = !G.paused;
    D['overlay-pause'].classList.toggle('hidden', !G.paused);
    global.AUDIO.setPaused(G.paused);
    global.AUDIO.sfx('ui');
  }
  function toggleHelp() {
    G.helpOpen = !G.helpOpen;
    D['overlay-help'].classList.toggle('hidden', !G.helpOpen);
    // 帮助面板优先级高于暂停面板；关闭后恢复暂停面板
    D['overlay-pause'].classList.toggle('hidden', G.helpOpen || !G.paused);
    global.AUDIO.sfx('ui');
  }
  function toggleHud() {
    G.hudHidden = !G.hudHidden;
    D.cabinet.classList.toggle('hud-hidden', G.hudHidden);
  }
  function toggleAuto() {
    G.auto = !G.auto;
    global.AUDIO.sfx('ui');
    toast(D['pickup-toast'], G.auto ? 'AUTO CRUISE ON' : 'AUTO CRUISE OFF');
    updateHUD(true);
  }

  /* ---------------- 玩法更新 ---------------- */
  function updateDay() {
    var phase = ((G.totalDistance / TRACK + G.dayOffset) % 2 + 2) % 2;
    G.dayFactor = phase < 1 ? 1 - phase : phase - 1;
  }

  function registerOvertake() {
    if (G.demo) return;
    if (G.comboTimer > 0) G.combo = Math.min(G.combo + 1, 99);
    else G.combo = 1;
    G.comboTimer = 2.7;
    var gain = Math.round((120 + G.speedRatio * 180) * G.combo);
    G.score += gain;
    toast(D['combo-toast'], 'OVERTAKE  x' + G.combo + '   +' + gain);
    global.AUDIO.sfx('combo', G.combo);
    emit(7, 'rgba(255,209,102,ALPHA)', .5, .84, .22, true);
  }

  function updateTraffic(dt, playerAbs) {
    var visible = 0, i, c;
    for (i = 0; i < G.traffic.length; i++) {
      c = G.traffic[i];
      var prev = c.rel;
      c.rel += (c.speed - G.speed) * dt;
      if (c.rel < -3200 || c.rel > CFG.drawDistance * L * .98) {
        spawnCar(c, rand(11000, CFG.drawDistance * L * .85));
        prev = c.rel;
      }
      if (c.rel > 0 && c.rel < CFG.drawDistance * L * .78) visible++;
      if (!G.demo && prev > 0 && c.rel <= 0) registerOvertake();
      if (!G.demo && c.rel > -80 && c.rel < 430 && Math.abs(c.offset - G.playerX) < .27 && G.speed > 2500) {
        G.speed *= .48; G.nitro = Math.max(0, G.nitro - 14);
        G.combo = 1; G.comboTimer = 0;
        G.playerX += (G.playerX >= c.offset ? .18 : -.18);
        c.rel = 1500;
        toast(D['combo-toast'], 'CRASH!  -SPEED');
        global.AUDIO.sfx('crash');
        emit(18, 'rgba(255,45,149,ALPHA)', .5, .87, .3, true);
      }
      c.z = ((playerAbs + c.rel) % TRACK + TRACK) % TRACK;
    }
    // 视野内始终有车可超
    if (visible < 7) {
      var need = 7 - visible;
      for (i = 0; i < need; i++) {
        var idx = i % G.traffic.length;
        spawnCar(G.traffic[idx], rand(6000, CFG.drawDistance * L * .72));
      }
    }
  }

  function updateNotes(dt, playerAbs) {
    for (var i = 0; i < G.notes.length; i++) {
      var n = G.notes[i];
      n.rel -= G.speed * dt;
      if (n.rel < -1600) { spawnNote(n, rand(14000, CFG.drawDistance * L * .78)); }
      if (!G.demo && Math.abs(n.rel) < 620 && Math.abs(n.offset - G.playerX) < .44) {
        G.nitro = Math.min(100, G.nitro + 28);
        G.score += 150;
        toast(D['pickup-toast'], '♪  NITRO +28   +150');
        global.AUDIO.sfx('pickup');
        emit(14, 'rgba(40,231,255,ALPHA)', .5, .80, .25, true);
        spawnNote(n, rand(15000, CFG.drawDistance * L * .78));
      }
      n.z = ((playerAbs + n.rel) % TRACK + TRACK) % TRACK;
    }
  }

  function update(dt) {
    var demo = G.demo;
    if (!demo) G.raceTime += dt;

    var inp;
    if (demo) {
      inp = { gas: true, brake: false, steer: Math.sin(G.time * .55) * .20, drift: false, nitro: false };
      G.speed = 6200 + Math.sin(G.time * .7) * 1100;
    } else {
      inp = computeInput(dt);
      // 纵向物理
      var cap = G.nitroActive ? MAXSPEED * 1.46 : MAXSPEED;
      var acc;
      if (inp.gas) acc = 4600 + (G.nitroActive ? 3200 : 0);
      else if (inp.brake) acc = -9200;
      else acc = -1900;
      G.speed += acc * dt;
      if (Math.abs(G.playerX) > .99) G.speed -= 4300 * dt;   // 冲出路面减速
      G.speed = clamp(G.speed, 0, cap);
    }
    G.speedRatio = clamp(G.speed / MAXSPEED, 0, 1.5);
    G.braking = !!inp.brake && G.speed > 100;

    // 横向物理
    var speedPct = clamp(G.speed / MAXSPEED, 0, 1.5);
    var dx = dt * 2.1 * Math.min(speedPct, 1.2);
    var curve = segAt(G.position + CFG.playerZ).curve;
    G.playerX += inp.steer * dx * 1.15;                      // 转向灵敏度
    G.playerX -= dx * speedPct * curve * .30;                // 弯道离心力
    G.steering = inp.steer;
    G.steerVisual += (inp.steer * .9 - G.steerVisual) * Math.min(1, dt * 8);

    // 漂移
    var drifting = !demo && inp.drift && G.speed > MAXSPEED * .32 && Math.abs(inp.steer) > .12;
    if (drifting) {
      G.driftIntensity = Math.min(1, G.driftIntensity + dt * 1.9);
      G.playerX += inp.steer * dt * .85 * speedPct;
      G.nitro = Math.min(100, G.nitro + dt * (11 + 17 * speedPct) * G.driftIntensity);
      G.score += dt * 55 * speedPct;
      G.driftVisual += (inp.steer * G.driftIntensity - G.driftVisual) * Math.min(1, dt * 7);
      if (Math.random() < dt * 34) {
        emit(2, Math.random() < .5 ? 'rgba(255,45,149,ALPHA)' : 'rgba(40,231,255,ALPHA)',
          .5 + (Math.random() < .5 ? -.055 : .055), .90, .13, true);
      }
    } else {
      G.driftIntensity = Math.max(0, G.driftIntensity - dt * 2.6);
      G.driftVisual += (0 - G.driftVisual) * Math.min(1, dt * 6);
    }
    G.playerX = clamp(G.playerX, -1.85, 1.85);

    // 氮气
    if (!demo) {
      var wantNitro = inp.nitro && G.nitro > 0;
      G.nitroActive = wantNitro;
      if (wantNitro) {
        G.nitro = Math.max(0, G.nitro - dt * 30);
        if (!G.nitroWasActive) global.AUDIO.sfx('nitro');
        if (Math.random() < dt * 30) emit(2, 'rgba(40,231,255,ALPHA)', .5 + rand(-.05, .05), .91, .1, true);
      }
      G.nitroWasActive = wantNitro;
      if (G.comboTimer > 0) { G.comboTimer -= dt; if (G.comboTimer <= 0) G.combo = 1; }
    } else {
      G.nitroActive = false;
    }

    // 前进 / 圈数
    var prevPos = G.position;
    G.position = (G.position + G.speed * dt) % TRACK;
    G.totalDistance += G.speed * dt;
    var playerAbs = G.position + CFG.playerZ;

    // 加速带
    var pseg = segAt(playerAbs);
    if (pseg.boost && !G.onBoost && G.speed > 900 && !demo) {
      G.speed = Math.min(MAXSPEED * 1.46, G.speed + 2100);
      G.score += 80;
      toast(D['pickup-toast'], '» BOOST PAD  +80');
      global.AUDIO.sfx('boost');
      emit(12, 'rgba(40,231,255,ALPHA)', .5, .88, .3, true);
    }
    G.onBoost = pseg.boost;

    // 车流 / 音符 / 粒子
    updateTraffic(dt, playerAbs);
    updateNotes(dt, playerAbs);
    updateParticles(dt);

    // 昼夜 / 视差
    updateDay();
    G.parallax += curve * speedPct * dt * 22;

    // 完成一圈
    if (!demo && G.position < prevPos - TRACK * .5) {
      var lapTime = G.raceTime - G.lapStartTime;
      G.lapStartTime = G.raceTime;
      if (lapTime > 1 && (G.bestLap === null || lapTime < G.bestLap)) {
        G.bestLap = lapTime; saveBest(lapTime);
        toast(D['combo-toast'], '★ NEW BEST LAP  ' + formatTime(lapTime));
      } else {
        toast(D['combo-toast'], 'LAP ' + pad(G.lap, 2) + '  ' + formatTime(lapTime));
      }
      G.lap++;
      G.score += 1000;
      global.AUDIO.sfx('lap');
      emit(20, 'rgba(255,209,102,ALPHA)', .5, .8, .35, true);
    }
  }

  /* ---------------- HUD ---------------- */
  var hudAcc = 0;
  function updateHUD(force) {
    var kmh = Math.round(G.speed * KMH);
    D['hud-speed'].textContent = pad(kmh, 3);
    D['hud-speed'].classList.toggle('boost', G.nitroActive);
    D['speed-fill'].style.width = clamp(G.speedRatio * 100, 0, 100) + '%';
    D['hud-lap'].textContent = pad(G.lap, 2);
    D['hud-best'].textContent = formatTime(G.bestLap);
    D['hud-dist'].textContent = (G.totalDistance * DIST_SCALE).toFixed(2) + ' KM';
    D['hud-score'].textContent = pad(G.score, 7);
    D['hud-combo'].textContent = 'x' + G.combo;
    D['hud-auto'].textContent = G.auto ? 'ON' : 'OFF';
    D['hud-auto'].classList.toggle('on', G.auto);
    D['hud-nitro-num'].textContent = Math.round(G.nitro) + '%';
    D['nitro-fill'].style.width = G.nitro + '%';
    D['nitro-fill'].classList.toggle('full', G.nitro >= 99);
    D['phase-fill'].style.width = ((1 - G.dayFactor) * 100).toFixed(1) + '%';
    var label = G.dayFactor > .62 ? 'DAY / 日' : (G.dayFactor > .30 ? 'DUSK / 黄昏' : 'NIGHT / 夜');
    D['hud-phase'].textContent = label;
    if (force) hudAcc = 0;
  }

  /* ---------------- 主循环 ---------------- */
  function frame(now) {
    var dt = Math.min((now - frame.last) / 1000, .05);
    if (!isFinite(dt) || dt < 0) dt = 0.016;
    frame.last = now;
    G.time += dt;
    if ((G.started && !G.paused && !G.helpOpen) || !G.started) update(dt);
    global.SCENE.render(G, G.time);
    global.AUDIO.update({
      speedRatio: G.speedRatio, nitroActive: G.nitroActive,
      driftIntensity: G.driftIntensity, paused: G.paused || G.helpOpen || !G.started
    });
    hudAcc += dt;
    if (hudAcc > .075) { updateHUD(); hudAcc = 0; }
    requestAnimationFrame(frame);
  }
  frame.last = 0;

  /* ---------------- 启动 ---------------- */
  function resize() {
    var w = global.innerWidth, h = global.innerHeight;
    global.SCENE.resize(w, h, global.devicePixelRatio || 1);
  }

  function boot() {
    cacheDom();
    parseDebug();
    global.SCENE.init(D.screen);
    buildTrack();
    resize();
    resetGame();
    G.demo = true;                 // START ENGINE 之前为自动演示画面
    G.started = false;

    bindKeyboard();
    bindTouch();
    D['btn-start'].addEventListener('click', startGame);
    D['btn-resume'].addEventListener('click', togglePause);
    D['btn-restart-p'].addEventListener('click', restart);
    D['btn-help-close'].addEventListener('click', toggleHelp);
    global.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && G.started && !G.paused && !G.helpOpen) togglePause();
    });
    frame.last = performance.now();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 供调试 / 自动化验证使用
  global.NEON = { G: G, debug: debug, start: startGame, reset: resetGame, CFG: CFG };
})(window);
