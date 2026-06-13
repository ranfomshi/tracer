import { getStore } from "@netlify/blobs";

// Retrieve a previously saved trace by id. Functions v2 signature so the Blobs
// environment is wired up automatically.

export default async (req: Request): Promise<Response> => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return new Response("Missing id", { status: 400 });
  }

  const store = getStore("traces");
  const record = await store.get(id, { type: "json" });
  if (!record) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(JSON.stringify(record), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
};
