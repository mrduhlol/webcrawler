"use strict";
// Visual DOM crawler — overlay paint + single-page crawling engine.
// The underlying page DOM is never modified (nodes keyed by element object).
// Build with `npm run build` (emits dist/spider.js). Do not edit dist by hand.
(() => {
    function reqEl(id) {
        return document.getElementById(id);
    }
    const canvasEl = document.getElementById("crawler-overlay");
    if (!(canvasEl instanceof HTMLCanvasElement))
        throw new Error("missing #crawler-overlay");
    const canvas = canvasEl;
    const rawCtx = canvas.getContext("2d");
    if (!rawCtx)
        throw new Error("no 2d context");
    const ctx = rawCtx;
    // HUD / stats pills are gone from the page; keep refs optional so the
    // engine still runs headless in tests.
    const hudText = reqEl("hud-text");
    const statDiscovered = reqEl("stat-discovered");
    const statVisited = reqEl("stat-visited");
    const statLinks = reqEl("stat-links");
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
    // --- input: the cursor is a faint target the creature notices, nothing more ---
    const mouse = { x: W * 0.6, y: H * 0.4, active: false, lastMove: 0 };
    window.addEventListener("mousemove", (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
        mouse.active = true;
        mouse.lastMove = performance.now();
    }, { passive: true });
    window.addEventListener("touchmove", (e) => {
        const t = e.touches[0];
        if (t) {
            mouse.x = t.clientX;
            mouse.y = t.clientY;
            mouse.active = true;
            mouse.lastMove = performance.now();
        }
    }, { passive: true });
    // --- spider state ---
    const spider = {
        x: W * 0.3, y: H * 0.3,
        vx: 0, vy: 0,
        angle: 0,
        speed: 0,
        bobPhase: Math.random() * 10,
    };
    const SNIFF_RADIUS = 220; // detection range (px), invisible
    const LATCH_RADIUS = 130; // inspect range (px)
    const MAX_SPEED = 380; // px/sec, modulated into scurries below
    const ACCEL = 1500; // darts, then brakes hard
    const CURSOR_PULL = 0.18; // faint tug toward a recent cursor
    // ink-on-paper palette: monochrome, almost no glow
    const INK = "35,39,46";
    const STRAND = `rgba(${INK},0.30)`;
    const WEB = `rgba(${INK},0.16)`;
    const BOX = `rgba(${INK},0.55)`;
    const DOT = `rgba(${INK},0.30)`;
    const LABEL_FG = "#2a2e36";
    const LABEL_BG = "rgba(250,249,246,0.92)";
    const LABEL_EDGE = `rgba(${INK},0.38)`;
    // --- crawling engine: node graph for the current page ---
    const nodeByEl = new Map();
    const nodes = [];
    const edges = []; // silk left behind between visited nodes
    let nodeSeq = 0;
    let lastVisitedNode = null;
    let unvisitedCount = 0;
    function elementText(el) {
        const htmlEl = el;
        const imgEl = el;
        const inputEl = el;
        const t = (htmlEl.innerText || imgEl.alt || inputEl.value || htmlEl.title || "")
            .trim().replace(/\s+/g, " ");
        return t.slice(0, 80);
    }
    function elementUrl(el) {
        return el.getAttribute("href") || el.getAttribute("src");
    }
    function classify(tag) {
        if (tag === "a")
            return "link <a>";
        if (tag === "button")
            return "button";
        if (tag.charAt(0) === "h")
            return "heading <" + tag + ">";
        if (tag === "p")
            return "para <p>";
        if (tag === "img")
            return "image <img>";
        if (tag === "video")
            return "video";
        if (tag === "iframe")
            return "frame <iframe>";
        return "ref <" + tag + ">";
    }
    // Technical annotations: DOI / ISBN surfaced when the element carries one.
    function findDoi(haystack) {
        const m = haystack.match(/10\.\d{4,}\/[^\s"'<>\]\)]+/);
        if (!m)
            return null;
        return m[0].replace(/[.,;]+$/, "");
    }
    function findIsbn(haystack) {
        const m = haystack.match(/\bISBN(?:-1[03])?[\s:]*([0-9][0-9\s-]{8,}[0-9xX])/i);
        if (!m)
            return null;
        const digits = m[1].replace(/[\s-]/g, "");
        if (digits.length !== 10 && digits.length !== 13)
            return null;
        return digits;
    }
    function shortRef(url) {
        const s = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
        return s.length > 30 ? s.slice(0, 29) + "…" : s;
    }
    function nodeLabelLines(n, full) {
        const head = n.tag + (n.url ? " · " + shortRef(n.url) : "");
        if (!full)
            return [head];
        const hay = (n.url ? n.url + " " : "") + n.text;
        const doi = findDoi(hay);
        if (doi)
            return [head, "doi:" + doi];
        const isbn = findIsbn(hay);
        if (isbn)
            return [head, "isbn:" + isbn];
        return [head];
    }
    function readRect(n) {
        const r = n.el.getBoundingClientRect();
        n.x = r.left;
        n.y = r.top;
        n.w = r.width;
        n.h = r.height;
        n.cx = r.left + r.width / 2;
        n.cy = r.top + r.height / 2;
    }
    function scanDOM() {
        const scope = document.body ?? document;
        const els = scope.querySelectorAll("a, button, h1, h2, h3, h4, p, img, video, iframe, [href], [src]");
        const seen = new Set();
        els.forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4)
                return;
            if (r.bottom < -50 || r.top > H + 50 || r.right < -50 || r.left > W + 50)
                return;
            seen.add(el);
            const existing = nodeByEl.get(el);
            if (!existing) {
                const tag = el.tagName.toLowerCase();
                const n = {
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
            }
            else {
                readRect(existing);
            }
        });
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            if (!seen.has(n.el) || !n.el.isConnected) {
                if (!n.visited)
                    unvisitedCount--;
                nodeByEl.delete(n.el);
                nodes.splice(i, 1);
                if (lastVisitedNode === n)
                    lastVisitedNode = null;
                if (latched === n)
                    latched = null;
            }
        }
        for (let i = edges.length - 1; i >= 0; i--) {
            if (!nodeByEl.has(edges[i].a.el) || !nodeByEl.has(edges[i].b.el))
                edges.splice(i, 1);
        }
    }
    let latched = null; // element under inspection
    let latchUntil = 0;
    function visit(node) {
        if (node.visited)
            return;
        node.visited = true;
        unvisitedCount--;
        if (lastVisitedNode && lastVisitedNode !== node)
            edges.push({ a: lastVisitedNode, b: node });
        lastVisitedNode = node;
        updateStats();
    }
    const lastStats = { d: -1, v: -1, l: -1 };
    function updateStats() {
        const d = nodes.length;
        let v = 0, l = 0;
        for (const n of nodes) {
            if (n.visited)
                v++;
            if (n.url)
                l++;
        }
        if (d !== lastStats.d && statDiscovered) {
            statDiscovered.textContent = String(d);
            lastStats.d = d;
        }
        if (v !== lastStats.v && statVisited) {
            statVisited.textContent = String(v);
            lastStats.v = v;
        }
        if (l !== lastStats.l && statLinks) {
            statLinks.textContent = String(l);
            lastStats.l = l;
        }
    }
    scanDOM();
    updateStats();
    setInterval(() => { scanDOM(); updateStats(); }, 600);
    window.addEventListener("scroll", () => scanDOM(), { passive: true });
    function closestPointOnRect(px, py, t) {
        return {
            x: Math.max(t.x, Math.min(px, t.x + t.w)),
            y: Math.max(t.y, Math.min(py, t.y + t.h)),
        };
    }
    function nodeDistanceToSpider(n) {
        const px = Math.max(n.x, Math.min(spider.x, n.x + n.w));
        const py = Math.max(n.y, Math.min(spider.y, n.y + n.h));
        return Math.hypot(spider.x - px, spider.y - py);
    }
    // --- generative layer: hairlines, chips, the creature ---
    function strokeBox(n, corners) {
        const pad = 2;
        const x = n.x - pad, y = n.y - pad, w = n.w + pad * 2, h = n.h + pad * 2;
        ctx.save();
        ctx.strokeStyle = BOX;
        ctx.lineWidth = 1;
        if (!corners) {
            ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        }
        else {
            // small corner ticks instead of a full frame
            const c = Math.min(7, w / 3, h / 3);
            ctx.beginPath();
            ctx.moveTo(x, y + c);
            ctx.lineTo(x, y);
            ctx.lineTo(x + c, y);
            ctx.moveTo(x + w - c, y);
            ctx.lineTo(x + w, y);
            ctx.lineTo(x + w, y + c);
            ctx.moveTo(x + w, y + h - c);
            ctx.lineTo(x + w, y + h);
            ctx.lineTo(x + w - c, y + h);
            ctx.moveTo(x + c, y + h);
            ctx.lineTo(x, y + h);
            ctx.lineTo(x, y + h - c);
            ctx.stroke();
        }
        ctx.restore();
    }
    function drawLabel(ax, ay, lines) {
        ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
        let w = 0;
        for (const ln of lines)
            w = Math.max(w, ctx.measureText(ln).width);
        w += 10;
        const h = lines.length * 11 + 7;
        let lx = Math.max(4, Math.min(ax - w / 2, W - w - 4));
        let ly = ay - h - 8;
        let stemFromTop = false;
        if (ly < 4) {
            ly = ay + 8;
            stemFromTop = true;
        }
        ctx.save();
        ctx.fillStyle = LABEL_BG;
        ctx.strokeStyle = LABEL_EDGE;
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.rect(lx + 0.5, ly + 0.5, w, h);
        ctx.fill();
        ctx.stroke();
        // hairline stem tying the note to its element
        ctx.strokeStyle = LABEL_EDGE;
        ctx.beginPath();
        if (stemFromTop) {
            ctx.moveTo(ax, ly);
            ctx.lineTo(ax, ay);
        }
        else {
            ctx.moveTo(ax, ly + h);
            ctx.lineTo(ax, ay);
        }
        ctx.stroke();
        ctx.fillStyle = LABEL_FG;
        lines.forEach((ln, i) => ctx.fillText(ln, lx + 5, ly + 12 + i * 11));
        ctx.restore();
    }
    // a silk filament from the spinnerets to an anchor point, near-invisible
    function drawStrand(x1, y1, x2, y2, alpha) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2 + 6;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = STRAND;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo(mx, my, x2, y2);
        ctx.stroke();
        ctx.restore();
    }
    // silk left behind: the web the creature has already spun
    function drawWeb() {
        if (edges.length === 0)
            return;
        ctx.save();
        ctx.strokeStyle = WEB;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        for (const e of edges) {
            ctx.moveTo(e.a.cx, e.a.cy);
            ctx.lineTo(e.b.cx, e.b.cy);
        }
        ctx.stroke();
        ctx.restore();
    }
    function drawCursorReticle(now) {
        if (!mouse.active || now - mouse.lastMove > 3000)
            return;
        ctx.save();
        ctx.globalAlpha = 0.28;
        ctx.strokeStyle = `rgba(${INK},1)`;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = `rgba(${INK},1)`;
        ctx.beginPath();
        ctx.arc(mouse.x, mouse.y, 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    function legPose(side, i, time, moving, inspecting, out) {
        // alternating gait; probing taps when inspecting
        const phase = (i % 2 === 0 ? 0 : Math.PI) + (side > 0 ? Math.PI * 0.9 : 0) + i * 0.55;
        const freq = inspecting ? 2.6 : 9 + spider.speed / 40;
        const t = time * freq + phase;
        const stride = moving ? 2.6 + Math.min(2.4, spider.speed / 160) : 0;
        const lift = inspecting ? Math.max(0, Math.sin(t)) * 1.1 : Math.max(0, Math.sin(t)) * (1.2 + stride * 0.5);
        const swing = Math.cos(t) * stride;
        const rootX = 3.5 - i * 2.6;
        const rootY = side * 2.6;
        const spread = 5.5 + (i === 1 || i === 2 ? 1.6 : 0);
        out.kx = rootX + 1.5 + swing * 0.5;
        out.ky = side * (spread * 0.55) + lift * 0.3;
        out.fx = rootX - 1 + swing + (inspecting && i < 2 ? 1.5 : 0);
        out.fy = side * spread + lift;
    }
    function drawSpider(time, moving, inspecting) {
        spider.bobPhase += 0.016 * (inspecting ? 2.4 : 1.2);
        const bob = Math.sin(spider.bobPhase * 2.1) * (inspecting ? 0.5 : 0.3);
        const pitch = Math.sin(time * 0.004 + 1) * 0.035;
        ctx.save();
        ctx.translate(spider.x, spider.y + bob * 0.4);
        ctx.rotate(spider.angle + pitch);
        ctx.strokeStyle = `rgb(${INK})`;
        ctx.fillStyle = `rgb(${INK})`;
        ctx.lineWidth = 0.9;
        ctx.lineCap = "round";
        // legs first (behind the body), three segments each
        const pose = { kx: 0, ky: 0, fx: 0, fy: 0 };
        for (const side of [-1, 1]) {
            for (let i = 0; i < 4; i++) {
                legPose(side, i, time / 1000, moving, inspecting, pose);
                const rootX = 3.5 - i * 2.6;
                const rootY = side * 2.6;
                ctx.globalAlpha = 0.88;
                ctx.beginPath();
                ctx.moveTo(rootX, rootY);
                ctx.lineTo(pose.kx, pose.ky);
                ctx.lineTo(pose.fx, pose.fy);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
        // abdomen with segments
        ctx.beginPath();
        ctx.ellipse(-4.5, bob * 0.3, 5.2, 3.7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = LABEL_BG;
        ctx.lineWidth = 0.6;
        for (let s = 0; s < 3; s++) {
            ctx.beginPath();
            ctx.ellipse(-6 + s * 2.1, bob * 0.3, 1.1, 3.1, 0.25, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
        // pedicel + cephalothorax
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-0.5, 0);
        ctx.lineTo(1.2, 0);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(3.4, 0, 3.1, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();
        // pedipalps
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(5.6, -1.4);
        ctx.lineTo(7.4, -2.4);
        ctx.moveTo(5.6, 1.4);
        ctx.lineTo(7.4, 2.4);
        ctx.stroke();
        // spinnerets at the rear (where silk comes from)
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(-9.2, -1);
        ctx.lineTo(-10.4, -1.8);
        ctx.moveTo(-9.2, 1);
        ctx.lineTo(-10.4, 1.8);
        ctx.stroke();
        // eyes: two plain dots, no glow
        ctx.fillStyle = LABEL_BG;
        ctx.beginPath();
        ctx.arc(5.2, -0.9, 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(5.2, 0.9, 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    // spinneret tip in world space: silk originates here, not at the center
    function spinneretTip() {
        const c = Math.cos(spider.angle), s = Math.sin(spider.angle);
        return { x: spider.x + c * -10.4, y: spider.y + s * -10.4 };
    }
    function setHud(mode, detail) {
        if (!hudText)
            return;
        const text = mode === "latch" ? `crawling ${detail ?? ""}` :
            mode === "chase" ? "following cursor…" : "spider idle — move your mouse";
        if (hudText.textContent !== text)
            hudText.textContent = text;
    }
    // --- main loop ---
    let last = performance.now();
    function frame(now) {
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        // tour: nearest unvisited node is the crawl target; patrol on cooldowns after
        let autoTarget = null;
        let best = Infinity;
        if (unvisitedCount > 0) {
            for (const n of nodes) {
                if (n.visited)
                    continue;
                const d = nodeDistanceToSpider(n);
                if (d < best) {
                    best = d;
                    autoTarget = n;
                }
            }
        }
        else {
            for (const n of nodes) {
                if (now < n.cooldownUntil)
                    continue;
                const d = nodeDistanceToSpider(n);
                if (d < best) {
                    best = d;
                    autoTarget = n;
                }
            }
        }
        const cursorFresh = mouse.active && (now - mouse.lastMove < 2500);
        const wt = now / 1000;
        const wanderX = Math.sin(wt * 0.9) * 60 + Math.sin(wt * 2.3) * 20;
        const wanderY = Math.cos(wt * 1.1) * 60 + Math.cos(wt * 1.7) * 20;
        let gx, gy;
        if (latched) {
            const a = closestPointOnRect(spider.x, spider.y, latched);
            gx = a.x;
            gy = a.y;
        }
        else if (autoTarget) {
            const a = closestPointOnRect(spider.x, spider.y, autoTarget);
            gx = a.x + wanderX * 0.25;
            gy = a.y + wanderY * 0.25;
        }
        else {
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
        // scurry: speed breathes so travel reads as darts and drifts, not a cruise
        const scurry = Math.max(0.3, 0.62 + 0.28 * Math.sin(wt * 0.63) + 0.18 * Math.sin(wt * 1.71 + 2));
        const desired = Math.min(MAX_SPEED * scurry, dist * 4);
        const ax = dist > 1 ? (dx / dist) * ACCEL : 0;
        const ay = dist > 1 ? (dy / dist) * ACCEL : 0;
        spider.vx += ax * dt;
        spider.vy += ay * dt;
        // faint sideways skitter while travelling
        if (!latched && dist > 4) {
            const px = -dy / dist, py = dx / dist;
            const sk = Math.sin(wt * 6.3 + 1.7) * 60 * dt;
            spider.vx += px * sk;
            spider.vy += py * sk;
        }
        if (latched) {
            // inspecting: come to a full stop on the element
            const damp = 1 - Math.min(1, 9 * dt);
            spider.vx *= damp;
            spider.vy *= damp;
        }
        else {
            spider.vx *= (1 - Math.min(1, 4.2 * dt));
            spider.vy *= (1 - Math.min(1, 4.2 * dt));
            const sp = Math.hypot(spider.vx, spider.vy);
            if (sp > desired) {
                spider.vx = spider.vx / sp * desired;
                spider.vy = spider.vy / sp * desired;
            }
        }
        spider.x += spider.vx * dt;
        spider.y += spider.vy * dt;
        spider.x = Math.max(6, Math.min(W - 6, spider.x));
        spider.y = Math.max(6, Math.min(H - 6, spider.y));
        spider.speed = Math.hypot(spider.vx, spider.vy);
        if (spider.speed > 10) {
            const targetAngle = Math.atan2(spider.vy, spider.vx);
            let d = targetAngle - spider.angle;
            while (d > Math.PI)
                d -= Math.PI * 2;
            while (d < -Math.PI)
                d += Math.PI * 2;
            spider.angle += d * Math.min(1, 12 * dt);
        }
        // --- detection: nearest nodes within sniff radius ---
        const nearest = [];
        for (const n of nodes) {
            const px = Math.max(n.x, Math.min(spider.x, n.x + n.w));
            const py = Math.max(n.y, Math.min(spider.y, n.y + n.h));
            const d = Math.hypot(spider.x - px, spider.y - py);
            if (d < SNIFF_RADIUS)
                nearest.push({ t: n, d });
        }
        nearest.sort((a, b) => a.d - b.d);
        if (latched && now > latchUntil)
            latched = null;
        if (!latched && nearest.length > 0 && nearest[0].d < LATCH_RADIUS) {
            const pick = nearest.find((n) => (!n.t.visited || (unvisitedCount === 0 && now >= n.t.cooldownUntil)) &&
                n.d < LATCH_RADIUS);
            if (pick) {
                latched = pick.t;
                latchUntil = now + 1800 + Math.random() * 900; // inspect a while
                if (unvisitedCount === 0)
                    latched.cooldownUntil = now + 6000;
                visit(latched);
                scanDOM();
            }
        }
        if (latched) {
            readRect(latched);
        }
        // --- paint: the generative layer ---
        ctx.clearRect(0, 0, W, H);
        drawWeb();
        const tip = spinneretTip();
        if (latched) {
            const a = closestPointOnRect(spider.x, spider.y, latched);
            drawStrand(tip.x, tip.y, a.x, a.y, 0.85);
            strokeBox(latched, true);
            drawLabel(latched.cx, latched.y, nodeLabelLines(latched, true));
            setHud("latch", `on ${latched.kind} · ${latched.tag}`);
        }
        else if (nearest.length > 0) {
            const first = nearest[0].t;
            const a = closestPointOnRect(spider.x, spider.y, first);
            drawStrand(tip.x, tip.y, a.x, a.y, 0.4);
            strokeBox(first, false);
            drawLabel(first.cx, first.y, nodeLabelLines(first, false));
            if (nearest.length > 1) {
                const second = nearest[1].t;
                drawLabel(second.cx, second.y, nodeLabelLines(second, false));
            }
            setHud(dist > 30 ? "chase" : "idle");
        }
        else {
            setHud(dist > 30 ? "chase" : "idle");
        }
        drawSpider(now, spider.speed > 25, latched !== null);
        drawCursorReticle(now);
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();
