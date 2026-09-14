import semver from "semver";

const REGISTRY_BASE = "https://registry.npmjs.org";

// In-memory only — cleared when the process exits, so it doesn't save a
// network round trip across separate `scanner scan` runs. What it does
// save: a package's full metadata document covers every published version
// in one request, so within a single scan it avoids re-fetching a package
// that shows up more than once (e.g. same name in dependencies and
// devDependencies), and Phase 4's maintainer/version-anomaly checks can
// reuse the same cached document instead of hitting the registry again.
//
// Deliberately keyed by package name, not name+version: the registry has no
// per-version-only endpoint that's cheaper than the whole-package one, so
// keying by name+version would just cause duplicate fetches of the same
// document when a package appears under different declared ranges.
const metadataCache = new Map();

export function clearRegistryCache() {
  metadataCache.clear();
}

/**
 * Fetches (and caches) the full registry metadata document for a package.
 * Returns null if the package isn't found (404) rather than throwing, so a
 * scan can report "not found on registry" instead of crashing.
 */
export function fetchPackageMetadata(name, { fetchImpl = fetch } = {}) {
  if (metadataCache.has(name)) {
    return metadataCache.get(name);
  }

  const promise = (async () => {
    const url = `${REGISTRY_BASE}/${name}`;
    let response;
    try {
      response = await fetchImpl(url);
    } catch (err) {
      throw new Error(`Network error fetching ${name} from registry: ${err.message}`);
    }

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Registry returned ${response.status} for ${name}`);
    }

    return response.json();
  })();

  metadataCache.set(name, promise);
  return promise;
}

/**
 * Picks the version that would actually be installed for a declared range,
 * given a package's registry metadata. Falls back to the "latest" dist-tag
 * when the range doesn't resolve against published versions (e.g. a git
 * URL, "workspace:*", or a range with no matching release) — this is an
 * approximation, since without a lockfile we can't know the exact resolved
 * version npm would pick.
 */
export function resolveVersion(versionRange, metadata) {
  const publishedVersions = Object.keys(metadata.versions ?? {});
  // Deliberately NOT { includePrerelease: true }: real npm excludes
  // prerelease versions (1.5.0-beta.1) from matching a plain range like
  // "^1.0.0" unless the range itself targets a prerelease. Matching that
  // default matters here, not just for realism — Phase 4 found that some
  // packages publish nightly/canary builds with unusual version numbers
  // (e.g. "0.0.0-nightly-next-...") that would otherwise be eligible to get
  // selected as "resolved" for certain ranges, corrupting the version being
  // analyzed.
  const resolved = semver.maxSatisfying(publishedVersions, versionRange);
  if (resolved) {
    return { version: resolved, approximated: false };
  }

  const latest = metadata["dist-tags"]?.latest;
  if (latest && metadata.versions?.[latest]) {
    return { version: latest, approximated: true };
  }

  return null;
}
