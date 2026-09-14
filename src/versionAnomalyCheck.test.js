import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  getVersionHistory,
  checkDormancy,
  checkMajorJump,
  checkMaintainerChange,
} from "./versionAnomalyCheck.js";
import { DORMANCY_DAYS, MIN_MAJOR_JUMP } from "./versionAnomalyScan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

function loadFixture(relativePath) {
  return JSON.parse(readFileSync(join(projectRoot, relativePath), "utf-8"));
}

function fakeMetadata({ time, maintainersByVersion = {} }) {
  const versions = {};
  for (const version of Object.keys(time)) {
    if (["created", "modified", "unpublished"].includes(version)) continue;
    versions[version] = { maintainers: maintainersByVersion[version] ?? [] };
  }
  return { time, versions };
}

// ---------------------------------------------------------------------------
// 1. Unit tests for the core logic
// ---------------------------------------------------------------------------
describe("getVersionHistory", () => {
  it("sorts versions by actual publish time, not semver order", () => {
    const metadata = fakeMetadata({
      time: {
        created: "2020-01-01T00:00:00Z",
        modified: "2023-01-01T00:00:00Z",
        "2.0.0": "2022-01-01T00:00:00Z",
        "1.0.0": "2020-06-01T00:00:00Z",
        // published out of semver order: a patch to the old major, after 2.0.0 shipped
        "1.0.1": "2023-01-01T00:00:00Z",
      },
    });

    const history = getVersionHistory(metadata);
    expect(history.map((h) => h.version)).toEqual(["1.0.0", "2.0.0", "1.0.1"]);
  });

  it("excludes the created/modified/unpublished meta-keys", () => {
    const metadata = fakeMetadata({
      time: {
        created: "2020-01-01T00:00:00Z",
        modified: "2023-01-01T00:00:00Z",
        "1.0.0": "2020-06-01T00:00:00Z",
      },
    });
    expect(getVersionHistory(metadata).map((h) => h.version)).toEqual(["1.0.0"]);
  });
});

describe("checkDormancy", () => {
  const metadata = fakeMetadata({
    time: {
      "1.0.0": "2020-01-01T00:00:00Z",
      "1.0.1": "2020-02-01T00:00:00Z", // 31 days after 1.0.0
      "2.0.0": "2023-01-01T00:00:00Z", // ~1065 days after 1.0.1
    },
  });
  const history = getVersionHistory(metadata);

  it("does not flag the first-ever release (no predecessor)", () => {
    expect(checkDormancy(history, "1.0.0", { dormancyDays: 365 })).toBeNull();
  });

  it("does not flag a normal, short gap", () => {
    expect(checkDormancy(history, "1.0.1", { dormancyDays: 365 })).toBeNull();
  });

  it("flags a gap at or above the threshold", () => {
    const result = checkDormancy(history, "2.0.0", { dormancyDays: 365 });
    expect(result).not.toBeNull();
    expect(result.previousVersion).toBe("1.0.1");
    expect(result.gapDays).toBeGreaterThanOrEqual(1000);
  });

  it("does not flag when the threshold is raised above the actual gap", () => {
    expect(checkDormancy(history, "2.0.0", { dormancyDays: 5000 })).toBeNull();
  });

  it("returns null for a version not present in history", () => {
    expect(checkDormancy(history, "9.9.9", { dormancyDays: 365 })).toBeNull();
  });
});

describe("checkMajorJump", () => {
  const metadata = fakeMetadata({
    time: {
      "1.0.0": "2020-01-01T00:00:00Z",
      "2.0.0": "2020-02-01T00:00:00Z", // jump of 1 — routine
      "5.0.0": "2020-03-01T00:00:00Z", // jump of 3 from 2.0.0 — large
    },
  });
  const history = getVersionHistory(metadata);

  it("does not flag a routine single major bump", () => {
    expect(checkMajorJump(history, "2.0.0", { minJump: 2 })).toBeNull();
  });

  it("flags a jump at or above the threshold", () => {
    const result = checkMajorJump(history, "5.0.0", { minJump: 2 });
    expect(result).toEqual({ previousVersion: "2.0.0", jump: 3 });
  });

  it("does not flag a major-version decrease (e.g. a backport release)", () => {
    const metadataWithBackport = fakeMetadata({
      time: {
        "5.0.0": "2020-01-01T00:00:00Z",
        "2.0.1": "2020-02-01T00:00:00Z", // published later, but a lower major
      },
    });
    const h = getVersionHistory(metadataWithBackport);
    expect(checkMajorJump(h, "2.0.1", { minJump: 2 })).toBeNull();
  });

  it("respects a stricter threshold", () => {
    expect(checkMajorJump(history, "5.0.0", { minJump: 4 })).toBeNull();
  });

  it("ignores prerelease/nightly versions as the comparison baseline (real FP found in Phase 4 measurement)", () => {
    // A nightly channel publishes "0.0.0-nightly-*" the same day as a
    // normal 48.x stable release — naive chronological comparison would
    // read this as a 48-major jump. It should compare against the last
    // *stable* release instead.
    const metadata = fakeMetadata({
      time: {
        "47.0.0": "2020-01-01T00:00:00Z",
        "0.0.0-nightly-next-20260902.0": "2020-06-01T00:00:00Z",
        "48.5.0": "2020-06-01T00:00:01Z",
      },
    });
    const h = getVersionHistory(metadata);
    // Correctly computes a routine jump of 1 (47 -> 48) against the last
    // stable release, so it's not flagged even at a permissive threshold —
    // the naive (unfixed) computation would have reported jump: 48.
    expect(checkMajorJump(h, "48.5.0", { minJump: 1 })).toEqual({
      previousVersion: "47.0.0",
      jump: 1,
    });
    expect(checkMajorJump(h, "48.5.0", { minJump: 2 })).toBeNull();
  });

  it("returns null when the target version is itself a prerelease", () => {
    const metadata = fakeMetadata({
      time: {
        "1.0.0": "2020-01-01T00:00:00Z",
        "5.0.0-beta.1": "2020-06-01T00:00:00Z",
      },
    });
    const h = getVersionHistory(metadata);
    expect(checkMajorJump(h, "5.0.0-beta.1", { minJump: 2 })).toBeNull();
  });
});

describe("checkMaintainerChange", () => {
  it("does not flag an unchanged maintainer list", () => {
    const metadata = fakeMetadata({
      time: { "1.0.0": "2020-01-01T00:00:00Z", "1.0.1": "2020-02-01T00:00:00Z" },
      maintainersByVersion: {
        "1.0.0": [{ name: "alice" }, { name: "bob" }],
        "1.0.1": [{ name: "alice" }, { name: "bob" }],
      },
    });
    const history = getVersionHistory(metadata);
    expect(checkMaintainerChange(metadata, history, "1.0.1")).toBeNull();
  });

  it("flags an added maintainer", () => {
    const metadata = fakeMetadata({
      time: { "1.0.0": "2020-01-01T00:00:00Z", "1.0.1": "2020-02-01T00:00:00Z" },
      maintainersByVersion: {
        "1.0.0": [{ name: "alice" }],
        "1.0.1": [{ name: "alice" }, { name: "mallory" }],
      },
    });
    const history = getVersionHistory(metadata);
    const result = checkMaintainerChange(metadata, history, "1.0.1");
    expect(result).toEqual({ previousVersion: "1.0.0", added: ["mallory"], removed: [] });
  });

  it("flags a removed maintainer (the classic hand-off/hijack pattern)", () => {
    const metadata = fakeMetadata({
      time: { "1.0.0": "2020-01-01T00:00:00Z", "1.0.1": "2020-02-01T00:00:00Z" },
      maintainersByVersion: {
        "1.0.0": [{ name: "alice" }],
        "1.0.1": [{ name: "mallory" }],
      },
    });
    const history = getVersionHistory(metadata);
    const result = checkMaintainerChange(metadata, history, "1.0.1");
    expect(result).toEqual({ previousVersion: "1.0.0", added: ["mallory"], removed: ["alice"] });
  });

  it("does not flag the first-ever release (no predecessor to compare)", () => {
    const metadata = fakeMetadata({
      time: { "1.0.0": "2020-01-01T00:00:00Z" },
      maintainersByVersion: { "1.0.0": [{ name: "alice" }] },
    });
    const history = getVersionHistory(metadata);
    expect(checkMaintainerChange(metadata, history, "1.0.0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Real-world true positive: event-stream's 2018 maintainer-hijack
// incident. Fixture is a trimmed, static snapshot of the real registry
// metadata (test-fixtures/event-stream-metadata-snapshot.json) — offline,
// not a live fetch — so this test can't be flaky against network/registry
// state.
// ---------------------------------------------------------------------------
describe("real-world true positive: event-stream (2018)", () => {
  const metadata = loadFixture("test-fixtures/event-stream-metadata-snapshot.json");
  const history = getVersionHistory(metadata);

  it("flags the 780-day dormancy gap right before the compromised 3.3.5 release", () => {
    const result = checkDormancy(history, "3.3.5", { dormancyDays: DORMANCY_DAYS });
    expect(result).not.toBeNull();
    expect(result.previousVersion).toBe("3.3.4");
    expect(result.gapDays).toBe(780);
  });

  it("flags the attacker (right9ctrl) being added as maintainer at 3.3.5", () => {
    const result = checkMaintainerChange(metadata, history, "3.3.5");
    expect(result).toEqual({ previousVersion: "3.3.4", added: ["right9ctrl"], removed: [] });
  });

  it("flags the original author (dominictarr) being removed by 4.0.0", () => {
    const result = checkMaintainerChange(metadata, history, "4.0.0");
    expect(result).toEqual({ previousVersion: "3.3.5", added: [], removed: ["dominictarr"] });
  });

  it("does not flag 3.3.6 itself (the malicious release shipped only 4 days after 3.3.5, no dormancy or maintainer change at that exact version)", () => {
    expect(checkDormancy(history, "3.3.6", { dormancyDays: DORMANCY_DAYS })).toBeNull();
    expect(checkMaintainerChange(metadata, history, "3.3.6")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. False-positive rate regression — unbiased sample.
//
// 270 real packages, randomly sampled from npm's top 10000 by popularity
// (see test-fixtures/version-anomaly-sample.json for the exact provenance,
// including a data-quality caveat: the source ranking dataset had only
// 5247 truly unique names among its 10000 entries, so a 300-item draw
// de-duplicated down to 270). Each entry's dormancy/major-jump outcome at
// several candidate thresholds was precomputed by calling the real
// src/versionAnomalyCheck.js functions directly (see that fixture's
// `description`), so this test only replays those precomputed numbers —
// no live network here, matching the rest of this suite.
// ---------------------------------------------------------------------------
describe("false-positive rate regression (unbiased sample, n=270)", () => {
  const { packages, sampleSize } = loadFixture("test-fixtures/version-anomaly-sample.json");

  it("loaded the expected sample size", () => {
    expect(packages.length).toBe(sampleSize);
    expect(packages.length).toBeGreaterThanOrEqual(250);
  });

  it(`dormancy flag rate at the chosen ${DORMANCY_DAYS}-day threshold stays at or below 13.0% (35/270, measured in Phase 4)`, () => {
    const flagged = packages.filter((p) => p.dormancyAtThreshold[String(DORMANCY_DAYS)] !== null);
    expect(
      flagged.length,
      `flagged: ${JSON.stringify(flagged.map((p) => p.name))}`
    ).toBeLessThanOrEqual(35);
  });

  it(`major-jump flag rate at the chosen minJump=${MIN_MAJOR_JUMP} stays at or below 1.5% (4/270, measured in Phase 4)`, () => {
    const flagged = packages.filter((p) => p.majorJumpAtThreshold[String(MIN_MAJOR_JUMP)] !== null);
    expect(
      flagged.length,
      `flagged: ${JSON.stringify(flagged.map((p) => p.name))}`
    ).toBeLessThanOrEqual(4);
  });

  it("maintainer-change incidence stays at or below 6.3% (17/270, measured in Phase 4) — informational, not a tuned threshold", () => {
    const flagged = packages.filter((p) => p.maintainerAdded.length > 0 || p.maintainerRemoved.length > 0);
    expect(flagged.length).toBeLessThanOrEqual(17);
  });
});
