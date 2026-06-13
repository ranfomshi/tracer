// Core ball-tracking logic. Runs entirely in the browser on canvas pixel data.
//
// Approach: detect-then-fit with a physics prior.
//
//   1. Sample the ball's colour from the user's impact (seed) click — works for
//      a ball that is lighter OR darker than the background.
//   2. For every frame, scan the region of interest for pixels that MOVED since
//      the previous frame AND match the ball's colour, then group them into
//      blobs. Each frame yields a list of candidate positions (not one guess),
//      so a fast ball is never "lost" by a too-small search window.
//   3. Fit a motion model through those candidates, anchored at the impact point
//      (and the landing point, if given):
//          x(t) = vx·t + x0          (≈ constant horizontal speed)
//          y(t) = a·t² + vy·t + y0   (constant downward accel — gravity)
//      In a fixed-camera image a ball under gravity is very close to this
//      parabola-in-time: it decelerates on the way up, hangs at the apex, then
//      accelerates down. Fitting it iteratively (assign nearest candidate →
//      refit) rejects off-trajectory false positives and fills gaps.
//
// Classical CV + a physics model — no downloads, no GPU, fully offline.

export interface TrackPoint {
  frame: number;
  t: number;
  x: number;
  y: number;
  /** Detection support 0..1 (how well a real detection backed this point). */
  confidence: number;
  /** True for the user-placed impact/landing anchors. */
  manual: boolean;
}

export interface TrackOptions {
  /** Frame-difference delta below which a pixel is treated as static (0..255). */
  motionThreshold: number;
  /** Max colour distance (0..441) a pixel may be from the ball template. */
  colorTolerance: number;
  /** Largest blob (in px) still considered a ball candidate, as a fraction of
   *  the search-region area. Bigger blobs (camera shake, people) are dropped. */
  maxBlobFraction: number;
}

export const DEFAULT_OPTIONS: TrackOptions = {
  motionThreshold: 18,
  colorTolerance: 120,
  maxBlobFraction: 0.04,
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Frame {
  frame: number;
  t: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A detected blob: position plus a score (summed motion×colour weight). */
export interface Candidate {
  x: number;
  y: number;
  score: number;
}

/** Result of a trace: the fitted path plus the raw per-frame candidates (for
 *  the debug overlay). `candidates[n]` lines up with frame index n. */
export interface TraceResult {
  points: TrackPoint[];
  candidates: Candidate[][];
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b; // Rec. 601
}

/** Mean RGB of a small patch — the ball's appearance template. */
function sampleColor(f: Frame, cx: number, cy: number, r: number): RGB {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(f.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(f.height - 1, Math.ceil(cy + r));
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * f.width + x) * 4;
      sr += f.data[i];
      sg += f.data[i + 1];
      sb += f.data[i + 2];
      n++;
    }
  }
  return n ? { r: sr / n, g: sg / n, b: sb / n } : { r: 255, g: 255, b: 255 };
}

/**
 * Find candidate ball blobs in one frame: pixels that moved since `prev` and
 * resemble the ball colour, grouped into connected components. Returns the
 * strongest few, ranked by score.
 */
function findCandidates(
  cur: Frame,
  prev: Frame,
  template: RGB,
  opts: TrackOptions,
  roi?: Rect | null,
): Candidate[] {
  const { width, height } = cur;
  const rx0 = roi ? Math.max(0, Math.floor(roi.x)) : 0;
  const ry0 = roi ? Math.max(0, Math.floor(roi.y)) : 0;
  const rx1 = roi ? Math.min(width - 1, Math.ceil(roi.x + roi.w) - 1) : width - 1;
  const ry1 = roi ? Math.min(height - 1, Math.ceil(roi.y + roi.h) - 1) : height - 1;
  const rw = rx1 - rx0 + 1;
  const rh = ry1 - ry0 + 1;
  if (rw <= 0 || rh <= 0) return [];

  // Per-pixel weight for the region (0 = not a ball pixel).
  const weight = new Float32Array(rw * rh);
  for (let y = ry0; y <= ry1; y++) {
    for (let x = rx0; x <= rx1; x++) {
      const i = (y * width + x) * 4;
      const r = cur.data[i];
      const g = cur.data[i + 1];
      const b = cur.data[i + 2];
      const motion = Math.abs(
        luma(r, g, b) - luma(prev.data[i], prev.data[i + 1], prev.data[i + 2]),
      );
      if (motion < opts.motionThreshold) continue;
      const dr = r - template.r;
      const dg = g - template.g;
      const db = b - template.b;
      const sim = 1 - Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / opts.colorTolerance);
      if (sim <= 0) continue;
      weight[(y - ry0) * rw + (x - rx0)] = Math.min(1, motion / 64) * sim;
    }
  }

  // Connected-component labelling (8-connectivity) via an explicit stack.
  const visited = new Uint8Array(rw * rh);
  const stack: number[] = [];
  const cands: Candidate[] = [];
  const maxSize = Math.max(400, Math.floor(rw * rh * opts.maxBlobFraction));

  for (let p = 0; p < rw * rh; p++) {
    if (visited[p] || weight[p] <= 0) continue;
    stack.length = 0;
    stack.push(p);
    visited[p] = 1;
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let size = 0;
    while (stack.length) {
      const q = stack.pop()!;
      const qx = q % rw;
      const qy = (q / rw) | 0;
      const w = weight[q];
      sw += w;
      sx += (qx + rx0) * w;
      sy += (qy + ry0) * w;
      size++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = qx + dx;
          const ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
          const nq = ny * rw + nx;
          if (!visited[nq] && weight[nq] > 0) {
            visited[nq] = 1;
            stack.push(nq);
          }
        }
      }
    }
    if (size > maxSize || sw <= 0) continue; // ignore huge motion regions
    cands.push({ x: sx / sw, y: sy / sw, score: sw });
  }

  cands.sort((a, b) => b.score - a.score);
  return cands.slice(0, 6);
}

/** Weighted least-squares slope m for v = m·t + c0 (c0 fixed = anchor). */
function fitLinear(s: { t: number; v: number; w: number }[], c0: number): number {
  let num = 0;
  let den = 0;
  for (const p of s) {
    num += p.w * p.t * (p.v - c0);
    den += p.w * p.t * p.t;
  }
  return den > 1e-9 ? num / den : 0;
}

/** Weighted least-squares a,b for v = a·t² + b·t + c0 (c0 fixed = anchor). */
function fitQuad(
  s: { t: number; v: number; w: number }[],
  c0: number,
): { a: number; b: number } {
  let St4 = 0;
  let St3 = 0;
  let St2 = 0;
  let Sr2 = 0;
  let Sr1 = 0;
  for (const p of s) {
    const t = p.t;
    const w = p.w;
    const r = p.v - c0;
    const t2 = t * t;
    St4 += w * t2 * t2;
    St3 += w * t2 * t;
    St2 += w * t2;
    Sr2 += w * t2 * r;
    Sr1 += w * t * r;
  }
  const det = St4 * St2 - St3 * St3;
  if (Math.abs(det) < 1e-9) {
    // Not enough curvature info — fall back to a straight line.
    return { a: 0, b: St2 > 1e-9 ? Sr1 / St2 : 0 };
  }
  return {
    a: (Sr2 * St2 - Sr1 * St3) / det,
    b: (St4 * Sr1 - St3 * Sr2) / det,
  };
}

/**
 * Trace the ball across consecutive frames (frames[0] is the impact/seed
 * frame). Returns the fitted physics path plus per-frame candidates.
 */
export function trackBall(
  frames: Frame[],
  seed: { x: number; y: number },
  opts: TrackOptions = DEFAULT_OPTIONS,
  roi?: Rect | null,
  end?: { x: number; y: number } | null,
): TraceResult {
  if (frames.length === 0) return { points: [], candidates: [] };

  const template = sampleColor(frames[0], seed.x, seed.y, 3);
  const N = frames.length;
  const tEnd = N - 1;

  const candidates: Candidate[][] = [[]];
  for (let n = 1; n < N; n++) {
    candidates.push(findCandidates(frames[n], frames[n - 1], template, opts, roi));
  }

  // Model anchored at the seed (t=0): x = mx·t + seed.x, y = ay·t² + by·t + seed.y
  let mx = 0;
  let ay = 0;
  let by = 0;
  if (end && tEnd > 0) {
    mx = (end.x - seed.x) / tEnd;
    by = (end.y - seed.y) / tEnd; // straight start; curvature comes from fit
  }

  const diag = Math.hypot(frames[0].width, frames[0].height);

  // Iteratively assign the nearest in-gate candidate per frame, then refit.
  for (let iter = 0; iter < 8; iter++) {
    const sx: { t: number; v: number; w: number }[] = [{ t: 0, v: seed.x, w: 50 }];
    const sy: { t: number; v: number; w: number }[] = [{ t: 0, v: seed.y, w: 50 }];
    if (end) {
      sx.push({ t: tEnd, v: end.x, w: 50 });
      sy.push({ t: tEnd, v: end.y, w: 50 });
    }
    const gate = Math.max(diag * 0.05, diag * (0.13 - 0.009 * iter));
    for (let n = 1; n < N; n++) {
      if (end && n === tEnd) continue; // landing is already anchored
      const predX = mx * n + seed.x;
      const predY = ay * n * n + by * n + seed.y;
      let best: Candidate | null = null;
      let bestD = gate;
      for (const c of candidates[n]) {
        const d = Math.hypot(c.x - predX, c.y - predY);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best) {
        sx.push({ t: n, v: best.x, w: best.score });
        sy.push({ t: n, v: best.y, w: best.score });
      }
    }
    mx = fitLinear(sx, seed.x);
    const q = fitQuad(sy, seed.y);
    ay = q.a;
    by = q.b;
  }

  // Sample the fitted model per frame; mark confidence where a candidate backs it.
  const points: TrackPoint[] = [];
  for (let n = 0; n < N; n++) {
    const x = mx * n + seed.x;
    const y = ay * n * n + by * n + seed.y;
    let support = 0;
    if (n > 0) {
      for (const c of candidates[n]) {
        if (Math.hypot(c.x - x, c.y - y) < diag * 0.04) {
          support = Math.max(support, Math.min(1, c.score));
        }
      }
    }
    points.push({
      frame: frames[n].frame,
      t: frames[n].t,
      x,
      y,
      confidence: n === 0 ? 1 : support,
      manual: n === 0,
    });
  }

  if (end && points.length > 1) {
    const last = points[points.length - 1];
    last.x = end.x;
    last.y = end.y;
    last.confidence = 1;
    last.manual = true;
  }

  return { points, candidates };
}
