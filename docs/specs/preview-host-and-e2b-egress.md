# Preview host and E2B egress

Amends `docs/factoree-sdd.md` §31 and §37, `docs/specs/e2b-sandbox-provider.md` and `docs/specs/run-diagnostics.md`. Supersedes the preview environment of DI-21.179 and the egress part of DI-21.181. Closes GitHub issue 86 and completes issue 81.

## What it does
Every preview answers the browser and the readiness probe as it answers a developer after a clone. A dev server that checks the Host or the Origin, such as Vite, webpack-dev-server, Next.js, Rails, Django or Phoenix, needs no setting. On E2B, Factoree records each host that a sandbox looks up. A failed setup part, a failed run step and the setup report then name the hosts that the allow list denied, as on Kiln. The setup bootstrap allow list on E2B holds only the hosts that the setup session reached.

## Decisions
- A preview proxy runs in the sandbox behind the exposed port, for every preview, with no config key — the app then sees what a developer sees, on every stack and every sandbox provider.
- The proxy sets Host, Origin, Referer and X-Forwarded-Host to `localhost:<port>` and X-Forwarded-Proto to `http` — a rewrite of Host alone fails the Origin checks, as GitHub Codespaces shows.
- The proxy rewrites a Location of a response back to the public host and drops each Set-Cookie Domain that does not cover the public host, such as `localhost` or a fixed company domain (DI-21.189), and it passes websocket upgrades — redirects, sessions and hot reload then work through the public URL.
- The proxy does not change response bodies. An absolute URL that the app writes into a page points to localhost — Devin documents the same limit, and a body rewrite would change the evidence.
- The proxy is a Node script in `/opt/factoree/bin`, owned by root, and it runs as the sandbox user — it sits between the browser and the patched app, so a changed proxy can serve nothing that the app cannot serve itself, and Kiln runs no command as root.
- The proxy runs on the providers that run the sandbox image, Kiln and E2B. Fly Sprites and the local adapter expose the readyUrl port as before — they do not hold the image, and the local URL is already localhost.
- The proxy port is `port + 30000`, or `port - 30000` above 35535. Factoree exposes the proxy port, and the readiness probe, the validator prompt and the browser use its URL — the validator prompt needs the URL before the preview starts.
- The proxy starts as its own process before the preview command and stops with it. A proxy that exits fails the preview with its output.
- With the proxy, a preview that listens on localhost alone works, so the loopback hint names only a port where nothing listens.
- The 0.19.0 preview environment (`FACTOREE_PREVIEW_URL`, `FACTOREE_PREVIEW_HOST`, `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`) and its setup prompt line go — the proxy makes them unnecessary, and the Vite variable takes one host only before Vite 8.1.0.
- The sandbox image adds `dnsmasq-base`. In each E2B sandbox, a root dnsmasq logs every lookup to a root-owned file and forwards it to 8.8.8.8, with no cache — E2B keeps no egress log and allows 8.8.8.8.
- dnsmasq listens on the guest's own interface address, and `/etc/resolv.conf` names that address — the rootless Docker daemon resolves through slirp4netns, which cannot reach a loopback resolver.
- E2B starts dnsmasq after a create and after a restore from a snapshot, and the start is idempotent — a restored sandbox must log too.
- Each `applyNetworkPolicy` on E2B appends a marker line with the allowed names to the same file before it changes the rules. `E2BSandbox.egressLog` reads the file and judges each lookup against the policy in force at that line: covered means `allowed`, not covered means `denied` — one log then serves every phase without worker state.
- `egressLog` returns null when dnsmasq did not start or the file cannot be read — no record is better than a wrong record.
- E2B `egressLog` has the same contract as Kiln's, so faults, setup reports and the bootstrap allow list use it with no provider check — one code path for both providers.
- The setup report note "records no blocked requests" stays for Fly Sprites and the local adapter only.

## Out
- A rewrite of response bodies, OAuth callbacks, or service workers.
- A browser inside the sandbox.
- A record of a process that skips DNS, such as DNS over HTTPS or a bare IP address.
- An egress log on Fly Sprites or the local adapter.

## How I know it works
- A Vite 6 app, a Next.js 16 app with HMR, a Rails 8 app in development and a Django 5 app with `DEBUG=True` each pass a setup proof preview on E2B and on Kiln with no allowed-hosts setting.
- A Django form POST through the preview URL passes its CSRF check.
- A Rails redirect through the preview URL lands on the public host, not on localhost.
- On E2B, a verify command that runs `curl https://example.org` fails, and the run event lists `example.org` under `deniedHosts`, with `egress: "recorded"`.
- On E2B, a test that pulls `postgres:15-alpine` in the verify phase fails, and the setup report names `registry-1.docker.io` as denied.
- A setup report on E2B lists "The bootstrap reached" with only the hosts the session reached.
- After a warm restore on E2B, a lookup still appears in `egressLog`.
- On E2B, a write to the DNS log file as user `agent` fails.
- A preview command that listens on 127.0.0.1 only passes a setup proof on E2B.
