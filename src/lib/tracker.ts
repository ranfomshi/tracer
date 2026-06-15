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

/** A user-placed anchor the path must pass through (0 = impact frame). */
export interface Anchor {
  n: number;
  x: number;
  y: number;
}

type Sample = { t: number; v: number; w: number };

/** Weighted least squares for v = m·t + b. */
function fitLinear(s: Sample[]): { m: number; b: number } {
  let Sw = 0;
  let St = 0;
  let St2 = 0;
  let Sv = 0;
  let Stv = 0;
  for (const p of s) {
    Sw += p.w;
    St += p.w * p.t;
    St2 += p.w * p.t * p.t;
    Sv += p.w * p.v;
    Stv += p.w * p.t * p.v;
  }
  const det = St2 * Sw - St * St;
  if (Math.abs(det) < 1e-9) return { m: 0, b: Sw > 0 ? Sv / Sw : 0 };
  return { m: (Stv * Sw - Sv * St) / det, b: (St2 * Sv - St * Stv) / det };
}

/** Weighted least squares for v = a·t² + b·t + c. */
function fitQuad(s: Sample[]): { a: number; b: number; c: number } {
  let S0 = 0;
  let S1 = 0;
  let S2 = 0;
  let S3 = 0;
  let S4 = 0;
  let T0 = 0;
  let T1 = 0;
  let T2 = 0;
  for (const p of s) {
    const t = p.t;
    const w = p.w;
    const t2 = t * t;
    S0 += w;
    S1 += w * t;
    S2 += w * t2;
    S3 += w * t2 * t;
    S4 += w * t2 * t2;
    T0 += w * p.v;
    T1 += w * t * p.v;
    T2 += w * t2 * p.v;
  }
  const m = [
    [S4, S3, S2],
    [S3, S2, S1],
    [S2, S1, S0],
  ];
  const det = det3(m);
  if (Math.abs(det) < 1e-9) {
    const lin = fitLinear(s); // not enough curvature info → straight line
    return { a: 0, b: lin.m, c: lin.b };
  }
  const rhs = [T2, T1, T0];
  return {
    a: det3(replaceCol(m, 0, rhs)) / det,
    b: det3(replaceCol(m, 1, rhs)) / det,
    c: det3(replaceCol(m, 2, rhs)) / det,
  };
}

function det3(m: number[][]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

function replaceCol(m: number[][], col: number, v: number[]): number[][] {
  return m.map((row, r) => row.map((val, c) => (c === col ? v[r] : val)));
}

const ANCHOR_WEIGHT = 400;

/**
 * Fit the physics path — x linear, y quadratic in frame index — through the
 * user anchors (heavily weighted, so the path passes through every click) and
 * the per-frame detection candidates. Iterates: assign a candidate per frame,
 * refit, tightening a gate so off-trajectory false positives drop out. The
 * first pass trusts the strongest blob per frame to bootstrap the whole flight.
 */
export function fitTrajectory(
  candidates: Candidate[][],
  frameMeta: { frame: number; t: number }[],
  anchors: Anchor[],
  diag: number,
): TrackPoint[] {
  const N = frameMeta.length;
  if (N === 0) return [];
  const anchorByN = new Map<number, Anchor>();
  for (const a of anchors) anchorByN.set(a.n, a);

  // Projectile model: constant horizontal velocity, gravity on the vertical —
  //   x(n) = bx·n + cx           (linear: steady horizontal speed)
  //   y(n) = ay·n² + by·n + cy   (quadratic: rises, hangs, falls — gravity)
  // Keeping x linear is what makes the path arc UP-and-over instead of bowing
  // sideways: detection noise can't inject spurious horizontal curvature.
  let bx = 0;
  let cx = anchors[0]?.x ?? 0;
  let ay = 0;
  let by = 0;
  let cy = anchors[0]?.y ?? 0;

  for (let iter = 0; iter < 10; iter++) {
    const sx: Sample[] = [];
    const sy: Sample[] = [];
    for (const a of anchors) {
      sx.push({ t: a.n, v: a.x, w: ANCHOR_WEIGHT });
      sy.push({ t: a.n, v: a.y, w: ANCHOR_WEIGHT });
    }
    const gate = Math.max(diag * 0.04, diag * (0.14 - 0.013 * iter));
    for (let n = 0; n < N; n++) {
      if (anchorByN.has(n)) continue;
      const cands = candidates[n];
      if (!cands || cands.length === 0) continue;
      let pick: Candidate | null = null;
      if (iter === 0) {
        pick = cands[0]; // strongest blob — bootstrap the whole arc
      } else {
        const predX = bx * n + cx;
        const predY = ay * n * n + by * n + cy;
        let bestD = gate;
        for (const c of cands) {
          const d = Math.hypot(c.x - predX, c.y - predY);
          if (d < bestD) {
            bestD = d;
            pick = c;
          }
        }
      }
      if (pick) {
        sx.push({ t: n, v: pick.x, w: pick.score });
        sy.push({ t: n, v: pick.y, w: pick.score });
      }
    }
    const lx = fitLinear(sx);
    bx = lx.m;
    cx = lx.b;
    const qy = fitQuad(sy);
    ay = qy.a;
    by = qy.b;
    cy = qy.c;
  }

  const points: TrackPoint[] = [];
  for (let n = 0; n < N; n++) {
    const anchor = anchorByN.get(n);
    const x = anchor ? anchor.x : bx * n + cx;
    const y = anchor ? anchor.y : ay * n * n + by * n + cy;
    let support = anchor ? 1 : 0;
    if (!anchor) {
      for (const c of candidates[n] ?? []) {
        if (Math.hypot(c.x - x, c.y - y) < diag * 0.04) {
          support = Math.max(support, Math.min(1, c.score));
        }
      }
    }
    points.push({
      frame: frameMeta[n].frame,
      t: frameMeta[n].t,
      x,
      y,
      confidence: support,
      manual: !!anchor,
    });
  }
  return points;
}

/** Detect per-frame candidates for a whole sequence (frames[0] = seed frame). */
export function detectCandidates(
  frames: Frame[],
  seed: { x: number; y: number },
  opts: TrackOptions = DEFAULT_OPTIONS,
  roi?: Rect | null,
): Candidate[][] {
  if (frames.length === 0) return [];
  const template = sampleColor(frames[0], seed.x, seed.y, 3);
  const out: Candidate[][] = [[]];
  for (let n = 1; n < frames.length; n++) {
    out.push(findCandidates(frames[n], frames[n - 1], template, opts, roi));
  }
  return out;
}

/**
 * Convenience: detect candidates then fit, anchored at the impact point (and
 * the landing point if given). frames[0] is the impact/seed frame.
 */
export function trackBall(
  frames: Frame[],
  seed: { x: number; y: number },
  opts: TrackOptions = DEFAULT_OPTIONS,
  roi?: Rect | null,
  end?: { x: number; y: number } | null,
): TraceResult {
  if (frames.length === 0) return { points: [], candidates: [] };
  const candidates = detectCandidates(frames, seed, opts, roi);
  const frameMeta = frames.map((f) => ({ frame: f.frame, t: f.t }));
  const diag = Math.hypot(frames[0].width, frames[0].height);
  const anchors: Anchor[] = [{ n: 0, x: seed.x, y: seed.y }];
  if (end) anchors.push({ n: frames.length - 1, x: end.x, y: end.y });
  const points = fitTrajectory(candidates, frameMeta, anchors, diag);
  return { points, candidates };
}
