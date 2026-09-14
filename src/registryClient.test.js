import { describe, it, expect, beforeEach } from "vitest";
import { fetchPackageMetadata, resolveVersion, clearRegistryCache } from "./registryClient.js";

function fakeMetadata(name, versions, latest) {
  return {
    name,
    "dist-tags": { latest },
    versions: Object.fromEntries(versions.map((v) => [v, { name, version: v, scripts: {} }])),
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  clearRegistryCache();
});

describe("fetchPackageMetadata caching", () => {
  it("only calls fetch once for repeated requests of the same package", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      return jsonResponse(fakeMetadata("left-pad", ["1.0.0"], "1.0.0"));
    };

    await fetchPackageMetadata("left-pad", { fetchImpl });
    await fetchPackageMetadata("left-pad", { fetchImpl });
    await fetchPackageMetadata("left-pad", { fetchImpl });

    expect(callCount).toBe(1);
  });

  it("calls fetch separately for different packages", async () => {
    const calledFor = [];
    const fetchImpl = async (url) => {
      calledFor.push(url);
      return jsonResponse(fakeMetadata("pkg", ["1.0.0"], "1.0.0"));
    };

    await fetchPackageMetadata("left-pad", { fetchImpl });
    await fetchPackageMetadata("chalk", { fetchImpl });

    expect(calledFor).toHaveLength(2);
  });

  it("returns null (not a throw) for a 404", async () => {
    const fetchImpl = async () => jsonResponse(null, 404);
    const result = await fetchPackageMetadata("this-does-not-exist", { fetchImpl });
    expect(result).toBeNull();
  });

  it("caches concurrent in-flight requests for the same package as one call", async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      return jsonResponse(fakeMetadata("left-pad", ["1.0.0"], "1.0.0"));
    };

    await Promise.all([
      fetchPackageMetadata("left-pad", { fetchImpl }),
      fetchPackageMetadata("left-pad", { fetchImpl }),
    ]);

    expect(callCount).toBe(1);
  });
});

describe("resolveVersion", () => {
  it("resolves a caret range to the highest matching published version", () => {
    const metadata = fakeMetadata("x", ["1.0.0", "1.2.0", "1.9.9", "2.0.0"], "2.0.0");
    const result = resolveVersion("^1.0.0", metadata);
    expect(result).toEqual({ version: "1.9.9", approximated: false });
  });

  it("falls back to the latest dist-tag when the range matches nothing published", () => {
    const metadata = fakeMetadata("x", ["1.0.0", "2.0.0"], "2.0.0");
    const result = resolveVersion("git+https://github.com/example/x.git", metadata);
    expect(result).toEqual({ version: "2.0.0", approximated: true });
  });

  it("returns null when there's no matching version and no usable latest tag", () => {
    const metadata = { name: "x", "dist-tags": {}, versions: {} };
    expect(resolveVersion("^1.0.0", metadata)).toBeNull();
  });
});
