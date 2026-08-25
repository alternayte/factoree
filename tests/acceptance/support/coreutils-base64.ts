import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `capturePatch` reads the patch file with `base64 <path>`, which is the GNU coreutils form. The
 * production sandbox image carries GNU coreutils. A macOS developer machine carries the BSD form,
 * which needs `-i <path>` and rejects a bare path. A test host must not decide whether the real
 * `capturePatch` runs, so this helper puts a GNU-compatible `base64` in front of the host one.
 *
 * The shim is installed only when the host `base64` rejects a bare path. On Linux it does
 * nothing at all. The shim changes no source file, and it changes no production behavior.
 */
export interface Base64Shim {
  installed: boolean;
  remove: () => void;
}

const acceptsPathArgument = (): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "factoree-base64-probe-"));
  try {
    const file = join(probe, "probe.bin");
    writeFileSync(file, "probe", "utf8");
    execFileSync("base64", [file], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
};

export const installCoreutilsBase64 = (): Base64Shim => {
  if (acceptsPathArgument()) return { installed: false, remove: () => undefined };

  const real = execFileSync("sh", ["-c", "command -v base64"], { encoding: "utf8" }).trim();
  const directory = mkdtempSync(join(tmpdir(), "factoree-base64-shim-"));
  const script = join(directory, "base64");
  // Standard input accepts the same bytes on both forms, so one line covers every host.
  writeFileSync(script, `#!/bin/sh\nif [ "$#" -eq 1 ] && [ -f "$1" ]; then exec ${real} < "$1"; fi\nexec ${real} "$@"\n`, "utf8");
  chmodSync(script, 0o755);

  const previous = process.env["PATH"] ?? "";
  process.env["PATH"] = `${directory}:${previous}`;

  return {
    installed: true,
    remove: (): void => {
      process.env["PATH"] = previous;
      rmSync(directory, { recursive: true, force: true });
    },
  };
};
