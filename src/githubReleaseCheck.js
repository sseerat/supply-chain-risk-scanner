const GITHUB_API_BASE = "https://api.github.com";

/**
 * Extracts { owner, repo } from an npm `repository` field, which may be a
 * bare string or a { type, url } object, in any of the URL shapes npm
 * accepts (git+https://, git://, ssh, or a bare "owner/repo" shorthand).
 * Returns null if it isn't a GitHub URL.
 */
export function parseGithubRepo(repositoryField) {
  const url = typeof repositoryField === "string" ? repositoryField : repositoryField?.url;
  if (!url) return null;

  const match = /github\.com[:/]+([^/]+)\/([^/#]+)/i.exec(url);
  if (!match) return null;

  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

function candidateTags(version, packageName) {
  return [`v${version}`, version, `${packageName}@${version}`];
}

/**
 * Best-effort check for a GitHub release matching a version. Tries a few
 * common tag naming conventions (this is a heuristic — real repos use all
 * sorts of tag formats, so "not found" here is weak evidence, not proof).
 * Degrades gracefully: unauthenticated GitHub API access is rate-limited to
 * 60 requests/hour, so this stops trying (checked: false) the moment it
 * sees a rate-limit response, rather than burning the rest of the quota.
 */
export async function checkGithubRelease(repositoryField, version, packageName, { fetchImpl = fetch } = {}) {
  const repo = parseGithubRepo(repositoryField);
  if (!repo) {
    return { checked: false, reason: "no parseable GitHub repository URL" };
  }

  for (const tag of candidateTags(version, packageName)) {
    let response;
    try {
      response = await fetchImpl(
        `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/releases/tags/${encodeURIComponent(tag)}`,
        { headers: { "User-Agent": "supply-chain-risk-scanner" } }
      );
    } catch (err) {
      return { checked: false, reason: `network error: ${err.message}` };
    }

    if (response.status === 403 || response.status === 429) {
      return { checked: false, reason: "GitHub API rate limited" };
    }
    if (response.ok) {
      return { checked: true, found: true, tag };
    }
  }

  return { checked: true, found: false, triedTags: candidateTags(version, packageName) };
}
