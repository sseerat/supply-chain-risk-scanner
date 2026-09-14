# Supply-Chain Risk Scanner (npm)

A CLI tool that scans a project's `package.json` and flags dependencies that
show signs of supply-chain attack risk. Built to demonstrate dependency-graph
analysis, npm registry API integration, and applied threat modeling — the
kind of work motivated by real incidents like `event-stream`, `ua-parser-js`,
`coa`/`rc`, and `node-ipc`.

Status: **Phase 2 of 5 complete** (Foundation + Typosquat Detection). See
[Roadmap](#roadmap) below.

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

## Testing

Automated tests (Vitest) live in `src/typosquat.test.js`. Run them with:

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

Fixtures:

- `test-fixtures/express-package.json` — a real, fetched `express` manifest
  (44 dependencies) used as a false-positive check.
- `test-fixtures/typosquat-example-package.json` — a synthetic manifest with
  deliberately misspelled package names, used as a true-positive check
  (exercised manually via the CLI; see Phase 2 commit for sample output).
- `test-fixtures/popular-packages-1001-1500.json` — the 500-package
  false-positive benchmark sample, for the regression test above.

## Roadmap

- [x] Phase 1 — Foundation (CLI, dependency listing)
- [x] Phase 2 — Typosquat detection
- [ ] Phase 3 — Install script red flags (registry API + script inspection)
- [ ] Phase 4 — Maintainer & version anomalies
- [ ] Phase 5 — Scoring & report (`--json`, colored output)

## What I'd add with more time

- Transitive dependency scanning (currently direct deps only)
- Damerau-Levenshtein for transposition-aware typosquat detection
- ML-based or reputation-weighted scoring instead of pure heuristics
- Real-time CI integration (fail a build on High-risk findings)
- Cross-checking flagged packages against [OSV.dev](https://osv.dev)'s
  known-malicious-package database
