import { describe, expect, it } from "vitest";
import { SkaelRegistry } from "~/adapters/skael/skael-registry.js";
import { readTarGz, writeTarGz } from "~/adapters/skael/tar.js";
import { resolutionIdOf, sha256Hex, SkillRegistryError, type SkillDelivery } from "~/domain/runs/skill-registry.js";

const skillArchive = (name: string, body: string): Uint8Array =>
  writeTarGz([{ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n` }]);

const lint = skillArchive("lint", "Run the linter first.");
const deploy = skillArchive("deploy", "Deploy with the script.");

/** A Skael bundle, as internal/sets/bundle.go writes it. */
const bundleOf = (archives: Record<string, { version: number; archive: Uint8Array; digest?: string }>) => {
  const skills = Object.entries(archives).map(([name, entry]) => ({
    name,
    version: entry.version,
    sha256: entry.digest ?? sha256Hex(entry.archive),
    archive: `.agents/skills/.archives/${name}@${entry.version}.tar.gz`,
  }));
  const id = resolutionIdOf(skills);
  const manifest = { set: "go-tools", resolution_id: id, complete: true, skills };
  return {
    id,
    bytes: writeTarGz([
      { path: ".agents/skills/manifest.json", content: JSON.stringify(manifest) },
      ...skills.map((skill) => ({ path: skill.archive, content: archives[skill.name]!.archive })),
    ]),
  };
};

const fetchOf =
  (routes: Record<string, () => Response>) =>
  (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const route = routes[url.pathname];
    return Promise.resolve(route === undefined ? new Response("not found", { status: 404 }) : route());
  };

const archivesOf = (delivery: SkillDelivery) => {
  if (delivery.kind !== "archives") throw new Error("expected archives");
  return delivery.resolution;
};

describe("SkaelRegistry (docs/specs/skill-registry.md)", () => {
  it("resolves a named set to the pinned versions and the resolution id of the bundle", async () => {
    const bundle = bundleOf({ lint: { version: 7, archive: lint }, deploy: { version: 2, archive: deploy } });
    const registry = new SkaelRegistry({
      url: "https://skael.test",
      key: "sk-1",
      set: "go-tools",
      fetch: fetchOf({
        "/api/sets/go-tools/bundle": () =>
          new Response(bundle.bytes, { headers: { "x-skael-resolution": bundle.id, "x-skael-complete": "true" } }),
      }),
    });

    const resolution = archivesOf(await registry.resolve());

    expect(resolution.id).toBe(bundle.id);
    expect(resolution.skills.map((skill) => [skill.name, skill.version])).toEqual([
      ["deploy", 2],
      ["lint", 7],
    ]);
    expect(readTarGz(resolution.skills[1]!.archive)[0]?.name).toBe("SKILL.md");
  });

  it("refuses a bundle whose archive does not match its digest, and names the skill", async () => {
    const changed = new Uint8Array(lint);
    changed[changed.length - 1] = (changed[changed.length - 1]! + 1) % 256;
    const bundle = bundleOf({ lint: { version: 7, archive: changed, digest: sha256Hex(lint) } });
    const registry = new SkaelRegistry({
      url: "https://skael.test",
      key: "sk-1",
      set: "go-tools",
      fetch: fetchOf({ "/api/sets/go-tools/bundle": () => new Response(bundle.bytes) }),
    });

    const error = await registry.resolve().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SkillRegistryError);
    expect((error as SkillRegistryError).deterministic).toBe(true);
    expect((error as Error).message).toContain('"lint"');
  });

  it("resolves every released skill from the sync manifest with the Skael resolution id", async () => {
    const registry = new SkaelRegistry({
      url: "https://skael.test",
      key: "sk-1",
      set: null,
      fetch: fetchOf({
        "/api/sync/manifest": () =>
          Response.json([
            { name: "deploy", version: 2, checksum: sha256Hex(deploy) },
            { name: "lint", version: 7, checksum: sha256Hex(lint) },
          ]),
        "/api/skills/deploy/versions/2/download": () => new Response(deploy),
        "/api/skills/lint/versions/7/download": () => new Response(lint),
      }),
    });

    const resolution = archivesOf(await registry.resolve());

    expect(resolution.set).toBeNull();
    expect(resolution.id).toBe(
      resolutionIdOf([
        { name: "lint", version: 7, sha256: sha256Hex(lint) },
        { name: "deploy", version: 2, sha256: sha256Hex(deploy) },
      ]),
    );
  });

  it("refuses an archive with an entry outside the skill directory", async () => {
    const escaping = writeTarGz([{ path: "../escape.sh", content: "echo" }]);
    const bundle = bundleOf({ lint: { version: 1, archive: escaping } });
    const registry = new SkaelRegistry({
      url: "https://skael.test",
      key: "sk-1",
      set: "go-tools",
      fetch: fetchOf({ "/api/sets/go-tools/bundle": () => new Response(bundle.bytes) }),
    });

    await expect(registry.resolve()).rejects.toThrow(/leaves the skill directory/);
  });

  it("fails the save-time check of every released skill for a key limited to one set", async () => {
    const registry = new SkaelRegistry({
      url: "https://skael.test",
      key: "sk-1",
      set: null,
      fetch: fetchOf({ "/api/sync/manifest": () => Response.json({ detail: "forbidden" }, { status: 403 }) }),
    });

    await expect(registry.check()).rejects.toThrow(/403/);
  });
});
