import type { Handler } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Persist a trace as JSON in a Netlify Blobs store and return a short id that
// can be used to retrieve / share it.

function randomId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const trace = payload as {
    points?: unknown[];
    width?: number;
    height?: number;
    fps?: number;
  };
  if (!Array.isArray(trace.points) || trace.points.length === 0) {
    return { statusCode: 400, body: "Trace must include points" };
  }

  const id = randomId();
  const record = {
    id,
    createdAt: new Date().toISOString(),
    width: trace.width ?? 0,
    height: trace.height ?? 0,
    fps: trace.fps ?? 30,
    points: trace.points,
    note: (payload as { note?: string }).note,
  };

  const store = getStore("traces");
  await store.setJSON(id, record);

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  };
};
