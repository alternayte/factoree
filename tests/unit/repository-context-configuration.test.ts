import { describe, expect, it } from "vitest";
import { FakeRepositoryReader } from "../support/fake-repository-reader.js";
import {
  DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION,
  readRepositoryContextConfiguration,
} from "~/domain/context/repository-context-configuration.js";

const VALID = `version: 1

identity:
  product: checkout-platform
  linear:
    teamKey: PAY

verify:
  commands:
    - name: check
      run: "true"

context:
  backstage:
    enabled: true
  referenceRepositories:
    automaticDiscovery: true
`;

describe("readRepositoryContextConfiguration", () => {
  it("reads the context block at the pinned SHA", async () => {
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "a".repeat(40), files: { ".factoree/config.yaml": VALID } },
    });
    const configuration = await readRepositoryContextConfiguration(
      reader,
      "https://git.test/acme/app.git",
      "main",
    );
    expect(configuration).toEqual({ backstageEnabled: true, automaticReferenceDiscovery: true });
    // The read must use the SHA, never the branch name.
    expect(reader.calls).toContain(`readBlob https://git.test/acme/app.git ${"a".repeat(40)} .factoree/config.yaml`);
  });

  it("returns the defaults when the file is missing", async () => {
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "b".repeat(40), files: {} },
    });
    expect(
      await readRepositoryContextConfiguration(reader, "https://git.test/acme/app.git", "main"),
    ).toEqual(DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION);
  });

  it("returns the defaults when the file is invalid, because PREPARING fails the Run instead", async () => {
    const reader = new FakeRepositoryReader({
      "https://git.test/acme/app.git": { sha: "c".repeat(40), files: { ".factoree/config.yaml": "nope: 1" } },
    });
    expect(
      await readRepositoryContextConfiguration(reader, "https://git.test/acme/app.git", "main"),
    ).toEqual(DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION);
  });

  it("returns the defaults when the repository cannot be reached", async () => {
    const reader = new FakeRepositoryReader({});
    expect(
      await readRepositoryContextConfiguration(reader, "https://git.test/missing.git", "main"),
    ).toEqual(DEFAULT_REPOSITORY_CONTEXT_CONFIGURATION);
  });
});
