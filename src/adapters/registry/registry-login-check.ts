import { basicOf, realmOf } from "~/domain/products/host-credentials.js";

/** The token service a registry login is checked against and later bound to. */
export interface RegistryRealm {
  realmHost: string | null;
  realmPath: string | null;
}

/** A registry login that failed its check on save. The message names the registry's answer. */
export class RegistryLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryLoginError";
  }
}

const TIMEOUT_MS = 15_000;

/**
 * docs/specs/host-credentials.md, DI-17.06. An anonymous `GET /v2/` names the token service in its
 * `WWW-Authenticate` header: Docker Hub puts it on auth.docker.io, and Artifactory names the
 * repository in its path. A realm `GET` with Basic must answer 200. A registry with a Basic
 * challenge has no token service, and `GET /v2/` with Basic must answer 200.
 */
export const checkRegistryLogin = async (
  host: string,
  username: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistryRealm> => {
  const call = async (url: string, authorization: string | null): Promise<Response> => {
    try {
      return await fetchImpl(url, {
        headers: authorization === null ? {} : { authorization },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new RegistryLoginError(`${host} did not answer from the Factoree server: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const anonymous = await call(`https://${host}/v2/`, null);
  const challenge = anonymous.headers.get("www-authenticate");
  const realm = anonymous.status === 401 ? realmOf(challenge) : null;
  const basic = basicOf(username, secret);
  if (realm === null) {
    const checked = await call(`https://${host}/v2/`, basic);
    if (checked.status !== 200) throw new RegistryLoginError(`${host} answered ${checked.status} to the login on /v2/.`);
    return { realmHost: null, realmPath: null };
  }
  const service = /service="([^"]+)"/i.exec(challenge ?? "")?.[1];
  const query = service === undefined ? "" : `?service=${encodeURIComponent(service)}`;
  const checked = await call(`https://${realm.host}${realm.path}${query}`, basic);
  if (checked.status !== 200) throw new RegistryLoginError(`${host} answered ${checked.status} to the login at its token service ${realm.host}.`);
  return { realmHost: realm.host, realmPath: realm.path };
};
