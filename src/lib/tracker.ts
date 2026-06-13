// Core ball-tracking logic. Runs entirely in the browser on canvas pixel data.
//
// Strategy: the golf ball is a small, bright object that moves fast relative to
// the (mostly static) background. We seed the tracker with the ball's location
// on the first frame, then for each subsequent frame we:
//   1. compute a per-pixel "motion" signal by differencing consecutive frames,
//   2. search a window around the position predicted from current velocity,
//   3. score candidate pixels by motion * brightness and take the weighted
//      centroid of the strongest cluster as the new ball position,
//   4. update velocity (with smoothing) for the next prediction.
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
  /** Pixel brightness/motion delta below which a pixel is ignored (0..255). */
  motionThreshold: number;
  /** Stop tracking after this many consecutive low-confidence frames. */
  maxMisses: number;
  /** Velocity smoothing factor 0..1 (higher = smoother, laggier). */
  velocitySmoothing: number;
}

export const DEFAULT_OPTIONS: TrackOptions = {
  searchRadius: 60,
  motionThreshold: 28,
  maxMisses: 6,
  velocitySmoothing: 0.45,
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

interface Detection {
  x: number;
  y: number;
  confidence: number;
}

function luma(data: Uint8ClampedArray, i: number): number {
  // Rec. 601 luminance. `i` is the index of the R channel.
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

/**
 * Find the ball within a search window by scoring pixels on how much they
 * moved (frame difference) and how bright they are, then taking the
 * intensity-weighted centroid. Returns null if nothing crosses threshold.
 */
function detectInWindow(
  cur: Frame,
  prev: Frame,
  cx: number,
  cy: number,
  radius: number,
  threshold: number,
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
      const motion = Math.abs(luma(cur.data, i) - luma(prev.data, i));
      if (motion < threshold) continue;
      const brightness = luma(cur.data, i) / 255; // favour the white ball
      // Distance falloff keeps us locked onto the predicted location.
      const dx = (x - cx) / radius;
      const dy = (y - cy) / radius;
      const dist = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const w = motion * (0.4 + 0.6 * brightness) * (1 - 0.6 * dist);
      if (w <= 0) continue;
      sumW += w;
      sumX += x * w;
      sumY += y * w;
      peak = Math.max(peak, w);
      count++;
    }
  }

  if (sumW === 0 || count < 2) return null;

  // Confidence: blend of how strong the signal is and how compact the blob is.
  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  const compactness = 1 - Math.min(1, count / area);
  const strength = Math.min(1, peak / 180);
  const confidence = Math.max(0, Math.min(1, 0.5 * strength + 0.5 * compactness));

  return { x: sumX / sumW, y: sumY / sumW, confidence };
}

/**
 * Track the ball across a sequence of already-grabbed frames, starting from a
 * user-supplied seed position on `frames[0]`.
 *
 * `frames` must be consecutive and ordered; the seed corresponds to frames[0].
 */
export function trackBall(
  frames: Frame[],
  seed: { x: number; y: number },
  opts: TrackOptions = DEFAULT_OPTIONS,
  roi?: Rect | null,
): TrackPoint[] {
  if (frames.length === 0) return [];

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

  for (let n = 1; n < frames.length; n++) {
    const prev = frames[n - 1];
    const cur = frames[n];

    const predX = px + vx;
    const predY = py + vy;
    const speed = Math.hypot(vx, vy);
    // Widen the search as the ball speeds up so we don't lose a fast shot.
    const radius = Math.min(
      Math.max(cur.width, cur.height) / 2,
      opts.searchRadius + speed * 1.5,
    );

    const det = detectInWindow(
      cur,
      prev,
      predX,
      predY,
      radius,
      opts.motionThreshold,
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
      // Coast on the last velocity when we lose the ball briefly.
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

    if (misses >= opts.maxMisses) break;
  }

  return points;
}
