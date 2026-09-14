import { getDirectDependencies } from "./parsePackageJson.js";
import { findTyposquats } from "./typosquat.js";
import { scanInstallScripts } from "./installScriptScan.js";
import { scanVersionAnomalies } from "./versionAnomalyScan.js";

function describeInstallScriptRisk(result) {
  if (!result || result.status === "not-found") return "not found on registry";
  if (result.status === "unresolved-version") return "couldn't resolve version";
  if (result.status === "error") return `registry error: ${result.error}`;

  const flaggedScripts = Object.keys(result.flags);
  if (flaggedScripts.length === 0) {
    const hasScripts = Object.keys(result.lifecycleScripts).length > 0;
    return hasScripts ? "install script present (no red flags)" : "-";
  }

  return flaggedScripts
    .map((scriptName) => {
      const categories = result.flags[scriptName].map((f) => f.category).join(", ");
      return `⚠ ${scriptName}: ${categories}`;
    })
    .join("; ");
}

function describeVersionAnomaly(result) {
  if (!result || result.status !== "ok") return "-";

  const parts = [];
  if (result.dormancy) {
    parts.push(`⚠ dormant ${result.dormancy.gapDays}d then published (prev ${result.dormancy.previousVersion})`);
  }
  if (result.majorJump) {
    const ghNote =
      result.github.checked && !result.github.found
        ? ", no matching GitHub release found"
        : "";
    parts.push(`⚠ major jump ${result.majorJump.previousVersion} → ${result.resolvedVersion}${ghNote}`);
  }
  if (result.maintainerChange) {
    const { added, removed } = result.maintainerChange;
    const bits = [];
    if (added.length > 0) bits.push(`+${added.join(",+")}`);
    if (removed.length > 0) bits.push(`-${removed.join(",-")}`);
    parts.push(`⚠ maintainers changed (${bits.join(" ")})`);
  }

  return parts.length > 0 ? parts.join("; ") : "-";
}

export async function scanCommand(packageJsonPath) {
  let deps;
  try {
    deps = getDirectDependencies(packageJsonPath);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (deps.length === 0) {
    console.log("No dependencies found.");
    return;
  }

  console.log(`\nFound ${deps.length} direct dependencies in ${packageJsonPath}:\n`);

  const typosquatFlags = findTyposquats(deps.map((d) => d.name));

  console.log("Checking install scripts and version/maintainer history via the npm registry...");
  const [installScriptResults, versionAnomalyResults] = await Promise.all([
    scanInstallScripts(deps),
    scanVersionAnomalies(deps),
  ]);

  console.table(
    deps.map(({ name, versionRange, type }) => {
      const typosquatFlag = typosquatFlags.get(name);
      return {
        Package: name,
        "Version Range": versionRange,
        Type: type,
        "Typosquat Risk": typosquatFlag
          ? `possible typo of "${typosquatFlag.closestMatch}" (distance ${typosquatFlag.distance})`
          : "-",
        "Install Script Risk": describeInstallScriptRisk(installScriptResults.get(name)),
        "Version/Maintainer Anomaly": describeVersionAnomaly(versionAnomalyResults.get(name)),
      };
    })
  );

  if (typosquatFlags.size > 0) {
    console.log(
      `\n${typosquatFlags.size} package(s) flagged as possible typosquats. Review closely — this is a heuristic, not proof.`
    );
  }

  const withScripts = [...installScriptResults.values()].filter(
    (r) => r.status === "ok" && Object.keys(r.lifecycleScripts).length > 0
  );
  if (withScripts.length > 0) {
    console.log(`\n${withScripts.length} package(s) have install scripts (surfaced for review):\n`);
    for (const result of withScripts) {
      const versionLabel = result.approximated
        ? `${result.resolvedVersion} (approximated from "latest" — declared range didn't resolve)`
        : result.resolvedVersion;
      console.log(`  ${result.name}@${versionLabel}`);
      for (const [scriptName, scriptText] of Object.entries(result.lifecycleScripts)) {
        const isFlagged = Boolean(result.flags[scriptName]);
        console.log(`    ${isFlagged ? "⚠" : " "} ${scriptName}: ${scriptText}`);
      }
    }
  }

  const installScriptFlagCount = [...installScriptResults.values()].filter(
    (r) => r.status === "ok" && Object.keys(r.flags).length > 0
  ).length;
  if (installScriptFlagCount > 0) {
    console.log(
      `\n${installScriptFlagCount} package(s) flagged for install-script red flags. Review closely — this is a heuristic, not proof.`
    );
  }

  const versionAnomalyFlagCount = [...versionAnomalyResults.values()].filter(
    (r) => r.status === "ok" && (r.dormancy || r.majorJump || r.maintainerChange)
  ).length;
  if (versionAnomalyFlagCount > 0) {
    console.log(
      `\n${versionAnomalyFlagCount} package(s) flagged for version/maintainer anomalies. Review closely — this is a heuristic, not proof.`
    );
  }
}
