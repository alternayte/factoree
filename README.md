# Factoree

Factoree is a self-hosted control plane for coding agents. You delegate a Linear issue to Factoree. Factoree freezes a context contract and a validation contract, runs a coding agent in an isolated sandbox, and then verifies, validates and reviews the change in a fresh sandbox. It publishes the exact verified patch as a GitHub pull request and posts a Proof Pack to the Linear issue.

An agent claim is never evidence. Factoree runs the checks itself and decides from the artefacts.

Factoree is a Temporal worker and an HTTP API in TypeScript on Node 24, with PostgreSQL for its state. One image, `ghcr.io/alternayte/factoree`, holds both.

## Install

**Docker Compose** on one machine. It starts PostgreSQL, a Temporal server on the same PostgreSQL, a one-time migration, the API and the worker from the released images, with no checkout:

```sh
mkdir factoree && cd factoree
curl -fsSLO https://raw.githubusercontent.com/alternayte/factoree/main/deploy/compose/compose.yml
printf 'FACTOREE_MASTER_KEY=%s\nFACTOREE_PUBLIC_URL=%s\n' "$(openssl rand -hex 32)" 'https://factoree.example.com' > .env
docker compose up -d
curl -s http://localhost:3000/version
```

Set `FACTOREE_PUBLIC_URL` to the HTTPS URL where Linear and GitHub reach the API on port 3000. Keep `.env`: the master key in it decrypts the credentials that Factoree stores. To pin a release, add `FACTOREE_IMAGE=ghcr.io/alternayte/factoree:0.2.2` to `.env`.

**Kubernetes** with Helm. The chart deploys the API, the worker and a migration Job. It uses your PostgreSQL and your Temporal service:

```sh
kubectl create secret generic factoree-db --from-literal=url='postgresql://factoree:...@db:5432/factoree'
kubectl create secret generic factoree-master-key --from-literal=key="$(openssl rand -hex 32)"
helm install factoree oci://ghcr.io/alternayte/charts/factoree --version 0.2.2 \
  --set temporal.address=temporal-frontend.temporal.svc:7233 \
  --set publicURL=https://factoree.example.com
```

[`deploy/helm/factoree/values.yaml`](deploy/helm/factoree/values.yaml) lists every value: the Temporal namespace, task queue and API key, resources, the ingress and the image tag.

## Environment

The environment holds only infrastructure. Factoree keeps every other setting in its database, and you change it in the web UI.

| Variable | Purpose |
|---|---|
| `FACTOREE_DATABASE_URL` | The PostgreSQL URL. |
| `FACTOREE_MASTER_KEY` | 32 bytes of hexadecimal. It encrypts the stored credentials. |
| `FACTOREE_TEMPORAL_ADDRESS` | The Temporal frontend, for example `temporal:7233`. |
| `FACTOREE_TEMPORAL_NAMESPACE` | The Temporal namespace. The default is `default`. |
| `FACTOREE_TEMPORAL_TASK_QUEUE` | The Temporal task queue. The default is `factoree`. |
| `FACTOREE_TEMPORAL_API_KEY` | The API key of a Temporal Cloud namespace. Leave it empty for a self-hosted Temporal. |
| `FACTOREE_PUBLIC_URL` | The external base URL of the API. |
| `FACTOREE_PORT` | The port of the API. The default is `3000`. |
| `FACTOREE_LOG_LEVEL` | `debug`, `info`, `warn` or `error`. |

## Quickstart

1. Read the setup token from the API log. On a database with no finished setup, each start of the API writes one line with a new token:

   ```sh
   docker compose logs api | grep "enter the setup token"
   ```

   The line reads `setup is not complete. Open <FACTOREE_PUBLIC_URL>/setup and enter the setup token <token>`. A restart of the API replaces the token.

2. Open `<FACTOREE_PUBLIC_URL>/setup` and enter the token.
3. **GitHub App.** Factoree creates its GitHub App from a manifest. GitHub asks you to confirm and returns to setup.
4. **Linear app.** In Linear, create an OAuth application (Settings, API, OAuth applications) with the two callback URLs and the webhook URL that the step shows. Enter its client ID, client secret and webhook signing secret, then install the app in your Linear workspace.
5. **GitHub App install.** Install the App on the accounts that own the repositories that Factoree changes.
6. **Sandbox provider.** Choose Kiln, E2B or Fly Sprites and enter its URL and key. A released image pins its sandbox image, so the image field can stay empty. Set the live sandbox limit to the limit of your provider account.
7. **First product.** Choose a Linear team. Enter the model and, if the model needs one, its API key. The product starts at L2 unless you choose another level.
8. **Finish.** The setup token stops working. From then on, sign in with Linear. A Linear workspace admin is a Factoree admin and changes the install and product settings in the UI. Scripts send an API key from the API keys screen as `Authorization: Bearer <key>`.
9. Add a `.factoree/config.yaml` to a repository that the GitHub App can reach. Start from [`examples/node-web-app`](examples/node-web-app/.factoree/config.yaml) or [`examples/go-service`](examples/go-service/.factoree/config.yaml).
10. Delegate a Linear issue of the product's team to Factoree. Factoree posts its progress on the issue. When the change passes every check, it links the pull request and posts the proof pack.

A product runs at most `maxConcurrentRuns` runs at one time, 2 by default. A run over the limit waits in the state `QUEUED`, and the issue shows `Queued: N runs ahead.` Factoree never starts more live sandboxes than the live sandbox limit. At the limit it deletes its oldest retained sandbox, or it waits for a free one.

## The image

The image has these commands:

| Command | Purpose |
|---|---|
| `api` | Start the HTTP API. |
| `worker` | Start the Temporal worker. |
| `migrate` | Apply the database migrations. |
| `--version` | Print the version, the commit and the build date. |

`GET /version` on the API returns the same values. Each release pins the digest of its sandbox image, `ghcr.io/alternayte/factoree-sandbox`, in the image.

## Documentation

| Document | What it holds |
|---|---|
| [docs/factoree-sdd.md](docs/factoree-sdd.md) | The design. |
| [docs/specs/](docs/specs/) | The specs that amend the design. |
| [docs/architecture.md](docs/architecture.md) | The architecture. |
| [docs/quickstart.md](docs/quickstart.md) | One live run from a checkout, for development. |
| [examples/](examples/) | `.factoree/config.yaml` files to start from. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to build, test and submit a change. |
| [TESTING.md](TESTING.md) | The test layers and the release checks. |
| [SECURITY.md](SECURITY.md) | How to report a security defect. |
| [CHANGELOG.md](CHANGELOG.md) | What changed. |

## License

Factoree is free software under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). If you run a changed version of Factoree as a network service, you must offer its source code to the users of that service.
