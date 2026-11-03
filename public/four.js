// Two canvas pieces drawn with real 3D and 4D geometry:
// - a tesseract (4D cube) that unfolds out of a plain cube, then turns through the fourth dimension;
// - an x-ray flower that blooms in 3D, while a slow rotation through a fourth axis makes it breathe.
// Both run only while on screen, and stand still for people who ask for less motion.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Sizes a canvas to its box, draws a scene in fixed logical units, and animates while visible.
function stage(canvas, logicalWidth, logicalHeight, draw) {
  let visible = false;
  let started = 0;
  let scale = 1;
  const resize = () => {
    const ratio = devicePixelRatio || 1;
    const width = canvas.clientWidth;
    if (!width) return;
    scale = width / logicalWidth;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(logicalHeight * scale * ratio);
    canvas.style.height = `${logicalHeight * scale}px`;
    frame(performance.now(), true);
  };
  const frame = (now, once = false) => {
    if (!once && (!visible || document.hidden)) return;
    const ctx = canvas.getContext('2d');
    const ratio = devicePixelRatio || 1;
    ctx.setTransform(scale * ratio, 0, 0, scale * ratio, 0, 0);
    ctx.clearRect(0, 0, logicalWidth, logicalHeight);
    draw(ctx, started ? (now - started) / 1000 : 0);
  };
  let last = 0;
  const loop = (now) => {
    if (now - last > 33) { frame(now); last = now; }
    requestAnimationFrame(loop);
  };
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible && !started) started = performance.now();
  }, { threshold: 0.2 }).observe(canvas);
  if (!reducedMotion) requestAnimationFrame(loop);
  return { still: () => reducedMotion };
}

const ease = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

// Ink colours follow the page theme, so labels stay readable in dark mode.
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ink = (alpha) => `rgba(${cssVar('--ink')}, ${alpha})`;

function rotate(a, b, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [a * c - b * s, a * s + b * c];
}

/* Tesseract */
export function tesseract() {
  const canvas = document.createElement('canvas');
  canvas.className = 'tesseract';
  canvas.setAttribute('aria-hidden', 'true');
  const vertices = [];
  for (let i = 0; i < 16; i += 1) vertices.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
  const edges = [];
  for (let i = 0; i < 16; i += 1) for (let bit = 1; bit < 16; bit <<= 1) if (!(i & bit)) edges.push([i, i | bit]);
  // Dust floating inside the hypercube, so its cells read as glass full of light.
  let seed = 11;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
  const dust = Array.from({ length: 140 }, () => [random(), random(), random(), random()]);

  const project = ([x, y, z, w], t, unfold) => {
    w *= unfold; // at 0 the fourth axis is flat and the shape is an ordinary cube
    [x, w] = rotate(x, w, t * 0.55);
    [y, w] = rotate(y, w, t * 0.31);
    [z, w] = rotate(z, w, t * 0.17);
    const k4 = 2.6 / (2.6 - w * 0.9);
    let [px, py, pz] = [x * k4, y * k4, z * k4];
    [px, pz] = rotate(px, pz, 0.6 + t * 0.12);
    [py, pz] = rotate(py, pz, -0.42);
    const k3 = 5 / (5 - pz);
    return [200 + px * k3 * 62, 160 + py * k3 * 62, pz, w];
  };

  stage(canvas, 400, 320, (ctx, seconds) => {
    const t = reducedMotion ? 1.2 : seconds;
    const unfold = reducedMotion ? 1 : ease((seconds - 0.3) / 2.2);
    const points = vertices.map((v) => project(v, t, unfold));
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(155, 77, 255, .45)';
    for (const [a, b] of edges) {
      const depth = (points[a][2] + points[b][2]) / 2;
      ctx.strokeStyle = `rgba(${Math.round(110 + depth * 18)}, 80, 255, ${(0.45 + (depth + 3) * 0.1).toFixed(2)})`;
      ctx.lineWidth = 1.1 + (depth + 3) * 0.12;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(points[a][0], points[a][1]);
      ctx.lineTo(points[b][0], points[b][1]);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    for (const d of dust) {
      const [x, y] = project(d, t, unfold);
      ctx.fillStyle = 'rgba(255, 95, 168, .55)';
      ctx.fillRect(x - 0.7, y - 0.7, 1.4, 1.4);
    }
    ctx.shadowBlur = 12;
    for (const [x, y] of points) {
      ctx.fillStyle = '#6c4dff';
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  });
  return canvas;
}

/* Moon */
// The brand mark as particles: a sphere of dots lit from one side, so only a crescent shows. The
// light slowly swings round, so the phase waxes and wanes, and dust drifts off the bright edge.
// A ring of dots circles it, like the gateway's loop of jobs.
export function particleMoon() {
  const canvas = document.createElement('canvas');
  canvas.className = 'night-moon';
  canvas.setAttribute('aria-hidden', 'true');
  let seed = 31;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const W = 700;
  const H = 860;
  const CENTER = [370, 430];
  const R = 205;
  // Points spread evenly over the sphere (a Fibonacci lattice), each with a little jitter.
  const COUNT = 3200;
  const sphere = Array.from({ length: COUNT }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / COUNT;
    const r = Math.sqrt(1 - y * y);
    const theta = i * Math.PI * (3 - Math.sqrt(5));
    return { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r, size: 0.7 + random() * 1.9, j: random() };
  });
  const ring = Array.from({ length: 520 }, () => ({ a: random() * Math.PI * 2, spread: (random() - 0.5) * 18, size: 0.5 + random() * 1.4 }));
  const dust = Array.from({ length: 900 }, () => {
    const u = random() * 2 - 1;
    const t = random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    return { x: Math.cos(t) * r, y: u, z: Math.sin(t) * r, life: random(), size: 0.5 + random() * 1.8 };
  });
  // Purple at the top, pink across the middle, blue at the bottom, as in the logo.
  const STOPS = [[139, 61, 255], [224, 91, 208], [90, 160, 255]];
  const color = (t, alpha) => {
    const p = Math.min(1.999, Math.max(0, t) * 2);
    const c0 = STOPS[Math.floor(p)];
    const c1 = STOPS[Math.floor(p) + 1];
    const f = p - Math.floor(p);
    return `rgba(${Math.round(c0[0] + (c1[0] - c0[0]) * f)}, ${Math.round(c0[1] + (c1[1] - c0[1]) * f)}, ${Math.round(c0[2] + (c1[2] - c0[2]) * f)}, ${alpha.toFixed(3)})`;
  };

  stage(canvas, W, H, (ctx, seconds) => {
    const time = reducedMotion ? 0 : seconds;
    const spin = time * 0.12;
    // Light from the upper left, swinging slowly: the crescent grows and thins.
    const swing = Math.sin(time * 0.18);
    const light = [-0.9, -0.3, 0.02 + swing * 0.22]; // from the left and a little behind, like the logo's crescent
    const len = Math.hypot(...light);
    const L = light.map((v) => v / len);
    const view = (x, y, z) => {
      const [rx, rz] = rotate(x, z, spin);
      const [ry, rz2] = rotate(y, rz, -0.18);
      return [rx, ry, rz2];
    };
    const project = (x, y, z, radius = R) => {
      const k = 1100 / (1100 - z * radius);
      return [CENTER[0] + x * radius * k, CENTER[1] + y * radius * k, k];
    };

    // Back half of the ring first, so the moon sits inside it.
    const ringPoint = (p) => {
      const ang = p.a + time * 0.25;
      let x = Math.cos(ang) * 1.55;
      let z = Math.sin(ang) * 1.55;
      let y = p.spread / R;
      [y, z] = rotate(y, z, 1.18);
      [x, y] = rotate(x, y, -0.32);
      return [x, y, z];
    };
    const drawRing = (front) => {
      for (const p of ring) {
        const [x, y, z] = ringPoint(p);
        if ((z > 0) !== front) continue;
        const [sx, sy, k] = project(x, y, z);
        ctx.fillStyle = color(0.5 + y * 0.4, 0.3 + (z + 1.6) * 0.16);
        ctx.fillRect(sx, sy, p.size * k, p.size * k);
      }
    };
    drawRing(false);

    for (const p of sphere) {
      const [x, y, z] = view(p.x, p.y, p.z);
      const lit = p.x * L[0] + p.y * L[1] + p.z * L[2];
      if (z < -0.15) continue; // the far side stays empty
      const glow = Math.max(0, Math.min(1, (lit + 0.05) * 1.6)); // the dark side keeps a faint earthshine
      const [sx, sy, k] = project(x, y, z);
      ctx.fillStyle = color((y + 1) / 2, 0.06 + glow * 0.86);
      ctx.beginPath();
      ctx.arc(sx, sy, p.size * k * (0.6 + glow * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }

    // Dust leaves from the bright limb, drifts outward and fades.
    for (const d of dust) {
      const lit = d.x * L[0] + d.y * L[1] + d.z * L[2];
      if (lit < 0.1) continue;
      const life = (d.life + time * 0.06) % 1;
      const reach = 1 + life * 0.45;
      const [x, y, z] = view(d.x * reach, d.y * reach, d.z * reach);
      if (z < -0.2) continue;
      const [sx, sy, k] = project(x, y, z);
      ctx.fillStyle = color((y + 1) / 2, (1 - life) * 0.5 * Math.min(1, lit * 2));
      ctx.beginPath();
      ctx.arc(sx, sy, d.size * k * (1 - life * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    drawRing(true);
  });
  return canvas;
}

/* Flower */
// `labels` are the three callouts: the head, the first leaf and the second leaf.
export function bloomingFlower(labels) {
  const canvas = document.createElement('canvas');
  canvas.className = 'bloom';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `An x-ray flower blooming. ${labels.map((l) => l.join(' ')).join('. ')}.`);
  const RINGS = [[7, 150, 62, 0, 0], [9, 112, 50, 0.35, 0.18], [11, 74, 34, 0.14, 0.36]]; // count, length, width, turn, delay
  const HEAD = [300, 225];

  // A point on one petal, in 3D around the flower head. u runs base to tip, v runs edge to edge.
  function petalPoint(phi, length, width, open, u, v, t) {
    const lift = (1 - open) * 1.35 + open * 0.12 + Math.sin(t * 0.8 + phi) * 0.04; // upright bud to wide open
    const radial = [Math.cos(phi), 0, Math.sin(phi)];
    const dir = [radial[0] * Math.cos(lift), -Math.sin(lift), radial[2] * Math.cos(lift)];
    const side = [-Math.sin(phi), 0, Math.cos(phi)];
    const half = width * Math.sin(Math.PI * Math.min(1, u * 1.05)) ** 0.8 * (1 - 0.25 * u);
    const cup = (u * u) * length * 0.18 * (1 - Math.abs(v) * 0.4);
    let x = dir[0] * length * u + side[0] * half * v;
    let y = dir[1] * length * u - cup;
    let z = dir[2] * length * u + side[2] * half * v;
    // The fourth axis: each petal carries a w that rotates into x, so the bloom folds and breathes.
    let w = Math.sin(phi * 3 + u * 2.4) * length * 0.35 * open;
    [x, w] = rotate(x, w, Math.sin(t * 0.35) * 0.6);
    const k4 = 900 / (900 - w);
    return [x * k4, y * k4, z * k4];
  }

  const view = (p, t) => {
    let [x, y, z] = p;
    [x, z] = rotate(x, z, t * 0.25);
    [y, z] = rotate(y, z, -0.95); // look down into the open flower
    const k = 700 / (700 - z);
    return [HEAD[0] + x * k, HEAD[1] + y * k, z];
  };

  const callout = (ctx, anchor, box, labelAt, lines) => {
    ctx.strokeStyle = ink(0.4);
    ctx.setLineDash([2, 3]);
    ctx.strokeRect(anchor[0] - box / 2, anchor[1] - box / 2, box, box);
    ctx.setLineDash([]);
    ctx.strokeStyle = ink(0.3);
    ctx.beginPath();
    ctx.moveTo(anchor[0] + (labelAt[0] < anchor[0] ? -box / 2 : box / 2), anchor[1] - box / 2);
    ctx.lineTo(labelAt[0], labelAt[1]);
    ctx.stroke();
    ctx.fillStyle = cssVar('--ink-label');
    ctx.font = '12px "JetBrains Mono", monospace';
    ctx.textAlign = labelAt[0] < anchor[0] ? 'right' : 'left';
    const x = labelAt[0] + (labelAt[0] < anchor[0] ? -6 : 6);
    lines.forEach((line, i) => ctx.fillText(line, x, labelAt[1] - 2 + i * 15));
  };

  stage(canvas, 600, 640, (ctx, seconds) => {
    const t = reducedMotion ? 2 : seconds;
    ctx.fillStyle = cssVar('--ink-faint');
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('NOCTURN.SPECIMEN', 24, 34);
    ctx.textAlign = 'right';
    ctx.fillText('BLOOM // 4D', 576, 34);

    // Stem and leaves sway gently; the leaves unfurl a little after the head starts to open.
    const sway = Math.sin(t * 0.9) * 6;
    ctx.shadowColor = 'rgba(155, 77, 255, .35)';
    ctx.shadowBlur = 6;
    ctx.strokeStyle = 'rgba(108, 77, 255, .7)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(HEAD[0], HEAD[1] + 20);
    ctx.bezierCurveTo(HEAD[0] + 14 + sway, 400, HEAD[0] - 22 + sway * 0.5, 500, HEAD[0] + 6, 630);
    ctx.stroke();
    const leafOpen = reducedMotion ? 1 : ease((seconds - 0.8) / 2);
    const leaf = (bx, by, dir, len) => {
      const tip = [bx + dir * len * leafOpen, by - 30 * leafOpen - 4];
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo((bx + tip[0]) / 2, by - 50 * leafOpen, tip[0], tip[1]);
      ctx.quadraticCurveTo((bx + tip[0]) / 2, by + 6, bx, by);
      ctx.fillStyle = 'rgba(79, 182, 255, .14)';
      ctx.fill();
      ctx.lineWidth = 0.9;
      ctx.strokeStyle = 'rgba(79, 140, 255, .65)';
      ctx.stroke();
      return [(bx + tip[0]) / 2, (by + tip[1]) / 2];
    };
    const leafA = leaf(HEAD[0] - 4 + sway * 0.6, 470, -1, 110);
    const leafB = leaf(HEAD[0] + 2 + sway * 0.3, 540, 1, 115);

    // Petals: built per ring, opening outer ring first, drawn back to front.
    const shapes = [];
    for (const [count, length, width, turn, delay] of RINGS) {
      const open = reducedMotion ? 1 : ease((seconds - delay) / 2.6);
      for (let i = 0; i < count; i += 1) {
        const phi = (i / count) * Math.PI * 2 + turn;
        const outline = [];
        for (let s = 0; s <= 12; s += 1) outline.push(view(petalPoint(phi, length, width, open, s / 12, -1, t), t));
        for (let s = 12; s >= 0; s -= 1) outline.push(view(petalPoint(phi, length, width, open, s / 12, 1, t), t));
        const vein = [0, 0.5, 0.95].map((u) => view(petalPoint(phi, length, width, open, u, 0, t), t));
        shapes.push({ outline, vein, depth: outline.reduce((sum, p) => sum + p[2], 0) / outline.length });
      }
    }
    shapes.sort((a, b) => a.depth - b.depth);
    ctx.shadowBlur = 8;
    for (const { outline, vein, depth } of shapes) {
      ctx.beginPath();
      outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = `rgba(${depth > 0 ? '255, 95, 168' : '155, 77, 255'}, ${(0.07 + Math.max(0, depth) / 1400).toFixed(3)})`;
      ctx.fill();
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = 'rgba(108, 77, 255, .55)';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(vein[0][0], vein[0][1]);
      ctx.quadraticCurveTo(vein[1][0], vein[1][1], vein[2][0], vein[2][1]);
      ctx.strokeStyle = 'rgba(108, 77, 255, .25)';
      ctx.stroke();
    }
    const core = ctx.createRadialGradient(HEAD[0], HEAD[1], 0, HEAD[0], HEAD[1], 26);
    core.addColorStop(0, 'rgba(255, 95, 168, .9)');
    core.addColorStop(1, 'rgba(155, 77, 255, 0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(HEAD[0], HEAD[1], 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    callout(ctx, HEAD, 100, [146, 120], labels[0]);
    callout(ctx, leafA, 60, [150, 420], labels[1]);
    callout(ctx, leafB, 60, [450, 470], labels[2]);
  });
  return canvas;
}
