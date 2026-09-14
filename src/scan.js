import { getDirectDependencies } from "./parsePackageJson.js";

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

  console.table(
    deps.map(({ name, versionRange, type }) => ({
      Package: name,
      "Version Range": versionRange,
      Type: type,
    }))
  );
}
