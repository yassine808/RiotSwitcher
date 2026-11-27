import { getLatest, FEED } from "../_latest.js";

// /download/setup and /download/portable redirect to the newest GitHub release.
export async function onRequestGet({ params }) {
  try {
    const latest = await getLatest();
    const url = params.kind === "portable" ? latest.portable : latest.setup;
    return Response.redirect(url, 302);
  } catch {
    return Response.redirect(FEED.replace("/latest/download", "/latest"), 302);
  }
}
