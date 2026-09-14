import { Command } from "commander";
import { scanCommand } from "./scan.js";

export function run(argv) {
  const program = new Command();

  program
    .name("scanner")
    .description("Scan an npm project's package.json for supply-chain risk signals");

  program
    .command("scan")
    .description("Scan a package.json for supply-chain risk signals and print a per-package risk report")
    .argument("<packageJsonPath>", "path to the package.json file to scan")
    .option("--json", "output machine-readable JSON instead of a table")
    .action(async (packageJsonPath, options) => {
      await scanCommand(packageJsonPath, { json: options.json });
    });

  program.parse(argv);
}
