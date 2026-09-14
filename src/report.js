import Table from "cli-table3";
import chalk from "chalk";

const SCORE_COLOR = {
  Low: chalk.green,
  Medium: chalk.yellow,
  High: chalk.red.bold,
};

/**
 * Short, human-readable descriptions for each signal a package was flagged
 * for — shared between the table's compact "Signals" column and the
 * per-package detail section.
 */
export function describeSignals(result) {
  const descriptions = [];

  if (result.typosquat) {
    descriptions.push(`typosquat (possible typo of "${result.typosquat.closestMatch}", distance ${result.typosquat.distance})`);
  }

  if (result.installScript?.status === "ok") {
    for (const [scriptName, flags] of Object.entries(result.installScript.flags)) {
      const categories = flags.map((f) => f.category).join(", ");
      descriptions.push(`install script (${scriptName}: ${categories})`);
    }
  }

  if (result.versionAnomaly?.status === "ok") {
    const { dormancy, majorJump, maintainerChange, github } = result.versionAnomaly;
    if (dormancy) {
      descriptions.push(`dormant ${dormancy.gapDays}d then published (prev ${dormancy.previousVersion})`);
    }
    if (majorJump) {
      const ghNote = github?.checked && !github.found ? ", no matching GitHub release found" : "";
      descriptions.push(`major jump ${majorJump.previousVersion} → ${result.resolvedVersion}${ghNote}`);
    }
    if (maintainerChange) {
      const bits = [];
      if (maintainerChange.added.length > 0) bits.push(`+${maintainerChange.added.join(",+")}`);
      if (maintainerChange.removed.length > 0) bits.push(`-${maintainerChange.removed.join(",-")}`);
      descriptions.push(`maintainers changed (${bits.join(" ")})`);
    }
  }

  return descriptions;
}

export function renderJson(results) {
  return JSON.stringify(results, null, 2);
}

export function renderTable(results) {
  const table = new Table({
    head: ["Package", "Version Range", "Type", "Score", "Signals"],
    wordWrap: true,
    colWidths: [28, 16, 14, 10, 60],
  });

  for (const result of results) {
    const colorize = SCORE_COLOR[result.score] ?? ((s) => s);
    const signalText = describeSignals(result);
    table.push([
      result.name,
      result.versionRange,
      result.type,
      colorize(result.score),
      signalText.length > 0 ? signalText.join("\n") : chalk.dim("-"),
    ]);
  }

  return table.toString();
}

export function renderSummary(results) {
  const counts = { High: 0, Medium: 0, Low: 0 };
  for (const r of results) counts[r.score]++;

  const parts = [
    counts.High > 0 ? chalk.red.bold(`${counts.High} High`) : `${counts.High} High`,
    counts.Medium > 0 ? chalk.yellow(`${counts.Medium} Medium`) : `${counts.Medium} Medium`,
    `${counts.Low} Low`,
  ];

  return `\nRisk summary: ${parts.join(", ")} (of ${results.length} direct dependencies). This is a heuristic report — review flagged packages yourself, don't treat any score as proof.`;
}
