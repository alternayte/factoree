/**
 * `Project.primaryRepository` holds an `owner/repo` slug. A checkout needs a clone URL. The
 * GitHub adapter arrives in Phase 9, so the base URL comes from one environment value here.
 *
 * Neither slug half can be a dot segment, "." or "..", the same rule `REPOSITORY_SLUG` applies in
 * `src/domain/refinement/work-item.ts`. The two modules keep separate copies of the rule, because
 * one parses free text for a repository-shaped reference and the other builds a clone URL, and a
 * cross-import between the two domains is not worth saving one regular expression.
 */
const SLUG = /^(?!\.{1,2}\/)[A-Za-z0-9._-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/**
 * Rejects a slug the URL builder cannot use, without building a URL. A caller uses this to check
 * a slug at the point it is configured, before the base URL is known or needed.
 */
export const assertRepositorySlug = (slug: string): void => {
  const trimmed = slug.replace(/\.git$/, "");
  if (!SLUG.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`A repository must be named "owner/repo". Received "${slug}".`);
  }
};

export const buildRepositoryUrl = (baseUrl: string, slug: string): string => {
  assertRepositorySlug(slug);
  const trimmed = slug.replace(/\.git$/, "");
  return `${baseUrl.replace(/\/+$/, "")}/${trimmed}.git`;
};
