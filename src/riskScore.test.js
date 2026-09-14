import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeRiskScore, deriveSignals } from "./riskScore.js";
import { getVersionHistory, checkDormancy, checkMajorJump, checkMaintainerChange } from "./versionAnomalyCheck.js";
import { DORMANCY_DAYS, MIN_MAJOR_JUMP } from "./versionAnomalyScan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

function loadFixture(relativePath) {
  return JSON.parse(readFileSync(join(projectRoot, relativePath), "utf-8"));
}

// ---------------------------------------------------------------------------
// 1. Unit tests for the scoring rule itself
// ---------------------------------------------------------------------------
describe("computeRiskScore", () => {
  it("scores no signals as Low", () => {
    expect(computeRiskScore([])).toBe("Low");
  });

  it("scores each weak signal alone as Low (not Medium, not High)", () => {
    expect(computeRiskScore(["dormancy"])).toBe("Low");
    expect(computeRiskScore(["majorJump"])).toBe("Low");
    expect(computeRiskScore(["maintainerChange"])).toBe("Low");
  });

  it("scores each strong signal alone as Medium — never High by itself", () => {
    expect(computeRiskScore(["typosquat"])).toBe("Medium");
    expect(computeRiskScore(["installScript"])).toBe("Medium");
  });

  it("scores any 2 distinct signal types as High, weak+weak included", () => {
    expect(computeRiskScore(["dormancy", "maintainerChange"])).toBe("High");
    expect(computeRiskScore(["dormancy", "majorJump"])).toBe("High");
    expect(computeRiskScore(["majorJump", "maintainerChange"])).toBe("High");
  });

  it("scores 2 strong signals together as High", () => {
    expect(computeRiskScore(["typosquat", "installScript"])).toBe("High");
  });

  it("scores the illustrative 3-signal event-stream-style combination as High", () => {
    expect(computeRiskScore(["dormancy", "majorJump", "maintainerChange"])).toBe("High");
  });

  it("de-duplicates repeated signal entries rather than over-counting", () => {
    // Defensive: deriveSignals never actually produces duplicates, but the
    // scoring function shouldn't silently misbehave if it received them.
    expect(computeRiskScore(["dormancy", "dormancy", "dormancy"])).toBe("Low");
  });

  it("rejects an unrecognized signal name rather than silently miscounting it", () => {
    expect(() => computeRiskScore(["not-a-real-signal"])).toThrow();
  });
});

describe("deriveSignals", () => {
  it("returns no signals for an all-clean package", () => {
    const signals = deriveSignals({
      typosquatFlag: null,
      installScriptResult: { status: "ok", flags: {} },
      versionAnomalyResult: { status: "ok", dormancy: null, majorJump: null, maintainerChange: null },
    });
    expect(signals).toEqual([]);
  });

  it("picks up a typosquat flag", () => {
    const signals = deriveSignals({
      typosquatFlag: { closestMatch: "lodash", distance: 2 },
      installScriptResult: { status: "ok", flags: {} },
      versionAnomalyResult: { status: "ok", dormancy: null, majorJump: null, maintainerChange: null },
    });
    expect(signals).toEqual(["typosquat"]);
  });

  it("picks up an install-script flag", () => {
    const signals = deriveSignals({
      typosquatFlag: null,
      installScriptResult: { status: "ok", flags: { postinstall: [{ category: "network fetch" }] } },
      versionAnomalyResult: { status: "ok", dormancy: null, majorJump: null, maintainerChange: null },
    });
    expect(signals).toEqual(["installScript"]);
  });

  it("picks up all three version-anomaly signals independently", () => {
    const signals = deriveSignals({
      typosquatFlag: null,
      installScriptResult: { status: "ok", flags: {} },
      versionAnomalyResult: {
        status: "ok",
        dormancy: { gapDays: 800 },
        majorJump: { jump: 2 },
        maintainerChange: { added: ["x"], removed: [] },
      },
    });
    expect(signals).toEqual(["dormancy", "majorJump", "maintainerChange"]);
  });

  it("ignores non-'ok' statuses (not-found/error/unresolved) — informational, not scored", () => {
    const signals = deriveSignals({
      typosquatFlag: null,
      installScriptResult: { status: "not-found" },
      versionAnomalyResult: { status: "error", error: "boom" },
    });
    expect(signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Real-world true positive: the full pipeline on event-stream's actual
// 2018 incident data scores High — from real signals (dormancy +
// maintainer change), not a synthetic example. Uses the same offline
// static snapshot as versionAnomalyCheck.test.js.
// ---------------------------------------------------------------------------
describe("real-world true positive: event-stream scores High", () => {
  const metadata = loadFixture("test-fixtures/event-stream-metadata-snapshot.json");
  const history = getVersionHistory(metadata);

  it("scores 3.3.5 (the version that added the attacker as maintainer) as High", () => {
    const dormancy = checkDormancy(history, "3.3.5", { dormancyDays: DORMANCY_DAYS });
    const majorJump = checkMajorJump(history, "3.3.5", { minJump: MIN_MAJOR_JUMP });
    const maintainerChange = checkMaintainerChange(metadata, history, "3.3.5");

    const signals = deriveSignals({
      typosquatFlag: null,
      installScriptResult: { status: "ok", flags: {} },
      versionAnomalyResult: { status: "ok", dormancy, majorJump, maintainerChange },
    });

    // Real data: dormancy (780-day gap) + maintainerChange (right9ctrl
    // added) — 2 aligned signals from the actual incident, no majorJump at
    // this particular version (3.3.x stays within major version 3).
    expect(signals.sort()).toEqual(["dormancy", "maintainerChange"]);
    expect(computeRiskScore(signals)).toBe("High");
  });
});

// ---------------------------------------------------------------------------
// 3. Real-world true negative: a package with ONLY dormancy (no other
// signals) must score Low/Medium, not High — the explicit requirement this
// phase was built around. Pulled from Phase 4's real 270-package sample
// rather than constructed, so it's a genuine "quiet but harmless" package.
// ---------------------------------------------------------------------------
describe("real-world check: dormancy alone does not reach High", () => {
  const { packages } = loadFixture("test-fixtures/version-anomaly-sample.json");

  const dormancyOnly = packages.find(
    (p) =>
      p.dormancyAtThreshold[String(DORMANCY_DAYS)] !== null &&
      p.majorJumpAtThreshold[String(MIN_MAJOR_JUMP)] === null &&
      p.maintainerAdded.length === 0 &&
      p.maintainerRemoved.length === 0
  );

  it("found a real package flagged for dormancy alone in the sample", () => {
    expect(dormancyOnly).toBeDefined();
  });

  it(`scores ${dormancyOnly?.name} (dormancy-only) as Low, not High`, () => {
    const signals = deriveSignals({
      typosquatFlag: null,
      installScriptResult: { status: "ok", flags: {} },
      versionAnomalyResult: {
        status: "ok",
        dormancy: { gapDays: dormancyOnly.dormancyAtThreshold[String(DORMANCY_DAYS)] },
        majorJump: null,
        maintainerChange: null,
      },
    });
    const score = computeRiskScore(signals);
    expect(score).not.toBe("High");
    expect(score).toBe("Low");
  });
});
