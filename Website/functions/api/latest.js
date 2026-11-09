import { getLatest } from "../_latest.js";

export async function onRequestGet() {
  try {
    return Response.json(await getLatest(), { headers: { "cache-control": "public, max-age=60" } });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 502 });
  }
}
