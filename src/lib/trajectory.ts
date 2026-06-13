// Turning raw tracked points into a clean, broadcast-style tracer arc.

import type { TrackPoint } from "./tracker";

/**
 * Smooth a path with a small moving average. Manual points are anchors and are
 * left untouched so user corrections stay exact.
 */
export function smoothPath(points: TrackPoint[], window = 2): TrackPoint[] {
  if (points.length <= 2) return points;
  return points.map((p, idx) => {
    if (p.manual) return p;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let k = -window; k <= window; k++) {
      const q = points[idx + k];
      if (!q) continue;
      sx += q.x;
      sy += q.y;
      n++;
    }
    return { ...p, x: sx / n, y: sy / n };
  });
}

/**
 * Fit y = a*x^2 + b*x + c to the points (least squares) and resample, giving
 * the smooth parabola you expect from a ball flight. Falls back to the raw
 * (smoothed) points when the data is too sparse or near-vertical.
 */
export function fitParabola(points: TrackPoint[]): { x: number; y: number }[] {
  if (points.length < 4) return points.map((p) => ({ x: p.x, y: p.y }));

  const n = points.length;
  let Sx = 0,
    Sx2 = 0,
    Sx3 = 0,
    Sx4 = 0,
    Sy = 0,
    Sxy = 0,
    Sx2y = 0;
  for (const p of points) {
    const x = p.x;
    const x2 = x * x;
    Sx += x;
    Sx2 += x2;
    Sx3 += x2 * x;
    Sx4 += x2 * x2;
    Sy += p.y;
    Sxy += x * p.y;
    Sx2y += x2 * p.y;
  }

  // Solve the 3x3 normal-equations system via Cramer's rule.
  const m = [
    [Sx4, Sx3, Sx2],
    [Sx3, Sx2, Sx],
    [Sx2, Sx, n],
  ];
  const v = [Sx2y, Sxy, Sy];
  const det = det3(m);
  if (Math.abs(det) < 1e-6) return points.map((p) => ({ x: p.x, y: p.y }));

  const a = det3(replaceCol(m, 0, v)) / det;
  const b = det3(replaceCol(m, 1, v)) / det;
  const c = det3(replaceCol(m, 2, v)) / det;

  const xs = points.map((p) => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const out: { x: number; y: number }[] = [];
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const x = minX + ((maxX - minX) * i) / steps;
    out.push({ x, y: a * x * x + b * x + c });
  }
  return out;
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

/**
 * How far along the path (0..1) the ball is at video time `t`, so the drawn
 * trail can grow in sync with playback.
 */
export function progressAtTime(points: TrackPoint[], t: number): number {
  if (points.length < 2) return 0;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  if (t <= t0) return 0;
  if (t >= t1) return 1;
  return (t - t0) / (t1 - t0);
}
