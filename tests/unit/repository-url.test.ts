import { describe, expect, it } from "vitest";
import { buildRepositoryUrl } from "~/domain/projects/repository-url.js";

describe("buildRepositoryUrl", () => {
  it("builds a clone URL from a slug", () => {
    expect(buildRepositoryUrl("https://github.com", "acme/app")).toBe("https://github.com/acme/app.git");
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(buildRepositoryUrl("https://github.com/", "acme/app")).toBe("https://github.com/acme/app.git");
  });

  it("does not double the .git suffix", () => {
    expect(buildRepositoryUrl("https://github.com", "acme/app.git")).toBe("https://github.com/acme/app.git");
  });

  it("rejects a slug that is not owner/repo", () => {
    expect(() => buildRepositoryUrl("https://github.com", "acme")).toThrow(/owner\/repo/);
    expect(() => buildRepositoryUrl("https://github.com", "a/b/c")).toThrow(/owner\/repo/);
  });

  it("rejects a slug that tries to escape the base URL", () => {
    expect(() => buildRepositoryUrl("https://github.com", "../etc")).toThrow();
    expect(() => buildRepositoryUrl("https://github.com", "a/..")).toThrow();
  });

  it("rejects a slug half that is a single dot segment", () => {
    expect(() => buildRepositoryUrl("https://github.com", "owner/.")).toThrow(/owner\/repo/);
    expect(() => buildRepositoryUrl("https://github.com", "owner/..")).toThrow(/owner\/repo/);
    expect(() => buildRepositoryUrl("https://github.com", "./repo")).toThrow(/owner\/repo/);
    expect(() => buildRepositoryUrl("https://github.com", "../repo")).toThrow(/owner\/repo/);
    expect(() => buildRepositoryUrl("https://github.com", "owner/../repo")).toThrow(/owner\/repo/);
  });

  it("accepts an ordinary slug that holds a dot", () => {
    expect(buildRepositoryUrl("https://github.com", "owner/my.repo")).toBe(
      "https://github.com/owner/my.repo.git",
    );
  });
});
