// Global camera-motion estimation so the trace can be locked to the scene
// rather than to fixed screen pixels. When the camera pans/tilts during a
// shot, the ball's pixel position changes from BOTH the ball's flight and the
// camera move; estimating the camera move lets us cancel it out before fitting
// and re-apply it per frame when drawing, so the arc sticks to the background.
//
// Method (classical, in-browser): downscale each frame to a small luma image,
// then for a grid of high-texture background blocks find the translation that
// best matches the previous frame (block matching, SSD). The MEDIAN block
// displacement is the global camera translation — robust to the ball, players,
// and other local motion. Translation only (handles pan/tilt); zoom/rotation
// are out of scope.

import type { Frame, Rect } from "./tracker";

export interface Offset {
  /** Cumulative apparent shift of the scene (px, full-res) from frame 0. A
   *  scene point at frame-0 position P appears at frame n at P + offset[n]. */
  dx: number;
  dy: number;
}

const TARGET_W = 320; // downscale width for matching
const SEARCH = 8; // ± search radius in small-image px
const PATCH = 3; // half block size in small-image px
const MIN_GRAD = 10; // skip flat (e.g. sky) blocks below this gradient
const MIN_BLOCKS = 6; // need at least this many valid blocks to trust a pair

interface Small {
  data: Float32Array;
  w: number;
  h: number;
  scale: number; // full-res px per small px
}

/** Downscale a frame's RGBA to a small luma image by box-averaging. */
function toSmallLuma(f: Frame): Small {
  const scale = Math.max(1, Math.round(f.width / TARGET_W));
  const w = Math.max(1, Math.floor(f.width / scale));
  const h = Math.max(1, Math.floor(f.height / scale));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      const sx0 = x * scale;
      const sy0 = y * scale;
      for (let yy = 0; yy < scale; yy++) {
        const fy = sy0 + yy;
        if (fy >= f.height) break;
        for (let xx = 0; xx < scale; xx++) {
          const fx = sx0 + xx;
          if (fx >= f.width) break;
          const i = (fy * f.width + fx) * 4;
          s += 0.299 * f.data[i] + 0.587 * f.data[i + 1] + 0.114 * f.data[i + 2];
          n++;
        }
      }
      out[y * w + x] = n ? s / n : 0;
    }
  }
  return { data: out, w, h, scale };
}

function gradMag(s: Small, x: number, y: number): number {
  const i = y * s.w + x;
  const gx = Math.abs(s.data[i + 1] - s.data[i - 1]);
  const gy = Math.abs(s.data[i + s.w] - s.data[i - s.w]);
  return gx + gy;
}

function median(arr: number[]): number {
  const a = [...arr].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Estimate small-image translation (dx,dy) of the scene from prev→cur. */
function estimatePair(prev: Small, cur: Small, roi: Rect | null): Offset {
  const { w, h, scale } = cur;
  const margin = PATCH + SEARCH + 1;
  const step = Math.max(8, Math.floor(Math.min(w, h) / 16));
  const dxs: number[] = [];
  const dys: number[] = [];

  for (let y = margin; y < h - margin; y += step) {
    for (let x = margin; x < w - margin; x += step) {
      // Skip the ball's area (the ROI) so the ball/golfer don't bias the camera
      // estimate; the camera is read from the surrounding background.
      if (roi) {
        const fx = x * scale;
        const fy = y * scale;
        if (fx >= roi.x && fx <= roi.x + roi.w && fy >= roi.y && fy <= roi.y + roi.h) {
          continue;
        }
      }
      if (gradMag(cur, x, y) < MIN_GRAD) continue; // featureless block

      let best = Infinity;
      let bdx = 0;
      let bdy = 0;
      for (let sy = -SEARCH; sy <= SEARCH; sy++) {
        for (let sx = -SEARCH; sx <= SEARCH; sx++) {
          let ssd = 0;
          for (let py = -PATCH; py <= PATCH && ssd < best; py++) {
            const cy = y + py;
            const py0 = cy * cur.w;
            const pp0 = (cy + sy) * prev.w;
            for (let px = -PATCH; px <= PATCH; px++) {
              const d = cur.data[py0 + x + px] - prev.data[pp0 + x + px + sx];
              ssd += d * d;
            }
          }
          if (ssd < best) {
            best = ssd;
            bdx = sx;
            bdy = sy;
          }
        }
      }
      dxs.push(bdx);
      dys.push(bdy);
    }
  }

  if (dxs.length < MIN_BLOCKS) return { dx: 0, dy: 0 };
  // Scale small-image displacement back to full-res pixels.
  return { dx: median(dxs) * scale, dy: median(dys) * scale };
}

/**
 * Cumulative per-frame camera offsets relative to frame 0 (offset[0] = 0).
 * A scene point at frame-0 position P is at P + offset[n] in frame n, so a raw
 * detection raw_n maps to scene-locked coords as raw_n − offset[n].
 */
export function estimateOffsets(frames: Frame[], roi: Rect | null): Offset[] {
  if (frames.length === 0) return [];
  const offsets: Offset[] = [{ dx: 0, dy: 0 }];
  let prevSmall = toSmallLuma(frames[0]);
  for (let n = 1; n < frames.length; n++) {
    const curSmall = toSmallLuma(frames[n]);
    const step = estimatePair(prevSmall, curSmall, roi);
    offsets.push({
      dx: offsets[n - 1].dx + step.dx,
      dy: offsets[n - 1].dy + step.dy,
    });
    prevSmall = curSmall;
  }
  return offsets;
}
