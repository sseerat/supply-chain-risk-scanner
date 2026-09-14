# Supply-Chain Risk Scanner (npm)

A CLI tool that scans a project's `package.json` and flags dependencies that
show signs of supply-chain attack risk. Built to demonstrate dependency-graph
analysis, npm registry API integration, and applied threat modeling — the
kind of work motivated by real incidents like `event-stream`, `ua-parser-js`,
`coa`/`rc`, and `node-ipc`.

Status: **Phase 3 of 5 complete** (Foundation + Typosquat Detection + Install
Script Red Flags). See [Roadmap](#roadmap) below.

## Usage

```bash
node bin/scanner.js scan <path-to-package.json>
```

Example:

```bash
node bin/scanner.js scan ./test-fixtures/express-package.json
```

## Detection logic

### Phase 1 — Dependency listing

Parses `dependencies` and `devDependencies` out of the given `package.json`
and prints them as a table (name, declared version range, type). Transitive
dependencies are out of scope for the MVP.

### Phase 2 — Typosquat detection

For each direct dependency, the scanner checks whether its name is an exact
match in a bundled snapshot of the top 1000 npm packages by popularity. If
not, it computes the Levenshtein (edit) distance against every name in that
list and flags the dependency if the closest match is within a threshold —
on the theory that `reqeusts` sitting a couple of keystrokes from `requests`
is a classic typosquat signature.

**Data source:** `data/top-1000-packages.json` is a static, point-in-time
snapshot (see `snapshotDate` in the file) sourced from
[tristan-f-r/npm-rank](https://github.com/tristan-f-r/npm-rank), an
automated GitHub Actions job that ranks npm packages by popularity. It is
**not** fetched live — popularity rankings drift slowly, and a static
snapshot keeps the scanner fast, offline-capable, and reproducible. Rebuild
it periodically (see `data/top-1000-packages.json`'s `source` field) to stay
current; a stale snapshot mainly risks missing newly-popular packages, not
false negatives on established ones.

**Why not a flat "distance ≤ 2" threshold:** the brief's starting point was
edit distance ≤ 2 against the full list. Before locking that in, I measured
its false-positive rate against two sets of *legitimate* packages:

1. All 44 dependencies of a real `express` `package.json` not already in the
   top-1000 snapshot (11 non-exact names).
2. The *next* 500 most-popular npm packages (ranks 1001–1500) — real,
   legitimate, popular packages that just happen to sit outside the top-1000
   snapshot, used as a stand-in for "plausible direct dependencies that
   aren't typosquats."

At a flat distance ≤ 2, set (2) had a **9.8% false-positive rate** (49/500),
almost entirely on short names where a distance of 2 covers a large fraction
of the string — e.g. `util` flagged as a possible typo of `uuid`, `moo` of
`meow`, `temp` of `pump`. Edit distance is a poor signal on short strings:
there just aren't enough characters for "far away" to mean anything.

The fix implemented in `src/typosquat.js`: **scale the allowed distance by
the length of the shorter name being compared**, instead of a flat cutoff:

| shorter name length | max allowed distance |
|---|---|
| < 4 chars | 0 (exact match only — never flagged) |
| 4–5 chars | 1 |
| ≥ 6 chars | 2 |

Re-measured with this scaling:
- Set (2) false-positive rate dropped to **4.8%** (24/500).
- A hand-built set of 25 typosquat-style names (`lodahs`, `expres`,
  `chalkk`, `cross-env-`, `axioss`, `commanderr`, etc.) still caught
  **19/25 (76%)**.

**Trade-off, explicitly:** this is a heuristic, not proof. The remaining
false positives in set (2) are mostly *genuinely* close, unrelated package
names (`synckit`/`asynckit`, `xlsx`/`clsx`, `simple-get`/`simple-git`) —
tightening further to kill those would also kill true positives, since
typosquats are specifically designed to look like these near-misses. The
tool surfaces "possible typo of X (distance N)" as a signal for a human to
review, not an automatic verdict — flagged packages are not blocked or
scored as malicious on this signal alone (that combination happens in
Phase 5).

**Known limitation:** standard Levenshtein distance counts a single
character transposition (e.g. `axois` vs `axios`) as distance 2, not 1, so
some real-world typo patterns are under-counted. Damerau-Levenshtein (which
treats adjacent transpositions as a single edit) would catch more of these
— noted as a future improvement rather than implemented now, to stay within
the brief's suggested `fast-levenshtein` dependency.

### Phase 3 — Install script red flags

For each direct dependency, the scanner fetches the package's full metadata
document from the npm registry (`https://registry.npmjs.org/<name>`),
resolves which published version the declared range would actually install,
and inspects that version's `preinstall`/`install`/`postinstall` scripts for
patterns associated with malicious behavior: a bare `curl`/`wget`/
`Invoke-WebRequest` call, `eval(`, `child_process` usage, or a write target
under a sensitive path (`~/.ssh/`, `.npmrc`, `~/.aws/credentials`, shell
profile files).

**Version resolution:** without a lockfile, the scanner doesn't know the
exact version npm would install — it resolves the declared range
(`^6.0.0`, etc.) against the registry's list of published versions using
`semver.maxSatisfying`, and falls back to the `latest` dist-tag
(marked "approximated" in output) when the range doesn't resolve, e.g. a
git URL or workspace protocol.

**Deliberate scope limit:** this only inspects the script *command string*
in `package.json` — it does not fetch and analyze files that string
invokes (e.g. what `node scripts/install.js` actually does). That's a much
larger static-analysis problem. This matters for the false-positive
measurement below: it's *exactly* why native-module packages test clean —
their install step is almost always "run a local script," and the
interesting logic (if any) lives inside a file this scanner doesn't open.

**False-positive measurement:** before finalizing the pattern list, I
pulled real registry metadata for packages known to use install scripts for
legitimate reasons — native module builds (`node-gyp`, `node-gyp-build`,
`prebuild-install`) or fetching prebuilt binaries — including the ones
named in the brief (`node-sass`, `bcrypt`, `sharp`) plus 20 more real
packages (`puppeteer`, `canvas`, `sqlite3`, `fsevents`, `esbuild`, `cypress`,
`argon2`, `keytar`, `node-pty`, `leveldown`, etc. — full list in
`test-fixtures/legit-install-scripts.json`, fetched directly from the
registry). Result: **0/23 false positives.** Their scripts are things like
`node-gyp rebuild`, `prebuild-install -r napi || node-gyp rebuild`, and
`node scripts/install.js` — none contain the string-level patterns being
checked for, which is exactly the intended behavior: flag the technique
(fetch-and-execute inline), not the presence of a native build step.

**True-positive check:** synthetic scripts modeled on documented
supply-chain attack techniques — `curl ... | bash`, `wget` + `chmod +x` +
execute, `child_process.exec` wrapping a download, `eval` of a
base64-decoded payload, SSH-key exfiltration via a sensitive write path —
all correctly flagged (see `src/installScriptCheck.test.js`). These are
reconstructed from known technique categories, not copied from any real
malicious package.

**Caching:** `src/registryClient.js` caches each package's full metadata
document in memory, keyed by package name (not name+version — the registry
has no cheaper per-version endpoint, the whole-package document covers
every version in one request, and a package can appear under different
declared ranges in `dependencies` vs `devDependencies`, so keying by
name+version would cause *extra* duplicate fetches rather than fewer). This
saves a redundant network call within a single scan when a package name
repeats, and Phase 4's version-history/maintainer checks will reuse the
same cached document. It's in-memory only — cleared when the process exits
— so it does **not** save a network round trip across separate `scanner
scan` invocations; a persistent (e.g. file-based) cache is listed under
[What I'd add with more time](#what-id-add-with-more-time).

**Stack deviation:** used Node's built-in `fetch` instead of the brief's
suggested `axios`/`node-fetch` — Node 22 ships a native `fetch`, so an HTTP
client dependency adds nothing here. Also added `semver` (not in the
brief's suggested stack) for version-range resolution — needed to check the
version that would actually be installed rather than guessing.

## Testing

Automated tests (Vitest) live in `src/typosquat.test.js`,
`src/installScriptCheck.test.js`, and `src/registryClient.test.js`. Run them
with:

```bash
npm test
```

Chosen over Jest for zero-config ESM support — this project uses native
`"type": "module"`, which Jest needs extra transform config for.

What's covered:

- **Threshold-logic unit tests** — `maxAllowedDistance()` is tested directly
  against each length bucket (< 4, 4–5, ≥ 6 chars), and `checkTyposquat()` is
  exercised against a small controlled popular-name list to pin down exact
  boundary behavior (e.g. a name at exactly the allowed distance flags; one
  edit further doesn't), independent of the live snapshot's contents.
- **True positives** — a fixed set of typosquat-style names (`lodahs`,
  `expres`, `axioss`, `commanderr`, etc.), including two picked to sit
  exactly on the boundary of their length bucket, asserted against the real
  bundled snapshot with exact expected `closestMatch`/`distance`.
- **True negatives** — exact matches to popular packages, the short-name
  false positives from the original flat-threshold measurement (`util`,
  `temp`, `moo`, etc. — must stay unflagged), a past-boundary case, and a
  dedicated check that the real `express` fixture produces zero flags.
- **Documented limitations** — a fixed set of names the current algorithm is
  known to miss (`axois`, `chlak`, `electorn`, …, all transposition- or
  length-bucket-driven), asserted as *currently* unflagged so a future
  algorithm change surfaces here deliberately rather than silently.
- **False-positive regression** — replays the Phase 2 measurement (all 500
  packages ranked 1001–1500, `test-fixtures/popular-packages-1001-1500.json`)
  and asserts the flag count stays at or below 24/500 (4.8%), so a future
  change to the threshold logic can't silently regress false-positive rate.

Also covered for Phase 3 (`src/installScriptCheck.test.js` /
`src/registryClient.test.js`):

- **Pattern-matching unit tests** — each red-flag category (network fetch,
  eval, child_process, suspicious write target) tested directly against
  synthetic strings, plus negative checks (a substring like "retrieval"
  shouldn't trip the `eval` pattern; a plain `node install.js` shouldn't
  trip anything).
- **True positives** — the five synthetic attack-technique scripts described
  above, each asserted to produce the expected category.
- **True negatives / FP regression** — every one of the 23 real legitimate
  scripts in `test-fixtures/legit-install-scripts.json` asserted individually
  (via `it.each`) to produce zero flags, plus one aggregate assertion that
  the false-positive list is empty — so a future change to the pattern list
  that breaks any single legitimate package fails loudly with its name.
- **Registry client** — `fetchPackageMetadata` tested with a mocked `fetch`
  (no live network in the suite): asserts repeated calls for the same
  package hit the network once, different packages each get their own
  fetch, concurrent in-flight requests for the same package collapse into
  one call, and a 404 resolves to `null` rather than throwing.
  `resolveVersion` tested against fake metadata for range resolution and the
  latest-tag fallback.

Fixtures:

- `test-fixtures/express-package.json` — a real, fetched `express` manifest
  (44 dependencies) used as a false-positive check.
- `test-fixtures/typosquat-example-package.json` — a synthetic manifest with
  deliberately misspelled package names, used as a true-positive check
  (exercised manually via the CLI; see Phase 2 commit for sample output).
- `test-fixtures/popular-packages-1001-1500.json` — the 500-package
  false-positive benchmark sample for typosquat detection.
- `test-fixtures/legit-install-scripts.json` — 23 real packages' install
  scripts, fetched from the npm registry, for the install-script
  false-positive benchmark above.
- `test-fixtures/install-script-example-package.json` — a manifest mixing
  real native-build packages with a nonexistent package name, used to
  manually exercise the "not found on registry" path via the CLI.

## Roadmap

- [x] Phase 1 — Foundation (CLI, dependency listing)
- [x] Phase 2 — Typosquat detection
- [x] Phase 3 — Install script red flags (registry API + script inspection)
- [ ] Phase 4 — Maintainer & version anomalies
- [ ] Phase 5 — Scoring & report (`--json`, colored output)

## What I'd add with more time

- Transitive dependency scanning (currently direct deps only)
- Damerau-Levenshtein for transposition-aware typosquat detection
- Deeper install-script analysis: fetch and scan the actual files a script
  invokes (e.g. `install.js`), not just the command string in `package.json`
- A persistent (file-based) registry-metadata cache, so re-scanning a
  project across separate CLI runs also skips redundant network calls
- ML-based or reputation-weighted scoring instead of pure heuristics
- Real-time CI integration (fail a build on High-risk findings)
- Cross-checking flagged packages against [OSV.dev](https://osv.dev)'s
  known-malicious-package database
