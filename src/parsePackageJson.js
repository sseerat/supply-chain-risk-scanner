import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Reads a package.json file and returns its direct dependencies
 * (regular + dev), each tagged with the declared version range and type.
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

  const deps = [];

  for (const [name, versionRange] of Object.entries(manifest.dependencies ?? {})) {
    deps.push({ name, versionRange, type: "dependency" });
  }

  for (const [name, versionRange] of Object.entries(manifest.devDependencies ?? {})) {
    deps.push({ name, versionRange, type: "devDependency" });
  }

  return deps;
}
