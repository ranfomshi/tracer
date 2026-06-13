# Tracer 🏌️

Trace the flight path of a golf shot from your own video — a self-hosted,
open take on the broadcast-style ball tracer, running entirely in the browser.

[![Netlify Status](https://img.shields.io/badge/deploy-netlify-2dd4bf)](https://netlify.com)

## How it works

Golf-ball tracing is usually locked behind proprietary hardware/software.
Tracer does it with **classical computer vision in the browser** — no model
downloads, no GPU, no video upload required:

1. **Upload** a clip of a shot (MP4 / MOV / WebM). It stays on your machine.
2. **Scrub** to the moment of impact and click the ball to seed the tracker.
3. **Trace** — Tracer steps through the frames, differences consecutive frames
   to isolate the fast-moving bright ball, and follows it with a velocity-
   predicting search window.
4. **Correct** any stray points with a click; the arc is smoothed and a
   parabola is fit for that clean broadcast look.
5. **Export** an annotated `.webm`, or **save & share** the trace via a link.

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

- A reasonably **static camera** and a **bright ball against a contrasting sky**
  works best — that's what the motion + brightness scoring keys on.
- Set the **fps** field to match your clip (slow-mo footage especially).
- Seed the ball **at or just before impact** for the cleanest arc.

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
