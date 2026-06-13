import { useEffect, useMemo, useRef, useState } from "react";
import TracerStage from "./components/TracerStage";
import {
  DEFAULT_OPTIONS,
  detectCandidates,
  fitTrajectory,
  type Anchor,
  type Candidate,
  type Rect,
  type TrackPoint,
} from "./lib/tracker";

export interface DebugFrame {
  t: number;
  cands: Candidate[];
}

/** A user-placed ball position, stored in video time (mapped to a frame index
 *  at fit time, since frame spacing depends on the chosen window). */
interface TAnchor {
  t: number;
  x: number;
  y: number;
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
  const [impact, setImpact] = useState<TAnchor | null>(null);
  const [landing, setLanding] = useState<TAnchor | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [clock, setClock] = useState(0);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [debug, setDebug] = useState(false);
  const [debugFrames, setDebugFrames] = useState<DebugFrame[]>([]);
  const [anchors, setAnchors] = useState<TAnchor[]>([]);
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

  // All user-placed anchors (impact first, then mid-flight, then landing) as a
  // single time-ordered list — the source of truth for both setup and re-fit.
  const allAnchors = useMemo<TAnchor[]>(() => {
    const list: TAnchor[] = [];
    if (impact) list.push(impact);
    list.push(...anchors);
    if (landing) list.push(landing);
    return list.sort((a, b) => a.t - b.t);
  }, [impact, anchors, landing]);

  // Map time-based anchors onto frame indices for a given window, de-duped.
  const anchorsByFrame = (
    list: TAnchor[],
    seedT: number,
    dt: number,
    count: number,
  ): Anchor[] => {
    const byN = new Map<number, Anchor>();
    for (const a of list) {
      const n = Math.max(0, Math.min(count - 1, Math.round((a.t - seedT) / dt)));
      byN.set(n, { n, x: a.x, y: a.y });
    }
    return [...byN.values()].sort((a, b) => a.n - b.n);
  };

  // Drop a computed trace (keeps the user's anchors) — used when the window-
  // defining impact/landing changes and a fresh trace is needed.
  const invalidateTrace = () => {
    setPoints([]);
    setDebugFrames([]);
    traceCtxRef.current = null;
  };

  // Re-fit from cached detections (used when anchors change after a trace).
  const refitFromCtx = (list: TAnchor[]) => {
    const ctx = traceCtxRef.current;
    if (!ctx) return;
    const anchored = anchorsByFrame(list, ctx.seedT, ctx.dt, ctx.frameMeta.length);
    setPoints(fitTrajectory(ctx.candidates, ctx.frameMeta, anchored, ctx.diag));
  };

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
    setImpact(null);
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

    if (mode === "seed") {
      setImpact({ x, y, t });
      setMode("view");
      // Impact defines the trace window (and colour template) — invalidate any
      // existing trace so it's re-computed.
      invalidateTrace();
      setStatus({
        msg: "Impact set. Add anchors on a few mid-flight frames and/or set the landing, then Trace shot.",
        kind: "ok",
      });
    } else if (mode === "land") {
      setLanding({ x, y, t });
      setMode("view");
      // Landing defines the END of the trace window — must re-trace so the last
      // frame is the one you marked, not the end of the clip.
      invalidateTrace();
      setStatus({
        msg: "Landing set — press Trace shot to fit the arc ending on this frame.",
        kind: "ok",
      });
    } else if (mode === "correct") {
      // Add (or replace, if on the same frame) a mid-flight anchor. Works both
      // before a trace (feeds the fit) and after (re-fits instantly).
      const sameFrame = (a: TAnchor) =>
        traceCtxRef.current
          ? Math.round((a.t - traceCtxRef.current.seedT) / traceCtxRef.current.dt) ===
            Math.round((t - traceCtxRef.current.seedT) / traceCtxRef.current.dt)
          : Math.abs(a.t - t) < 0.5 / fps;
      const next = [...anchors.filter((a) => !sameFrame(a)), { x, y, t }].sort(
        (a, b) => a.t - b.t,
      );
      setAnchors(next);
      if (traceCtxRef.current) {
        const full = [...(impact ? [impact] : []), ...next, ...(landing ? [landing] : [])];
        refitFromCtx(full);
      }
      const total = next.length + (impact ? 1 : 0) + (landing ? 1 : 0);
      setStatus({
        msg: traceCtxRef.current
          ? `Anchor added — arc re-fitted (${total} anchors).`
          : `Anchor added (${total} total). They'll guide the trace.`,
        kind: "ok",
      });
    }
  };

  const runTrace = async () => {
    const v = videoRef.current;
    if (!v || !impact) return;
    const seed = impact;
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
      const candidates = detectCandidates(frames, { x: seed.x, y: seed.y }, DEFAULT_OPTIONS, roi);
      const frameMeta = frames.map((f) => ({ frame: f.frame, t: f.t }));
      const diag = Math.hypot(meta.w, meta.h);
      // Map every user anchor (impact + mid-flight + landing) onto frame indices
      // and fit through them; detection fills the gaps.
      const anchored = anchorsByFrame(allAnchors, seed.t, dt, frames.length);
      const tracked = fitTrajectory(candidates, frameMeta, anchored, diag);

      // Cache the detection context so anchor edits re-fit instantly (no re-grab).
      traceCtxRef.current = {
        candidates,
        frameMeta,
        diag,
        seedT: seed.t,
        dt,
      };
      setPoints(tracked);
      setDebugFrames(
        tracked.map((p, n) => ({ t: p.t, cands: candidates[n] ?? [] })),
      );
      await seekToAsync(v, seed.t);
      const hit = tracked.filter((p) => p.confidence > 0.1).length;
      const detected = candidates.reduce((s, c) => s + c.length, 0);
      setStatus({
        msg: `Traced ${tracked.length} frames — ${hit} backed by detections, ${detected} candidates found.${
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
        ? "Step to a frame and click the <b>ball</b> to anchor it. Add several across the flight — the trace fits through every anchor."
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
            markers={[...(impact ? [impact] : []), ...anchors].map((a) => ({
              x: a.x,
              y: a.y,
            }))}
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
                className={mode === "seed" ? "active" : impact ? "active" : ""}
                onClick={() => setMode(mode === "seed" ? "view" : "seed")}
                disabled={busy}
              >
                ◎ {impact ? "Edit impact" : "Set impact"}
              </button>
              <button
                className={mode === "correct" ? "active" : anchors.length ? "active" : ""}
                onClick={() => setMode(mode === "correct" ? "view" : "correct")}
                disabled={busy || !impact}
              >
                ✎ {anchors.length ? `Add anchor (${anchors.length})` : "Add anchor"}
              </button>
              <button
                className={mode === "land" ? "active" : landing ? "active" : ""}
                onClick={() => setMode(mode === "land" ? "view" : "land")}
                disabled={busy || !impact}
              >
                ⊕ {landing ? "Edit landing" : "Set landing"}
              </button>
              <button
                className="primary"
                onClick={runTrace}
                disabled={busy || !impact}
              >
                ✦ Trace shot
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
                  // Clear computed results but keep the user's anchors/impact/
                  // landing so the shot can be re-traced.
                  setPoints([]);
                  setDebugFrames([]);
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
                  setImpact(null);
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
