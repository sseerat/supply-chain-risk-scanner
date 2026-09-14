# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node.js CLI that scans an npm project's `package.json` for supply-chain
attack risk signals — typosquatting, malicious install scripts, and
maintainer/version anomalies — and combines them into a per-package
Low/Medium/High risk score. See `README.md` for the full detection-logic
writeup, including the false-positive measurements behind every threshold
and two real historical incidents (`event-stream` 2018) used as validation
fixtures.

## Commands

```bash
node bin/scanner.js scan <path-to-package.json>          # table output
node bin/scanner.js scan <path-to-package.json> --json    # machine-readable
npm test                                                   # vitest run (all tests)
npx vitest run src/riskScore.test.js                        # a single test file
npx vitest run -t "test name substring"                     # a single test by name
```

There is no build or lint step — this is plain ESM Node (`"type": "module"`
in package.json), run directly.

## Architecture

Each detection phase is a self-contained pipeline of three layers, all
wired together in `src/scan.js`:

1. A **pure, network-free check module** (`typosquat.js`,
   `installScriptCheck.js`, `versionAnomalyCheck.js`, `riskScore.js`) — the
   actual decision logic, fully unit-testable with synthetic inputs.
2. A **scan orchestrator** (`installScriptScan.js`, `versionAnomalyScan.js`)
   — fetches registry data via `registryClient.js` and applies the pure
   check to each dependency, with bounded concurrency
   (`mapWithConcurrency.js`).
3. `scan.js` ties every phase's results together per dependency, computes
   the combined signal list and risk score, then hands off to
   `report.js` for table (`cli-table3`/`chalk`) or `--json` rendering.

**`registryClient.js` is the single source of registry data for Phases 3
and 4.** It fetches a package's full metadata document
(`registry.npmjs.org/<name>`, covers every published version in one call)
and caches it in memory keyed by package name — deliberately *not*
name+version, since one document serves every check regardless of which
range resolved to it, and caching by name+version would cause more
duplicate fetches, not fewer, when a package appears under different
ranges in `dependencies` vs `devDependencies`. `resolveVersion()` there
picks the version a declared range would actually install
(`semver.maxSatisfying`, no `includePrerelease` — matches real npm
behavior; getting this wrong previously let prerelease/nightly builds get
selected and corrupted the version-anomaly checks, see README Phase 4).
**Any new detector that needs registry data should go through this
client**, not add a new fetch path.

**Version-history checks compare against the immediately preceding
version in real publish-time order** (`time` field), not semver order —
`versionAnomalyCheck.js`'s `getVersionHistory()` builds this, and
`stableOnly()` filters out prerelease versions before the
dormancy/major-jump comparisons specifically (a real bug found during
Phase 4 measurement: nightly builds with unusual version numbers,
interleaved in publish history, were producing nonsense "major jump"
results).

**Risk scoring (`riskScore.js`) is deliberately not points-based.** It
counts *distinct signal types* present (`typosquat`, `installScript`,
`dormancy`, `majorJump`, `maintainerChange`): two "strong" types alone cap
at Medium, three "weak" types alone cap at Low, and High requires 2+
distinct types aligning on one package — no single signal, however
severe, reaches High alone. This was calibrated empirically (see README)
against how often signals actually co-occur in a real sample, not
guessed.

## The measurement discipline this project follows

Every detection threshold in this codebase (typosquat edit-distance
buckets, install-script red-flag patterns, dormancy days, major-jump size,
the risk-scoring signal-count rule) was chosen by measuring false-positive
rates against real npm registry data — sampled either randomly from a
popularity-ranked dataset or via targeted registry search when random
sampling had too low an incidence rate (see README's Phase 3 writeup for
why: <0.1% of a random top-10000 sample has any install script at all) —
**not** by adopting the project brief's suggested numbers as-is. When
adding or adjusting a detector, follow the same pattern: measure against a
real sample, document the exact population sampled (this codebase has
been burned by both an unrepresentative hand-picked sample and a
source dataset with duplicate entries — both are called out explicitly in
README rather than glossed over), and lock the measured rate into a
regression test the same way the existing `*.test.js` files do
(`test-fixtures/*sample*.json` fixtures + an `it` asserting the flagged
count stays at or below the measured number).

## Tests

Vitest, colocated as `src/*.test.js`. Tests are fully offline — no live
network calls — by using static fixtures under `test-fixtures/` (some are
snapshots of real registry responses, e.g.
`event-stream-metadata-snapshot.json`; some are pre-computed measurement
results, e.g. `version-anomaly-sample.json`) and by mocking `fetch` where
a test exercises the registry-calling code itself
(`registryClient.test.js`, `githubReleaseCheck.test.js`). When adding a
fixture that's a real registry pull, trim it to only the fields the code
actually reads (see how `event-stream-metadata-snapshot.json` strips
everything except `time` and each version's `maintainers`) rather than
committing a full raw API response.
