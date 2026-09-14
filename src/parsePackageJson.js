import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Extracts direct dependencies (regular + dev) from an already-parsed
 * package.json object, each tagged with its declared version range and
 * type. Pure and I/O-free, so it's shared by both the CLI (which reads a
 * file) and the web API (which receives a JSON body) — no filesystem or
 * network access here.
 */
export function getDirectDependenciesFromManifest(manifest) {
  const deps = [];

  for (const [name, versionRange] of Object.entries(manifest.dependencies ?? {})) {
    deps.push({ name, versionRange, type: "dependency" });
  }

  for (const [name, versionRange] of Object.entries(manifest.devDependencies ?? {})) {
    deps.push({ name, versionRange, type: "devDependency" });
  }

  return deps;
}

/**
 * Reads a package.json file and returns its direct dependencies. CLI-only
 * (does filesystem I/O) — see getDirectDependenciesFromManifest for the
 * shared, I/O-free extraction logic.
 */
export function getDirectDependencies(packageJsonPath) {
  const absolutePath = resolve(packageJsonPath);

  let raw;
  try {
    raw = readFileSync(absolutePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`No package.json found at: ${absolutePath}`);
    }
    throw err;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error(`Could not parse JSON in: ${absolutePath}`);
  }

  return getDirectDependenciesFromManifest(manifest);
}
