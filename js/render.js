/* render.js — canvas wallpaper renderer. Shared by the browser app AND the
 * Node desktop companion (loaded there verbatim). No DOM access at module
 * scope; every drawing takes an explicit 2D context. Exposes `Render`.
 *
 * v3:
 *  - date/clock header REMOVED (cleaner, calmer wallpaper).
 *  - anchors (靠上/居中/靠下) now move the block across the FULL free height.
 *  - custom title/footer are free-floating blocks (positionable), not pinned.
 *  - fontStyle (system font families) + inkOverride (text color) support.
 *  - background can be a custom photo (bgImage) with a soft legibility scrim.
 */
(function (global) {
  'use strict';

  var FONT_STACKS = {
    hei:    '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",-apple-system,Segoe UI,Arial,sans-serif',
    song:   '"Songti SC","STSong","SimSun","Noto Serif CJK SC","Source Han Serif SC",serif',
    kai:    '"Kaiti SC","STKaiti","KaiTi","楷体",cursive',
    yuan:   '"Yuanti SC","YouYuan","幼圆","PingFang SC","Microsoft YaHei",sans-serif',
    heiti:  '"Heiti SC","STHeiti","SimHei","黑体","PingFang SC",sans-serif',
  };
  function fontStack(settings) {
    var key = (settings && settings.fontStyle) || 'hei';
    return FONT_STACKS[key] || FONT_STACKS.hei;
  }

  /* ---------- text helpers ---------- */
  function wrap(ctx, text, maxWidth) {
    var words = String(text || '').split(/\s+/).filter(Boolean);
    var lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  function wrapMixed(ctx, text, maxWidth) {
    var s = String(text || '');
    if (!/\s/.test(s) && /[一-鿿]/.test(s)) {
      var lines = [], line = '';
      for (var i = 0; i < s.length; i++) {
        var test = line + s[i];
        if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = s[i]; }
        else line = test;
      }
      if (line) lines.push(line);
      return lines;
    }
    return wrap(ctx, s, maxWidth);
  }

  /* ---------- colors ---------- */
  // Resolve the main text ink. settings.inkOverride wins over theme.ink.
  function ink(theme, settings) { return (settings && settings.inkOverride) || theme.ink; }
  function subInk(theme, settings) {
    // secondary text stays a softened version of the ink
    if (settings && settings.inkOverride) return settings.inkOverride;
    return theme.sub;
  }

  /* ---------- background: photo OR gradient+pattern ---------- */
  function drawBackground(ctx, W, H, theme, settings) {
    if (settings && settings.bgImage) {
      var img = settings.bgImage;
      // A selected file can still be decoding (or be an unsupported image). Do
      // not paint the light scrim until there is a drawable bitmap, otherwise a
      // failed drawImage leaves the wallpaper looking like a blank white page.
      var iw = Number(img.naturalWidth || img.width) || 0;
      var ih = Number(img.naturalHeight || img.height) || 0;
      if (iw > 0 && ih > 0) {
      // cover-fit
      var ir = iw / ih, cr = W / H;
      var dw, dh, dx, dy;
      if (ir > cr) { dh = H; dw = Math.round(H * ir); dx = Math.round((W - dw) / 2); dy = 0; }
      else { dw = W; dh = Math.round(W / ir); dx = 0; dy = Math.round((H - dh) / 2); }
      // Add a restrained safety zoom after cover-fit. Without it, a photo whose
      // aspect ratio matches the wallpaper has zero crop overflow on one axis,
      // which makes horizontal or vertical dragging appear to be broken.
      var zoom = Math.max(1, Math.min(1.45, Number(settings.bgImageZoom) || 1.14));
      dw = Math.round(dw * zoom); dh = Math.round(dh * zoom);
      dx = Math.round((W - dw) / 2); dy = Math.round((H - dh) / 2);
      // Move only inside the covered/cropped overflow. x/y remain stable across
      // different wallpaper sizes because they are stored as normalized offsets.
      var pos = settings.bgImagePos || {};
      var extraX = Math.max(0, dw - W), extraY = Math.max(0, dh - H);
      dx += Math.round(Math.max(-1, Math.min(1, Number(pos.x) || 0)) * extraX / 2);
      dy += Math.round(Math.max(-1, Math.min(1, Number(pos.y) || 0)) * extraY / 2);
      var drawn = true;
      try { ctx.drawImage(img, dx, dy, dw, dh); } catch (e) { drawn = false; }
      if (drawn) {
        // Keep the image visible; older saved settings used a much whiter 0.42
        // overlay, so cap it to a light wash on every render.
        var scrim = Math.max(0, Math.min(0.24, settings.bgScrim == null ? 0.22 : settings.bgScrim));
        ctx.fillStyle = 'rgba(255,252,247,' + scrim + ')';
        ctx.fillRect(0, 0, W, H);
        return;
      }
      }
    }
    if (theme && theme.liquid) {
      drawLiquidBackground(ctx, W, H, theme, settings);
      return;
    }

    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, theme.bg);
    g.addColorStop(1, theme.bg2 || theme.bg);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    var pattern = (settings && settings.bgPattern) || 'soft';
    if (pattern === 'none') { drawCartoon(ctx, W, H, theme); return; }
    ctx.save();
    if (pattern === 'soft' || pattern === 'blobs') drawBlobs(ctx, W, H, theme, pattern === 'blobs' ? 3 : 1);
    if (pattern === 'dots') drawDots(ctx, W, H, theme);
    if (pattern === 'grid') drawGrid(ctx, W, H, theme);
    if (pattern === 'diag') drawDiag(ctx, W, H, theme);
    if (pattern === 'waves') drawWaves(ctx, W, H, theme);
    ctx.restore();
    drawCartoon(ctx, W, H, theme);
  }

  /* Liquid Glass wallpaper material. This is not a flat blue gradient: several
   * broad light fields are composited beneath a pair of soft caustic bands so
   * the exported PNG keeps the same refractive, pearl-like depth as the UI. */
  function drawLiquidBackground(ctx, W, H, theme, settings) {
    // 尊重 theme 的 bg/bg2：珍珠白等中性配色渲染纯白，蓝色「玻璃」保持原浅蓝灰。
    var neutral = theme.bg === '#ffffff' || theme.name === '珍珠';
    var base = ctx.createLinearGradient(0, 0, W, H);
    if (neutral) {
      base.addColorStop(0, theme.bg || '#ffffff');
      base.addColorStop(.55, '#fbfbfd');
      base.addColorStop(1, theme.bg2 || '#f1f1f4');
    } else {
      base.addColorStop(0, '#fbfdff');
      base.addColorStop(.34, '#eef5fa');
      base.addColorStop(.72, '#dfeaf2');
      base.addColorStop(1, '#d5e1ea');
    }
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    var fields = neutral ? [
      [W * .12, H * .05, Math.max(W, H) * .58, 'rgba(255,255,255,.96)'],
      [W * .91, H * .12, Math.max(W, H) * .44, 'rgba(228,228,234,.42)'],
      [W * .18, H * .94, Math.max(W, H) * .46, 'rgba(232,232,238,.34)'],
      [W * .82, H * .86, Math.max(W, H) * .38, 'rgba(224,224,230,.30)'],
    ] : [
      [W * .12, H * .05, Math.max(W, H) * .58, 'rgba(255,255,255,.96)'],
      [W * .91, H * .12, Math.max(W, H) * .44, 'rgba(183,219,239,.42)'],
      [W * .18, H * .94, Math.max(W, H) * .46, 'rgba(218,226,245,.34)'],
      [W * .82, H * .86, Math.max(W, H) * .38, 'rgba(211,233,237,.30)'],
    ];
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    fields.forEach(function (field) {
      var glow = ctx.createRadialGradient(field[0], field[1], 0, field[0], field[1], field[2]);
      glow.addColorStop(0, field[3]);
      glow.addColorStop(.48, field[3].replace(/\.[0-9]+\)$/, '.16)'));
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
    });

    // Wide specular bands mimic light bending through a continuous sheet.
    var band = ctx.createLinearGradient(0, 0, W, H);
    band.addColorStop(0, 'rgba(255,255,255,0)');
    band.addColorStop(.38, 'rgba(255,255,255,.44)');
    band.addColorStop(.55, neutral ? 'rgba(232,232,238,.24)' : 'rgba(190,223,240,.24)');
    band.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = band;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(18, Math.min(W, H) * .045);
    ctx.shadowColor = 'rgba(255,255,255,.52)';
    ctx.shadowBlur = px(ctx, Math.max(16, Math.min(W, H) * .025));
    ctx.beginPath();
    ctx.moveTo(-W * .08, H * .22);
    ctx.bezierCurveTo(W * .24, H * .06, W * .61, H * .34, W * 1.08, H * .12);
    ctx.stroke();
    ctx.globalAlpha = .62;
    ctx.lineWidth *= .62;
    ctx.beginPath();
    ctx.moveTo(-W * .06, H * .88);
    ctx.bezierCurveTo(W * .30, H * .70, W * .72, H * 1.02, W * 1.06, H * .76);
    ctx.stroke();
    ctx.restore();

    // A translucent inner rim gives the whole wallpaper a sheet-of-glass edge.
    ctx.save();
    var edge = Math.max(3, Math.round(Math.min(W, H) * .003));
    var inset = edge * 2;
    var rim = ctx.createLinearGradient(0, 0, W, H);
    rim.addColorStop(0, 'rgba(255,255,255,.88)');
    rim.addColorStop(.34, 'rgba(255,255,255,.20)');
    rim.addColorStop(.72, neutral ? 'rgba(150,150,160,.16)' : 'rgba(135,174,202,.16)');
    rim.addColorStop(1, 'rgba(255,255,255,.62)');
    ctx.strokeStyle = rim;
    ctx.lineWidth = edge;
    rr(ctx, inset, inset, W - inset * 2, H - inset * 2, Math.max(18, Math.min(W, H) * .024));
    ctx.stroke();
    ctx.restore();

    // Explicit pattern choices remain available, but Liquid starts on `none`.
    var pattern = (settings && settings.bgPattern) || 'none';
    if (pattern === 'soft' || pattern === 'blobs') drawBlobs(ctx, W, H, theme, pattern === 'blobs' ? 3 : 1);
    if (pattern === 'dots') drawDots(ctx, W, H, theme);
    if (pattern === 'grid') drawGrid(ctx, W, H, theme);
    if (pattern === 'diag') drawDiag(ctx, W, H, theme);
    if (pattern === 'waves') drawWaves(ctx, W, H, theme);
  }
  function drawBlobs(ctx, W, H, theme, count) {
    var spots = [[0.85, 0.12, 0.6], [0.1, 0.85, 0.5], [0.5, 0.5, 0.7]];
    for (var i = 0; i < count && i < spots.length; i++) {
      var s = spots[i];
      ctx.globalAlpha = 0.5;
      var rg = ctx.createRadialGradient(W * s[0], H * s[1], 0, W * s[0], H * s[1], W * s[2]);
      rg.addColorStop(0, theme.accentSoft || theme.accent);
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;
  }
  function drawDots(ctx, W, H, theme) {
    ctx.fillStyle = theme.patternInk || theme.sub;
    ctx.globalAlpha = 0.10;
    var step = Math.round(W * 0.05);
    var r = Math.max(1.5, W * 0.0035);
    for (var y = step; y < H; y += step)
      for (var x = step; x < W; x += step) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    ctx.globalAlpha = 1;
  }
  function drawGrid(ctx, W, H, theme) {
    ctx.strokeStyle = theme.patternInk || theme.sub;
    ctx.globalAlpha = 0.08;
    ctx.lineWidth = 1;
    var step = Math.round(W * 0.055);
    for (var x = step; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (var y = step; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  function drawDiag(ctx, W, H, theme) {
    ctx.strokeStyle = theme.patternInk || theme.sub;
    ctx.globalAlpha = 0.06;
    ctx.lineWidth = Math.max(1, W * 0.0012);
    var step = Math.round(W * 0.045);
    for (var o = -H; o < W; o += step) {
      ctx.beginPath(); ctx.moveTo(o, 0); ctx.lineTo(o + H, H); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function drawWaves(ctx, W, H, theme) {
    ctx.strokeStyle = theme.patternInk || theme.sub;
    ctx.globalAlpha = 0.10;
    ctx.lineWidth = Math.max(1.5, W * 0.0015);
    var rows = 5, amp = W * 0.02, wl = W * 0.35;
    for (var r = 0; r < rows; r++) {
      var baseY = H * (0.18 + r * 0.16);
      ctx.beginPath();
      for (var x = 0; x <= W; x += 8) {
        var y = baseY + Math.sin((x / wl) * Math.PI * 2 + r) * amp;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- cartoon helpers ---------- */
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function star(ctx, cx, cy, spikes, outer, inner) {
    var rot = -Math.PI / 2, step = Math.PI / spikes;
    ctx.beginPath();
    ctx.moveTo(cx, cy - outer);
    for (var i = 0; i < spikes; i++) {
      ctx.lineTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer); rot += step;
      ctx.lineTo(cx + Math.cos(rot) * inner, cy + Math.sin(rot) * inner); rot += step;
    }
    ctx.closePath();
  }
  /* 卡通点缀：角落/边缘的小星星 + 圆点，克制不抢单词。仅作用于主题背景（无照片时）。 */
  function drawCartoon(ctx, W, H, theme) {
    // Refined palettes (Liquid Glass) deliberately have no automatic stars or
    // edge dots. Explicit texture choices are still handled above.
    if (!theme || theme.blob === false) return;
    var A = theme.accentSoft || theme.accent || '#ffd9b8';
    var B = theme.patternInk || theme.sub || '#d9b48f';
    var u = Math.min(W, H);                       // scale unit
    var sr = Math.max(6, u * 0.011);              // star outer radius
    var dr = Math.max(3, u * 0.005);              // dot radius
    ctx.save();
    // stars (filled, soft accent)
    var stars = [[0.12, 0.10, 1.0], [0.88, 0.16, 0.8], [0.16, 0.86, 0.85], [0.86, 0.80, 1.05], [0.50, 0.06, 0.7]];
    ctx.fillStyle = A; ctx.globalAlpha = 0.55;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i]; star(ctx, W * s[0], H * s[1], 4, sr * s[2], sr * s[2] * 0.42); ctx.fill();
    }
    // dots (pattern ink, sparser, along edges)
    var dots = [[0.30, 0.13], [0.68, 0.09], [0.10, 0.50], [0.92, 0.46], [0.30, 0.90], [0.64, 0.88], [0.46, 0.93], [0.90, 0.66]];
    ctx.fillStyle = B; ctx.globalAlpha = 0.35;
    for (var j = 0; j < dots.length; j++) {
      ctx.beginPath(); ctx.arc(W * dots[j][0], H * dots[j][1], dr * (0.8 + (j % 3) * 0.35), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /* ---------- reminders block ---------- */
  function remindersHeight(ctx, W, reminders, settings) {
    if (!settings.showReminders || !reminders || !reminders.length) return 0;
    var fs = Math.round(W * 0.020);
    var lh = Math.round(fs * 1.8);
    return Math.round(lh * 1.15) + Math.min(reminders.length, 6) * lh;
  }
  function drawReminders(ctx, W, H, theme, reminders, settings, margin, startY, minutesUntilFn) {
    if (!settings.showReminders || !reminders || !reminders.length) return startY;
    var F = fontStack(settings);
    var fs = Math.round(W * 0.020);
    var lh = Math.round(fs * 1.8);
    var y = startY;
    ctx.textBaseline = 'top';
    ctx.font = '600 ' + fs + 'px ' + F;
    ctx.fillStyle = theme.accent;
    ctx.fillText('今日提醒', margin, y);
    y += Math.round(lh * 1.15);
    var shown = reminders.filter(r => !r.done).concat(reminders.filter(r => r.done)).slice(0, 6);
    ctx.font = '400 ' + fs + 'px ' + F;
    for (var i = 0; i < shown.length; i++) {
      var r = shown[i];
      var box = Math.round(fs * 0.92);
      ctx.strokeStyle = subInk(theme, settings); ctx.lineWidth = Math.max(1, W * 0.0012);
      ctx.strokeRect(margin, y + Math.round(fs * 0.18), box, box);
      if (r.done) {
        ctx.strokeStyle = theme.accent;
        ctx.beginPath();
        ctx.moveTo(margin + box * 0.15, y + fs * 0.18 + box * 0.5);
        ctx.lineTo(margin + box * 0.42, y + fs * 0.18 + box * 0.78);
        ctx.lineTo(margin + box * 0.88, y + fs * 0.18 + box * 0.18);
        ctx.stroke();
      }
      ctx.fillStyle = r.done ? subInk(theme, settings) : ink(theme, settings);
      var label = r.text;
      if (r.time) {
        var mins = minutesUntilFn ? minutesUntilFn(r.time) : null;
        label += ' · ' + r.time;
        if (mins != null && mins >= 0) label += ' (' + mins + '分钟后)';
      }
      var tx = margin + box + Math.round(fs * 0.65);
      ctx.fillText(label, tx, y, W - tx - margin);
      y += lh;
    }
    return y;
  }

  /* vertical start position from an anchor, across the FULL free band. */
  function anchorY(anchor, availTop, availBottom, blockH, bias) {
    var span = Math.max(0, availBottom - availTop - blockH);
    if (anchor === 'top') return availTop;
    if (anchor === 'bottom') return availBottom - blockH;
    return availTop + Math.round(span * (bias == null ? 0.5 : bias)); // center
  }

  /* Resolve a block's top Y given anchor + fractional offset, over a band.
   * The anchor baseline comes from the band, but an explicit drag offset may
   * take the block anywhere on the canvas (even over the other block) — so we
   * only clamp to keep it at least partly visible. */
  function blockTopFor(anchor, offY, availTop, availBottom, blockH, H) {
    var base = anchorY(anchor, availTop, availBottom, blockH, 0.5);
    var y = base + Math.round((offY || 0) * H);
    var pad = Math.round(H * 0.03);
    return Math.max(pad - blockH, Math.min(H - pad, y));
  }

  /* Dashed outline around the block currently being dragged — live feedback
   * so dragging visibly "grabs" something. Drawn from settings.hl. */
  function drawHlRect(ctx, theme, x, y, w, h) {
    if (!w || !h) return;
    ctx.save();
    ctx.strokeStyle = theme.accent;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(2, Math.round(w * 0.003));
    ctx.setLineDash([Math.max(8, Math.round(w * 0.009)), Math.max(6, Math.round(w * 0.005))]);
    var pad = Math.round(w * 0.008);
    ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
    ctx.restore();
  }
  function drawBackgroundDragCue(ctx, W, H, theme) {
    var p = Math.max(16, Math.round(W * 0.025));
    ctx.save();
    ctx.strokeStyle = theme.accent;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(2, Math.round(W * 0.003));
    ctx.setLineDash([Math.max(10, Math.round(W * 0.012)), Math.max(6, Math.round(W * 0.007))]);
    ctx.strokeRect(p, p, W - p * 2, H - p * 2);
    ctx.setLineDash([]);
    ctx.fillStyle = theme.accent;
    ctx.font = '700 ' + Math.max(13, Math.round(W * 0.018)) + 'px sans-serif';
    ctx.fillText('↔ 拖动调整背景取景', p * 1.6, p * 2.2);
    ctx.restore();
  }

  /* ---------- free custom text blocks (title / footer) ---------- */
  function drawCustomBlocks(ctx, W, H, theme, settings, margin) {
    if (!(settings.custom && settings.custom.enabled)) return;
    var F = fontStack(settings);
    var blocks = [];
    if (settings.custom.title) blocks.push({ text: settings.custom.title, key: 'title', defY: 0.06 });
    if (settings.custom.footer) blocks.push({ text: settings.custom.footer, key: 'footer', defY: 0.9 });
    blocks.forEach(function (b) {
      var pos = (settings.custom.pos && settings.custom.pos[b.key]) || {};
      var fs = Math.round(W * 0.02 * (pos.scale || 1));
      ctx.font = '500 ' + fs + 'px ' + F;
      ctx.fillStyle = b.key === 'title' ? ink(theme, settings) : subInk(theme, settings);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      var cx = Math.round(W * (pos.x != null ? pos.x : 0.5));
      var cy = Math.round(H * (pos.y != null ? pos.y : b.defY));
      ctx.fillText(b.text, cx, cy);
      ctx.textAlign = 'left';
      if (settings.hl && settings.hl.kind === 'custom' && settings.hl.key === b.key) {
        var tw = ctx.measureText(b.text).width;
        drawHlRect(ctx, theme, cx - tw / 2 - fs * 0.5, cy - fs * 0.85, tw + fs * 1.0, fs * 1.7);
      }
    });
    ctx.textBaseline = 'alphabetic';
  }

  /* ---------- GROUP layout ---------- */
  function renderGroup(ctx, W, H, theme, words, reminders, settings, dateStr, minutesUntilFn) {
    var margin = Math.round(W * 0.06);
    var n = Math.max(1, words.length);
    // 6 词起字号由版面自动适配，避免用户调大后挤压释义或产生断行；
    // 只有 1–5 个词才提供自由缩放。
    var scale = n < 6 ? (settings.fontScale || 1) : 1;
    var weight = settings.fontWeight || 700;
    var spacing = settings.letterSpacing || 0;
    var lineHMul = settings.lineHeight || 1;
    var F = fontStack(settings);
    drawBackground(ctx, W, H, theme, settings);
    drawCustomBlocks(ctx, W, H, theme, settings, margin);
    var topBand = Math.round(margin * 1.1);
    var bottomBand = H - Math.round(margin * 1.1);

    var remH = remindersHeight(ctx, W, reminders, settings);
    var remAnchor = settings.anchorReminders || 'bottom';
    var remTop = blockTopFor(remAnchor, settings.offReminders.y, topBand, bottomBand, remH, H);

    var wordsTop = topBand, wordsBottom = bottomBand;
    // keep words out of the reminders zone unless the user dragged them there
    if (remH && remAnchor === 'top') wordsTop = Math.max(wordsTop, remTop + remH + Math.round(H * 0.02));
    if (remH && remAnchor === 'bottom') wordsBottom = Math.min(wordsBottom, remTop - Math.round(H * 0.02));

    // Row height is sized to the CONTENT (word font), not forced to fill the
    // band — so the block is smaller than the free space and the anchor
    // (靠上/居中/靠下) can actually move it. Cap the fill so very few words on
    // a tall canvas don't become absurdly sparse.
    // 字号 slider drives the font DIRECTLY; 行距 slider drives the gap. The block
    // is still centered by the anchor, but we never shrink the font back down just
    // because there's extra room — that's what made the sliders feel dead.
    // ---- 列数与排版模式 -----------------------------------------------------
    // 8 词起固定为两列、从左到右逐行填充。配合 UI 中的偶数校正，
    // 每一行都会完整成对，避免出现第一列比第二列多一行的凌乱视觉。
    var autoCols = n >= 8 ? 2 : 1;
    var cols = (settings.wordCols | 0) || autoCols;
    cols = Math.max(1, Math.min(n, cols, 2));

    var avail = Math.max(1, wordsBottom - wordsTop);
    var wordFs = Math.round(W * 0.052 * scale);
    wordFs = Math.max(Math.round(W * 0.016), wordFs);
    var gap = Math.round(W * 0.045);                       // 列间距
    var colW = Math.round((W - 2 * margin - gap * (cols - 1)) / cols);
    var rows = Math.ceil(n / cols);

    var single = cols === 1;
    // 行高：单列按内容（大字 + 词性释义横排），多列用「单词在上、释义在下」的紧凑卡片，
    // 窄列里才不会挤成一团。字号/行距滑块直接驱动，仅在整块溢出时才收缩。
    var rowH = single
      ? Math.round(wordFs * 3.0 * lineHMul)
      : Math.round(wordFs * 2.35 * lineHMul);
    var maxFillRowH = Math.floor(avail / rows);
    if (rowH > maxFillRowH && maxFillRowH > 0) {
      rowH = maxFillRowH;
      // 多词时优先保住“英文主词”的字号；释义会自然保持更小。
      // 旧的 0.34 上限几乎抹平了 100% 与 170% 的视觉差异。
      wordFs = Math.max(Math.round(W * 0.016), Math.min(wordFs, Math.round(rowH * 0.48)));
    }
    var blockH = rowH * rows;
    var blockTop = blockTopFor(settings.anchorWords || 'center', settings.offWords.y, wordsTop, wordsBottom, blockH, H);
    var xNudge = Math.round((settings.offWords.x || 0) * W);

    // 从左到右逐行填充：16 词始终是 8 行 × 2 列，而不是 9 左 / 7 右。
    function cellPos(i) {
      var c = i % cols;
      var r = Math.floor(i / cols);
      return { col: c, row: r, x: margin + xNudge + c * (colW + gap), y: blockTop + r * rowH };
    }
    // 把真实单词格回传给 UI：点击预览时不靠猜坐标，能精准选中对应单词。
    settings.wordCells = words.map(function (_, i) {
      var p = cellPos(i);
      return { index: i, x: p.x / W, y: p.y / H, w: (single ? W - 2 * margin : colW) / W, h: rowH / H };
    });

    // 卡通贴纸底卡：每个单词一格极淡圆角底色，像贴纸卡，不遮字。
    if (settings.wordCards !== false && !settings.bgImage) {
      ctx.save();
      var liquidCards = !!theme.liquid;
      ctx.fillStyle = liquidCards ? 'rgba(255,255,255,.24)' : (theme.accentSoft || theme.accent || '#ffd9b8');
      ctx.globalAlpha = liquidCards ? 1 : (single ? 0.16 : 0.30);
      if (liquidCards) {
        ctx.strokeStyle = 'rgba(255,255,255,.64)';
        ctx.lineWidth = Math.max(1.5, W * .0012);
        ctx.shadowColor = theme.name === '珍珠' ? 'rgba(60,60,70,.13)' : 'rgba(54,83,105,.14)';
        ctx.shadowBlur = px(ctx, Math.max(8, W * .009));
        ctx.shadowOffsetY = px(ctx, Math.max(2, W * .0025));
      }
      var padX = Math.round(W * 0.012);
      var cardR = Math.min(Math.round(rowH * 0.30), Math.round(W * 0.02));
      for (var ci = 0; ci < n; ci++) {
        var cp = cellPos(ci);
        var cwid = single ? (W - 2 * margin + padX * 2) : (colW - Math.round(W * 0.006));
        var cx0 = single ? (margin + xNudge - padX) : cp.x;
        rr(ctx, cx0, cp.y + Math.round(rowH * 0.05), cwid, rowH - Math.round(rowH * 0.12), cardR);
        ctx.fill();
        if (liquidCards) ctx.stroke();
        if (settings.selectedWordIndex === ci) {
          ctx.save();
          ctx.strokeStyle = theme.accent || '#ff8f4d';
          ctx.lineWidth = Math.max(2, W * 0.003);
          ctx.setLineDash([Math.max(5, W * 0.008), Math.max(4, W * 0.006)]);
          rr(ctx, cx0 + ctx.lineWidth, cp.y + Math.round(rowH * 0.05) + ctx.lineWidth, cwid - ctx.lineWidth * 2, rowH - Math.round(rowH * 0.12) - ctx.lineWidth * 2, cardR);
          ctx.stroke(); ctx.restore();
        }
      }
      ctx.restore();
    }

    words.forEach(function (w, i) {
      var cp = cellPos(i);
      ctx.textBaseline = 'middle';
      var midY = cp.y + rowH / 2;
      // 点击任意一个词出现的是“整组”编辑器：字号、字体、粗细和颜色始终同步到全部单词。
      var itemWeight = weight;
      var itemFont = F;
      var itemInk = ink(theme, settings);
      var itemWordFs = wordFs;
      var meaning = (w.pos ? w.pos + ' ' : '') + (w.meaning || '');

      if (single) {
        // 原单列排版：只突出单词本身；行高够时释义换行堆叠，否则单行横排
        var m = cp.x;
        var ix = m;
        var stacked = rowH >= wordFs * 2.4;
        if (stacked) {
          ctx.fillStyle = ink(theme, settings);
          ctx.fillStyle = itemInk;
          ctx.font = itemWeight + ' ' + itemWordFs + 'px ' + itemFont;
          drawSpaced(ctx, w.word, ix, midY - rowH * 0.16, spacing);
          var ww = measureSpaced(ctx, w.word, spacing);
          if (settings.showPhonetic && w.phonetic) {
            ctx.fillStyle = subInk(theme, settings);
            ctx.font = '400 ' + Math.round(itemWordFs * 0.48) + 'px ' + itemFont;
            ctx.fillText(w.phonetic, ix + ww + Math.round(W * 0.015), midY - rowH * 0.16, cp.x + colW + gap - ix - ww - Math.round(W * 0.015));
          }
          ctx.fillStyle = subInk(theme, settings);
          ctx.font = '400 ' + Math.round(wordFs * 0.54) + 'px ' + F;
          ctx.fillText(meaning, ix, midY + rowH * 0.22, cp.x + colW - ix);
        } else {
          ctx.fillStyle = ink(theme, settings);
          ctx.fillStyle = itemInk;
          ctx.font = itemWeight + ' ' + itemWordFs + 'px ' + itemFont;
          drawSpaced(ctx, w.word, ix, midY, spacing);
          var tx = ix + measureSpaced(ctx, w.word, spacing) + Math.round(W * 0.014);
          if (settings.showPhonetic && w.phonetic) {
            ctx.fillStyle = subInk(theme, settings);
            ctx.font = '400 ' + Math.round(itemWordFs * 0.48) + 'px ' + itemFont;
            ctx.fillText(w.phonetic, tx, midY, W * 0.2);
            tx += ctx.measureText(w.phonetic).width + Math.round(W * 0.014);
          }
          ctx.fillStyle = subInk(theme, settings);
          ctx.font = '400 ' + Math.round(wordFs * 0.5) + 'px ' + F;
          ctx.fillText(meaning, tx, midY, cp.x + colW + gap - tx);
        }
        if (i < n - 1) {
          ctx.strokeStyle = theme.line || 'rgba(128,128,128,0.18)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(cp.x, cp.y + rowH); ctx.lineTo(W - margin + xNudge, cp.y + rowH); ctx.stroke();
        }
      } else {
        // 多列紧凑卡片：单词（大字、字间距生效）在上，音标 + 释义（缩小、截断）在下。
        var inset = Math.round(W * 0.014);
        var x0 = cp.x + inset;
        var maxTextW = colW - inset * 2;
        var wfs = Math.min(Math.round(itemWordFs), Math.round(colW * 0.48));
        var wx = x0;
        var wy = midY - rowH * 0.10;
        ctx.fillStyle = itemInk;
        ctx.font = itemWeight + ' ' + wfs + 'px ' + itemFont;
        drawSpaced(ctx, w.word, wx, wy, spacing);
        var wordW = measureSpaced(ctx, w.word, spacing);
        if (settings.showPhonetic && w.phonetic) {
          ctx.fillStyle = subInk(theme, settings);
          ctx.font = '400 ' + Math.round(wfs * 0.42) + 'px ' + itemFont;
          var phW = maxTextW - wordW - Math.round(W * 0.012);
          if (phW > wfs) ctx.fillText(w.phonetic, wx + wordW + Math.round(W * 0.012), wy, phW);
        }
        ctx.fillStyle = subInk(theme, settings);
        ctx.font = '400 ' + Math.round(wfs * 0.46) + 'px ' + itemFont;
        ctx.fillText(meaning, x0, cp.y + rowH * 0.72, maxTextW);
      }
    });

    if (remH) drawReminders(ctx, W, H, theme, reminders, settings, margin + Math.round((settings.offReminders.x || 0) * W), remTop, minutesUntilFn);

    if (settings.hl) {
      if (settings.hl.kind === 'background') drawBackgroundDragCue(ctx, W, H, theme);
      else if (settings.hl.kind === 'reminders' && remH) drawHlRect(ctx, theme, margin + Math.round((settings.offReminders.x || 0) * W), remTop, W - 2 * margin, remH);
      else if (settings.hl.kind === 'words') drawHlRect(ctx, theme, margin + xNudge, blockTop, W - 2 * margin, blockH);
    }
  }

  /* letter-spacing helpers (canvas has no tracking, so draw per-char). */
  function measureSpaced(ctx, text, spacing) {
    if (!spacing) return ctx.measureText(text).width;
    var w = 0;
    for (var i = 0; i < text.length; i++) w += ctx.measureText(text[i]).width + spacing;
    return w - spacing;
  }
  function drawSpaced(ctx, text, x, y, spacing) {
    if (!spacing) { ctx.fillText(text, x, y); return; }
    var cx = x;
    for (var i = 0; i < text.length; i++) {
      ctx.fillText(text[i], cx, y);
      cx += ctx.measureText(text[i]).width + spacing;
    }
  }

  /* ---------- REMINDER PAGE (for whole-page cycling) ---------- */
  function renderReminderPage(ctx, W, H, theme, reminders, settings, dateStr, minutesUntilFn) {
    var margin = Math.round(W * 0.08);
    var F = fontStack(settings);
    drawBackground(ctx, W, H, theme, settings);
    drawCustomBlocks(ctx, W, H, theme, settings, margin);
    ctx.textBaseline = 'top';
    var titleFs = Math.round(W * 0.055);
    var y = Math.round(H * 0.14);
    ctx.fillStyle = theme.accent;
    ctx.fillRect(margin, y, Math.round(W * 0.06), Math.max(4, Math.round(W * 0.008)));
    y += Math.round(W * 0.06);
    ctx.fillStyle = ink(theme, settings);
    ctx.font = '800 ' + titleFs + 'px ' + F;
    ctx.fillText('今日提醒', margin, y);
    y += Math.round(titleFs * 1.6);

    var list = (reminders || []).filter(r => !r.done).concat((reminders || []).filter(r => r.done));
    if (!list.length) {
      ctx.fillStyle = subInk(theme, settings);
      ctx.font = '400 ' + Math.round(W * 0.028) + 'px ' + F;
      ctx.fillText('今天还没有提醒事项', margin, y);
      return;
    }
    var fs = Math.round(W * 0.032);
    var lh = Math.round(fs * 1.9);
    var max = Math.min(list.length, Math.floor((H - y - margin * 2) / lh));
    for (var i = 0; i < max; i++) {
      var r = list[i];
      var box = Math.round(fs * 0.95);
      ctx.strokeStyle = subInk(theme, settings); ctx.lineWidth = Math.max(1.5, W * 0.0015);
      ctx.strokeRect(margin, y + Math.round(fs * 0.15), box, box);
      if (r.done) {
        ctx.strokeStyle = theme.accent;
        ctx.beginPath();
        ctx.moveTo(margin + box * 0.15, y + fs * 0.15 + box * 0.5);
        ctx.lineTo(margin + box * 0.42, y + fs * 0.15 + box * 0.78);
        ctx.lineTo(margin + box * 0.88, y + fs * 0.15 + box * 0.18);
        ctx.stroke();
      }
      ctx.fillStyle = r.done ? subInk(theme, settings) : ink(theme, settings);
      var label = r.text;
      if (r.time) {
        var mins = minutesUntilFn ? minutesUntilFn(r.time) : null;
        label += ' · ' + r.time;
        if (mins != null && mins >= 0) label += ' (' + mins + '分钟后)';
      }
      ctx.font = '500 ' + fs + 'px ' + F;
      ctx.fillText(label, margin + box + Math.round(fs * 0.7), y, W - margin * 2 - box);
      y += lh;
    }
  }

  /* Main dispatcher. page: 'words' | 'reminders'.
   * opts.scale < 1 draws the same W×H layout into a smaller bitmap (the live
   * preview); all layout math stays in wallpaper coordinates. */
  function draw(ctx, opts) {
    var page = opts.page || 'words';
    var s = opts.scale > 0 ? opts.scale : 1;
    ctx.save();
    if (s !== 1) ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.__wpScale = s;
    if (page === 'reminders') {
      renderReminderPage(ctx, opts.width, opts.height, opts.theme, opts.reminders, opts.settings, opts.dateStr, opts.minutesUntil);
    } else {
      renderGroup(ctx, opts.width, opts.height, opts.theme, opts.words, opts.reminders, opts.settings, opts.dateStr, opts.minutesUntil);
    }
    ctx.__wpScale = 1;
    ctx.restore();
  }
  /* shadowBlur / shadowOffset ignore the canvas transform, so scale them by hand. */
  function px(ctx, v) { return v * (ctx.__wpScale || 1); }

  /* Browser convenience: render to a canvas element. */
  function render(opts) {
    var s = opts.scale > 0 ? opts.scale : 1;
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(opts.width * s));
    canvas.height = Math.max(1, Math.round(opts.height * s));
    draw(canvas.getContext('2d'), opts);
    return canvas;
  }
  function toPNG(canvas) { return canvas.toDataURL('image/png'); }

  var api = { draw: draw, render: render, toPNG: toPNG, FONT_STACK: FONT_STACKS.hei, FONT_STACKS: FONT_STACKS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node companion
  global.Render = api;
})(typeof window !== 'undefined' ? window : globalThis);
