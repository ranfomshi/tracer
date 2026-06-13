// Thin client for the Netlify Functions that persist & share traces.

import type { TrackPoint } from "./tracker";

export interface SharedTrace {
  id?: string;
  createdAt?: string;
  /** Native video pixel dimensions the points were captured against. */
  width: number;
  height: number;
  fps: number;
  points: TrackPoint[];
  note?: string;
}

export async function saveTrace(trace: SharedTrace): Promise<{ id: string }> {
  const res = await fetch("/.netlify/functions/save-trace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(trace),
  });
  if (!res.ok) throw new Error(`Save failed (${res.status})`);
  return res.json();
}

export async function getTrace(id: string): Promise<SharedTrace> {
  const res = await fetch(
    `/.netlify/functions/get-trace?id=${encodeURIComponent(id)}`,
  );
  if (!res.ok) throw new Error(`Trace ${id} not found (${res.status})`);
  return res.json();
}
