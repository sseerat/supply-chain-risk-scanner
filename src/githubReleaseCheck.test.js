import { describe, it, expect } from "vitest";
import { parseGithubRepo, checkGithubRelease } from "./githubReleaseCheck.js";

describe("parseGithubRepo", () => {
  it("parses a git+https URL", () => {
    expect(parseGithubRepo("git+https://github.com/lodash/lodash.git")).toEqual({
      owner: "lodash",
      repo: "lodash",
    });
  });

  it("parses a plain https URL without .git", () => {
    expect(parseGithubRepo("https://github.com/facebook/react")).toEqual({
      owner: "facebook",
      repo: "react",
    });
  });

  it("parses an object-form repository field", () => {
    expect(parseGithubRepo({ type: "git", url: "https://github.com/tj/commander.js.git" })).toEqual({
      owner: "tj",
      repo: "commander.js",
    });
  });

  it("parses an ssh-style URL", () => {
    expect(parseGithubRepo("git@github.com:sindresorhus/chalk.git")).toEqual({
      owner: "sindresorhus",
      repo: "chalk",
    });
  });

  it("returns null for a non-GitHub repository", () => {
    expect(parseGithubRepo("https://gitlab.com/owner/repo.git")).toBeNull();
  });

  it("returns null when there's no repository field", () => {
    expect(parseGithubRepo(undefined)).toBeNull();
    expect(parseGithubRepo(null)).toBeNull();
  });
});

describe("checkGithubRelease", () => {
  it("reports unchecked when the repository isn't on GitHub", async () => {
    const result = await checkGithubRelease("https://gitlab.com/owner/repo", "1.0.0", "pkg");
    expect(result).toEqual({ checked: false, reason: "no parseable GitHub repository URL" });
  });

  it("finds a release on the first tag format tried (v-prefixed)", async () => {
    const calledUrls = [];
    const fetchImpl = async (url) => {
      calledUrls.push(url);
      return { ok: true, status: 200 };
    };
    const result = await checkGithubRelease("https://github.com/o/r", "2.0.0", "pkg", { fetchImpl });
    expect(result).toEqual({ checked: true, found: true, tag: "v2.0.0" });
    expect(calledUrls).toHaveLength(1);
    expect(calledUrls[0]).toContain("releases/tags/v2.0.0");
  });

  it("falls through to later tag formats before giving up", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      return { ok: callCount === 3, status: callCount === 3 ? 200 : 404 };
    };
    const result = await checkGithubRelease("https://github.com/o/r", "2.0.0", "pkg", { fetchImpl });
    expect(callCount).toBe(3);
    expect(result).toEqual({ checked: true, found: true, tag: "pkg@2.0.0" });
  });

  it("reports found:false when no tag format matches", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404 });
    const result = await checkGithubRelease("https://github.com/o/r", "2.0.0", "pkg", { fetchImpl });
    expect(result.checked).toBe(true);
    expect(result.found).toBe(false);
  });

  it("stops immediately and reports unchecked when rate limited", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      return { ok: false, status: 403 };
    };
    const result = await checkGithubRelease("https://github.com/o/r", "2.0.0", "pkg", { fetchImpl });
    expect(result).toEqual({ checked: false, reason: "GitHub API rate limited" });
    expect(callCount).toBe(1); // doesn't burn through all three tag attempts once rate limited
  });
});
