import { useEffect, useRef } from "react";
import type { Candidate, Rect, TrackPoint } from "../lib/tracker";
import { progressAtTime } from "../lib/trajectory";

type Mode = "seed" | "correct" | "view" | "roi" | "land";

interface Props {
  videoUrl: string;
  points: TrackPoint[];
  mode: Mode;
  roi: Rect | null;
  landing: { x: number; y: number } | null;
  /** User-placed anchor positions (impact + mid-flight) to mark. */
  markers: { x: number; y: number }[];
  /** Whether to draw editing guides (markers, ROI box, landing); off in export. */
  showGuides: boolean;
  /** Whether to draw the raw detection candidates for the current frame. */
  debug: boolean;
  debugFrames: { t: number; cands: Candidate[] }[];
  /** Per-frame camera offsets (scene-lock). The trail is stored scene-locked
   *  and shifted by the current frame's offset so it sticks to the scene. */
  offsets: { t: number; dx: number; dy: number }[];
  videoRef: React.RefObject<HTMLVideoElement>;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  onPoint: (x: number, y: number) => void;
  onRoiChange: (roi: Rect | null) => void;
  onLoadedMeta: (w: number, h: number, duration: number) => void;
  hint: string;
}

export default function TracerStage({
  videoUrl,
  points,
  mode,
  roi,
  landing,
  markers,
  showGuides,
  debug,
  debugFrames,
  offsets,
  videoRef,
  canvasRef,
  onPoint,
  onRoiChange,
  onLoadedMeta,
  hint,
}: Props) {
  // Refs so the rAF draw loop always sees fresh data without restarting.
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const roiRef = useRef(roi);
  roiRef.current = roi;
  const landingRef = useRef(landing);
  landingRef.current = landing;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const showGuidesRef = useRef(showGuides);
  showGuidesRef.current = showGuides;
  const debugRef = useRef(debug);
  debugRef.current = debug;
  const debugFramesRef = useRef(debugFrames);
  debugFramesRef.current = debugFrames;
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;

  // Live ROI drag (not committed until mouse-up).
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragRectRef = useRef<Rect | null>(null);

  useEffect(() => {
    let raf = 0;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      if (w && h && video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, w, h);
      }
      if (showGuidesRef.current) {
        drawRoi(ctx, dragRectRef.current ?? roiRef.current, w, h);
        if (landingRef.current) drawLanding(ctx, landingRef.current);
        for (const m of markersRef.current) drawMarker(ctx, m.x, m.y);
      }
      if (debugRef.current) {
        drawDebug(ctx, debugFramesRef.current, video.currentTime);
      }
      const o = offsetAt(offsetsRef.current, video.currentTime);
      drawTrail(ctx, pointsRef.current, video.currentTime, video.paused, o);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, canvasRef, videoUrl]);

  const toNative = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * canvas.height) / rect.height,
    };
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== "seed" && mode !== "correct" && mode !== "land") return;
    const p = toNative(e);
    onPoint(p.x, p.y);
  };

  const handleDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== "roi") return;
    const p = toNative(e);
    dragStartRef.current = p;
    dragRectRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
  };

  const handleMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== "roi" || !dragStartRef.current) return;
    dragRectRef.current = normRect(dragStartRef.current, toNative(e));
  };

  const handleUp = () => {
    if (mode !== "roi" || !dragStartRef.current) return;
    const r = dragRectRef.current;
    dragStartRef.current = null;
    dragRectRef.current = null;
    // A tiny box clears the ROI; otherwise commit it.
    onRoiChange(r && r.w > 6 && r.h > 6 ? r : null);
  };

  return (
    <div className="stage">
      <video
        ref={videoRef}
        src={videoUrl}
        crossOrigin="anonymous"
        playsInline
        muted
        preload="auto"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          const canvas = canvasRef.current;
          if (canvas) {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
          }
          onLoadedMeta(v.videoWidth, v.videoHeight, v.duration);
        }}
      />
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onMouseDown={handleDown}
        onMouseMove={handleMove}
        onMouseUp={handleUp}
        onMouseLeave={handleUp}
      />
      {hint && (
        <div className="hint" dangerouslySetInnerHTML={{ __html: hint }} />
      )}
    </div>
  );
}

function normRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function drawRoi(
  ctx: CanvasRenderingContext2D,
  roi: Rect | null,
  w: number,
  h: number,
) {
  if (!roi || roi.w < 1 || roi.h < 1) return;
  ctx.save();
  // Dim everything outside the ROI so the active area is obvious.
  ctx.fillStyle = "rgba(7, 11, 16, 0.5)";
  ctx.fillRect(0, 0, w, roi.y); // top
  ctx.fillRect(0, roi.y + roi.h, w, h - (roi.y + roi.h)); // bottom
  ctx.fillRect(0, roi.y, roi.x, roi.h); // left
  ctx.fillRect(roi.x + roi.w, roi.y, w - (roi.x + roi.w), roi.h); // right

  ctx.strokeStyle = "rgba(45, 212, 191, 0.95)";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);
  ctx.restore();
}

function drawDebug(
  ctx: CanvasRenderingContext2D,
  frames: { t: number; cands: Candidate[] }[],
  time: number,
) {
  if (frames.length === 0) return;
  // Pick the debug frame nearest the current playback time.
  let best = frames[0];
  let bestD = Infinity;
  for (const f of frames) {
    const d = Math.abs(f.t - time);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  const maxScore = best.cands.reduce((m, c) => Math.max(m, c.score), 1);
  ctx.save();
  for (const c of best.cands) {
    const radius = 4 + 10 * Math.min(1, c.score / maxScore);
    ctx.beginPath();
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(250, 204, 21, 0.95)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

function drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.fillStyle = "rgba(45, 212, 191, 0.9)";
  ctx.strokeStyle = "rgba(7, 11, 16, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawLanding(
  ctx: CanvasRenderingContext2D,
  p: { x: number; y: number },
) {
  ctx.save();
  ctx.strokeStyle = "rgba(45, 212, 191, 0.95)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
  ctx.stroke();
  // Crosshair through the centre.
  ctx.beginPath();
  ctx.moveTo(p.x - 14, p.y);
  ctx.lineTo(p.x + 14, p.y);
  ctx.moveTo(p.x, p.y - 14);
  ctx.lineTo(p.x, p.y + 14);
  ctx.stroke();
  ctx.restore();
}

/** Interpolate the camera offset at a given playback time. */
function offsetAt(
  offsets: { t: number; dx: number; dy: number }[],
  t: number,
): { dx: number; dy: number } {
  if (offsets.length === 0) return { dx: 0, dy: 0 };
  if (t <= offsets[0].t) return offsets[0];
  const last = offsets[offsets.length - 1];
  if (t >= last.t) return last;
  for (let i = 1; i < offsets.length; i++) {
    if (t <= offsets[i].t) {
      const a = offsets[i - 1];
      const b = offsets[i];
      const f = (t - a.t) / (b.t - a.t || 1);
      return { dx: a.dx + (b.dx - a.dx) * f, dy: a.dy + (b.dy - a.dy) * f };
    }
  }
  return last;
}

function drawTrail(
  ctx: CanvasRenderingContext2D,
  points: TrackPoint[],
  time: number,
  paused: boolean,
  o: { dx: number; dy: number },
) {
  if (points.length < 2) {
    if (points.length === 1) drawHead(ctx, points[0].x + o.dx, points[0].y + o.dy);
    return;
  }

  // Draw the trail through the tracked points (in time order) so it sits on the
  // detected path regardless of shot direction. Points are stored scene-locked,
  // so we add the current frame's camera offset to keep the arc glued to the
  // background as the camera pans. When paused, show the whole arc; while
  // playing it grows with the ball.
  const progress = paused ? 1 : progressAtTime(points, time);
  const reveal = Math.max(1, Math.floor(progress * (points.length - 1)));

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.shadowColor = "rgba(230, 57, 70, 0.9)";
  ctx.shadowBlur = 18;
  ctx.strokeStyle = "rgba(230, 57, 70, 0.95)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(points[0].x + o.dx, points[0].y + o.dy);
  for (let i = 1; i <= reveal; i++) ctx.lineTo(points[i].x + o.dx, points[i].y + o.dy);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255, 240, 210, 0.95)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  const head = points[reveal];
  if (head) drawHead(ctx, head.x + o.dx, head.y + o.dy);
}

function drawHead(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.shadowColor = "rgba(255,255,255,0.9)";
  ctx.shadowBlur = 14;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
