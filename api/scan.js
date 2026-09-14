import { getDirectDependenciesFromManifest } from "../src/parsePackageJson.js";
import { runScan } from "../src/scan.js";

// Vercel Functions config. Hobby-plan deployments cap actual execution well
// below this regardless (historically 10s) — this just requests the
// platform's maximum rather than assuming it. See SCAN_TIMEOUT_MS below for
// the internal guard that matters regardless of plan.
export const config = {
  maxDuration: 30,
};

// A large package.json isn't primarily a *byte-size* risk here (real
// manifests are tiny) — it's a *dependency-count* risk, since each
// dependency triggers live npm registry (and sometimes GitHub) calls. Cap
// the number processed per request rather than the request body size.
const MAX_DEPENDENCIES = 100;

// Internal timeout, independent of the platform's own function timeout —
// guarantees the client gets a clean JSON error instead of a raw platform
// 504 if the npm registry or GitHub API is slow. Note: this does not abort
// the in-flight registry requests themselves (no AbortController threaded
// through registryClient/githubReleaseCheck) — it only stops *waiting* on
// them and responds to the client; the background work may still run to
// completion server-side within the platform's own hard limit.
const SCAN_TIMEOUT_MS = 25_000;

// Best-effort, single-instance rate limiting — with a confirmed gap, not
// just a theoretical one: tested locally via `vercel dev`, and each
// invocation runs as an isolated process with its own fresh module state,
// so requestLog never accumulates between requests there — this provides
// ZERO protection under `vercel dev`. In real production it may do a
// little better on a single warm instance reused across consecutive
// requests, but Vercel Functions can and do scale to multiple concurrent
// instances with independent memory, so it's still not a real distributed
// limit. Kept as a real (if weak) speed bump rather than nothing, but a
// production deployment expecting genuine public traffic should replace
// this with Vercel KV or Upstash Redis for an actual guarantee — the
// dependency-count cap and timeout below are the safeguards that actually
// hold regardless of instance/process state.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const requestLog = new Map(); // ip -> recent request timestamps

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (requestLog.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  requestLog.set(ip, recent);

  // Bound memory: an unbounded Map keyed by IP would itself be a resource
  // leak against a warm instance under sustained abuse.
  if (requestLog.size > 5000) {
    requestLog.clear();
  }

  return recent.length > RATE_LIMIT_MAX_REQUESTS;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("__scan_timeout__")), ms)),
  ]);
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

export default async function handler(req, res) {
  // Permissive CORS: this is a public, read-only analysis endpoint with no
  // auth and no sensitive data, so allowing any origin to call it is fine.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. POST a package.json body to this endpoint." });
    return;
  }

  if (isRateLimited(getClientIp(req))) {
    res.status(429).json({ error: "Too many requests. Please wait a minute and try again." });
    return;
  }

  // req.body is a lazy getter on Vercel's Node runtime — accessing it
  // throws synchronously if the body doesn't parse as JSON (confirmed via
  // local `vercel dev` testing, not just a defensive guess), so this must
  // be inside a try/catch rather than a plain assignment.
  let manifest;
  try {
    manifest = req.body;
  } catch {
    res.status(400).json({ error: "Request body is not valid JSON." });
    return;
  }

  if (typeof manifest === "string") {
    try {
      manifest = JSON.parse(manifest);
    } catch {
      res.status(400).json({ error: "Request body is not valid JSON." });
      return;
    }
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    res.status(400).json({ error: "Request body must be a JSON object — the contents of a package.json file." });
    return;
  }

  let deps;
  try {
    deps = getDirectDependenciesFromManifest(manifest);
  } catch {
    // Internal errors never reach the client as raw messages/stack traces —
    // full detail goes to the platform's server-side logs only.
    console.error("Failed to extract dependencies from manifest:", manifest);
    res.status(400).json({ error: "Could not read dependencies from the provided package.json." });
    return;
  }

  if (deps.length === 0) {
    res.status(200).json([]);
    return;
  }

  if (deps.length > MAX_DEPENDENCIES) {
    res.status(413).json({
      error: `Too many dependencies (${deps.length}). This endpoint scans at most ${MAX_DEPENDENCIES} direct dependencies per request.`,
    });
    return;
  }

  try {
    const results = await withTimeout(runScan(deps), SCAN_TIMEOUT_MS);
    res.status(200).json(results);
  } catch (err) {
    if (err instanceof Error && err.message === "__scan_timeout__") {
      res.status(504).json({
        error: "The scan took too long (npm registry or GitHub API was slow). Try again, or scan a smaller package.json.",
      });
      return;
    }

    console.error("Scan failed:", err);
    res.status(500).json({ error: "Internal error while scanning. Please try again." });
  }
}
