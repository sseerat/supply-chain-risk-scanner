// Pure, network-free anomaly checks over a package's registry metadata.
// All three checks compare the scanner's *resolved* version (see
// registryClient.resolveVersion) against whichever published version came
// immediately before it in real publish-time order — not semver order —
// since that's the actual event a compromised-maintainer or hijacked-account
// attack produces: a sudden publish, whenever it happens to land relative to
// version numbering. See README for the thresholds and the false-positive
// measurement behind them.

const META_TIME_KEYS = new Set(["created", "modified", "unpublished"]);

/**
 * Builds { version, publishedAt: Date } entries in actual publish order.
 */
export function getVersionHistory(metadata) {
  const time = metadata.time ?? {};
  const versions = new Set(Object.keys(metadata.versions ?? {}));

  return Object.entries(time)
    .filter(([key]) => versions.has(key) && !META_TIME_KEYS.has(key))
    .map(([version, publishedAt]) => ({ version, publishedAt: new Date(publishedAt) }))
    .sort((a, b) => a.publishedAt - b.publishedAt);
}

function findWithPredecessor(history, targetVersion) {
  const idx = history.findIndex((h) => h.version === targetVersion);
  if (idx <= 0) return null; // not found, or it's the first-ever release (no predecessor)
  return { current: history[idx], previous: history[idx - 1] };
}

// A real-world false positive surfaced during Phase 4 measurement: some
// packages publish to a separate prerelease/nightly/canary channel with its
// own version scheme (e.g. "0.0.0-nightly-next-20260902.0") interleaved in
// publish-time history with normal stable releases. Comparing against one
// of those as "the previous version" produces nonsense (a "48-major jump"
// from a nightly build published the same day). Dormancy and major-jump
// comparisons are about the stable release line a normal `npm install`
// actually walks, so prerelease versions (anything with a semver "-tag") are
// excluded from the comparison history for those two checks — maintainer
// changes aren't filtered, since who can publish is meaningful regardless
// of which channel they published to.
function stableOnly(history) {
  return history.filter((h) => !h.version.includes("-"));
}

/**
 * Flags a version published more than `dormancyDays` after the previous
 * release — i.e. the project went quiet, then suddenly shipped something.
 */
export function checkDormancy(history, targetVersion, { dormancyDays }) {
  const pair = findWithPredecessor(stableOnly(history), targetVersion);
  if (!pair) return null;

  const gapDays = (pair.current.publishedAt - pair.previous.publishedAt) / (1000 * 60 * 60 * 24);
  if (gapDays < dormancyDays) return null;

  return {
    previousVersion: pair.previous.version,
    previousPublishedAt: pair.previous.publishedAt.toISOString(),
    publishedAt: pair.current.publishedAt.toISOString(),
    gapDays: Math.round(gapDays),
  };
}

function parseMajor(version) {
  const match = /^(\d+)\./.exec(version);
  return match ? Number(match[1]) : null;
}

/**
 * Flags a version whose major number jumps by `minJump` or more compared to
 * the immediately preceding published version (e.g. 2.x straight to 4.x).
 * A normal major bump (jump of 1) is routine semver practice, not a flag.
 */
export function checkMajorJump(history, targetVersion, { minJump }) {
  const pair = findWithPredecessor(stableOnly(history), targetVersion);
  if (!pair) return null;

  const currentMajor = parseMajor(pair.current.version);
  const previousMajor = parseMajor(pair.previous.version);
  if (currentMajor === null || previousMajor === null) return null;

  const jump = currentMajor - previousMajor;
  if (jump < minJump) return null;

  return { previousVersion: pair.previous.version, jump };
}

/**
 * Flags a change in the recorded `maintainers` list between the immediately
 * preceding published version and the target version. Each version's
 * maintainers array is a point-in-time snapshot (verified against real
 * registry data — it is not retroactively rewritten), so this reflects who
 * actually had publish access at each release, not just who ran `npm
 * publish` for one specific version (that's `_npmUser`, a weaker signal
 * since any maintainer on a healthy multi-person team can publish any
 * release without it meaning anything changed).
 */
export function checkMaintainerChange(metadata, history, targetVersion) {
  const pair = findWithPredecessor(history, targetVersion);
  if (!pair) return null;

  const currentMaintainers = metadata.versions[pair.current.version]?.maintainers ?? [];
  const previousMaintainers = metadata.versions[pair.previous.version]?.maintainers ?? [];

  const currentNames = new Set(currentMaintainers.map((m) => m.name));
  const previousNames = new Set(previousMaintainers.map((m) => m.name));

  const added = [...currentNames].filter((n) => !previousNames.has(n));
  const removed = [...previousNames].filter((n) => !currentNames.has(n));

  if (added.length === 0 && removed.length === 0) return null;

  return { previousVersion: pair.previous.version, added, removed };
}
