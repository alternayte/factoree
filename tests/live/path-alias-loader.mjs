// A minimal Node module resolution hook. It rewrites the repository's `~/` import alias to a
// file URL under `src/`, so a plain `node` process can run a TypeScript entry point of
// `tests/live` without a bundler. The repository has no `tsx` and no `ts-node` in
// `devDependencies`, so this file, and not a new dependency, is the runner for
// `npm run acceptance:live`. Only `tests/live/acceptance-live.ts` uses this hook.

const SOURCE_ROOT = new URL("../../src/", import.meta.url);
const ALIAS_PREFIX = "~/";

export const resolve = async (specifier, context, nextResolve) => {
  const target = specifier.startsWith(ALIAS_PREFIX)
    ? new URL(specifier.slice(ALIAS_PREFIX.length), SOURCE_ROOT).href
    : specifier;
  try {
    return await nextResolve(target, context);
  } catch (error) {
    // The repository writes every import with a `.js` specifier and a `.ts` source file, the
    // usual NodeNext convention. `tsc` maps that pairing on its own. A plain `node` process does
    // not, so this hook retries the `.ts` file when the `.js` specifier does not resolve.
    const isModuleNotFound =
      typeof error === "object" && error !== null && "code" in error && error.code === "ERR_MODULE_NOT_FOUND";
    if (isModuleNotFound && target.endsWith(".js")) {
      return nextResolve(`${target.slice(0, -3)}.ts`, context);
    }
    throw error;
  }
};
