// Export the composited (video + tracer overlay) playback to a WebM file using
// MediaRecorder on a canvas captureStream. No server round-trip required.

export async function recordCanvas(
  canvas: HTMLCanvasElement,
  durationMs: number,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const stream = canvas.captureStream(30);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 6_000_000,
  });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  return new Promise<Blob>((resolve, reject) => {
    const start = performance.now();
    const tick = () => {
      const frac = Math.min(1, (performance.now() - start) / durationMs);
      onProgress?.(frac);
      if (frac < 1) requestAnimationFrame(tick);
    };

    recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    recorder.onerror = (e) => reject(e);
    recorder.start();
    requestAnimationFrame(tick);
    window.setTimeout(() => recorder.stop(), durationMs);
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
