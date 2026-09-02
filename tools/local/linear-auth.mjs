/**
 * Runs the Linear OAuth flow once and stores the installation.
 *
 * A Linear access token lives for twenty-four hours. This script collects the access token, the
 * refresh token, and the lifetime in one pass, then stores all three through
 * `PUT /admin/linear-installations`. The worker refreshes the token from there on, so an
 * operator runs this once per workspace rather than once per day.
 *
 * The script prints no token. It prints the workspace, the expiry, and the outcome.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const need = (name) => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`Set ${name} in .env first.`);
    process.exit(1);
  }
  return value;
};

const clientId = need("LINEAR_CLIENT_ID");
const clientSecret = need("LINEAR_CLIENT_SECRET");
const adminToken = need("ADMIN_API_TOKEN");
const apiBase = process.env.API_BASE ?? `http://localhost:${process.env.PORT ?? "3000"}`;
const port = Number(process.env.LINEAR_OAUTH_PORT ?? "8080");
const redirectUri = `http://localhost:${port}/callback`;
// `actor=app` makes the token act as the Factoree agent, not as the operator who authorizes it.
const scope = process.env.LINEAR_OAUTH_SCOPE ?? "read,write,app:assignable,app:mentionable";

const authorizeUrl =
  "https://linear.app/oauth/authorize?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    actor: "app",
  }).toString();

const linear = async (token, query) => {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await response.json();
  if (!response.ok || body.errors) throw new Error(`Linear answered ${response.status}`);
  return body.data;
};

const exchange = async (code) => {
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!response.ok) throw new Error(`the Linear token endpoint answered ${response.status}`);
  const body = await response.json();
  if (typeof body.access_token !== "string") throw new Error("the response carried no access token");
  return body;
};

const store = async (tokens) => {
  const data = await linear(tokens.access_token, "{ organization { id name } }");
  const organization = data.organization;
  const payload = {
    linearWorkspaceId: organization.id,
    workspaceName: organization.name,
    accessToken: tokens.access_token,
    ...(typeof tokens.refresh_token === "string" ? { refreshToken: tokens.refresh_token } : {}),
    ...(typeof tokens.expires_in === "number" ? { expiresIn: tokens.expires_in } : {}),
    scopes: typeof tokens.scope === "string" ? tokens.scope.split(/[ ,]+/).filter(Boolean) : [],
  };
  const response = await fetch(`${apiBase}/admin/linear-installations`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`the admin API answered ${response.status}. Is \`just api\` running?`);
  }
  return { organization, payload };
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);
  if (url.pathname !== "/callback") {
    response.writeHead(404).end("not the callback path");
    return;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error !== null || code === null) {
    response.writeHead(400).end(`Linear reported: ${error ?? "no code"}`);
    console.error(`\nLinear reported: ${error ?? "no code"}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  void (async () => {
    try {
      const tokens = await exchange(code);
      const { organization, payload } = await store(tokens);
      const expiry =
        payload.expiresIn === undefined
          ? "no expiry reported"
          : new Date(Date.now() + payload.expiresIn * 1000).toISOString();
      response.writeHead(200, { "Content-Type": "text/plain" }).end("Factoree stored the installation. Close this tab.");
      console.log(`\nStored the installation of ${organization.name}.`);
      console.log(`  workspace id:  ${organization.id}`);
      console.log(`  refresh token: ${payload.refreshToken === undefined ? "ABSENT" : "stored"}`);
      console.log(`  access token expires: ${expiry}`);
      if (payload.refreshToken === undefined) {
        console.log("\nLinear returned no refresh token, so the worker cannot refresh this one.");
      }
      console.log("\nRestart `just worker` to use it.");
    } catch (failure) {
      response.writeHead(500).end(String(failure instanceof Error ? failure.message : failure));
      console.error(`\n${failure instanceof Error ? failure.message : String(failure)}`);
      process.exitCode = 1;
    } finally {
      server.close();
    }
  })();
});

server.listen(port, () => {
  console.log("Add this redirect URI to the Linear application first:");
  console.log(`  ${redirectUri}\n`);
  console.log("Open this URL, then approve the workspace:");
  console.log(`  ${authorizeUrl}\n`);
  if (process.platform === "darwin") spawn("open", [authorizeUrl], { stdio: "ignore", detached: true }).unref();
  console.log(`Waiting for the callback on port ${port}.`);
});
