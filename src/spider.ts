// Visual DOM crawler — overlay paint + single-page crawling engine.
// The underlying page DOM is never modified (nodes keyed by element object).
// Build with `npm run build` (emits ../spider.js). Do not edit spider.js by hand.
(() => {
  const canvasEl = document.getElementById("crawler-overlay");
  if (!(canvasEl instanceof HTMLCanvasElement)) throw new Error("missing #crawler-overlay");
  const ctx = canvasEl.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  const hudText = document.getElementById("hud-text");
  const hudDot = document.getElementById("hud-dot");
  if (!hudText || !hudDot) throw new Error("missing hud elements");
  const statDiscovered = document.getElementById("stat-discovered");
  const statVisited = document.getElementById("stat-visited");
  const statLinks = document.getElementById("stat-links");

  let W = 0;
  let H = 0;
  let DPR = 1;

  function resize(): void {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvasEl.width = Math.floor(W * DPR);
    canvasEl.height = Math.floor(H * DPR);
    canvasEl.style.width = W + "px";
    canvasEl.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  interface Spider {
    x: number; y: number;
    vx: number; vy: number;
    angle: number;
    speed: number;
  }

  interface CrawlNode {
    id: number;
    el: Element;
    tag: string;
    kind: string;
    text: string;
    url: string | null;
    x: number; y: number; w: number; h: number;
    cx: number; cy: number;
    visited: boolean;
    cooldownUntil: number;
  }

  interface Edge { a: CrawlNode; b: CrawlNode; }

  // --- input: mouse cursor is an optional influence, not the only driver ---
  const mouse = { x: W * 0.6, y: H * 0.4, active: false, lastMove: 0 };
  window.addEventListener("mousemove", (e: MouseEvent) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.active = true;
    mouse.lastMove = performance.now();
  }, { passive: true });
  window.addEventListener("touchmove", (e: TouchEvent) => {
    const t = e.touches[0];
    if (t) { mouse.x = t.clientX; mouse.y = t.clientY; mouse.active = true; mouse.lastMove = performance.now(); }
  }, { passive: true });

  // --- spider state (movement + rendering unchanged) ---
  const spider: Spider = {
    x: W * 0.3, y: H * 0.3,
    vx: 0, vy: 0,
    angle: 0,
    speed: 0,
  };

  const SNIFF_RADIUS = 220;   // detection range (px)
  const LATCH_RADIUS = 140;   // latch-on / visit range (px)
  const MAX_SPEED = 420;      // px/sec
  const ACCEL = 900;
  const CURSOR_PULL = 0.35;   // how strongly a recent cursor pulls the spider off its tour

  // --- crawling engine: node graph for the current page ---
  // Keyed by element object itself: re-scans can never create duplicates,
  // and the page DOM is never touched (no ids, no data attributes).
  const nodeByEl = new Map<Element, CrawlNode>();
  const nodes: CrawlNode[] = [];
  const edges: Edge[] = []; // persistent web between visited nodes
  let nodeSeq = 0;
  let lastVisitedNode: CrawlNode | null = null;
  let unvisitedCount = 0;

  function elementText(el: Element): string {
    const htmlEl = el as HTMLElement;
    const imgEl = el as HTMLImageElement;
    const inputEl = el as HTMLInputElement;
    const t = (htmlEl.innerText || imgEl.alt || inputEl.value || htmlEl.title || "")
      .trim().replace(/\s+/g, " ");
    return t.slice(0, 80);
  }

  function elementUrl(el: Element): string | null {
    return el.getAttribute("href") || el.getAttribute("src");
  }

  function classify(tag: string): string {
    if (tag === "a") return "link <a>";
    if (tag === "button") return "button";
    if (tag.charAt(0) === "h") return "heading <" + tag + ">";
    if (tag === "p") return "para <p>";
    if (tag === "img") return "image <img>";
    if (tag === "video") return "video";
    if (tag === "iframe") return "frame <iframe>";
    return "ref <" + tag + ">";
  }

  function readRect(n: CrawlNode): void {
    const r = n.el.getBoundingClientRect();
    n.x = r.left; n.y = r.top; n.w = r.width; n.h = r.height;
    n.cx = r.left + r.width / 2; n.cy = r.top + r.height / 2;
  }

  function scanDOM(): void {
    const scope: Element | Document = document.body ?? document;
    const els = scope.querySelectorAll(
      "a, button, h1, h2, h3, h4, p, img, video, iframe, [href], [src]"
    );
    const seen = new Set<Element>();
    els.forEach((el) => {
      if (el.closest("#hud") || el.closest("#stats")) return;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      if (r.bottom < -50 || r.top > H + 50 || r.right < -50 || r.left > W + 50) return;
      seen.add(el);
      const existing = nodeByEl.get(el);
      if (!existing) {
        const tag = el.tagName.toLowerCase();
        const n: CrawlNode = {
          id: ++nodeSeq,
          el, tag,
          kind: classify(tag),
          text: elementText(el),
          url: elementUrl(el),
          x: r.left, y: r.top, w: r.width, h: r.height,
          cx: r.left + r.width / 2, cy: r.top + r.height / 2,
          visited: false,
          cooldownUntil: 0,
        };
        nodeByEl.set(el, n);
        nodes.push(n);
        unvisitedCount++;
      } else {
        readRect(existing);
      }
    });
    // prune detached nodes and their web edges
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!seen.has(n.el) || !n.el.isConnected) {
        if (!n.visited) unvisitedCount--;
        nodeByEl.delete(n.el);
        nodes.splice(i, 1);
        if (lastVisitedNode === n) lastVisitedNode = null;
        if (latched === n) latched = null;
      }
    }
    for (let i = edges.length - 1; i >= 0; i--) {
      if (!nodeByEl.has(edges[i].a.el) || !nodeByEl.has(edges[i].b.el)) edges.splice(i, 1);
    }
  }

  let latched: CrawlNode | null = null; // currently highlighted target
  let latchUntil = 0;

  function visit(node: CrawlNode): void {
    if (node.visited) return;
    node.visited = true;
    unvisitedCount--;
    if (lastVisitedNode && lastVisitedNode !== node) edges.push({ a: lastVisitedNode, b: node });
    lastVisitedNode = node;
    updateStats();
  }

  const lastStats = { d: -1, v: -1, l: -1 };
  function updateStats(): void {
    const d = nodes.length;
    let v = 0, l = 0;
    for (const n of nodes) {
      if (n.visited) v++;
      if (n.url) l++;
    }
    if (d !== lastStats.d && statDiscovered) { statDiscovered.textContent = String(d); lastStats.d = d; }
    if (v !== lastStats.v && statVisited) { statVisited.textContent = String(v); lastStats.v = v; }
    if (l !== lastStats.l && statLinks) { statLinks.textContent = String(l); lastStats.l = l; }
  }

  scanDOM();
  updateStats();
  setInterval(() => { scanDOM(); updateStats(); }, 600);
  window.addEventListener("scroll", () => scanDOM(), { passive: true });

  function closestPointOnRect(px: number, py: number, t: CrawlNode): { x: number; y: number } {
    return {
      x: Math.max(t.x, Math.min(px, t.x + t.w)),
      y: Math.max(t.y, Math.min(py, t.y + t.h)),
    };
  }

  function nodeDistanceToSpider(n: CrawlNode): number {
    const px = Math.max(n.x, Math.min(spider.x, n.x + n.w));
    const py = Math.max(n.y, Math.min(spider.y, n.y + n.h));
    return Math.hypot(spider.x - px, spider.y - py);
  }

  function roundRectPath(x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawLabel(x: number, y: number, text: string, accent: string): void {
    ctx.font = "11px ui-monospace, monospace";
    const w = ctx.measureText(text).width + 16;
    const h = 20;
    const lx = Math.max(6, Math.min(x - w / 2, W - w - 6));
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

  function drawThread(x1: number, y1: number, x2: number, y2: number, color: string): void {
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

  // persistent web between visited nodes (cheap flat strokes, no glow)
  function drawWeb(): void {
    ctx.save();
    ctx.strokeStyle = "rgba(88,255,155,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const e of edges) {
      ctx.moveTo(e.a.cx, e.a.cy);
      ctx.lineTo(e.b.cx, e.b.cy);
    }
    ctx.stroke();
    // dots for discovered-but-unvisited nodes
    ctx.fillStyle = "rgba(124,196,255,0.35)";
    ctx.beginPath();
    for (const n of nodes) {
      if (!n.visited && n.cx > -20 && n.cx < W + 20 && n.cy > -20 && n.cy < H + 20) {
        ctx.moveTo(n.cx + 2, n.cy);
        ctx.arc(n.cx, n.cy, 2, 0, Math.PI * 2);
      }
    }
    ctx.fill();
    ctx.restore();
  }

  function drawHighlight(t: CrawlNode, color: string): void {
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

  function drawSpider(time: number, moving: boolean): void {
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

  function setHud(mode: "latch" | "chase" | "idle", detail?: string): void {
    const text = mode === "latch" ? `crawling ${detail ?? ""}` :
      mode === "chase" ? "following cursor…" : "spider idle — move your mouse";
    if (hudText.textContent !== text) hudText.textContent = text;
    hudDot.style.background = mode === "latch" ? "#58ff9b" : mode === "chase" ? "#7cc4ff" : "#8d97ad";
    hudDot.style.boxShadow = `0 0 8px ${hudDot.style.background}`;
  }

  // --- main loop ---
  let last = performance.now();
  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    // tour: nearest unvisited node is the crawl target.
    // Once everything is visited, patrol the nearest node whose cooldown
    // expired, so the spider roams instead of camping one spot.
    let autoTarget: CrawlNode | null = null;
    let best = Infinity;
    if (unvisitedCount > 0) {
      for (const n of nodes) {
        if (n.visited) continue;
        const d = nodeDistanceToSpider(n);
        if (d < best) { best = d; autoTarget = n; }
      }
    } else {
      for (const n of nodes) {
        if (now < n.cooldownUntil) continue;
        const d = nodeDistanceToSpider(n);
        if (d < best) { best = d; autoTarget = n; }
      }
    }

    // steering goal: crawl target, with wander + optional cursor pull
    const cursorFresh = mouse.active && (now - mouse.lastMove < 2500);
    const wt = now / 1000;
    const wanderX = Math.sin(wt * 0.9) * 60 + Math.sin(wt * 2.3) * 20;
    const wanderY = Math.cos(wt * 1.1) * 60 + Math.cos(wt * 1.7) * 20;
    let gx: number, gy: number;
    if (latched) {
      const a = closestPointOnRect(spider.x, spider.y, latched);
      gx = a.x; gy = a.y;
    } else if (autoTarget) {
      const a = closestPointOnRect(spider.x, spider.y, autoTarget);
      gx = a.x + wanderX * 0.25;
      gy = a.y + wanderY * 0.25;
    } else {
      gx = (cursorFresh ? mouse.x : W / 2 + Math.sin(wt * 0.4) * W * 0.25) + wanderX * 0.25;
      gy = (cursorFresh ? mouse.y : H / 2 + Math.cos(wt * 0.5) * H * 0.25) + wanderY * 0.25;
    }
    if (cursorFresh && (autoTarget || latched)) {
      gx = gx * (1 - CURSOR_PULL) + mouse.x * CURSOR_PULL;
      gy = gy * (1 - CURSOR_PULL) + mouse.y * CURSOR_PULL;
    }

    const dx = gx - spider.x;
    const dy = gy - spider.y;
    const dist = Math.hypot(dx, dy);

    // ease: arrive slowly when close so it doesn't jitter on the target
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

    // --- detection: nearest nodes within sniff radius ---
    const nearest: Array<{ t: CrawlNode; d: number }> = [];
    for (const n of nodes) {
      const px = Math.max(n.x, Math.min(spider.x, n.x + n.w));
      const py = Math.max(n.y, Math.min(spider.y, n.y + n.h));
      const d = Math.hypot(spider.x - px, spider.y - py);
      if (d < SNIFF_RADIUS) nearest.push({ t: n, d });
    }
    nearest.sort((a, b) => a.d - b.d);

    if (latched && now > latchUntil) latched = null;
    // latch onto closest once spider is on top of it => node visited.
    // Skip already-visited nodes while the tour still has fresh targets,
    // otherwise the spider re-latches forever and never moves on.
    // In patrol mode each node cools down after a latch so the tour rotates.
    if (!latched && nearest.length > 0 && nearest[0].d < LATCH_RADIUS) {
      const pick = nearest.find((n) =>
        (!n.t.visited || (unvisitedCount === 0 && now >= n.t.cooldownUntil)) &&
        n.d < LATCH_RADIUS);
      if (pick) {
        latched = pick.t;
        latchUntil = now + 1800;
        if (unvisitedCount === 0) latched.cooldownUntil = now + 6000;
        visit(latched);
        scanDOM();
      }
    }
    // keep latch rect fresh while page scrolls
    if (latched) {
      readRect(latched);
    }

    // --- paint ---
    ctx.clearRect(0, 0, W, H);

    // persistent crawled web first (under everything else)
    drawWeb();

    // threads + highlights: latched element first, then up to 2 nearby
    const accent = "#58ff9b";
    if (latched) {
      const a = closestPointOnRect(spider.x, spider.y, latched);
      drawThread(spider.x, spider.y, a.x, a.y, accent);
      drawHighlight(latched, accent);
      drawLabel(latched.cx, latched.y, latched.kind, accent);
      setHud("latch", `on ${latched.kind} · ${latched.tag}`);
    } else if (nearest.length > 0) {
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
