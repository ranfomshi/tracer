// Core ball-tracking logic. Runs entirely in the browser on canvas pixel data.
//
// Strategy: the ball is a small object that MOVES relative to the (mostly
// static) background — it may be lighter OR darker than what's behind it, so we
// don't assume brightness. Instead we sample the ball's actual colour from the
// user's seed click and, for each subsequent frame:
//   1. compute a per-pixel "motion" signal by differencing consecutive frames,
//   2. among the moving pixels, score how well each matches the ball's colour
//      template (this also rejects the frame-difference "ghost" left where the
//      ball used to be, which now shows background),
//   3. search a window around the predicted position and take the weighted
//      centroid of the best-matching cluster,
//   4. update velocity for the next prediction. An optional landing point pulls
//      the prediction toward where the ball is known to come down.
//
// This is deliberately classical CV — no model downloads, no GPU required — so
// it works offline and within a static Netlify deploy.

export interface TrackPoint {
  /** Frame index this point belongs to. */
  frame: number;
  /** Video time in seconds. */
  t: number;
  /** Ball position in video pixel coordinates. */
  x: number;
  y: number;
  /** Detection confidence 0..1. `manual` points are always 1. */
  confidence: number;
  /** True when the user placed/corrected this point by hand. */
  manual: boolean;
}

export interface TrackOptions {
  /** Half-width of the search window in pixels (scales with speed too). */
  searchRadius: number;
  /** Frame-difference delta below which a pixel is treated as static (0..255). */
  motionThreshold: number;
  /** Max colour distance (0..441) a pixel may be from the ball template. */
  colorTolerance: number;
  /** Stop tracking after this many consecutive misses (ignored if a landing
   *  point is supplied — then we coast all the way to it). */
  maxMisses: number;
  /** Velocity smoothing factor 0..1 (higher = smoother, laggier). */
  velocitySmoothing: number;
  /** How strongly the landing point pulls the prediction, 0..1. */
  landingPull: number;
}

export const DEFAULT_OPTIONS: TrackOptions = {
  searchRadius: 60,
  motionThreshold: 22,
  colorTolerance: 115,
  maxMisses: 6,
  velocitySmoothing: 0.45,
  landingPull: 0.5,
};

/** A rectangular region in video pixel coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A single grabbed frame: raw RGBA pixels plus dimensions. */
export interface Frame {
  frame: number;
  t: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface Detection {
  x: number;
  y: number;
  confidence: number;
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
 * Find the ball within a search window. A pixel counts only if it MOVED since
 * the previous frame and its colour resembles the ball template; we then take
 * the weighted centroid. Returns null if nothing qualifies.
 */
function detectInWindow(
  cur: Frame,
  prev: Frame,
  template: RGB,
  cx: number,
  cy: number,
  radius: number,
  opts: TrackOptions,
  roi?: Rect | null,
): Detection | null {
  const { width, height } = cur;
  let x0 = Math.max(0, Math.floor(cx - radius));
  let x1 = Math.min(width - 1, Math.ceil(cx + radius));
  let y0 = Math.max(0, Math.floor(cy - radius));
  let y1 = Math.min(height - 1, Math.ceil(cy + radius));

  // Clip the search window to the region of interest so anything outside the
  // user-drawn box can never be picked up.
  if (roi) {
    x0 = Math.max(x0, Math.floor(roi.x));
    y0 = Math.max(y0, Math.floor(roi.y));
    x1 = Math.min(x1, Math.ceil(roi.x + roi.w) - 1);
    y1 = Math.min(y1, Math.ceil(roi.y + roi.h) - 1);
    if (x0 > x1 || y0 > y1) return null;
  }

  let sumW = 0;
  let sumX = 0;
  let sumY = 0;
  let peak = 0;
  let count = 0;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4;
      const r = cur.data[i];
      const g = cur.data[i + 1];
      const b = cur.data[i + 2];
      const motion = Math.abs(
        luma(r, g, b) - luma(prev.data[i], prev.data[i + 1], prev.data[i + 2]),
      );
      if (motion < opts.motionThreshold) continue;

      // Colour similarity to the ball — works for light OR dark balls and
      // rejects the ghost (sky) the ball moved away from.
      const dr = r - template.r;
      const dg = g - template.g;
      const db = b - template.b;
      const colorDist = Math.sqrt(dr * dr + dg * dg + db * db);
      const sim = 1 - Math.min(1, colorDist / opts.colorTolerance);
      if (sim <= 0) continue;

      // Distance falloff keeps us locked onto the predicted location.
      const ddx = (x - cx) / radius;
      const ddy = (y - cy) / radius;
      const dist = Math.min(1, Math.sqrt(ddx * ddx + ddy * ddy));

      const w = Math.min(1, motion / 64) * sim * (1 - 0.6 * dist);
      if (w <= 0) continue;
      sumW += w;
      sumX += x * w;
      sumY += y * w;
      peak = Math.max(peak, w);
      count++;
    }
  }

  if (sumW === 0 || count < 2) return null;

  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  const compactness = 1 - Math.min(1, count / area);
  const strength = Math.min(1, peak / 0.6);
  const confidence = Math.max(0, Math.min(1, 0.5 * strength + 0.5 * compactness));

  return { x: sumX / sumW, y: sumY / sumW, confidence };
}

/**
 * Track the ball across a sequence of already-grabbed consecutive frames,
 * starting from the seed position on `frames[0]`. If `end` (a landing point) is
 * given, the prediction is pulled toward it and the final point is anchored to
 * it exactly.
 */
export function trackBall(
  frames: Frame[],
  seed: { x: number; y: number },
  opts: TrackOptions = DEFAULT_OPTIONS,
  roi?: Rect | null,
  end?: { x: number; y: number } | null,
): TrackPoint[] {
  if (frames.length === 0) return [];

  const template = sampleColor(frames[0], seed.x, seed.y, 3);

  const points: TrackPoint[] = [
    {
      frame: frames[0].frame,
      t: frames[0].t,
      x: seed.x,
      y: seed.y,
      confidence: 1,
      manual: true,
    },
  ];

  let px = seed.x;
  let py = seed.y;
  let vx = 0;
  let vy = 0;
  let misses = 0;
  const N = frames.length;

  for (let n = 1; n < N; n++) {
    const prev = frames[n - 1];
    const cur = frames[n];

    let predX = px + vx;
    let predY = py + vy;
    if (end) {
      // Expected per-frame step if the remaining distance to the landing point
      // were spread evenly over the remaining frames.
      const remaining = Math.max(1, N - n);
      const towardX = (end.x - px) / remaining;
      const towardY = (end.y - py) / remaining;
      const k = opts.landingPull;
      predX = px + (1 - k) * vx + k * towardX;
      predY = py + (1 - k) * vy + k * towardY;
    }

    const speed = Math.hypot(vx, vy);
    const radius = Math.min(
      Math.max(cur.width, cur.height) / 2,
      opts.searchRadius + speed * 1.5,
    );

    const det = detectInWindow(
      cur,
      prev,
      template,
      predX,
      predY,
      radius,
      opts,
      roi,
    );

    let nx: number;
    let ny: number;
    let confidence: number;

    if (det && det.confidence > 0.08) {
      nx = det.x;
      ny = det.y;
      confidence = det.confidence;
      misses = 0;
    } else {
      // Coast on the prediction (which heads toward the landing point if set).
      nx = predX;
      ny = predY;
      confidence = 0;
      misses++;
    }

    const newVx = nx - px;
    const newVy = ny - py;
    const s = opts.velocitySmoothing;
    vx = s * vx + (1 - s) * newVx;
    vy = s * vy + (1 - s) * newVy;
    px = nx;
    py = ny;

    points.push({
      frame: cur.frame,
      t: cur.t,
      x: nx,
      y: ny,
      confidence,
      manual: false,
    });

    // Without a landing target, give up after too many misses; with one, keep
    // coasting so the arc completes to the known landing spot.
    if (!end && misses >= opts.maxMisses) break;
  }

  // Anchor the arc to the exact landing point the user chose.
  if (end && points.length > 1) {
    const last = points[points.length - 1];
    last.x = end.x;
    last.y = end.y;
    last.confidence = 1;
    last.manual = true;
  }

  return points;
}
