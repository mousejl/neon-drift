/* ==========================================================
   NEON DRIFT // js/audio.js
   全部音乐 / 音效由 Web Audio API 实时合成，零外部音频文件
   BGM: 112 BPM synthwave, Am7 - Fmaj7 - Cmaj7 - G
   鼓组 / 贝斯 / 16 分琶音 / Pad / Lead + Delay + 混响
   引擎声随车速实时变调；仅 START ENGINE 之后才创建 AudioContext
   ========================================================== */
(function (global) {
  'use strict';

  var BPM = 112;
  var BEAT = 60 / BPM;              // 0.535714 s
  var S16 = BEAT / 4;               // 16 分音符 0.133929 s
  var LOOP_STEPS = 16 * 8;          // 8 小节循环，每个和弦 2 小节

  var mtof = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };

  // 和弦：根音（贝斯）+ 四个声部（MIDI）
  var CHORDS = [
    { name: 'Am7', root: 33, notes: [57, 60, 64, 67], melody: [0, 0, 69, 0, 72, 0, 76, 0, 74, 0, 72, 0, 69, 0, 0, 0] },
    { name: 'Fmaj7', root: 29, notes: [53, 57, 60, 64], melody: [0, 0, 72, 0, 76, 0, 77, 0, 76, 0, 72, 0, 69, 0, 0, 0] },
    { name: 'Cmaj7', root: 36, notes: [48, 52, 55, 59], melody: [0, 0, 76, 0, 79, 0, 81, 0, 79, 0, 76, 0, 72, 0, 0, 0] },
    { name: 'G', root: 31, notes: [55, 59, 62, 67], melody: [0, 0, 74, 0, 79, 0, 81, 0, 79, 0, 76, 0, 74, 0, 0, 0] }
  ];
  var ARP_PATTERN = [0, 1, 2, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 2];

  var A = {
    ctx: null, started: false, failed: false, paused: false,
    timer: null, nextTime: 0, step: 0,
    master: null, musicBus: null, sfxBus: null, engineBus: null,
    revSend: null, delaySend: null, noiseBuf: null,
    engine: null, driftGain: null, windGain: null
  };

  /* ---------------- 基础设施 ---------------- */
  function makeNoise(ctx, seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    var seed = 12345;
    for (var i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d[i] = (seed / 2147483648) - 1;
    }
    return buf;
  }
  function makeImpulse(ctx, seconds, decay) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(2, len, ctx.sampleRate);
    var seed = 987654321;
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        d[i] = ((seed / 2147483648) - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }
  function ramp(param, t, value, tau) {
    try { param.setTargetAtTime(value, t, tau); } catch (e) { param.value = value; }
  }
  function env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  function stopAt(node, t) { try { node.stop(t); } catch (e) { } }

  function voice(type, freq, t, dur, peak, dest, attack, decay) {
    var ctx = A.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    env(g, t, peak, attack || 0.004, decay || dur);
    o.connect(g); g.connect(dest || A.musicBus);
    o.start(t); stopAt(o, t + (attack || 0.004) + (decay || dur) + 0.08);
    return { o: o, g: g };
  }

  /* ---------------- 图构建 ---------------- */
  function buildGraph() {
    var ctx = A.ctx;
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 22; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.22;
    A.master = ctx.createGain(); A.master.gain.value = 0.82;
    A.master.connect(comp);
    // 分析节点：用于运行时自检（不改变听感）
    A.analyser = ctx.createAnalyser(); A.analyser.fftSize = 1024;
    comp.connect(A.analyser); A.analyser.connect(ctx.destination);

    A.musicBus = ctx.createGain(); A.musicBus.gain.value = 0.62; A.musicBus.connect(A.master);
    A.sfxBus = ctx.createGain(); A.sfxBus.gain.value = 0.85; A.sfxBus.connect(A.master);
    A.engineBus = ctx.createGain(); A.engineBus.gain.value = 0.42; A.engineBus.connect(A.master);

    // 混响
    var conv = ctx.createConvolver(); conv.buffer = makeImpulse(ctx, 2.4, 2.6);
    var revOut = ctx.createGain(); revOut.gain.value = 0.42;
    A.revSend = ctx.createGain(); A.revSend.gain.value = 1;
    A.revSend.connect(conv); conv.connect(revOut); revOut.connect(A.master);

    // Delay（附点八分，约 0.402 s）
    var dly = ctx.createDelay(1.2); dly.delayTime.value = BEAT * 0.75;
    var fb = ctx.createGain(); fb.gain.value = 0.34;
    var wet = ctx.createGain(); wet.gain.value = 0.32;
    A.delaySend = ctx.createGain(); A.delaySend.gain.value = 1;
    A.delaySend.connect(dly); dly.connect(fb); fb.connect(dly);
    dly.connect(wet); wet.connect(A.master); wet.connect(A.revSend);

    A.noiseBuf = makeNoise(ctx, 2);
  }

  function noiseSource() {
    var s = A.ctx.createBufferSource(); s.buffer = A.noiseBuf; s.loop = true; return s;
  }

  /* ---------------- 鼓组 ---------------- */
  function kick(t) {
    var ctx = A.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(155, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    g.gain.setValueAtTime(0.95, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
    o.connect(g); g.connect(A.musicBus);
    o.start(t); stopAt(o, t + 0.34);
    // 敲击瞬态
    var n = noiseSource(), ng = ctx.createGain(), hp = ctx.createBiquadFilter();
    hp.type = 'lowpass'; hp.frequency.value = 1800;
    ng.gain.setValueAtTime(0.28, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    n.connect(hp); hp.connect(ng); ng.connect(A.musicBus);
    n.start(t); stopAt(n, t + 0.05);
  }
  function snare(t) {
    var ctx = A.ctx, n = noiseSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 1350;
    g.gain.setValueAtTime(0.34, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    n.connect(hp); hp.connect(g); g.connect(A.musicBus); g.connect(A.revSend);
    n.start(t); stopAt(n, t + 0.22);
    voice('triangle', 190, t, 0.10, 0.16, A.musicBus, 0.002, 0.10);
  }
  function hat(t, level, open) {
    var ctx = A.ctx, n = noiseSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 7200;
    var d = open ? 0.20 : 0.045;
    g.gain.setValueAtTime(level, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    n.connect(hp); hp.connect(g); g.connect(A.musicBus);
    n.start(t); stopAt(n, t + d + 0.02);
  }

  /* ---------------- 贝斯 / 琶音 / Pad / Lead ---------------- */
  function bass(t, midi, dur) {
    var ctx = A.ctx, f = mtof(midi);
    var o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    var flt = ctx.createBiquadFilter(), g = ctx.createGain();
    o1.type = 'sawtooth'; o1.frequency.setValueAtTime(f, t);
    o2.type = 'square'; o2.frequency.setValueAtTime(f / 2, t);
    flt.type = 'lowpass'; flt.Q.value = 7;
    flt.frequency.setValueAtTime(260, t);
    flt.frequency.exponentialRampToValueAtTime(1100, t + 0.045);
    flt.frequency.exponentialRampToValueAtTime(190, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.24, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o1.connect(flt); o2.connect(flt); flt.connect(g); g.connect(A.musicBus);
    o1.start(t); o2.start(t); stopAt(o1, t + dur + 0.05); stopAt(o2, t + dur + 0.05);
  }

  function arp(t, midi) {
    var ctx = A.ctx, f = mtof(midi);
    var o = ctx.createOscillator(), flt = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'square'; o.frequency.setValueAtTime(f, t);
    flt.type = 'lowpass'; flt.frequency.setValueAtTime(3200, t);
    flt.frequency.exponentialRampToValueAtTime(700, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.055, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    o.connect(flt); flt.connect(g); g.connect(A.musicBus); g.connect(A.delaySend);
    o.start(t); stopAt(o, t + 0.2);
  }

  function pad(t, notes, dur) {
    var ctx = A.ctx, flt = ctx.createBiquadFilter(), g = ctx.createGain();
    flt.type = 'lowpass'; flt.frequency.value = 1050; flt.Q.value = 0.7;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.052, t + 0.42);
    g.gain.setValueAtTime(0.052, t + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    flt.connect(g); g.connect(A.musicBus); g.connect(A.revSend);
    for (var i = 0; i < notes.length; i++) {
      for (var d = 0; d < 2; d++) {
        var o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.value = mtof(notes[i] + 12) * (d ? 1.004 : 0.996);
        o.connect(flt); o.start(t); stopAt(o, t + dur + 0.1);
      }
    }
  }

  function lead(t, midi, dur) {
    var ctx = A.ctx, f = mtof(midi);
    var o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    var flt = ctx.createBiquadFilter(), g = ctx.createGain();
    o1.type = 'sawtooth'; o2.type = 'square';
    o1.frequency.setValueAtTime(f * 0.995, t);
    o1.frequency.linearRampToValueAtTime(f, t + 0.06);
    o2.frequency.setValueAtTime(f * 1.003, t);
    flt.type = 'lowpass'; flt.Q.value = 4;
    flt.frequency.setValueAtTime(900, t);
    flt.frequency.exponentialRampToValueAtTime(3400, t + 0.09);
    flt.frequency.exponentialRampToValueAtTime(800, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.085, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o1.connect(flt); o2.connect(flt); flt.connect(g);
    g.connect(A.musicBus); g.connect(A.delaySend); g.connect(A.revSend);
    o1.start(t); o2.start(t); stopAt(o1, t + dur + 0.05); stopAt(o2, t + dur + 0.05);
  }

  /* ---------------- 引擎 / 风噪 / 漂移 ---------------- */
  function buildEngine() {
    var ctx = A.ctx;
    var o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), o3 = ctx.createOscillator();
    var flt = ctx.createBiquadFilter(), g = ctx.createGain();
    o1.type = 'sawtooth'; o2.type = 'sawtooth'; o3.type = 'square';
    o1.frequency.value = 58; o2.frequency.value = 58.7; o3.frequency.value = 29;
    flt.type = 'lowpass'; flt.frequency.value = 420; flt.Q.value = 3;
    g.gain.value = 0.0001;
    o1.connect(flt); o2.connect(flt); o3.connect(flt); flt.connect(g); g.connect(A.engineBus);
    o1.start(); o2.start(); o3.start();

    // 风噪
    var n = noiseSource(), bp = ctx.createBiquadFilter(), ng = ctx.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
    ng.gain.value = 0.0001;
    n.connect(bp); bp.connect(ng); ng.connect(A.engineBus); n.start();

    // 漂移摩擦噪声（持续）
    var n2 = noiseSource(), bp2 = ctx.createBiquadFilter(), dg = ctx.createGain();
    bp2.type = 'bandpass'; bp2.frequency.value = 2600; bp2.Q.value = 1.2;
    dg.gain.value = 0.0001;
    n2.connect(bp2); bp2.connect(dg); dg.connect(A.sfxBus); n2.start();

    A.engine = { o1: o1, o2: o2, o3: o3, flt: flt, g: g, bp: bp };
    A.windGain = ng; A.driftGain = dg;
  }

  function updateEngine(speedRatio, nitro, drift, paused) {
    if (!A.started || !A.engine) return;
    var ctx = A.ctx, t = ctx.currentTime, e = A.engine;
    var f = 46 + speedRatio * 138 + (nitro ? 34 : 0);
    ramp(e.o1.frequency, t, f, 0.06);
    ramp(e.o2.frequency, t, f * 1.012 + 1.5, 0.06);
    ramp(e.o3.frequency, t, f * 0.5, 0.06);
    ramp(e.flt.frequency, t, 320 + speedRatio * 2100 + (nitro ? 700 : 0), 0.08);
    ramp(e.g.gain, t, paused ? 0.0001 : (0.10 + speedRatio * 0.19 + (nitro ? 0.08 : 0)), 0.08);
    ramp(A.windGain.gain, t, paused ? 0.0001 : (0.008 + speedRatio * 0.075), 0.1);
    ramp(A.driftGain.gain, t, paused ? 0.0001 : (drift > .05 ? 0.035 + drift * 0.11 : 0.0001), 0.07);
    ramp(A.engineBus.gain, t, paused ? 0.10 : 0.42, 0.12);
  }

  /* ---------------- 步进音序器 ---------------- */
  function scheduleStep(s, t) {
    var local = s % 16, chord = CHORDS[Math.floor(s / 32) % 4];
    // 鼓
    if (local % 4 === 0) kick(t);
    if (local === 4 || local === 12) snare(t);
    if (local % 2 === 0) hat(t, local % 4 === 0 ? 0.105 : 0.065, false);
    if (local === 14) hat(t, 0.10, true);
    // 贝斯
    if (local === 0 || local === 6 || local === 8 || local === 14) {
      bass(t, chord.root + (local === 6 ? 12 : 0), S16 * (local === 0 ? 3 : 2));
    }
    // 16 分琶音
    var an = chord.notes[ARP_PATTERN[local]] + (local >= 8 ? 12 : 0);
    arp(t, an);
    // Pad：每小节起始
    if (local === 0) pad(t, chord.notes, BEAT * 3.8);
    // Lead：每 2 小节一句
    var mel = chord.melody[local];
    if (mel) lead(t, mel, S16 * 1.7);
  }

  function scheduler() {
    if (!A.started || !A.ctx || A.ctx.state !== 'running') return;
    var now = A.ctx.currentTime;
    if (A.nextTime < now - 0.4) A.nextTime = now + 0.05;
    while (A.nextTime < now + 0.16) {
      if (!A.paused) scheduleStep(A.step, A.nextTime);
      A.nextTime += S16;
      A.step = (A.step + 1) % LOOP_STEPS;
    }
  }

  /* ---------------- 音效 ---------------- */
  function sfx(name, arg) {
    if (!A.started || !A.ctx) return;
    var ctx = A.ctx, t = ctx.currentTime, i;
    try {
      if (name === 'nitro') {
        var n = noiseSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
        bp.type = 'bandpass'; bp.Q.value = 1.1;
        bp.frequency.setValueAtTime(400, t);
        bp.frequency.exponentialRampToValueAtTime(5200, t + 0.55);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.30, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.72);
        n.connect(bp); bp.connect(g); g.connect(A.sfxBus); g.connect(A.revSend);
        n.start(t); stopAt(n, t + 0.75);
        var o = ctx.createOscillator(), og = ctx.createGain();
        o.type = 'sawtooth'; o.frequency.setValueAtTime(110, t);
        o.frequency.exponentialRampToValueAtTime(880, t + 0.4);
        og.gain.setValueAtTime(0.10, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        o.connect(og); og.connect(A.sfxBus); o.start(t); stopAt(o, t + 0.55);
      } else if (name === 'pickup') {
        var notes = [880, 1174.66, 1567.98, 2093];
        for (i = 0; i < notes.length; i++) {
          var tt = t + i * 0.055;
          voice('sine', notes[i], tt, 0.24, 0.16, A.sfxBus, 0.003, 0.24);
          var v = voice('triangle', notes[i] * 2, tt, 0.12, 0.045, A.delaySend, 0.003, 0.12);
          void v;
        }
      } else if (name === 'combo') {
        var lv = Math.min(arg || 1, 12);
        voice('square', 440 * Math.pow(1.06, lv), t, 0.12, 0.12, A.sfxBus, 0.003, 0.12);
        voice('sine', 880 * Math.pow(1.06, lv), t + 0.05, 0.16, 0.09, A.delaySend, 0.003, 0.16);
      } else if (name === 'boost' || name === 'lap') {
        var base = name === 'lap' ? 523.25 : 660;
        for (i = 0; i < 3; i++) voice('triangle', base * Math.pow(1.26, i), t + i * 0.06, 0.22, 0.11, A.sfxBus, 0.004, 0.22);
        var nn = noiseSource(), ng = ctx.createGain(), hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 3000;
        ng.gain.setValueAtTime(0.13, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        nn.connect(hp); hp.connect(ng); ng.connect(A.sfxBus);
        nn.start(t); stopAt(nn, t + 0.32);
      } else if (name === 'crash') {
        var cn = noiseSource(), cg = ctx.createGain(), lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 900;
        cg.gain.setValueAtTime(0.34, t); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
        cn.connect(lp); lp.connect(cg); cg.connect(A.sfxBus);
        cn.start(t); stopAt(cn, t + 0.4);
        var co = ctx.createOscillator(), cog = ctx.createGain();
        co.type = 'sine'; co.frequency.setValueAtTime(120, t);
        co.frequency.exponentialRampToValueAtTime(40, t + 0.3);
        cog.gain.setValueAtTime(0.3, t); cog.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
        co.connect(cog); cog.connect(A.sfxBus); co.start(t); stopAt(co, t + 0.35);
      } else if (name === 'ui') {
        voice('square', 740, t, 0.08, 0.07, A.sfxBus, 0.002, 0.08);
      }
    } catch (e) { /* 音频节点异常不应影响游戏 */ }
  }

  /* ---------------- 对外接口 ---------------- */
  function start() {
    if (A.started || A.failed) {
      if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume();
      return Promise.resolve(A.started);
    }
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) { A.failed = true; return Promise.resolve(false); }
      A.ctx = new AC();
      buildGraph();
      buildEngine();
      A.started = true;
      A.step = 0; A.nextTime = A.ctx.currentTime + 0.08;
      A.timer = setInterval(scheduler, 25);
      var pr = A.ctx.resume();
      if (pr && pr.catch) pr.catch(function () { });
      return Promise.resolve(true);
    } catch (e) {
      A.failed = true;
      return Promise.resolve(false);
    }
  }

  function setPaused(p) {
    A.paused = !!p;
    if (!A.started) return;
    var t = A.ctx.currentTime;
    ramp(A.musicBus.gain, t, p ? 0.0001 : 0.62, 0.12);
    ramp(A.master.gain, t, p ? 0.42 : 0.82, 0.12);
  }
  function update(g) {
    updateEngine(g.speedRatio, g.nitroActive, g.driftIntensity, g.paused);
  }
  function getState() { return { started: A.started, failed: A.failed }; }
  function info() {
    var rms = 0;
    if (A.analyser) {
      var data = new Float32Array(A.analyser.fftSize);
      A.analyser.getFloatTimeDomainData(data);
      var sum = 0;
      for (var i = 0; i < data.length; i++) sum += data[i] * data[i];
      rms = Math.sqrt(sum / data.length);
    }
    return {
      started: A.started, failed: A.failed,
      state: A.ctx ? A.ctx.state : 'none',
      step: A.step, nextTime: A.nextTime, rms: +rms.toFixed(5),
      engineFreq: A.engine ? A.engine.o1.frequency.value : null,
      bpm: BPM, progression: 'Am7 - Fmaj7 - Cmaj7 - G'
    };
  }

  global.AUDIO = {
    start: start, sfx: sfx, update: update, setPaused: setPaused, getState: getState, info: info,
    BPM: BPM, PROGRESSION: 'Am7 - Fmaj7 - Cmaj7 - G'
  };
})(window);
