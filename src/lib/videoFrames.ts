// Helpers for pulling pixel frames out of an HTMLVideoElement via canvas.

import type { Frame } from "./tracker";

/** Seek a video element and resolve once the frame is actually displayable. */
export function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const clamped = Math.max(0, Math.min(video.duration || 0, time));
    if (Math.abs(video.currentTime - clamped) < 1e-3 && video.readyState >= 2) {
      resolve();
      return;
    }
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = clamped;
  });
}

/**
 * Grab a consecutive run of frames starting at `startTime`, stepping by 1/fps,
 * up to `count` frames (bounded by video duration). Draws each frame to the
 * provided scratch canvas to read back RGBA pixels.
 */
export async function grabFrames(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  startTime: number,
  fps: number,
  count: number,
): Promise<Frame[]> {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");

  const width = video.videoWidth;
  const height = video.videoHeight;
  canvas.width = width;
  canvas.height = height;

  const dt = 1 / fps;
  const frames: Frame[] = [];
  for (let n = 0; n < count; n++) {
    const t = startTime + n * dt;
    if (t > (video.duration || 0)) break;
    await seekTo(video, t);
    ctx.drawImage(video, 0, 0, width, height);
    const img = ctx.getImageData(0, 0, width, height);
    frames.push({
      frame: Math.round(t * fps),
      t,
      data: img.data,
      width,
      height,
    });
  }
  return frames;
}
