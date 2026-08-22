/**
 * `Project.primaryRepository` holds an `owner/repo` slug. A checkout needs a clone URL. The
 * GitHub adapter arrives in Phase 9, so the base URL comes from one environment value here.
 */
const SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export const buildRepositoryUrl = (baseUrl: string, slug: string): string => {
  const trimmed = slug.replace(/\.git$/, "");
  if (!SLUG.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`A repository must be named "owner/repo". Received "${slug}".`);
  }
  return `${baseUrl.replace(/\/+$/, "")}/${trimmed}.git`;
};
