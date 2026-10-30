/**
 * docs/specs/check-isolation.md. A file that defines how a change is checked. The verify and
 * bootstrap commands come from `.factoree/config.yaml` at the base SHA, but the scripts they
 * call, the test runner configuration, and the compiler settings come from the patch. A patch
 * that changes one of them can weaken the check that judges it, so a human must see it first.
 */
const CHECK_DEFINING = [
  /^\.factoree\//,
  /(^|\/)package\.json$/,
  /(^|\/)(vitest|jest|playwright|cypress|karma|mocha)\.config\.[cm]?[jt]s$/,
  /(^|\/)\.mocharc(\.[a-z]+)?$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?)$/,
  /(^|\/)(pyproject\.toml|setup\.cfg|pytest\.ini|tox\.ini|conftest\.py)$/,
  /(^|\/)(justfile|Justfile|Makefile|makefile)$/,
  /^\.github\//,
];

export const checkDefiningFilesOf = (changedFiles: readonly string[]): string[] =>
  changedFiles.filter((path) => CHECK_DEFINING.some((pattern) => pattern.test(path)));
