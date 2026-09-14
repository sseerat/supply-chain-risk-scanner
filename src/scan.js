import { getDirectDependencies } from "./parsePackageJson.js";
import { findTyposquats } from "./typosquat.js";

export function scanCommand(packageJsonPath) {
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

  console.table(
    deps.map(({ name, versionRange, type }) => {
      const flag = typosquatFlags.get(name);
      return {
        Package: name,
        "Version Range": versionRange,
        Type: type,
        "Typosquat Risk": flag
          ? `possible typo of "${flag.closestMatch}" (distance ${flag.distance})`
          : "-",
      };
    })
  );

  if (typosquatFlags.size > 0) {
    console.log(
      `\n${typosquatFlags.size} package(s) flagged as possible typosquats. Review closely — this is a heuristic, not proof.`
    );
  }
}
