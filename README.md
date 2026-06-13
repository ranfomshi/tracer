# Tracer 🏌️

Trace the flight path of a golf shot from your own video — a self-hosted,
open take on the broadcast-style ball tracer, running entirely in the browser.

[![Netlify Status](https://img.shields.io/badge/deploy-netlify-2dd4bf)](https://netlify.com)

## How it works

Golf-ball tracing is usually locked behind proprietary hardware/software.
Tracer does it with **classical computer vision in the browser** — no model
downloads, no GPU, no video upload required:

1. **Upload** a clip of a shot (MP4 / MOV / WebM). It stays on your machine.
2. **Set impact** — scrub to the strike and click the ball. Tracer samples the
   ball's actual colour here, so it works whether the ball is *lighter or
   darker* than the background (no "bright blob" assumption).
3. *(Optional)* **Set landing** — scrub to where the ball comes down and click.
   Tracer then traces exactly that window, stays on track toward the spot, and
   anchors the arc to it.
4. *(Optional)* **Limit area** — drag a box; detection ignores everything
   outside it, killing false positives.
5. **Trace** — Tracer steps through the frames, keeps only *moving* pixels that
   match the ball's colour template, and follows it with a velocity-predicting
   search window.
6. **Correct** any stray points with a click; the arc is smoothed for a clean
   broadcast look.
7. **Export** an annotated `.webm`, or **save & share** the trace via a link.

### Pipeline

| Stage | File |
| --- | --- |
| Frame grabbing (canvas) | `src/lib/videoFrames.ts` |
| Detection & tracking | `src/lib/tracker.ts` |
| Smoothing + parabola fit | `src/lib/trajectory.ts` |
| Overlay rendering | `src/components/TracerStage.tsx` |
| Export (MediaRecorder) | `src/lib/export.ts` |
| Save / share | `netlify/functions/*` + Netlify Blobs |

## Tips for good traces

- A reasonably **static camera** helps most — motion is the primary cue.
- Click the ball **precisely at impact**: that click is also the colour sample,
  so land it on the ball, not the background.
- **Set landing** for tricky shots — it bounds the trace and keeps it on track.
- **Limit area** to a generous box around the whole expected flight path.
- Set the **fps** field to match your clip (slow-mo footage especially).

## Develop

```bash
npm install
npm run dev          # vite dev server
npm run netlify:dev  # app + functions (Netlify Blobs)
```

## Build & deploy

```bash
npm run build        # tsc + vite -> dist/
```

Deployed on Netlify. `netlify.toml` configures the build, the functions
directory, and an SPA fallback. Pushing to the default branch triggers a
production deploy.

## Notes / limitations

- Shared traces store the **path only** (in Netlify Blobs), not the video, so a
  viewer re-supplies the matching clip to overlay it.
- Tracking is tuned for typical daytime range/course footage; very noisy
  backgrounds or multiple bright moving objects may need manual corrections.
