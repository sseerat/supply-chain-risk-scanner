// Flags patterns embedded directly in an npm lifecycle script's command
// string (preinstall/install/postinstall). Deliberately does NOT fetch and
// analyze files the script invokes (e.g. `node install.js`'s contents) —
// that's a much deeper static-analysis problem than the MVP scope covers.
// See README for why this still catches the classic "curl | sh in
// postinstall" attack pattern while staying quiet on legitimate native
// module builds, which almost always just shell out to a local script.
const PATTERNS = [
  {
    category: "network fetch",
    regex: /\b(curl|wget)\b|Invoke-WebRequest|\biwr\s|bitsadmin|certutil\s+-urlcache/i,
  },
  {
    category: "eval",
    regex: /\beval\s*\(/,
  },
  {
    category: "child_process",
    regex: /\bchild_process\b|\bexecSync\s*\(|\bspawnSync\s*\(|\bspawn\s*\(|\bexec\s*\(/,
  },
  {
    category: "suspicious write target",
    regex: /\.ssh\/|authorized_keys|\.npmrc\b|\.aws\/credentials|\.bash_profile|\.bashrc|\.zshrc/,
  },
];

const LIFECYCLE_SCRIPT_NAMES = ["preinstall", "install", "postinstall"];

/**
 * Checks a single script command string for embedded red-flag patterns.
 * Returns an array of { category, matchedText }, empty if none found.
 */
export function checkScriptText(scriptText) {
  if (!scriptText) return [];

  const flags = [];
  for (const { category, regex } of PATTERNS) {
    const match = scriptText.match(regex);
    if (match) {
      flags.push({ category, matchedText: match[0] });
    }
  }
  return flags;
}

/**
 * Checks a package's `scripts` object for lifecycle install scripts and
 * flags any red-flag patterns found in them.
 *
 * Returns { lifecycleScripts, flags } where lifecycleScripts is the raw
 * { preinstall?, install?, postinstall? } subset (for transparency — surface
 * what the script actually runs, flagged or not) and flags is
 * { [scriptName]: Array<{ category, matchedText }> } for scripts with hits.
 */
export function checkPackageScripts(scripts = {}) {
  const lifecycleScripts = {};
  const flags = {};

  for (const name of LIFECYCLE_SCRIPT_NAMES) {
    const text = scripts[name];
    if (!text) continue;
    lifecycleScripts[name] = text;

    const scriptFlags = checkScriptText(text);
    if (scriptFlags.length > 0) {
      flags[name] = scriptFlags;
    }
  }

  return { lifecycleScripts, flags };
}
