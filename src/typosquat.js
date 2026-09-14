import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import levenshtein from "fast-levenshtein";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, "..", "data", "top-1000-packages.json");

// Edit distance is noisy on short strings (e.g. "moo" vs "meow" is distance 2
// but tells you nothing). Scale the allowed distance by the shorter of the
// two names being compared instead of using a flat threshold everywhere —
// see README for the false-positive analysis behind these cutoffs.
const MAX_FLAG_DISTANCE = 2;

function maxAllowedDistance(shorterLength) {
  if (shorterLength < 4) return 0; // require exact match, never flag
  if (shorterLength <= 5) return 1;
  return MAX_FLAG_DISTANCE;
}

let cachedSnapshot;

export function loadTop1000() {
  if (!cachedSnapshot) {
    const raw = readFileSync(SNAPSHOT_PATH, "utf-8");
    cachedSnapshot = JSON.parse(raw);
  }
  return cachedSnapshot;
}

/**
 * Checks a single package name against the top-1000 snapshot.
 * Returns null if it's an exact match (or no close match), otherwise
 * { closestMatch, distance }.
 */
export function checkTyposquat(packageName, popularNames) {
  if (popularNames.includes(packageName)) {
    return null;
  }

  let best = null;

  for (const popularName of popularNames) {
    const shorterLength = Math.min(packageName.length, popularName.length);
    const allowedDistance = maxAllowedDistance(shorterLength);
    if (allowedDistance === 0) {
      continue;
    }
    // Cheap pre-filter: distance can't be smaller than the length gap.
    if (Math.abs(popularName.length - packageName.length) > allowedDistance) {
      continue;
    }

    const distance = levenshtein.get(packageName, popularName);
    if (distance <= allowedDistance && (best === null || distance < best.distance)) {
      best = { closestMatch: popularName, distance };
    }
  }

  return best;
}

export function findTyposquats(dependencyNames) {
  const { packages: popularNames } = loadTop1000();
  const flags = new Map();

  for (const name of dependencyNames) {
    const result = checkTyposquat(name, popularNames);
    if (result) {
      flags.set(name, result);
    }
  }

  return flags;
}
