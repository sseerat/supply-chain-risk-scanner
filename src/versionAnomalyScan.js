import { fetchPackageMetadata, resolveVersion } from "./registryClient.js";
import {
  getVersionHistory,
  checkDormancy,
  checkMajorJump,
  checkMaintainerChange,
} from "./versionAnomalyCheck.js";
import { checkGithubRelease } from "./githubReleaseCheck.js";
import { mapWithConcurrency } from "./mapWithConcurrency.js";

const DEFAULT_CONCURRENCY = 8;

// See README "Phase 4" for the false-positive measurement behind these.
// The brief suggested 12 months (365 days) for dormancy — measured against
// 270 real packages, that flagged 18.5%; 545 days (~18 months) flags 13.0%
// while keeping a ~235-day margin under the real event-stream incident's
// 780-day gap.
export const DORMANCY_DAYS = 545;
// A routine single major bump (jump of 1) flagged 18.1% of the sample —
// completely normal semver practice. Requiring a jump of 2+ (skipping at
// least one major) drops that to 1.5%, and every remaining case in the
// sample was independently explainable (see README), not noise.
export const MIN_MAJOR_JUMP = 2;

/**
 * For each { name, versionRange } dependency, resolves the version that
 * would actually be installed (reusing registryClient's cached metadata —
 * the same document Phase 3's install-script check already fetched, so this
 * adds zero extra registry requests in a full scan) and checks it for:
 *   - a long-dormancy-then-publish gap
 *   - a large major-version jump (with a best-effort GitHub release check)
 *   - a maintainer-list change from the previous published version
 *
 * Returns a Map<name, result> where result.status is one of:
 * "ok" | "not-found" | "unresolved-version" | "error".
 */
export async function scanVersionAnomalies(
  deps,
  { concurrency = DEFAULT_CONCURRENCY, checkGithub = true, dormancyDays = DORMANCY_DAYS, minMajorJump = MIN_MAJOR_JUMP } = {}
) {
  // Unauthenticated GitHub API access is capped at 60 requests/hour. The
  // moment one call comes back rate-limited, stop trying for the rest of
  // this scan rather than burning through 404s that'll all fail the same way.
  let githubRateLimited = false;

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

    const history = getVersionHistory(metadata);
    const dormancy = checkDormancy(history, resolved.version, { dormancyDays });
    const majorJump = checkMajorJump(history, resolved.version, { minJump: minMajorJump });
    const maintainerChange = checkMaintainerChange(metadata, history, resolved.version);

    let github = { checked: false, reason: "not attempted (no major-version jump flagged)" };
    if (checkGithub && majorJump && !githubRateLimited) {
      const repositoryField = metadata.versions[resolved.version]?.repository ?? metadata.repository;
      github = await checkGithubRelease(repositoryField, resolved.version, name);
      if (!github.checked && github.reason === "GitHub API rate limited") {
        githubRateLimited = true;
      }
    }

    return {
      name,
      status: "ok",
      resolvedVersion: resolved.version,
      approximated: resolved.approximated,
      dormancy,
      majorJump,
      maintainerChange,
      github,
    };
  });

  return new Map(results.map((r) => [r.name, r]));
}
