import { useEffect, useMemo, useRef, useState } from "react";
import TracerStage from "./components/TracerStage";
import {
  DEFAULT_OPTIONS,
  fitTrajectory,
  trackBall,
  type Anchor,
  type Candidate,
  type Rect,
  type TrackPoint,
} from "./lib/tracker";

export interface DebugFrame {
  t: number;
  cands: Candidate[];
}

interface TraceCtx {
  candidates: Candidate[][];
  frameMeta: { frame: number; t: number }[];
  diag: number;
  seedT: number;
  dt: number;
}
import { grabFrames } from "./lib/videoFrames";
import { smoothPath } from "./lib/trajectory";
import { recordCanvas, downloadBlob } from "./lib/export";
import { saveTrace, getTrace } from "./lib/api";

type Mode = "view" | "seed" | "correct" | "roi" | "land";
type StatusKind = "" | "ok" | "error";

// Cap only the no-landing case; with a landing point we trace the exact window.
const MAX_TRACK_SECONDS = 8;
const MAX_TRACK_FRAMES = 360;

export default function App() {
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [meta, setMeta] = useState({ w: 0, h: 0, duration: 0 });
  const [fps, setFps] = useState(30);
  const [points, setPoints] = useState<TrackPoint[]>([]);
  const [roi, setRoi] = useState<Rect | null>(null);
  const [landing, setLanding] = useState<{ x: number; y: number; t: number } | null>(
    null,
  );
  const [mode, setMode] = useState<Mode>("view");
  const [clock, setClock] = useState(0);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [debug, setDebug] = useState(false);
  const [debugFrames, setDebugFrames] = useState<DebugFrame[]>([]);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [status, setStatus] = useState<{ msg: string; kind: StatusKind }>({
    msg: "",
    kind: "",
  });
  const [shareUrl, setShareUrl] = useState("");
  const [dragging, setDragging] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const traceCtxRef = useRef<TraceCtx | null>(null);

  const displayPoints = useMemo(() => smoothPath(points), [points]);

  // Keep the scrubber/clock in step with the video without re-rendering the
  // canvas (the stage drives its own rAF draw loop).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setClock(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Load a shared trace if the URL carries one. Video must be re-supplied by
  // the viewer, but the traced path is restored immediately.
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("t");
    if (!id) return;
    getTrace(id)
      .then((trace) => {
        setPoints(trace.points);
        setFps(trace.fps || 30);
        setStatus({
          msg: `Loaded shared trace ${id}. Add the matching video to view it over footage.`,
          kind: "ok",
        });
      })
      .catch(() => setStatus({ msg: `Couldn't load trace ${id}.`, kind: "error" }));
  }, []);

  const loadFile = (file: File) => {
    if (!file.type.startsWith("video/")) {
      setStatus({ msg: "Please choose a video file.", kind: "error" });
      return;
    }
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setPoints([]);
    setDebugFrames([]);
    setAnchors([]);
    traceCtxRef.current = null;
    setRoi(null);
    setLanding(null);
    setShareUrl("");
    setMode("view");
    setStatus({ msg: "", kind: "" });
  };

  const handleRoiChange = (next: Rect | null) => {
    setRoi(next);
    setMode("view");
    setStatus({
      msg: next
        ? "Detection area set — anything outside the box is ignored."
        : "Detection area cleared.",
      kind: "ok",
    });
  };

  const seekTo = (t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = Math.max(0, Math.min(meta.duration, t));
  };

  const stepFrame = (dir: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = Math.max(0, Math.min(meta.duration, v.currentTime + dir / fps));
  };

  const handlePoint = (x: number, y: number) => {
    const v = videoRef.current;
    if (!v) return;
    const t = v.currentTime;
    const frame = Math.round(t * fps);

    if (mode === "seed") {
      setPoints([{ frame, t, x, y, confidence: 1, manual: true }]);
      setMode("view");
      setStatus({
        msg: "Impact point set. Optionally set the landing point, then “Trace shot”.",
        kind: "ok",
      });
    } else if (mode === "land") {
      setLanding({ x, y, t });
      setMode("view");
      setStatus({
        msg: "Landing point set — the trace will end here and stay on track toward it.",
        kind: "ok",
      });
    } else if (mode === "correct") {
      const ctx = traceCtxRef.current;
      if (!ctx) return;
      // Map the current time to a frame index and add/replace an anchor there,
      // then re-fit the whole arc through every anchor.
      const n = Math.max(
        0,
        Math.min(ctx.frameMeta.length - 1, Math.round((t - ctx.seedT) / ctx.dt)),
      );
      const next: Anchor[] = [
        ...anchors.filter((a) => a.n !== n),
        { n, x, y },
      ].sort((a, b) => a.n - b.n);
      setAnchors(next);
      setPoints(fitTrajectory(ctx.candidates, ctx.frameMeta, next, ctx.diag));
      setStatus({
        msg: `Anchor set on this frame (${next.length} total). Arc re-fitted — add more to refine.`,
        kind: "ok",
      });
    }
  };

  const runTrace = async () => {
    const v = videoRef.current;
    if (!v || points.length === 0) return;
    const seed = points[0];
    setBusy(true);
    setStatus({ msg: "Tracing shot…", kind: "" });
    try {
      v.pause();
      const scratch = document.createElement("canvas");
      // With a landing point, trace the EXACT impact→landing window so the last
      // sampled frame lands on it; otherwise grab up to MAX_TRACK_SECONDS.
      const useLanding = landing && landing.t > seed.t;
      const targetT = useLanding
        ? landing!.t
        : Math.min(seed.t + MAX_TRACK_SECONDS, meta.duration);
      const fullSpan = Math.max(0, targetT - seed.t);
      const naturalCount = Math.ceil(fullSpan * fps) + 1;
      const count = Math.max(2, Math.min(naturalCount, MAX_TRACK_FRAMES));
      // Even time spacing across the window (subsamples long / slow-mo clips).
      const dt = count > 1 ? fullSpan / (count - 1) : 1 / fps;
      const frames = await grabFrames(v, scratch, seed.t, dt, count);
      const end = landing ? { x: landing.x, y: landing.y } : null;
      const result = trackBall(
        frames,
        { x: seed.x, y: seed.y },
        DEFAULT_OPTIONS,
        roi,
        end,
      );
      // Cache the detection context so manual corrections can re-fit instantly
      // (no re-grabbing of frames).
      const frameMeta = result.points.map((p) => ({ frame: p.frame, t: p.t }));
      traceCtxRef.current = {
        candidates: result.candidates,
        frameMeta,
        diag: Math.hypot(meta.w, meta.h),
        seedT: seed.t,
        dt,
      };
      const initialAnchors: Anchor[] = [{ n: 0, x: seed.x, y: seed.y }];
      if (end) initialAnchors.push({ n: frames.length - 1, x: end.x, y: end.y });
      setAnchors(initialAnchors);
      setPoints(result.points);
      setDebugFrames(
        result.points.map((p, n) => ({ t: p.t, cands: result.candidates[n] ?? [] })),
      );
      await seekToAsync(v, seed.t);
      const hit = result.points.filter((p) => p.confidence > 0.1).length;
      const detected = result.candidates.reduce((s, c) => s + c.length, 0);
      setStatus({
        msg: `Traced ${result.points.length} frames — ${hit} backed by detections, ${detected} candidates found.${
          detected === 0
            ? " No ball detected: try Limit area, check fps, or loosen detection."
            : " Toggle Debug to see what was detected."
        }`,
        kind: detected === 0 ? "error" : "ok",
      });
    } catch (err) {
      setStatus({ msg: `Tracing failed: ${(err as Error).message}`, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const play = () => videoRef.current?.play();
  const pause = () => videoRef.current?.pause();

  const exportVideo = async () => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || displayPoints.length < 2) return;
    setBusy(true);
    setExporting(true);
    setStatus({ msg: "Rendering export…", kind: "" });
    try {
      const start = displayPoints[0].t;
      const end = displayPoints[displayPoints.length - 1].t + 0.6;
      await seekToAsync(v, start);
      await v.play();
      const blob = await recordCanvas(c, (end - start) * 1000);
      v.pause();
      downloadBlob(blob, "tracer-shot.webm");
      setStatus({ msg: "Exported tracer-shot.webm", kind: "ok" });
    } catch (err) {
      setStatus({ msg: `Export failed: ${(err as Error).message}`, kind: "error" });
    } finally {
      setExporting(false);
      setBusy(false);
    }
  };

  const share = async () => {
    if (displayPoints.length < 2) return;
    setBusy(true);
    setStatus({ msg: "Saving trace…", kind: "" });
    try {
      const { id } = await saveTrace({
        width: meta.w,
        height: meta.h,
        fps,
        points: displayPoints,
      });
      const url = `${location.origin}${location.pathname}?t=${id}`;
      setShareUrl(url);
      setStatus({ msg: "Trace saved. Share link ready.", kind: "ok" });
    } catch (err) {
      setStatus({ msg: `Save failed: ${(err as Error).message}`, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const hasVideo = !!videoUrl;
  const hint =
    mode === "seed"
      ? "Click the <b>ball</b> on this frame to set its starting point."
      : mode === "correct"
        ? "Step to a frame and click the <b>ball</b> to anchor it — the arc re-fits through every anchor."
        : mode === "land"
          ? "Scrub to where the ball <b>lands</b>, then click the spot."
          : mode === "roi"
            ? "Drag to box the <b>area the ball stays within</b>. Outside is ignored. Tiny box = clear."
            : "";

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          Tracer<span className="dot">.</span>
        </h1>
        <p>trace the flight of any golf shot — in your browser</p>
      </header>
      <p className="tagline">
        Upload a clip of a shot, mark where the ball starts, and Tracer follows
        the flight and draws the arc. Everything runs locally; nothing is
        uploaded unless you choose to save a shareable trace.
      </p>

      {!hasVideo ? (
        <div
          className={`dropzone${dragging ? " drag" : ""}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) loadFile(f);
          }}
        >
          <strong>Drop a golf-shot video here</strong>
          <span>or click to choose a file — MP4, MOV, WebM</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadFile(f);
            }}
          />
        </div>
      ) : (
        <>
          <TracerStage
            videoUrl={videoUrl}
            points={displayPoints}
            mode={mode}
            roi={roi}
            landing={landing}
            showGuides={!exporting}
            debug={debug && !exporting}
            debugFrames={debugFrames}
            videoRef={videoRef}
            canvasRef={canvasRef}
            onPoint={handlePoint}
            onRoiChange={handleRoiChange}
            onLoadedMeta={(w, h, duration) => setMeta({ w, h, duration })}
            hint={hint}
          />

          <div className="panel">
            <div className="row">
              <button onClick={play} disabled={busy}>
                ▶ Play
              </button>
              <button onClick={pause} disabled={busy}>
                ⏸ Pause
              </button>
              <button onClick={() => stepFrame(-1)} disabled={busy} title="Previous frame">
                ⏮ Frame
              </button>
              <button onClick={() => stepFrame(1)} disabled={busy} title="Next frame">
                Frame ⏭
              </button>
              <input
                type="range"
                min={0}
                max={meta.duration || 0}
                step={0.01}
                value={Math.min(clock, meta.duration || 0)}
                onChange={(e) => seekTo(parseFloat(e.target.value))}
              />
              <span className="time">
                {clock.toFixed(2)}s · f{Math.round(clock * fps)}
              </span>
            </div>

            <div className="row">
              <button
                className={mode === "roi" ? "active" : roi ? "active" : ""}
                onClick={() => setMode(mode === "roi" ? "view" : "roi")}
                disabled={busy}
              >
                ▦ {roi ? "Edit area" : "Limit area"}
              </button>
              <button
                className={mode === "seed" ? "active" : ""}
                onClick={() => setMode(mode === "seed" ? "view" : "seed")}
                disabled={busy}
              >
                ◎ Set impact
              </button>
              <button
                className={mode === "land" ? "active" : landing ? "active" : ""}
                onClick={() => setMode(mode === "land" ? "view" : "land")}
                disabled={busy || points.length === 0}
              >
                ⊕ {landing ? "Edit landing" : "Set landing"}
              </button>
              <button
                className="primary"
                onClick={runTrace}
                disabled={busy || points.length === 0}
              >
                ✦ Trace shot
              </button>
              <button
                className={mode === "correct" ? "active" : ""}
                onClick={() => setMode(mode === "correct" ? "view" : "correct")}
                disabled={busy || !traceCtxRef.current}
              >
                ✎ {anchors.length > 1 ? `Anchors (${anchors.length})` : "Add anchor"}
              </button>
              <label className="field">
                fps
                <input
                  type="number"
                  min={1}
                  max={240}
                  value={fps}
                  onChange={(e) =>
                    setFps(Math.max(1, parseInt(e.target.value, 10) || 30))
                  }
                />
              </label>
            </div>

            <div className="row">
              <button
                className={debug ? "active" : ""}
                onClick={() => setDebug((d) => !d)}
                disabled={busy || debugFrames.length === 0}
              >
                ◴ Debug
              </button>
              <button onClick={exportVideo} disabled={busy || displayPoints.length < 2}>
                ⬇ Export video
              </button>
              <button onClick={share} disabled={busy || displayPoints.length < 2}>
                🔗 Save &amp; share
              </button>
              <button
                onClick={() => {
                  setPoints([]);
                  setDebugFrames([]);
                  setAnchors([]);
                  traceCtxRef.current = null;
                  setShareUrl("");
                  setStatus({ msg: "", kind: "" });
                }}
                disabled={busy || points.length === 0}
              >
                ↺ Clear trace
              </button>
              <button
                onClick={() => {
                  if (videoUrl) URL.revokeObjectURL(videoUrl);
                  setVideoUrl("");
                  setPoints([]);
                  setDebugFrames([]);
                  setAnchors([]);
                  traceCtxRef.current = null;
                  setRoi(null);
                  setLanding(null);
                }}
                disabled={busy}
              >
                ⨯ New video
              </button>
            </div>

            <div className={`status ${status.kind}`}>{status.msg}</div>

            {shareUrl && (
              <div className="sharebox">
                <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
                <button onClick={() => navigator.clipboard?.writeText(shareUrl)}>
                  Copy
                </button>
              </div>
            )}
          </div>
        </>
      )}

      <footer>
        Tracer — classical computer-vision ball tracking, no model downloads.
        Built with React + Netlify Functions.
      </footer>
    </div>
  );
}

function seekToAsync(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = time;
  });
}
