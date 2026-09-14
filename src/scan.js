import { getDirectDependencies } from "./parsePackageJson.js";
import { findTyposquats } from "./typosquat.js";
import { scanInstallScripts } from "./installScriptScan.js";
import { scanVersionAnomalies } from "./versionAnomalyScan.js";
import { computeRiskScore, deriveSignals } from "./riskScore.js";
import { renderTable, renderJson, renderSummary } from "./report.js";

function resolvedVersionFor(installScriptResult, versionAnomalyResult) {
  if (installScriptResult?.status === "ok") return installScriptResult.resolvedVersion;
  if (versionAnomalyResult?.status === "ok") return versionAnomalyResult.resolvedVersion;
  return null;
}

export async function scanCommand(packageJsonPath, { json = false } = {}) {
  let deps;
  try {
    deps = getDirectDependencies(packageJsonPath);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (deps.length === 0) {
    if (json) {
      console.log("[]");
    } else {
      console.log("No dependencies found.");
    }
    return;
  }

  if (!json) {
    console.log(`\nScanning ${deps.length} direct dependencies in ${packageJsonPath}...`);
    console.log("(checking typosquats, install scripts, and version/maintainer history via the npm registry)\n");
  }

  const typosquatFlags = findTyposquats(deps.map((d) => d.name));
  const [installScriptResults, versionAnomalyResults] = await Promise.all([
    scanInstallScripts(deps),
    scanVersionAnomalies(deps),
  ]);

  const results = deps.map(({ name, versionRange, type }) => {
    const typosquatFlag = typosquatFlags.get(name) ?? null;
    const installScriptResult = installScriptResults.get(name) ?? null;
    const versionAnomalyResult = versionAnomalyResults.get(name) ?? null;

    const signals = deriveSignals({ typosquatFlag, installScriptResult, versionAnomalyResult });
    const score = computeRiskScore(signals);

    return {
      name,
      versionRange,
      type,
      resolvedVersion: resolvedVersionFor(installScriptResult, versionAnomalyResult),
      typosquat: typosquatFlag,
      installScript: installScriptResult,
      versionAnomaly: versionAnomalyResult,
      signals,
      score,
    };
  });

  if (json) {
    console.log(renderJson(results));
    return;
  }

  console.log(renderTable(results));
  console.log(renderSummary(results));

  const withScripts = results.filter(
    (r) => r.installScript?.status === "ok" && Object.keys(r.installScript.lifecycleScripts).length > 0
  );
  if (withScripts.length > 0) {
    console.log(`\n${withScripts.length} package(s) have install scripts (surfaced for review):\n`);
    for (const r of withScripts) {
      const versionLabel = r.installScript.approximated
        ? `${r.installScript.resolvedVersion} (approximated from "latest" — declared range didn't resolve)`
        : r.installScript.resolvedVersion;
      console.log(`  ${r.name}@${versionLabel}`);
      for (const [scriptName, scriptText] of Object.entries(r.installScript.lifecycleScripts)) {
        const isFlagged = Boolean(r.installScript.flags[scriptName]);
        console.log(`    ${isFlagged ? "⚠" : " "} ${scriptName}: ${scriptText}`);
      }
    }
  }
}
