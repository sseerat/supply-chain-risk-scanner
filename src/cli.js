import { Command } from "commander";
import { scanCommand } from "./scan.js";

export function run(argv) {
  const program = new Command();

  program
    .name("scanner")
    .description("Scan an npm project's package.json for supply-chain risk signals");

  program
    .command("scan")
    .description("Scan a package.json and list its direct dependencies")
    .argument("<packageJsonPath>", "path to the package.json file to scan")
    .action(async (packageJsonPath) => {
      await scanCommand(packageJsonPath);
    });

  program.parse(argv);
}
