import { useEffect, useRef } from "react";
import type { TrackPoint } from "../lib/tracker";
import { progressAtTime } from "../lib/trajectory";

interface Props {
  videoUrl: string;
  points: TrackPoint[];
  mode: "seed" | "correct" | "view";
  videoRef: React.RefObject<HTMLVideoElement>;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  onPoint: (x: number, y: number) => void;
  onLoadedMeta: (w: number, h: number, duration: number) => void;
  hint: string;
}

export default function TracerStage({
  videoUrl,
  points,
  mode,
  videoRef,
  canvasRef,
  onPoint,
  onLoadedMeta,
  hint,
}: Props) {
  // Keep the latest points in a ref so the rAF loop always sees fresh data
  // without restarting the animation effect.
  const pointsRef = useRef(points);
  pointsRef.current = points;

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
      drawTrail(ctx, pointsRef.current, video.currentTime, w, h);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, canvasRef, videoUrl]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode === "view") return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    onPoint((e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY);
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
      <canvas ref={canvasRef} onClick={handleClick} />
      {hint && (
        <div className="hint" dangerouslySetInnerHTML={{ __html: hint }} />
      )}
    </div>
  );
}

function drawTrail(
  ctx: CanvasRenderingContext2D,
  points: TrackPoint[],
  time: number,
  _w: number,
  _h: number,
) {
  if (points.length < 2) {
    // Still show the single seed marker so users know it registered.
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

  // Soft outer glow.
  ctx.shadowColor = "rgba(230, 57, 70, 0.9)";
  ctx.shadowBlur = 18;
  ctx.strokeStyle = "rgba(230, 57, 70, 0.95)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i <= reveal; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();

  // Bright inner core.
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
