# Security policy

## Report a vulnerability

Do not open a public issue for a vulnerability.

1. Open the repository [alternayte/factoree](https://github.com/alternayte/factoree) on GitHub.
2. Open the **Security** tab.
3. Click **Report a vulnerability**.
4. Give the affected version or commit, the steps to reproduce and the effect.

GitHub keeps the report private between you and the maintainers. The maintainers publish a security advisory when a fix is available.

`GET /version` and `docker run --rm ghcr.io/alternayte/factoree:<tag> --version` give the version and the commit of an install.

## Supported versions

| Version | Supported |
|---|---|
| The latest release | Yes |
| Older releases | No |

## Security design

The SDD defines the main controls:

- An agent claim is never evidence. Factoree runs the verification, the user validation and the review itself, and decides from the artefacts.
- The implementer runs in a work sprite. Each check runs in a new check sprite, built from the base SHA plus the captured patch. The validator and the reviewer always start fresh.
- Factoree publishes only the verified patch. Its SHA-256 hash must reproduce at publication.
- The runner CLIs live root-owned in the sandbox image, so an agent cannot replace them.
- The action policy limits each agent session by role and by product. A repository's `.factoree/config.yaml` cannot raise a privilege that the product owns.
- The product owns the egress allow list of its sandboxes. A repository can only narrow it.
- Factoree encrypts stored credentials and product secrets with AES-256-GCM under `FACTOREE_MASTER_KEY`. Logs redact secret values.
- The GitHub App mints each token for one installation and one operation. Webhook signatures are verified before any parse.

For details, read [docs/factoree-sdd.md](docs/factoree-sdd.md) and [docs/specs/check-isolation.md](docs/specs/check-isolation.md).
