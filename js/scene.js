/* ==========================================================
   NEON DRIFT // js/scene.js
   场景渲染：全部图形由代码绘制，无任何外部素材
   - OutRun 式伪 3D 分段投影路面
   - 条纹落日 / 星空 / 远山 / 三层亮窗城市 / 透视霓虹网格
   - 棕榈树、路灯、霓虹广告牌、跨路拱门
   - 玩家车、车流、发光音符、加速带、粒子、速度线
   ========================================================== */
(function (global) {
  'use strict';

  var CFG = {
    segmentLength: 200,
    segmentCount: 1500,
    roadWidth: 2200,
    lanes: 3,
    drawDistance: 260,
    cameraHeight: 1050,
    fieldOfView: 100,
    fogDensity: 4.2
  };
  CFG.cameraDepth = 1 / Math.tan((CFG.fieldOfView / 2) * Math.PI / 180);
  CFG.playerZ = CFG.cameraHeight * CFG.cameraDepth;
  CFG.trackLength = CFG.segmentLength * CFG.segmentCount;

  var HORIZON = 0.44;          // 地平线位于画面高度的比例
  var S = { canvas: null, ctx: null, w: 0, h: 0, dpr: 1 };
  var CACHE = { sprites: {}, cars: {}, city: [], mountain: null, stars: [] };

  /* ---------------- 基础工具 ---------------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function col(r, g, b) { return [r, g, b]; }
  function mix(a, b, t) { return col(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)); }
  function css(c, alpha) {
    return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + (alpha === undefined ? 1 : alpha) + ')';
  }
  function makeCanvas(w, h) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    return { cv: c, ctx: c.getContext('2d') };
  }
  function poly(ctx, color, pts) {
    ctx.fillStyle = color; ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath(); ctx.fill();
  }
  function seeded(seed) {
    var s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function glowRect(ctx, x, y, w, h, color, blur) {
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = blur;
    ctx.fillStyle = color; ctx.fillRect(x, y, w, h); ctx.restore();
  }

  /* ---------------- 调色板（昼 → 夜） ---------------- */
  var PAL_DAY = {
    skyTop: col(42, 8, 88), skyMid: col(146, 22, 126), skyLow: col(255, 112, 92),
    ground: col(38, 8, 62), fog: col(70, 16, 92),
    mountain: col(72, 20, 104), cityBack: col(60, 16, 96), cityMid: col(38, 10, 74), cityFront: col(18, 5, 46),
    road1: col(38, 16, 62), road2: col(45, 19, 72),
    sunTop: col(255, 240, 164), sunMid: col(255, 150, 79), sunBot: col(255, 45, 149),
    grid: col(255, 45, 149), grid2: col(40, 231, 255)
  };
  var PAL_NIGHT = {
    skyTop: col(3, 0, 15), skyMid: col(18, 5, 52), skyLow: col(74, 22, 116),
    ground: col(8, 2, 28), fog: col(12, 4, 38),
    mountain: col(15, 5, 42), cityBack: col(20, 6, 50), cityMid: col(12, 3, 38), cityFront: col(5, 1, 20),
    road1: col(18, 8, 38), road2: col(24, 11, 47),
    sunTop: col(150, 96, 255), sunMid: col(120, 40, 200), sunBot: col(255, 45, 149),
    grid: col(255, 45, 149), grid2: col(40, 231, 255)
  };
  function palette(day) {
    var p = {};
    for (var k in PAL_DAY) p[k] = mix(PAL_NIGHT[k], PAL_DAY[k], day);
    return p;
  }

  /* ---------------- 预渲染：星空 / 远山 / 城市 / 精灵 ---------------- */
  function buildCaches() {
    var rnd = seeded(19861108), i, k;

    // 星空
    CACHE.stars = [];
    for (i = 0; i < 210; i++) {
      CACHE.stars.push({ x: rnd(), y: rnd() * 0.9, r: 0.4 + rnd() * 1.5, p: rnd() * 6.28, s: 0.4 + rnd() });
    }

    // 远山（两层锯齿剪影，峰顶靠近画布顶部以便露出城市天际线）
    var m = makeCanvas(2400, 300);
    for (k = 0; k < 2; k++) {
      var step = k === 0 ? 110 : 74;
      m.ctx.beginPath(); m.ctx.moveTo(0, 300);
      for (var x = 0; x <= 2400 + step; x += step) {
        var peak = (k === 0 ? 22 : 76) + rnd() * (k === 0 ? 105 : 95);
        m.ctx.lineTo(x, peak);
        m.ctx.lineTo(x + step * 0.5, peak + 55 + rnd() * 75);
      }
      m.ctx.lineTo(2400, 300); m.ctx.closePath();
      m.ctx.fillStyle = k === 0 ? 'rgba(58,16,96,.82)' : 'rgba(20,6,46,.94)';
      m.ctx.fill();
      m.ctx.lineWidth = 2;
      m.ctx.strokeStyle = k === 0 ? 'rgba(255,45,149,.55)' : 'rgba(40,231,255,.42)';
      m.ctx.stroke();
    }
    CACHE.mountain = m.cv;

    // 三层城市：高度、颜色、亮窗密度逐层变化
    var layerSpec = [
      { h: 100, bw: [26, 58], bh: [28, 92], win: 0.20, dark: '#150834', edge: '#ff2d95' },
      { h: 160, bw: [34, 78], bh: [46, 150], win: 0.30, dark: '#0d0528', edge: '#8a3bff' },
      { h: 230, bw: [44, 96], bh: [70, 215], win: 0.42, dark: '#050118', edge: '#28e7ff' }
    ];
    CACHE.city = [];
    for (k = 0; k < 3; k++) {
      var sp = layerSpec[k], o = makeCanvas(2400, sp.h), c = o.ctx, x = 0;
      while (x < 2400) {
        var bw = sp.bw[0] + rnd() * (sp.bw[1] - sp.bw[0]);
        var bh = sp.bh[0] + rnd() * (sp.bh[1] - sp.bh[0]);
        var top = sp.h - bh;
        c.fillStyle = sp.dark; c.fillRect(x, top, bw, bh);
        c.strokeStyle = sp.edge; c.globalAlpha = 0.22; c.lineWidth = 1;
        c.strokeRect(x + .5, top + .5, bw - 1, bh - 1); c.globalAlpha = 1;
        // 天线
        if (rnd() > 0.72) {
          c.fillStyle = sp.edge; c.globalAlpha = 0.5;
          c.fillRect(x + bw * .5, top - 12 - rnd() * 14, 2, 16); c.globalAlpha = 1;
        }
        // 亮窗
        var wc = ['#28e7ff', '#ff2d95', '#ffd166', '#b8f6ff', '#ff8ad8'];
        for (var wy = top + 8; wy < sp.h - 6; wy += 10) {
          for (var wx = x + 6; wx < x + bw - 6; wx += 8) {
            if (rnd() < sp.win) {
              c.globalAlpha = 0.55 + rnd() * 0.45;
              c.fillStyle = wc[(rnd() * wc.length) | 0];
              c.fillRect(wx, wy, 3.2, 4.5);
            }
          }
        }
        c.globalAlpha = 1;
        x += bw + 2 + rnd() * 8;
      }
      CACHE.city.push(o.cv);
    }

    // 路边精灵
    CACHE.sprites.palm = makePalm();
    CACHE.sprites.lamp = makeLamp();
    CACHE.sprites.arch = makeArch();
    CACHE.sprites.note = makeNote();
    CACHE.sprites.billboard = {};
    var words = ['NEON', 'OUTRUN', 'SYNTHWAVE', '1986', 'DRIVE', 'MIDNIGHT', 'RETRO', 'TURBO'];
    for (i = 0; i < words.length; i++) CACHE.sprites.billboard[words[i]] = makeBillboard(words[i], i);
    CACHE.billboardWords = words;
  }

  function makePalm() {
    var o = makeCanvas(200, 380), c = o.ctx;
    // 树干
    c.beginPath(); c.moveTo(92, 380); c.lineTo(100, 380);
    c.quadraticCurveTo(112, 250, 100, 120); c.lineTo(88, 120);
    c.quadraticCurveTo(78, 250, 92, 380); c.closePath();
    c.fillStyle = '#1b0b36'; c.fill();
    c.strokeStyle = '#ff2d95'; c.lineWidth = 2; c.globalAlpha = .55; c.stroke(); c.globalAlpha = 1;
    for (var i = 0; i < 8; i++) {
      c.fillStyle = 'rgba(255,45,149,.10)'; c.fillRect(90 + i * 1.1, 150 + i * 27, 12, 3);
    }
    // 树冠
    for (var j = 0; j < 9; j++) {
      var a = -Math.PI + (j / 8) * Math.PI;
      var ex = 100 + Math.cos(a) * 92, ey = 118 + Math.sin(a) * 56 - 18;
      c.beginPath(); c.moveTo(100, 116);
      c.quadraticCurveTo(100 + Math.cos(a) * 54, 116 + Math.sin(a) * 58 - 52, ex, ey);
      c.quadraticCurveTo(100 + Math.cos(a) * 48, 116 + Math.sin(a) * 34 - 10, 100, 122);
      c.closePath();
      c.fillStyle = j % 2 ? '#220b45' : '#150733'; c.fill();
      c.strokeStyle = j % 2 ? 'rgba(40,231,255,.6)' : 'rgba(255,45,149,.6)';
      c.lineWidth = 2; c.stroke();
    }
    c.save(); c.shadowColor = '#ff2d95'; c.shadowBlur = 18;
    c.fillStyle = '#ff77c2'; c.beginPath(); c.arc(100, 116, 6, 0, 6.283); c.fill(); c.restore();
    return o.cv;
  }

  function makeLamp() {
    var o = makeCanvas(120, 400), c = o.ctx;
    c.fillStyle = '#120730'; c.fillRect(54, 70, 11, 330);
    c.strokeStyle = 'rgba(40,231,255,.4)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(59, 78); c.quadraticCurveTo(59, 34, 96, 34); c.stroke();
    c.save(); c.shadowColor = '#28e7ff'; c.shadowBlur = 30;
    var g = c.createRadialGradient(98, 40, 2, 98, 40, 26);
    g.addColorStop(0, '#ffffff'); g.addColorStop(.25, '#a8f6ff'); g.addColorStop(1, 'rgba(40,231,255,0)');
    c.fillStyle = g; c.beginPath(); c.arc(98, 40, 28, 0, 6.283); c.fill();
    c.fillStyle = '#dffcff'; c.fillRect(84, 34, 28, 8);
    c.restore();
    // 地面光晕
    var g2 = c.createLinearGradient(0, 380, 0, 400);
    g2.addColorStop(0, 'rgba(40,231,255,0)'); g2.addColorStop(1, 'rgba(40,231,255,.3)');
    c.fillStyle = g2; c.fillRect(20, 380, 80, 20);
    return o.cv;
  }

  function makeBillboard(word, idx) {
    var o = makeCanvas(340, 230), c = o.ctx;
    var hue = idx % 2 ? '#28e7ff' : '#ff2d95';
    c.fillStyle = '#0b0326'; c.fillRect(58, 62, 224, 20);
    c.fillStyle = '#1a0838'; c.fillRect(20, 12, 300, 128);
    c.save(); c.shadowColor = hue; c.shadowBlur = 22;
    c.strokeStyle = hue; c.lineWidth = 4; c.strokeRect(20, 12, 300, 128);
    c.strokeStyle = 'rgba(255,255,255,.65)'; c.lineWidth = 1; c.strokeRect(28, 20, 284, 112);
    c.fillStyle = '#ffffff'; c.font = 'bold 40px "Arial Black", Impact, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(word, 170, 76);
    c.restore();
    c.fillStyle = hue; c.globalAlpha = .8;
    for (var i = 0; i < 8; i++) c.fillRect(34 + i * 36, 128, 20, 3);
    c.globalAlpha = 1;
    return o.cv;
  }

  function makeArch() {
    var o = makeCanvas(900, 340), c = o.ctx;
    // 立柱
    c.fillStyle = '#120733'; c.fillRect(30, 96, 46, 244); c.fillRect(824, 96, 46, 244);
    c.save(); c.shadowColor = '#ff2d95'; c.shadowBlur = 24;
    c.strokeStyle = '#ff2d95'; c.lineWidth = 5;
    c.strokeRect(30, 96, 46, 244); c.strokeRect(824, 96, 46, 244);
    c.restore();
    // 横梁
    c.fillStyle = '#0d0428'; c.fillRect(20, 26, 860, 86);
    c.save(); c.shadowColor = '#28e7ff'; c.shadowBlur = 26;
    c.strokeStyle = '#28e7ff'; c.lineWidth = 5; c.strokeRect(20, 26, 860, 86);
    c.fillStyle = '#ffffff'; c.font = 'italic bold 54px "Arial Black", Impact, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('NEON DRIFT', 450, 70);
    c.restore();
    // 霓虹斜纹
    c.save(); c.beginPath(); c.rect(20, 26, 860, 86); c.clip();
    for (var i = -100; i < 960; i += 34) {
      c.fillStyle = i % 68 === 0 ? 'rgba(255,45,149,.32)' : 'rgba(40,231,255,.16)';
      c.beginPath(); c.moveTo(i, 26); c.lineTo(i + 18, 26); c.lineTo(i - 18, 112); c.lineTo(i - 36, 112); c.closePath(); c.fill();
    }
    c.restore();
    c.fillStyle = '#ff2d95'; c.fillRect(76, 120, 8, 220); c.fillRect(816, 120, 8, 220);
    return o.cv;
  }

  function makeNote() {
    var o = makeCanvas(140, 160), c = o.ctx;
    c.save(); c.shadowColor = '#28e7ff'; c.shadowBlur = 26;
    var g = c.createRadialGradient(70, 78, 4, 70, 78, 64);
    g.addColorStop(0, 'rgba(210,255,255,.85)'); g.addColorStop(.4, 'rgba(40,231,255,.30)'); g.addColorStop(1, 'rgba(40,231,255,0)');
    c.fillStyle = g; c.beginPath(); c.arc(70, 78, 64, 0, 6.283); c.fill();
    c.strokeStyle = '#eaffff'; c.lineWidth = 9; c.lineJoin = 'round'; c.lineCap = 'round';
    c.beginPath(); c.moveTo(54, 112); c.lineTo(54, 48); c.lineTo(102, 36); c.lineTo(102, 96); c.stroke();
    c.fillStyle = '#ffffff';
    c.beginPath(); c.ellipse(42, 114, 16, 11, -0.4, 0, 6.283); c.fill();
    c.beginPath(); c.ellipse(90, 98, 16, 11, -0.4, 0, 6.283); c.fill();
    c.restore();
    return o.cv;
  }

  /* ---------------- 车辆绘制（后视） ---------------- */
  function paintCar(c, x, y, w, h, color, opts) {
    opts = opts || {};
    c.save(); c.translate(x, y);
    var W = w, H = h;
    // 地面阴影 / 车底霓虹
    c.save(); c.globalAlpha = .55;
    var ug = c.createRadialGradient(W / 2, H * .94, 2, W / 2, H * .94, W * .55);
    ug.addColorStop(0, opts.boost ? 'rgba(255,45,149,.9)' : 'rgba(40,231,255,.75)');
    ug.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = ug; c.beginPath(); c.ellipse(W / 2, H * .94, W * .55, H * .16, 0, 0, 6.283); c.fill(); c.restore();

    // 轮胎
    c.fillStyle = '#090313';
    c.fillRect(W * .04, H * .60, W * .17, H * .38);
    c.fillRect(W * .79, H * .60, W * .17, H * .38);
    c.fillStyle = 'rgba(40,231,255,.35)';
    c.fillRect(W * .04, H * .60, W * .17, 2); c.fillRect(W * .79, H * .60, W * .17, 2);

    // 尾翼
    c.fillStyle = '#160a34'; c.fillRect(W * .10, H * .30, W * .80, H * .075);
    c.fillStyle = '#ff2d95'; c.globalAlpha = .8; c.fillRect(W * .10, H * .30, W * .80, 2); c.globalAlpha = 1;
    c.fillStyle = '#0d0526'; c.fillRect(W * .16, H * .36, W * .05, H * .10); c.fillRect(W * .79, H * .36, W * .05, H * .10);

    // 车身主形
    var body = c.createLinearGradient(0, H * .34, 0, H * .94);
    body.addColorStop(0, '#ffffff'); body.addColorStop(.14, color);
    body.addColorStop(.62, '#2a0b4a'); body.addColorStop(1, '#120526');
    c.fillStyle = body;
    c.beginPath();
    c.moveTo(W * .16, H * .38); c.lineTo(W * .84, H * .38);
    c.lineTo(W * .96, H * .62); c.lineTo(W * .98, H * .88);
    c.lineTo(W * .88, H * .96); c.lineTo(W * .12, H * .96);
    c.lineTo(W * .02, H * .88); c.lineTo(W * .04, H * .62);
    c.closePath(); c.fill();
    c.strokeStyle = color; c.lineWidth = 2; c.globalAlpha = .75; c.stroke(); c.globalAlpha = 1;

    // 后窗
    c.fillStyle = '#080320';
    c.beginPath(); c.moveTo(W * .25, H * .40); c.lineTo(W * .75, H * .40);
    c.lineTo(W * .70, H * .62); c.lineTo(W * .30, H * .62); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(40,231,255,.55)'; c.lineWidth = 1.5; c.stroke();
    c.fillStyle = 'rgba(255,45,149,.22)';
    c.beginPath(); c.moveTo(W * .28, H * .41); c.lineTo(W * .48, H * .41); c.lineTo(W * .36, H * .60); c.lineTo(W * .30, H * .60); c.closePath(); c.fill();

    // 尾灯
    var tl = opts.brake ? '#fff0f0' : '#ff3355';
    c.save(); c.shadowColor = '#ff2d4f'; c.shadowBlur = opts.brake ? 26 : 15;
    c.fillStyle = tl;
    c.fillRect(W * .10, H * .70, W * .30, H * .075);
    c.fillRect(W * .60, H * .70, W * .30, H * .075);
    c.restore();
    c.fillStyle = 'rgba(255,255,255,.7)';
    c.fillRect(W * .13, H * .71, W * .24, 2); c.fillRect(W * .63, H * .71, W * .24, 2);

    // 保险杠 / 车牌
    c.fillStyle = '#0b0322'; c.fillRect(W * .22, H * .84, W * .56, H * .10);
    c.fillStyle = '#ffd166'; c.font = 'bold ' + Math.max(8, H * .09) + 'px "Courier New",monospace';
    c.textAlign = 'center'; c.fillText(opts.player ? '86' : 'SY', W / 2, H * .915);

    // 排气火焰
    if (opts.boost) {
      c.save(); c.globalCompositeOperation = 'lighter';
      for (var i = 0; i < 2; i++) {
        var fx = W * (i ? .68 : .28), fl = H * (.22 + Math.random() * .30);
        var fg = c.createLinearGradient(fx, H * .95, fx, H * .95 + fl);
        fg.addColorStop(0, 'rgba(255,255,255,.95)'); fg.addColorStop(.35, 'rgba(40,231,255,.8)');
        fg.addColorStop(1, 'rgba(255,45,149,0)');
        c.fillStyle = fg; c.beginPath(); c.moveTo(fx - W * .045, H * .95);
        c.lineTo(fx + W * .045, H * .95); c.lineTo(fx, H * .95 + fl); c.closePath(); c.fill();
      }
      c.restore();
    }
    c.restore();
  }

  function carSprite(color) {
    if (!CACHE.cars[color]) {
      var o = makeCanvas(220, 140);
      paintCar(o.ctx, 0, 0, 220, 140, color, { player: false });
      CACHE.cars[color] = o.cv;
    }
    return CACHE.cars[color];
  }

  /* ---------------- 赛道装饰（由 game.js 调用） ---------------- */
  function decorateTrack(segments) {
    var n = segments.length, i, rnd = seeded(424242);
    for (i = 0; i < n; i++) {
      var s = segments[i];
      s.sprites = [];
      s.boost = false;
      s.finish = (i === 0);
      if (i % 11 === 2) {
        s.sprites.push({ kind: 'palm', offset: -1.30 - rnd() * .22, worldW: 520, scale: 1 + rnd() * .35 });
        s.sprites.push({ kind: 'palm', offset: 1.30 + rnd() * .22, worldW: 520, scale: 1 + rnd() * .35 });
      }
      if (i % 26 === 8) {
        s.sprites.push({ kind: 'lamp', offset: (i % 52 === 8) ? -1.13 : 1.13, worldW: 330 });
      }
      if (i % 97 === 40 || i % 97 === 70) {
        var word = CACHE.billboardWords[(i / 97 | 0) % CACHE.billboardWords.length];
        s.sprites.push({
          kind: 'billboard', word: word,
          offset: (i % 97 === 40) ? -1.52 : 1.52, worldW: 1500
        });
      }
      if (i % 200 === 0) {
        s.sprites.push({ kind: 'arch', offset: 0, worldW: CFG.roadWidth * 2.85 });
      }
      // 直路上的加速带
      if (i > 60 && Math.abs(s.curve) < 0.9 && i % 173 >= 0 && i % 173 < 7) s.boost = true;
    }
  }

  /* ---------------- 投影 ---------------- */
  function project(p, cameraX, cameraY, cameraZ, W, H, roadWidth) {
    p.camera.x = (p.world.x || 0) - cameraX;
    p.camera.y = (p.world.y || 0) - cameraY;
    p.camera.z = (p.world.z || 0) - cameraZ;
    var z = Math.max(p.camera.z, 1);
    var scale = CFG.cameraDepth / z;
    p.screen.scale = scale;
    p.screen.x = W / 2 + scale * p.camera.x * W / 2;
    p.screen.y = H * HORIZON - scale * p.camera.y * H / 2;
    p.screen.w = scale * roadWidth * W / 2;
  }

  /* ---------------- 天空 / 落日 ---------------- */
  function drawSky(ctx, W, H, p, day, g, time) {
    var hy = H * HORIZON;
    var sky = ctx.createLinearGradient(0, 0, 0, hy + 10);
    sky.addColorStop(0, css(p.skyTop)); sky.addColorStop(.55, css(p.skyMid)); sky.addColorStop(1, css(p.skyLow));
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, hy + 12);

    // 星星
    var starA = clamp(1 - day, 0, 1);
    if (starA > 0.02) {
      ctx.save();
      for (var i = 0; i < CACHE.stars.length; i++) {
        var s = CACHE.stars[i], tw = .55 + .45 * Math.sin(time * s.s * 2 + s.p);
        ctx.fillStyle = 'rgba(226,240,255,' + (starA * tw * .9) + ')';
        ctx.fillRect(s.x * W, s.y * hy, s.r, s.r);
      }
      // 几颗大星带十字光芒
      ctx.globalCompositeOperation = 'lighter';
      for (var j = 0; j < 7; j++) {
        var bx = ((j * 0.173 + .07) % 1) * W, by = ((j * 0.311 + .05) % .7) * hy;
        ctx.strokeStyle = 'rgba(180,230,255,' + (starA * .5) + ')'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(bx - 6, by); ctx.lineTo(bx + 6, by);
        ctx.moveTo(bx, by - 6); ctx.lineTo(bx, by + 6); ctx.stroke();
      }
      ctx.restore();
    }

    // 远山剪影（先于落日绘制，太阳遮住中央山峰，左右两侧露出山脊）
    drawMountains(ctx, W, H, p, day, g);

    // 条纹落日
    var cx = W * .5 - g.parallax * .55, cy = hy - H * .055 - H * .205 * day + H * .13 * (1 - day);
    var R = Math.min(W * .20, H * .30);
    ctx.save();
    // 光晕
    var halo = ctx.createRadialGradient(cx, cy, R * .2, cx, cy, R * 2.4);
    halo.addColorStop(0, css(p.sunBot, .30 * (.35 + .65 * day)));
    halo.addColorStop(1, css(p.sunBot, 0));
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 2.4, 0, 6.283); ctx.fill();
    // 日盘
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.clip();
    var sg = ctx.createLinearGradient(0, cy - R, 0, cy + R);
    sg.addColorStop(0, css(p.sunTop)); sg.addColorStop(.48, css(p.sunMid)); sg.addColorStop(1, css(p.sunBot));
    ctx.fillStyle = sg; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    // 横向条纹：越往下越粗
    var y = cy + R * .06, gap = 3, th = 2;
    while (y < cy + R) {
      ctx.fillStyle = css(p.skyMid, .92);
      ctx.fillRect(cx - R, y, R * 2, th);
      y += th + gap; gap += .75; th += .55;
    }
    ctx.restore();
    // 霓虹轮廓
    ctx.strokeStyle = css(p.sunBot, .65); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.stroke();
    ctx.restore();
    S.sun = { x: cx, y: cy, r: R };
  }

  function drawMountains(ctx, W, H, p, day, g) {
    var hy = H * HORIZON;
    var mh = H * .29;
    var mx = -(((g.parallax + g.position * .0016) * .22) % 2400);
    ctx.save();
    ctx.globalAlpha = .78 + .22 * (1 - day);
    for (var x = mx; x < W; x += 2400) ctx.drawImage(CACHE.mountain, x, hy - mh + 6, 2400, mh);
    ctx.restore();
    // 山脚与天际线之间的薄雾
    ctx.fillStyle = css(p.mountain, .22);
    ctx.fillRect(0, hy - H * .10, W, H * .10);
  }

  function drawHorizonLayers(ctx, W, H, p, day, g) {
    var hy = H * HORIZON;
    var shift = g.parallax + g.position * .0016;
    // 三层城市（视差速度不同）
    var speeds = [.35, .62, 1.05], heights = [H * .105, H * .155, H * .215];
    var tints = [p.cityBack, p.cityMid, p.cityFront];
    for (var k = 0; k < 3; k++) {
      var off = -((shift * speeds[k]) % 2400);
      ctx.save();
      ctx.globalAlpha = .92 + .08 * (1 - day);
      for (var xx = off; xx < W; xx += 2400) {
        ctx.drawImage(CACHE.city[k], xx, hy - heights[k], 2400, heights[k]);
      }
      ctx.restore();
      // 层间霓虹地平线
      ctx.fillStyle = css(tints[k], .5);
      ctx.fillRect(0, hy - 1 + k * .5, W, 1);
    }
    // 地平线霓虹光带
    ctx.save(); ctx.shadowColor = '#ff2d95'; ctx.shadowBlur = 24;
    var lg = ctx.createLinearGradient(0, hy - 8, 0, hy + 10);
    lg.addColorStop(0, css(p.grid, 0)); lg.addColorStop(.5, css(p.grid, .55)); lg.addColorStop(1, css(p.grid2, 0));
    ctx.fillStyle = lg; ctx.fillRect(0, hy - 8, W, 18); ctx.restore();
  }

  /* ---------------- 透视霓虹网格地面 ---------------- */
  function drawGrid(ctx, W, H, p, day, g) {
    var hy = H * HORIZON, gh = H - hy;
    ctx.save(); ctx.beginPath(); ctx.rect(0, hy - 1, W, gh + 2); ctx.clip();
    var gg = ctx.createLinearGradient(0, hy, 0, H);
    gg.addColorStop(0, css(p.ground));
    gg.addColorStop(1, css(mix(p.ground, col(0, 0, 0), .55)));
    ctx.fillStyle = gg; ctx.fillRect(0, hy, W, gh);

    var vp = W / 2 - g.parallax * 1.4;
    ctx.globalCompositeOperation = 'lighter';
    // 纵向透视线
    for (var k = -14; k <= 14; k++) {
      ctx.strokeStyle = css(k % 2 ? p.grid2 : p.grid, .10 + .13 * (1 - day));
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(vp, hy);
      ctx.lineTo(vp + k * W * .155, H); ctx.stroke();
    }
    // 横向网格线（随行进滚动）
    var scroll = (g.position / CFG.segmentLength) % 2;
    for (var j = 0; j < 34; j++) {
      var z = (j + scroll) * 380;
      var y = hy + gh * (CFG.playerZ / (CFG.playerZ + z));
      if (y < hy + .5 || y > H) continue;
      var a = (.10 + .30 * (1 - day)) * clamp((y - hy) / gh * 1.6, .12, 1);
      ctx.strokeStyle = css(j % 2 ? p.grid2 : p.grid, a);
      ctx.lineWidth = 1 + (y - hy) / gh * 1.8;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    // 落日在地面的倒影
    if (S.sun) {
      var rg = ctx.createLinearGradient(0, hy, 0, hy + gh * .55);
      rg.addColorStop(0, css(p.sunBot, .28 * (.4 + .6 * day)));
      rg.addColorStop(1, css(p.sunBot, 0));
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.moveTo(S.sun.x - S.sun.r * .75, hy);
      ctx.lineTo(S.sun.x + S.sun.r * .75, hy);
      ctx.lineTo(S.sun.x + S.sun.r * 2.2, H); ctx.lineTo(S.sun.x - S.sun.r * 2.2, H);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------- 路面分段 ---------------- */
  function fogFactor(n) {
    var d = n / CFG.drawDistance;
    return 1 / Math.pow(Math.E, d * d * CFG.fogDensity);
  }

  function renderSegment(ctx, W, H, seg, pal, fog, day) {
    var a = seg.proj.p1.screen, b = seg.proj.p2.screen;
    var x1 = a.x, y1 = a.y, w1 = a.w, x2 = b.x, y2 = b.y, w2 = b.w;
    var light = (Math.floor(seg.index / 3) % 2) === 0;
    var roadCol = css(light ? pal.road1 : pal.road2);
    var rL = light ? '#ff2d95' : '#a8146c', rR = light ? '#28e7ff' : '#137c96';
    var rw1 = Math.max(w1 * .085, 1), rw2 = Math.max(w2 * .085, 1);

    // 左路缘（品红）/ 右路缘（青）
    poly(ctx, rL, [x1 - w1 - rw1, y1, x1 - w1, y1, x2 - w2, y2, x2 - w2 - rw2, y2]);
    poly(ctx, rR, [x1 + w1, y1, x1 + w1 + rw1, y1, x2 + w2 + rw2, y2, x2 + w2, y2]);
    // 沥青
    poly(ctx, roadCol, [x1 - w1, y1, x1 + w1, y1, x2 + w2, y2, x2 - w2, y2]);

    // 发光车道线（虚线 + 外层柔光）
    if (light) {
      for (var i = 1; i < CFG.lanes; i++) {
        var t = i / CFG.lanes;
        var lx1 = x1 - w1 + 2 * w1 * t, lx2 = x2 - w2 + 2 * w2 * t;
        var lw1 = Math.max(w1 * .012, .6), lw2 = Math.max(w2 * .012, .6);
        ctx.globalCompositeOperation = 'lighter';
        poly(ctx, 'rgba(40,231,255,.16)', [lx1 - lw1 * 3, y1, lx1 + lw1 * 3, y1, lx2 + lw2 * 3, y2, lx2 - lw2 * 3, y2]);
        poly(ctx, 'rgba(190,250,255,.92)', [lx1 - lw1, y1, lx1 + lw1, y1, lx2 + lw2, y2, lx2 - lw2, y2]);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    // 路肩霓虹细边
    ctx.globalCompositeOperation = 'lighter';
    poly(ctx, 'rgba(255,45,149,.30)', [x1 - w1, y1, x1 - w1 + Math.max(w1 * .012, .5), y1, x2 - w2 + Math.max(w2 * .012, .5), y2, x2 - w2, y2]);
    poly(ctx, 'rgba(40,231,255,.30)', [x1 + w1 - Math.max(w1 * .012, .5), y1, x1 + w1, y1, x2 + w2, y2, x2 + w2 - Math.max(w2 * .012, .5), y2]);
    ctx.globalCompositeOperation = 'source-over';

    // 加速带
    if (seg.boost && fog > .18) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      var bc = (Math.floor(seg.index / 2) % 2) ? 'rgba(40,231,255,.72)' : 'rgba(255,45,149,.72)';
      for (var k = 0; k < 2; k++) {
        var yy1 = lerp(y1, y2, .18 + k * .42), yy2 = lerp(y1, y2, .40 + k * .42);
        var ww1 = lerp(w1, w2, .18 + k * .42), ww2 = lerp(w1, w2, .40 + k * .42);
        var cc1 = lerp(x1, x2, .18 + k * .42), cc2 = lerp(x1, x2, .40 + k * .42);
        poly(ctx, bc, [cc1 - ww1 * .82, yy1, cc1 + ww1 * .82, yy1,
          cc1 + ww1 * .50, lerp(yy1, yy2, .55), cc2 + ww2 * .10, yy2,
          cc2 - ww2 * .10, yy2, cc1 - ww1 * .50, lerp(yy1, yy2, .55)]);
      }
      ctx.restore();
    }

    // 起终点格纹
    if (seg.finish) {
      var cells = 16;
      for (var q = 0; q < cells; q++) {
        var t1 = q / cells, t2 = (q + 1) / cells;
        poly(ctx, q % 2 ? '#ffffff' : '#170630', [
          x1 - w1 + 2 * w1 * t1, y1, x1 - w1 + 2 * w1 * t2, y1,
          x2 - w2 + 2 * w2 * t2, y2, x2 - w2 + 2 * w2 * t1, y2]);
      }
    }

    // 距离雾
    if (fog < 1) {
      poly(ctx, css(pal.fog, clamp(1 - fog, 0, .96)),
        [x1 - w1 - rw1 * 2, y1, x1 + w1 + rw1 * 2, y1,
          x2 + w2 + rw2 * 2, y2, x2 - w2 - rw2 * 2, y2]);
    }
  }

  /* ---------------- 精灵 / 车辆投影绘制 ---------------- */
  function segFrame(seg, pct, W, H) {
    var p1 = seg.proj.p1.screen, p2 = seg.proj.p2.screen;
    var scale = lerp(p1.scale, p2.scale, pct);
    return {
      cx: lerp(p1.x, p2.x, pct),
      cy: lerp(p1.y, p2.y, pct),
      w: lerp(p1.w, p2.w, pct),
      scale: scale
    };
  }

  function drawSprite(ctx, img, f, offset, worldW, W, H, clip, alpha, bob) {
    var sw = f.scale * worldW * W / 2;
    if (sw < .8 || sw > W * 12) return;
    var sh = sw * (img.height / img.width);
    var x = f.cx + offset * f.w - sw / 2;
    var y = f.cy - sh + (bob || 0);
    if (y > H + 100 || y + sh < -100) return;
    ctx.save();
    if (clip < H) { ctx.beginPath(); ctx.rect(0, 0, W, clip); ctx.clip(); }
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    ctx.drawImage(img, x, y, sw, sh);
    ctx.restore();
  }

  function drawTraffic(ctx, car, f, W, H, clip, day, time) {
    var sw = f.scale * 620 * W / 2;
    if (sw < 1.2 || sw > W * 4) return;
    var sh = sw * (140 / 220);
    var x = f.cx + car.offset * f.w - sw / 2;
    var y = f.cy - sh;
    ctx.save();
    if (clip < H) { ctx.beginPath(); ctx.rect(0, 0, W, clip); ctx.clip(); }
    // 车底辉光
    ctx.globalCompositeOperation = 'lighter';
    var ug = ctx.createRadialGradient(x + sw / 2, y + sh * .92, 1, x + sw / 2, y + sh * .92, sw * .5);
    ug.addColorStop(0, 'rgba(255,45,149,.35)'); ug.addColorStop(1, 'rgba(255,45,149,0)');
    ctx.fillStyle = ug; ctx.fillRect(x - sw * .2, y + sh * .5, sw * 1.4, sh * .7);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(carSprite(car.color), x, y, sw, sh);
    ctx.restore();
  }

  function drawNote(ctx, note, f, W, H, clip, time) {
    var sw = f.scale * 300 * W / 2;
    if (sw < 1 || sw > W * 3) return;
    var sh = sw * (160 / 140);
    var bob = Math.sin(time * 4 + note.seed) * sw * .12;
    var x = f.cx + note.offset * f.w - sw / 2;
    var y = f.cy - sh * .95 + bob;
    ctx.save();
    if (clip < H) { ctx.beginPath(); ctx.rect(0, 0, W, clip); ctx.clip(); }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = .75 + .25 * Math.sin(time * 6 + note.seed);
    ctx.drawImage(CACHE.sprites.note, x, y, sw, sh);
    ctx.restore();
  }

  /* ---------------- 玩家车与屏幕特效 ---------------- */
  function drawPlayer(ctx, W, H, g, time) {
    var cw = Math.min(W * .19, H * .34), ch = cw * (140 / 220);
    var steer = clamp(g.steerVisual, -1, 1);
    var px = W / 2 + steer * W * .012 - cw / 2;
    var py = H * .895 - ch + Math.sin(time * 13) * (1 + g.speedRatio * 2);
    ctx.save();
    // 漂移倾斜
    var skew = clamp(g.driftVisual * .26, -.28, .28);
    ctx.transform(1, 0, skew, 1, -skew * (py + ch / 2), 0);
    ctx.translate(px + cw / 2, py); ctx.rotate(steer * .035 + skew * .10); ctx.translate(-cw / 2, 0);
    paintCar(ctx, 0, 0, cw, ch, '#ff2d95', {
      player: true, boost: g.nitroActive, brake: g.braking
    });
    ctx.restore();
    S.carBox = { x: px, y: py, w: cw, h: ch };
  }

  function drawSpeedLines(ctx, W, H, g, time) {
    if (g.speedRatio < .55 && !g.nitroActive) return;
    var power = clamp((g.speedRatio - .5) * 1.6, 0, 1) + (g.nitroActive ? .6 : 0);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    var n = 24 + (power * 30 | 0);
    for (var i = 0; i < n; i++) {
      var seed = (i * 127.1 + Math.floor(time * 22) * .017);
      var a = (seed * 43758.5453) % 1;
      var ang = ((i * 2.399) % 6.283);
      var r = W * (.12 + a * .48);
      var cx = W / 2 + Math.cos(ang) * r, cy = H * .56 + Math.sin(ang) * r * .55;
      var len = 18 + a * 70 * power;
      ctx.strokeStyle = i % 3 === 0 ? 'rgba(255,45,149,' + (.10 + power * .22) + ')' : 'rgba(40,231,255,' + (.08 + power * .18) + ')';
      ctx.lineWidth = 1 + a * 1.6;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len * .55); ctx.stroke();
    }
    // 氮气染色
    if (g.nitroActive) {
      var vg = ctx.createRadialGradient(W / 2, H * .55, H * .18, W / 2, H * .55, H * .85);
      vg.addColorStop(0, 'rgba(255,45,149,0)'); vg.addColorStop(1, 'rgba(255,45,149,.20)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  function drawParticles(ctx, W, H, g) {
    if (!g.particles.length) return;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < g.particles.length; i++) {
      var p = g.particles[i], a = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.color.replace('ALPHA', (a * .9).toFixed(3));
      ctx.beginPath(); ctx.arc(p.x * W, p.y * H, p.r * (0.4 + a * .6), 0, 6.283); ctx.fill();
    }
    ctx.restore();
  }

  /* ---------------- 主渲染 ---------------- */
  function render(g, time) {
    var ctx = S.ctx, W = S.w, H = S.h;
    if (!ctx || W < 2 || H < 2) return;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    var day = clamp(g.dayFactor, 0, 1);
    var pal = palette(day);

    drawSky(ctx, W, H, pal, day, g, time);
    drawHorizonLayers(ctx, W, H, pal, day, g);
    drawGrid(ctx, W, H, pal, day, g);

    var segments = g.segments, N = segments.length, L = CFG.segmentLength;
    var position = g.position;
    var baseIndex = Math.floor(position / L) % N;
    var baseSeg = segments[baseIndex];
    var basePercent = (position % L) / L;
    var playerAbs = position + CFG.playerZ;
    var playerSeg = segments[Math.floor(playerAbs / L) % N];
    var playerPercent = (playerAbs % L) / L;
    var cameraY = CFG.cameraHeight + lerp(playerSeg.p1.world.y, playerSeg.p2.world.y, playerPercent);

    var x = 0, dx = -(baseSeg.curve * basePercent), maxy = H;
    var rendered = [];
    for (var n = 0; n < CFG.drawDistance; n++) {
      var idx = (baseIndex + n) % N;
      var seg = segments[idx];
      seg.looped = idx < baseIndex;
      seg.fog = fogFactor(n);
      seg.clip = maxy;
      var camZ = position - (seg.looped ? CFG.trackLength : 0);
      project(seg.p1, (g.playerX * CFG.roadWidth) - x, cameraY, camZ, W, H, CFG.roadWidth);
      project(seg.p2, (g.playerX * CFG.roadWidth) - x - dx, cameraY, camZ, W, H, CFG.roadWidth);
      seg.proj = { p1: seg.p1, p2: seg.p2, n: n };
      x += dx; dx += seg.curve;
      var a = seg.p1.screen, b = seg.p2.screen;
      if (seg.p1.camera.z <= CFG.cameraDepth || b.y >= a.y || b.y >= maxy) continue;
      renderSegment(ctx, W, H, seg, pal, seg.fog, day);
      maxy = b.y;
      rendered.push(seg);
    }

    // 车流 / 音符按远近分桶
    var buckets = {}, i, k;
    function bucketFor(absZ) {
      var rel = ((absZ - position) % CFG.trackLength + CFG.trackLength) % CFG.trackLength;
      if (rel > CFG.drawDistance * L) return -1;
      var idx2 = Math.floor((position + rel) / L) % N;
      var nn = (idx2 - baseIndex + N) % N;
      if (nn < 0 || nn >= CFG.drawDistance) return -1;
      return nn;
    }
    for (i = 0; i < g.traffic.length; i++) {
      var car = g.traffic[i], bn = bucketFor(car.z);
      if (bn < 0) continue;
      (buckets[bn] || (buckets[bn] = { cars: [], notes: [] })).cars.push({
        car: car, pct: (((car.z % L) + L) % L) / L
      });
    }
    for (i = 0; i < g.notes.length; i++) {
      var note = g.notes[i];
      if (note.dead) continue;
      var nn2 = bucketFor(note.z);
      if (nn2 < 0) continue;
      (buckets[nn2] || (buckets[nn2] = { cars: [], notes: [] })).notes.push({
        note: note, pct: (((note.z % L) + L) % L) / L
      });
    }

    // 由远及近绘制精灵与车流
    for (var m = CFG.drawDistance - 1; m >= 0; m--) {
      var sg = segments[(baseIndex + m) % N];
      if (!sg.proj || sg.proj.n !== m) continue;
      var f = segFrame(sg, 0, W, H);
      var clip = sg.clip;
      var has = (buckets[m] && (buckets[m].cars.length || buckets[m].notes.length));
      if (!sg.sprites.length && !has) continue;

      for (k = 0; k < sg.sprites.length; k++) {
        var sp = sg.sprites[k], img = null;
        if (sp.kind === 'palm') img = CACHE.sprites.palm;
        else if (sp.kind === 'lamp') img = CACHE.sprites.lamp;
        else if (sp.kind === 'billboard') img = CACHE.sprites.billboard[sp.word];
        else if (sp.kind === 'arch') img = CACHE.sprites.arch;
        if (!img) continue;
        var ww = sp.worldW * (sp.scale || 1);
        drawSprite(ctx, img, f, sp.offset, ww, W, H, clip, .55 + .45 * sg.fog);
      }
      if (buckets[m]) {
        for (k = 0; k < buckets[m].notes.length; k++) {
          drawNote(ctx, buckets[m].notes[k].note, segFrame(sg, buckets[m].notes[k].pct, W, H), W, H, clip, time);
        }
        for (k = 0; k < buckets[m].cars.length; k++) {
          drawTraffic(ctx, buckets[m].cars[k].car, segFrame(sg, buckets[m].cars[k].pct, W, H), W, H, clip, day, time);
        }
      }
    }

    drawSpeedLines(ctx, W, H, g, time);
    drawPlayer(ctx, W, H, g, time);
    drawParticles(ctx, W, H, g);
  }

  /* ---------------- 对外接口 ---------------- */
  function init(canvas) {
    S.canvas = canvas; S.ctx = canvas.getContext('2d', { alpha: false });
    buildCaches();
    return S.ctx;
  }
  function resize(w, h, dpr) {
    S.w = w; S.h = h; S.dpr = Math.min(dpr || 1, 2);
    S.canvas.width = Math.round(w * S.dpr);
    S.canvas.height = Math.round(h * S.dpr);
    S.canvas.style.width = w + 'px'; S.canvas.style.height = h + 'px';
  }

  global.SCENE = {
    CFG: CFG, init: init, resize: resize, render: render,
    decorateTrack: decorateTrack, carSprite: carSprite
  };
})(window);
