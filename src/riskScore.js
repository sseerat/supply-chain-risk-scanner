// Combines signals from Phases 2-4 into a single Low/Medium/High risk
// score per package. See README "Phase 5" for the empirical validation
// behind this design.
//
// Design rule: a signal's *type* (not how many sub-flags it produced) is
// what counts. Two signal types are treated as independently strong enough
// to reach High on their own if they co-occur (typosquat, installScript);
// the other three (dormancy, majorJump, maintainerChange) are individually
// common/explainable in legitimate packages (measured at 13.0%, 1.5%, and
// 6.3% base rates respectively in Phase 4's real sample) and are
// deliberately capped at Low alone — dormancy in particular was called out
// explicitly: it must never alone produce High.
//
// No single signal — strong or weak — reaches High by itself. High
// requires 2 or more DISTINCT signal types aligning, which Phase 4's real
// sample showed happens in only 1.9% of real packages (5/270) — rare
// enough to be a meaningful "look at this" trigger rather than noise.
const STRONG_SIGNALS = new Set(["typosquat", "installScript"]);
const ALL_SIGNALS = new Set(["typosquat", "installScript", "dormancy", "majorJump", "maintainerChange"]);

export function computeRiskScore(signals) {
  const distinct = new Set(signals);

  for (const s of distinct) {
    if (!ALL_SIGNALS.has(s)) {
      throw new Error(`Unknown signal type: ${s}`);
    }
  }

  if (distinct.size === 0) return "Low";
  if (distinct.size >= 2) return "High";

  const [only] = distinct;
  return STRONG_SIGNALS.has(only) ? "Medium" : "Low";
}

/**
 * Extracts the distinct signal-type names present for one package from its
 * Phase 2-4 scan results. Only "ok" status results contribute signals —
 * "not-found"/"error"/"unresolved-version" are informational, not scored.
 */
export function deriveSignals({ typosquatFlag, installScriptResult, versionAnomalyResult }) {
  const signals = [];

  if (typosquatFlag) {
    signals.push("typosquat");
  }

  if (installScriptResult?.status === "ok" && Object.keys(installScriptResult.flags).length > 0) {
    signals.push("installScript");
  }

  if (versionAnomalyResult?.status === "ok") {
    if (versionAnomalyResult.dormancy) signals.push("dormancy");
    if (versionAnomalyResult.majorJump) signals.push("majorJump");
    if (versionAnomalyResult.maintainerChange) signals.push("maintainerChange");
  }

  return signals;
}
