import type { Handler } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Retrieve a previously saved trace by id.

export const handler: Handler = async (event) => {
  const id = event.queryStringParameters?.id;
  if (!id) {
    return { statusCode: 400, body: "Missing id" };
  }

  const store = getStore("traces");
  const record = await store.get(id, { type: "json" });
  if (!record) {
    return { statusCode: 404, body: "Not found" };
  }

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=31536000, immutable",
    },
    body: JSON.stringify(record),
  };
};
