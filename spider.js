// Visual crawler prototype — everything is painted on a transparent overlay.
// The underlying page DOM is never modified.
(() => {
  const canvas = document.getElementById("crawler-overlay");
  const ctx = canvas.getContext("2d");
  const hudText = document.getElementById("hud-text");
  const hudDot = document.getElementById("hud-dot");

  let W = 0;
  let H = 0;
  let DPR = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  // --- input: mouse cursor is the attract point ---
  const mouse = { x: W * 0.6, y: H * 0.4, active: false, lastMove: 0 };
  window.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.active = true;
    mouse.lastMove = performance.now();
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (t) { mouse.x = t.clientX; mouse.y = t.clientY; mouse.active = true; mouse.lastMove = performance.now(); }
  }, { passive: true });

  // --- spider state ---
  const spider = {
    x: W * 0.3, y: H * 0.3,
    vx: 0, vy: 0,
    angle: 0,
    speed: 0,
    trail: [],
  };

  const SNIFF_RADIUS = 220;   // detection range (px)
  const LATCH_RADIUS = 140;   // latch-on range (px)
  const MAX_SPEED = 420;      // px/sec
  const ACCEL = 900;

  // Cache candidate element rects so we don't query layout every frame.
  let targets = [];
  function snapshotTargets() {
    const els = document.querySelectorAll("a, button, h1, h2, h3, p, img");
    const out = [];
    for (const el of els) {
      if (el.closest("#hud")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom < -50 || r.top > H + 50 || r.right < -50 || r.left > W + 50) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      let kind = "el";
      const tag = el.tagName.toLowerCase();
      if (tag === "a") kind = "link <a>";
      else if (tag === "button") kind = "button";
      else if (tag.startsWith("h")) kind = "heading <" + tag + ">";
      else if (tag === "p") kind = "para <p>";
      else if (tag === "img") kind = "image <img>";
      out.push({ el, x: r.left, y: r.top, w: r.width, h: r.height, cx, cy, kind, tag });
    }
    targets = out;
  }
  snapshotTargets();
  setInterval(snapshotTargets, 600);
  window.addEventListener("scroll", () => snapshotTargets(), { passive: true });

  let latched = null;      // currently highlighted target
  let latchUntil = 0;

  function closestPointOnRect(px, py, t) {
    return {
      x: Math.max(t.x, Math.min(px, t.x + t.w)),
      y: Math.max(t.y, Math.min(py, t.y + t.h)),
    };
  }

  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawLabel(x, y, text, accent) {
    ctx.font = "11px ui-monospace, monospace";
    const w = ctx.measureText(text).width + 16;
    const h = 20;
    let lx = Math.max(6, Math.min(x - w / 2, W - w - 6));
    let ly = y - 34;
    if (ly < 6) ly = y + 14;
    // bob gently
    ly += Math.sin(performance.now() / 500 + x) * 2;
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10;
    ctx.fillStyle = "rgba(8,12,20,0.88)";
    roundRectPath(lx, ly, w, h, 9);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    roundRectPath(lx, ly, w, h, 9);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#eaf2ff";
    ctx.fillText(text, lx + 8, ly + 13.5);
    ctx.restore();
  }

  function drawThread(x1, y1, x2, y2, color) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 + 12; // slight silk sag
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(mx, my, x2, y2);
    ctx.stroke();
    // bright core so it reads as glowing filament
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(mx, my, x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  function drawHighlight(t, color) {
    const pad = 6;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.95;
    roundRectPath(t.x - pad, t.y - pad, t.w + pad * 2, t.h + pad * 2, 10);
    ctx.stroke();
    ctx.restore();
  }

  function drawSpider(time, moving) {
    const { x, y, angle } = spider;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // soft glow under spider
    ctx.save();
    ctx.shadowColor = "rgba(124,196,255,0.9)";
    ctx.shadowBlur = 18;
    ctx.fillStyle = "rgba(124,196,255,0.12)";
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // --- 8 legs, animated with alternating tripod gait ---
    const stepFreq = 6 + spider.speed / 45; // faster wiggle when moving
    const amp = moving ? 6 : 2.5;
    ctx.lineCap = "round";
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 4; i++) {
        const phase = (i % 2 === 0 ? 0 : Math.PI) + (side > 0 ? Math.PI : 0);
        const t = time / 1000 * stepFreq + phase + i * 0.7;
        const lift = Math.sin(t) * amp;
        const swing = Math.cos(t * 0.9) * (moving ? 5 : 1.5);

        // leg roots along the body flanks, fans front-to-back
        const rootX = 8 - i * 6;
        const rootY = side * 6;
        const kneeX = rootX + 6 + swing * 0.4;
        const kneeY = side * (16 + (i === 1 || i === 2 ? 4 : 0)) + lift * 0.4;
        const footX = kneeX - 2 + swing;
        const footY = side * (30 + (i === 0 || i === 3 ? -4 : 2)) + lift;

        ctx.save();
        ctx.shadowColor = "rgba(124,196,255,0.8)";
        ctx.shadowBlur = 6;
        ctx.strokeStyle = "#9fd0ff";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(rootX, rootY);
        ctx.lineTo(kneeX, kneeY);
        ctx.lineTo(footX, footY);
        ctx.stroke();
        ctx.restore();

        // tiny foot dot
        ctx.fillStyle = "rgba(200,230,255,0.9)";
        ctx.beginPath();
        ctx.arc(footX, footY, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- body: abdomen + cephalothorax ---
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 8;
    // abdomen (rear)
    const grad = ctx.createRadialGradient(-6, 0, 1, -8, 0, 14);
    grad.addColorStop(0, "#3a4358");
    grad.addColorStop(1, "#141926");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(-9, 0, 11, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#7cc4ff";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // abdomen stripe
    ctx.strokeStyle = "rgba(124,196,255,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-17, 0); ctx.lineTo(-4, 0);
    ctx.stroke();
    // head
    ctx.fillStyle = "#1d2536";
    ctx.beginPath();
    ctx.ellipse(6, 0, 7, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#bfe0ff";
    ctx.stroke();
    ctx.restore();

    // eyes (front)
    ctx.fillStyle = "#ff5d5d";
    ctx.beginPath(); ctx.arc(10.5, -2, 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(10.5, 2, 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(10.8, -2, 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(10.8, 2, 0.5, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }

  function setHud(mode, detail) {
    const text = mode === "latch" ? `crawling ${detail}` :
      mode === "chase" ? "following cursor…" : "spider idle — move your mouse";
    if (hudText.textContent !== text) hudText.textContent = text;
    hudDot.style.background = mode === "latch" ? "#58ff9b" : mode === "chase" ? "#7cc4ff" : "#8d97ad";
    hudDot.style.boxShadow = `0 0 8px ${hudDot.style.background}`;
  }

  // --- main loop ---
  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    // pick steering goal: mouse cursor, plus organic wander
    const idle = now - mouse.lastMove > 2500 || !mouse.active;
    const wt = now / 1000;
    const wanderX = Math.sin(wt * 0.9) * 60 + Math.sin(wt * 2.3) * 20;
    const wanderY = Math.cos(wt * 1.1) * 60 + Math.cos(wt * 1.7) * 20;
    const gx = (idle ? W / 2 + Math.sin(wt * 0.4) * W * 0.25 : mouse.x) + wanderX * 0.25;
    const gy = (idle ? H / 2 + Math.cos(wt * 0.5) * H * 0.25 : mouse.y) + wanderY * 0.25;

    const dx = gx - spider.x;
    const dy = gy - spider.y;
    const dist = Math.hypot(dx, dy);

    // ease: arrive slowly when close so it doesn't jitter on the cursor
    const desired = Math.min(MAX_SPEED, dist * 4);
    const ax = dist > 1 ? (dx / dist) * ACCEL : 0;
    const ay = dist > 1 ? (dy / dist) * ACCEL : 0;
    spider.vx += ax * dt;
    spider.vy += ay * dt;

    // friction + speed clamp
    spider.vx *= (1 - Math.min(1, 3.2 * dt));
    spider.vy *= (1 - Math.min(1, 3.2 * dt));
    const sp = Math.hypot(spider.vx, spider.vy);
    if (sp > desired) {
      spider.vx = spider.vx / sp * desired;
      spider.vy = spider.vy / sp * desired;
    }
    spider.x += spider.vx * dt;
    spider.y += spider.vy * dt;
    spider.x = Math.max(10, Math.min(W - 10, spider.x));
    spider.y = Math.max(10, Math.min(H - 10, spider.y));
    spider.speed = Math.hypot(spider.vx, spider.vy);

    if (spider.speed > 12) {
      const targetAngle = Math.atan2(spider.vy, spider.vx);
      let d = targetAngle - spider.angle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      spider.angle += d * Math.min(1, 10 * dt);
    }

    // silk trail (short, fading)
    spider.trail.push({ x: spider.x, y: spider.y, life: 1 });
    if (spider.trail.length > 40) spider.trail.shift();
    for (const p of spider.trail) p.life -= dt * 1.4;

    // --- detection: nearest targets within sniff radius ---
    let nearest = [];
    for (const t of targets) {
      const px = Math.max(t.x, Math.min(spider.x, t.x + t.w));
      const py = Math.max(t.y, Math.min(spider.y, t.y + t.h));
      const d = Math.hypot(spider.x - px, spider.y - py);
      if (d < SNIFF_RADIUS) nearest.push({ t, d });
    }
    nearest.sort((a, b) => a.d - b.d);

    if (latched && now > latchUntil) latched = null;
    // latch onto closest once spider is on top of it
    if (!latched && nearest.length && nearest[0].d < LATCH_RADIUS) {
      latched = nearest[0].t;
      latchUntil = now + 1800;
      snapshotTargets();
    }
    // keep latch rect fresh while page scrolls
    if (latched) {
      const r = latched.el.getBoundingClientRect();
      latched.x = r.left; latched.y = r.top; latched.w = r.width; latched.h = r.height;
      latched.cx = r.left + r.width / 2; latched.cy = r.top + r.height / 2;
    }

    // --- paint ---
    ctx.clearRect(0, 0, W, H);

    // faint sniff ring
    ctx.save();
    ctx.globalAlpha = 0.10;
    ctx.strokeStyle = "#7cc4ff";
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.arc(spider.x, spider.y, SNIFF_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // trail
    ctx.save();
    ctx.strokeStyle = "rgba(160,200,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (const p of spider.trail) {
      if (p.life <= 0) continue;
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();

    // threads + highlights: latched element first, then up to 2 nearby
    const accent = "#58ff9b";
    if (latched) {
      const a = closestPointOnRect(spider.x, spider.y, latched);
      drawThread(spider.x, spider.y, a.x, a.y, accent);
      drawHighlight(latched, accent);
      drawLabel(latched.cx, latched.y, latched.kind, accent);
      setHud("latch", `on ${latched.kind} · ${latched.tag}`);
    } else if (nearest.length) {
      const show = nearest.slice(0, 3);
      show.forEach((n, i) => {
        const c = i === 0 ? "#7cc4ff" : "rgba(124,196,255,0.55)";
        const a = closestPointOnRect(spider.x, spider.y, n.t);
        if (i === 0) {
          drawThread(spider.x, spider.y, a.x, a.y, "#7cc4ff");
          drawHighlight(n.t, c);
        }
        if (i < 2) drawLabel(n.t.cx, n.t.y, n.t.kind, c);
      });
      setHud(dist > 30 ? "chase" : "idle");
    } else {
      setHud(dist > 30 ? "chase" : "idle");
    }

    drawSpider(now, spider.speed > 30);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
