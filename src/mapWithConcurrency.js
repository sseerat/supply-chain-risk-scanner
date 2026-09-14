/**
 * Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the result array. Shared by the install-script and
 * version-anomaly scanners so neither hammers the registry with unbounded
 * parallel requests.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
