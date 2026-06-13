import { getStore } from "@netlify/blobs";

// Persist a trace as JSON in a Netlify Blobs store and return a short id that
// can be used to retrieve / share it. Uses the Functions v2 signature so the
// Blobs environment is wired up automatically.

function randomId(): string {
  return (
    Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)
  );
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const trace = payload as {
    points?: unknown[];
    width?: number;
    height?: number;
    fps?: number;
    note?: string;
  };
  if (!Array.isArray(trace.points) || trace.points.length === 0) {
    return new Response("Trace must include points", { status: 400 });
  }

  const id = randomId();
  const record = {
    id,
    createdAt: new Date().toISOString(),
    width: trace.width ?? 0,
    height: trace.height ?? 0,
    fps: trace.fps ?? 30,
    points: trace.points,
    note: trace.note,
  };

  const store = getStore("traces");
  await store.setJSON(id, record);

  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
