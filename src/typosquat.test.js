import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  maxAllowedDistance,
  checkTyposquat,
  findTyposquats,
  loadTop1000,
} from "./typosquat.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

function loadFixture(relativePath) {
  return JSON.parse(readFileSync(join(projectRoot, relativePath), "utf-8"));
}

// ---------------------------------------------------------------------------
// 1. Unit tests for the length-scaling rule itself
// ---------------------------------------------------------------------------
describe("maxAllowedDistance (length-scaling rule)", () => {
  it("requires an exact match (distance 0) under 4 chars", () => {
    expect(maxAllowedDistance(1)).toBe(0);
    expect(maxAllowedDistance(2)).toBe(0);
    expect(maxAllowedDistance(3)).toBe(0);
  });

  it("allows distance <= 1 at 4-5 chars", () => {
    expect(maxAllowedDistance(4)).toBe(1);
    expect(maxAllowedDistance(5)).toBe(1);
  });

  it("allows distance <= 2 at 6+ chars", () => {
    expect(maxAllowedDistance(6)).toBe(2);
    expect(maxAllowedDistance(7)).toBe(2);
    expect(maxAllowedDistance(20)).toBe(2);
  });
});

// checkTyposquat exercised against a small, fixed popular-name list so these
// assertions don't depend on the contents of the bundled snapshot (which is
// expected to be regenerated over time).
describe("checkTyposquat (core logic, controlled input)", () => {
  const popularNames = ["chalk", "express", "commander", "ms"];

  it("does not flag an exact match", () => {
    expect(checkTyposquat("chalk", popularNames)).toBeNull();
  });

  it("flags a name exactly at the allowed boundary (4-5 char bucket, distance 1)", () => {
    // chalk (5) -> chalkk: distance 1, shorter length 5 -> allowed 1
    const result = checkTyposquat("chalkk", popularNames);
    expect(result).toEqual({ closestMatch: "chalk", distance: 1 });
  });

  it("does not flag a name one step past the boundary (distance 2 at 4-5 char bucket)", () => {
    // chalk (5) -> chalkzz: distance 2, shorter length 5 -> allowed 1, so 2 is over
    expect(checkTyposquat("chalkzz", popularNames)).toBeNull();
  });

  it("never flags near a 2-3 char popular name, even at distance 1", () => {
    // "ms" -> "os": distance 1, shorter length 2 -> allowed 0
    expect(checkTyposquat("os", popularNames)).toBeNull();
  });

  it("returns the closest match when multiple candidates are within range", () => {
    const result = checkTyposquat("expres", popularNames);
    expect(result).toEqual({ closestMatch: "express", distance: 1 });
  });
});

// ---------------------------------------------------------------------------
// 2. Known typosquats (true positives) — against the real bundled snapshot
// ---------------------------------------------------------------------------
describe("known typosquat-style names are flagged (true positives)", () => {
  const { packages: top1000 } = loadTop1000();

  const cases = [
    // [name, expected closest match, expected distance]
    ["lodahs", "lodash", 2],
    ["lodashs", "lodash", 1],
    ["expres", "express", 1],
    ["axioss", "axios", 1],
    ["commanderr", "commander", 1],
    ["webpac", "webpack", 1],
    ["eslintt", "eslint", 1],
    // Borderline: distance sits exactly at the allowed maximum for its bucket.
    ["chalkk", "chalk", 1], // 4-5 char bucket, allowed == 1
    ["corss-env", "cross-env", 2], // 6+ char bucket, allowed == 2
  ];

  it.each(cases)("flags %s as a possible typo of %s (distance %i)", (name, expectedMatch, expectedDistance) => {
    const result = checkTyposquat(name, top1000);
    expect(result).not.toBeNull();
    expect(result.closestMatch).toBe(expectedMatch);
    expect(result.distance).toBe(expectedDistance);
  });
});

// ---------------------------------------------------------------------------
// 3. Known legitimate packages (true negatives)
// ---------------------------------------------------------------------------
describe("known legitimate packages are not flagged (true negatives)", () => {
  const { packages: top1000 } = loadTop1000();

  it("does not flag exact matches to popular packages", () => {
    for (const name of ["lodash", "express", "chalk", "commander", "debug", "react"]) {
      expect(checkTyposquat(name, top1000)).toBeNull();
    }
  });

  // These are the short-name false positives measured in Phase 2 before the
  // length-scaling fix (e.g. "util" was flagged as a typo of "uuid" at a flat
  // distance <= 2 threshold). They must stay unflagged.
  it("does not flag short, unrelated legitimate names (the original false-positive cases)", () => {
    const shortNameCases = ["util", "temp", "moo", "esm", "tsx", "lie", "del"];
    for (const name of shortNameCases) {
      const result = checkTyposquat(name, top1000);
      expect(result, `expected "${name}" not to be flagged, got ${JSON.stringify(result)}`).toBeNull();
    }
  });

  it("does not flag a name one step past its bucket's allowed boundary", () => {
    // commander (9) -> commandrxy: distance 3, shorter length 9 -> allowed 2
    expect(checkTyposquat("commandrxy", top1000)).toBeNull();
  });

  it("produces zero false positives on a real-world package.json (express)", () => {
    const expressManifest = loadFixture("test-fixtures/express-package.json");
    const depNames = [
      ...Object.keys(expressManifest.dependencies ?? {}),
      ...Object.keys(expressManifest.devDependencies ?? {}),
    ];
    const flags = findTyposquats(depNames);
    expect(flags.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Documented limitations: names the current algorithm is known to miss.
// Standard Levenshtein counts an adjacent-letter transposition as distance 2
// (not 1), and single-character-longer words on short names fall outside the
// allowed bucket. See README "Known limitation". If the algorithm changes
// (e.g. a move to Damerau-Levenshtein) these are expected to start failing —
// update them deliberately rather than treating a failure here as a bug.
// ---------------------------------------------------------------------------
describe("documented limitations (currently missed typosquats)", () => {
  const { packages: top1000 } = loadTop1000();

  it.each(["reqeusts", "chlak", "electorn", "electon", "babell", "axois"])(
    "does not currently flag %s",
    (name) => {
      expect(checkTyposquat(name, top1000)).toBeNull();
    }
  );
});

// ---------------------------------------------------------------------------
// 4. Regression: false-positive rate on the 500-package benchmark sample
// ---------------------------------------------------------------------------
describe("false-positive rate regression (npm ranks 1001-1500)", () => {
  it("stays at or below the 4.8% (24/500) measured in Phase 2", () => {
    const { packages: top1000 } = loadTop1000();
    const { packages: sample } = loadFixture("test-fixtures/popular-packages-1001-1500.json");

    const flagged = sample.filter((name) => checkTyposquat(name, top1000) !== null);
    const rate = flagged.length / sample.length;

    expect(
      flagged.length,
      `false positives: ${JSON.stringify(flagged)}`
    ).toBeLessThanOrEqual(24);
    expect(rate).toBeLessThanOrEqual(0.048);
  });
});
