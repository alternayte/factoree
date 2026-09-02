/**
 * Builds the git environment that carries a repository credential. The credential never reaches
 * the process argument list, because `ps` and `/proc/<pid>/cmdline` are world readable. SDD
 * section 30 forbids that exposure. The environment of a process is readable by the same user
 * only, so it is the safe carrier.
 *
 * The module sits in `src/domain/security` because three callers need it and no two of them may
 * import each other: the trusted checkout of the publication, the sandbox checkout of a Run, and
 * the repository reader of context discovery. One copy keeps the three from drifting apart.
 *
 * A local path remote needs no header. The header is harmless on such a remote. This function
 * returns an empty environment only when the caller supplies no token or no `http` URL.
 */
export const credentialEnvironment = (
  cloneUrl: string,
  token: string | undefined,
): Record<string, string> => {
  if (token === undefined || token === "") return {};
  let origin: string;
  try {
    const parsed = new URL(cloneUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return {};
    origin = parsed.origin;
  } catch {
    return {};
  }
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
};
