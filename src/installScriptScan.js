import { fetchPackageMetadata, resolveVersion } from "./registryClient.js";
import { checkPackageScripts } from "./installScriptCheck.js";
import { mapWithConcurrency } from "./mapWithConcurrency.js";

const DEFAULT_CONCURRENCY = 8;

/**
 * For each { name, versionRange } dependency, fetches registry metadata,
 * resolves the version that would actually be installed, and checks its
 * preinstall/install/postinstall scripts for red-flag patterns.
 *
 * Returns a Map<name, result> where result.status is one of:
 * "ok" | "not-found" | "unresolved-version" | "error".
 */
export async function scanInstallScripts(deps, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const results = await mapWithConcurrency(deps, concurrency, async ({ name, versionRange }) => {
    let metadata;
    try {
      metadata = await fetchPackageMetadata(name);
    } catch (err) {
      return { name, status: "error", error: err.message };
    }

    if (!metadata) {
      return { name, status: "not-found" };
    }

    const resolved = resolveVersion(versionRange, metadata);
    if (!resolved) {
      return { name, status: "unresolved-version" };
    }

    const versionManifest = metadata.versions[resolved.version];
    const { lifecycleScripts, flags } = checkPackageScripts(versionManifest?.scripts);

    return {
      name,
      status: "ok",
      resolvedVersion: resolved.version,
      approximated: resolved.approximated,
      lifecycleScripts,
      flags,
    };
  });

  return new Map(results.map((r) => [r.name, r]));
}
