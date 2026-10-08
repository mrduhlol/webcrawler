"use strict";
// Neon web crawler — overlay paint + single-page crawling engine.
// The underlying page DOM is never modified (nodes keyed by element object).
// Build with `npm run build` (emits dist/spider.js). Do not edit dist by hand.
(() => {
    const canvasEl = document.getElementById("crawler-overlay");
    if (!(canvasEl instanceof HTMLCanvasElement))
        throw new Error("missing #crawler-overlay");
    const canvas = canvasEl;
    const rawCtx = canvas.getContext("2d");
    if (!rawCtx)
        throw new Error("no 2d context");
    const ctx = rawCtx;
    // HUD / stats pills are not on the page; refs stay optional for tests.
    const hudText = document.getElementById("hud-text");
    const statDiscovered = document.getElementById("stat-discovered");
    const statVisited = document.getElementById("stat-visited");
    const statLinks = document.getElementById("stat-links");
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
    // --- input: plain cursor, faint tug on the creature ---
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
    const spider = {
        x: W * 0.3, y: H * 0.3,
        vx: 0, vy: 0,
        angle: 0,
        speed: 0,
        pulse: Math.random() * 10,
    };
    const SNIFF_RADIUS = 260;
    const LATCH_RADIUS = 140;
    const MAX_SPEED = 520;
    const ACCEL = 2200;
    const CURSOR_PULL = 0.18;
    // neon palette on near-black
    const CYAN = "#2ee6ff";
    const BLUE = "#4f7cff";
    const MAGENTA = "#ff2ea6";
    const ORANGE = "#ff8a2a";
    const GREEN = "#7cff6b";
    const YELLOW = "#ffd23f";
    const VIOLET = "#8a63ff";
    const THREADS = [CYAN, MAGENTA, ORANGE, GREEN, BLUE, YELLOW];
    function kindHue(tag) {
        if (tag === "a")
            return CYAN;
        if (tag === "li")
            return BLUE;
        if (tag.charAt(0) === "h")
            return MAGENTA;
        if (tag === "p")
            return "#3f8cff";
        if (tag === "img" || tag === "button" || tag === "video")
            return GREEN;
        return VIOLET;
    }
    // --- crawling engine: node graph for the current page ---
    const nodeByEl = new Map();
    const nodes = [];
    const edges = [];
    let nodeSeq = 0;
    let lastVisitedNode = null;
    let unvisitedCount = 0;
    function elementText(el) {
        const htmlEl = el;
        const imgEl = el;
        const inputEl = el;
        const t = (htmlEl.innerText || imgEl.alt || inputEl.value || htmlEl.title || "")
            .trim().replace(/\s+/g, " ");
        return t.slice(0, 120);
    }
    function elementUrl(el) {
        return el.getAttribute("href") || el.getAttribute("src");
    }
    function classify(tag) {
        if (tag === "a")
            return "link <a>";
        if (tag === "button")
            return "button";
        if (tag === "li")
            return "cite <li>";
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
    // identifiers the video calls out: DOI, ISBN, OCLC, PMID, S2CID, ISSN
    function nodeIdentifiers(n) {
        const hay = (n.url ? n.url + " " : "") + n.text;
        const out = [];
        const doi = hay.match(/10\.\d{4,}\/[^\s"'<>\]\)]+/);
        if (doi)
            out.push({ label: "doi", value: doi[0].replace(/[.,;]+$/, ""), color: YELLOW });
        const isbn = hay.match(/\bISBN(?:-1[03])?[\s:]*([0-9][0-9\s-]{8,}[0-9xX])/i);
        if (isbn) {
            const digits = isbn[1].replace(/[\s-]/g, "");
            if (digits.length === 10 || digits.length === 13)
                out.push({ label: "isbn", value: digits, color: CYAN });
        }
        const oclc = hay.match(/\bOCLC\s+(\d{4,})/i);
        if (oclc)
            out.push({ label: "oclc", value: oclc[1], color: ORANGE });
        const pmid = hay.match(/\bPMID\s*:?\s*(\d{4,})/i);
        if (pmid)
            out.push({ label: "pmid", value: pmid[1], color: GREEN });
        const s2cid = hay.match(/\bS2CID\s+(\d{4,})/i);
        if (s2cid)
            out.push({ label: "s2cid", value: s2cid[1], color: ORANGE });
        const issn = hay.match(/\bISSN\s+(\d{4}-\d{3}[\dxX])/i);
        if (issn)
            out.push({ label: "issn", value: issn[1], color: GREEN });
        return out.slice(0, 3);
    }
    function shortRef(url) {
        const s = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
        return s.length > 30 ? s.slice(0, 29) + "…" : s;
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
        const els = scope.querySelectorAll("a, button, h1, h2, h3, h4, p, img, video, iframe, li, [href], [src]");
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
    let latched = null;
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
    // --- neon layer ---
    function roundRectPath(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }
    function neonBox(n, color, filled) {
        const pad = 3;
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = filled ? 18 : 12;
        if (filled) {
            ctx.globalAlpha = 0.28;
            ctx.fillStyle = color;
            roundRectPath(n.x - pad, n.y - pad, n.w + pad * 2, n.h + pad * 2, 6);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = filled ? 2.2 : 1.6;
        roundRectPath(n.x - pad, n.y - pad, n.w + pad * 2, n.h + pad * 2, 6);
        ctx.stroke();
        ctx.restore();
    }
    // bright dots sitting on the identifier tokens inside an element
    function identifierDots(n, ids) {
        if (ids.length === 0)
            return;
        ctx.save();
        ids.forEach((idn, k) => {
            const fx = 0.14 + 0.36 * k + ((n.id + k) % 5) * 0.03;
            const fy = n.cy + (((n.id + k) % 3) - 1) * n.h * 0.16;
            const dx = Math.max(n.x + 2, Math.min(n.x + n.w * Math.min(0.95, fx), n.x + n.w - 2));
            ctx.shadowColor = idn.color;
            ctx.shadowBlur = 8;
            ctx.fillStyle = idn.color;
            ctx.beginPath();
            ctx.arc(dx, fy, 2, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.restore();
    }
    function tinyTag(x, y, text, color) {
        ctx.save();
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.shadowColor = color;
        ctx.shadowBlur = 6;
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
        ctx.restore();
    }
    // signature look: the identifier value on a rotated bright chip
    function rotatedChip(cx, cy, text, color) {
        ctx.save();
        ctx.font = "bold 10px ui-monospace, Menlo, monospace";
        const tw = ctx.measureText(text).width;
        const w = tw + 12, h = 20;
        ctx.translate(cx, cy);
        ctx.rotate(-1.25);
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
        ctx.fillStyle = color;
        roundRectPath(-w / 2, -h / 2, w, h, 4);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#06070c";
        ctx.fillText(text, -tw / 2, 3.5);
        ctx.restore();
    }
    function thread(x1, y1, x2, y2, color, alpha) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x2, y2, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    function drawWeb() {
        if (edges.length === 0)
            return;
        ctx.save();
        ctx.strokeStyle = "rgba(90,100,255,0.22)";
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (const e of edges) {
            ctx.moveTo(e.a.cx, e.a.cy);
            ctx.lineTo(e.b.cx, e.b.cy);
        }
        ctx.stroke();
        ctx.restore();
    }
    function drawSpider(time, moving, inspecting) {
        spider.pulse += 0.016 * 5;
        const glow = 14 + Math.sin(spider.pulse) * 5 + (inspecting ? 6 : 0) + (moving ? 4 : 0);
        const bob = Math.sin(time * 0.004) * 1.2;
        ctx.save();
        ctx.translate(spider.x, spider.y + bob * 0.3);
        ctx.rotate(spider.angle);
        ctx.lineCap = "round";
        // 8 long straight neon legs, fanned front-to-back, dotted joints.
        // Front pair reaches far ahead, rear pair trails behind, like the video.
        const stepFreq = 7 + spider.speed / 40;
        for (let side = -1; side <= 1; side += 2) {
            for (let i = 0; i < 4; i++) {
                const phase = (i % 2 === 0 ? 0 : Math.PI) + (side > 0 ? Math.PI * 0.9 : 0) + i * 0.5;
                const t = (time / 1000) * stepFreq + phase;
                const stride = moving ? 5 + Math.min(4, spider.speed / 90) : 0;
                const swing = Math.cos(t) * stride;
                const lift = Math.max(0, Math.sin(t)) * (moving ? 3.2 : 1.2);
                // base fan angle per leg: front legs forward, rear legs swept back
                const fan = (side * (22 + i * 30) * Math.PI) / 180;
                const rootX = 6 - i * 5;
                const rootY = side * 4.5;
                const femur = 24;
                const tibia = 30;
                const kx = rootX + Math.cos(fan) * femur + swing * 0.5;
                const ky = rootY + Math.sin(fan) * femur * 0.6 + lift * 0.4;
                const fx = kx + Math.cos(fan) * tibia + swing;
                const fy = ky + Math.sin(fan) * tibia * 0.6 + lift;
                ctx.save();
                ctx.shadowColor = BLUE;
                ctx.shadowBlur = 7;
                ctx.strokeStyle = "#5b6cff";
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(rootX, rootY);
                ctx.lineTo(kx, ky);
                ctx.lineTo(fx, fy);
                ctx.stroke();
                // pink knee, cyan tip — the video's dotted joints
                ctx.shadowColor = MAGENTA;
                ctx.shadowBlur = 7;
                ctx.fillStyle = MAGENTA;
                ctx.beginPath();
                ctx.arc(kx, ky, 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowColor = CYAN;
                ctx.fillStyle = CYAN;
                ctx.beginPath();
                ctx.arc(fx, fy, 2.4, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        }
        // big stacked body: dark cyan-outlined abdomen, blue mid, bright head
        ctx.save();
        ctx.shadowColor = CYAN;
        ctx.shadowBlur = glow;
        ctx.fillStyle = "#0e2233";
        roundRectPath(-21, -6.5, 14, 13, 6.5);
        ctx.fill();
        ctx.strokeStyle = CYAN;
        ctx.lineWidth = 1.6;
        roundRectPath(-21, -6.5, 14, 13, 6.5);
        ctx.stroke();
        // abdomen segments
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = CYAN;
        ctx.lineWidth = 1;
        for (let s = 0; s < 3; s++) {
            ctx.beginPath();
            ctx.moveTo(-18 + s * 3.6, -5.4);
            ctx.quadraticCurveTo(-19.5 + s * 3.6, 0, -18 + s * 3.6, 5.4);
            ctx.stroke();
        }
        ctx.restore();
        ctx.shadowColor = BLUE;
        ctx.fillStyle = "#141b4a";
        roundRectPath(-7.5, -5, 11, 10, 5);
        ctx.fill();
        ctx.strokeStyle = "#5b6cff";
        ctx.lineWidth = 1.4;
        roundRectPath(-7.5, -5, 11, 10, 5);
        ctx.stroke();
        // bright head + amber core, like the video's glowing dot
        ctx.shadowColor = CYAN;
        ctx.shadowBlur = glow + 6;
        ctx.fillStyle = "#d9fbff";
        ctx.beginPath();
        ctx.arc(8, 0, 4.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#ffb02e";
        ctx.beginPath();
        ctx.arc(8, 0, 1.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.restore();
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
        // tour: nearest unvisited node; patrol on cooldowns once covered
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
        const scurry = Math.max(0.3, 0.62 + 0.28 * Math.sin(wt * 0.63) + 0.18 * Math.sin(wt * 1.71 + 2));
        const desired = Math.min(MAX_SPEED * scurry, dist * 4);
        const ax = dist > 1 ? (dx / dist) * ACCEL : 0;
        const ay = dist > 1 ? (dy / dist) * ACCEL : 0;
        spider.vx += ax * dt;
        spider.vy += ay * dt;
        if (!latched && dist > 4) {
            const px = -dy / dist, py = dx / dist;
            const sk = Math.sin(wt * 6.3 + 1.7) * 60 * dt;
            spider.vx += px * sk;
            spider.vy += py * sk;
        }
        if (latched) {
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
        spider.x = Math.max(8, Math.min(W - 8, spider.x));
        spider.y = Math.max(8, Math.min(H - 8, spider.y));
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
                latchUntil = now + 1800 + Math.random() * 900;
                if (unvisitedCount === 0)
                    latched.cooldownUntil = now + 6000;
                visit(latched);
                scanDOM();
            }
        }
        if (latched) {
            readRect(latched);
        }
        // --- paint: the neon layer ---
        ctx.clearRect(0, 0, W, H);
        drawWeb();
        // radiating threads to everything nearby, endpoint dots on the elements
        const show = nearest.slice(0, 6);
        show.forEach((n, i) => {
            if (latched && n.t === latched)
                return;
            const color = THREADS[i % THREADS.length];
            const a = closestPointOnRect(spider.x, spider.y, n.t);
            thread(spider.x, spider.y, a.x, a.y, color, n.t.visited ? 0.35 : 0.75);
        });
        // neon boxes + identifier dots + tiny tags on the nearest few
        show.slice(0, 3).forEach((n) => {
            const hue = kindHue(n.t.tag);
            const ids = nodeIdentifiers(n.t);
            neonBox(n.t, hue, false);
            identifierDots(n.t, ids);
            const head = n.t.tag + (n.t.url ? " · " + shortRef(n.t.url) : "");
            tinyTag(n.t.x, Math.max(10, n.t.y - 6), head, hue);
        });
        if (latched) {
            const hue = MAGENTA;
            const ids = nodeIdentifiers(latched);
            neonBox(latched, hue, true);
            identifierDots(latched, ids);
            const chipText = ids.length > 0 ? `${ids[0].label}:${ids[0].value}` : latched.kind;
            rotatedChip(latched.cx, latched.y - 26, chipText.slice(0, 34), ids.length > 0 ? ids[0].color : CYAN);
            tinyTag(latched.x, Math.max(10, latched.y - 6), latched.kind, hue);
            setHud("latch", `on ${latched.kind} · ${latched.tag}`);
        }
        else {
            setHud(dist > 30 ? "chase" : "idle");
        }
        drawSpider(now, spider.speed > 25, latched !== null);
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
})();
