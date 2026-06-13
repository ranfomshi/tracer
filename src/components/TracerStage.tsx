import { useEffect, useRef } from "react";
import type { Rect, TrackPoint } from "../lib/tracker";
import { progressAtTime } from "../lib/trajectory";

type Mode = "seed" | "correct" | "view" | "roi" | "land";

interface Props {
  videoUrl: string;
  points: TrackPoint[];
  mode: Mode;
  roi: Rect | null;
  landing: { x: number; y: number } | null;
  /** Whether to draw editing guides (ROI box, landing marker); off in export. */
  showGuides: boolean;
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
  showGuides,
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
  const showGuidesRef = useRef(showGuides);
  showGuidesRef.current = showGuides;

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
      }
      drawTrail(ctx, pointsRef.current, video.currentTime);
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
    if (mode !== "seed" && mode !== "correct") return;
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

function drawTrail(
  ctx: CanvasRenderingContext2D,
  points: TrackPoint[],
  time: number,
) {
  if (points.length < 2) {
    if (points.length === 1) drawHead(ctx, points[0].x, points[0].y);
    return;
  }

  // Draw the trail directly through the tracked points, in time order, so it
  // always sits exactly on the detected ball path regardless of shot direction.
  const progress = progressAtTime(points, time);
  const reveal = Math.max(1, Math.floor(progress * (points.length - 1)));

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.shadowColor = "rgba(230, 57, 70, 0.9)";
  ctx.shadowBlur = 18;
  ctx.strokeStyle = "rgba(230, 57, 70, 0.95)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i <= reveal; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255, 240, 210, 0.95)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  const head = points[reveal];
  if (head) drawHead(ctx, head.x, head.y);
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
