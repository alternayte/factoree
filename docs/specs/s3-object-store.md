# S3 object store for evidence and transcripts

Amends `docs/factoree-sdd.md` §39 and §51, `docs/specs/retro-agent.md` (the transcript bucket) and DI-7.8. Reference, read 2026-11-26: AWS S3 presigned URLs and lifecycle docs, GitHub anonymized image URLs (camo), Playwright trace viewer docs.

## What it does
The install gets one S3-compatible object store in Install settings. It holds kept transcripts, as in 0.23, and evidence: check logs, screenshots, video, traces, work item images and proof pack documents. An operator picks the evidence store, Linear, S3 or Filesystem, in the UI. With S3, every evidence link in a proof pack, a PR body or the run page is a stable Factoree URL. Screenshots and videos open through an open link with no sign-in, so they still render inline in Linear and GitHub. Logs, traces and documents need a Factoree sign-in. Evidence is kept by default, and a product can trim old video and traces.

## Decisions
- The transcript bucket becomes the install's object store, with the same fields: endpoint, bucket, region, access key, secret key — one bucket keeps self-hosting easy.
- `FACTOREE_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY` and `_SECRET_KEY` win and lock each field. The `FACTOREE_TRANSCRIPT_S3_*` names of 0.23 still work as aliases, and the new name wins when both are set — a released env var must not break.
- Object keys are `transcripts/<tenant>/<run>/<id>.txt.gz` and `evidence/<tenant>/<run>/<id>-<name>` — a prefix per tenant and run, so a lifecycle rule or a manual clean-up can target one.
- Install settings show "Test object store". It puts, reads and deletes one probe object and shows the result — the operator sees that the bucket works before a run depends on it.
- Install settings have an "Evidence store" choice: Linear, S3 or Filesystem, default Linear. S3 can be chosen only when the object store is complete and its last test passed — a run must not fail on a bad bucket.
- `FACTOREE_EVIDENCE_STORAGE`, when set, wins and locks the choice. It has no default value any more — the owner's env-over-UI rule, and a default would lock the field for every install.
- A new artifact goes to the store chosen at the time of its upload. An existing artifact stays where it is, and its link keeps working. Nothing is copied — old Linear and file links still open.
- With S3, an evidence row stores the object key. Every link Factoree writes is `<public URL>/artifacts/<id>` — a link that never expires, unlike a SigV4 presigned URL, which lasts at most 7 days.
- `/artifacts/<id>` needs a Factoree sign-in as a member of the artifact's tenant. It answers 302 to a presigned GET URL that lasts 5 minutes, with the stored content type. Logs, traces and documents get `Content-Disposition: attachment` — §52 by tenant check, and a log never renders as a page.
- Screenshots and videos get an open link, `/artifacts/<id>/<token>`. The token is HMAC-SHA256 of the artifact id under the master key, in base64url. It opens with no sign-in and never expires — Linear and GitHub fetch images through their own servers with no Factoree session, so only an open link renders inline.
- The proof pack and the PR body use the open link for screenshots and videos, and the sign-in link for every other kind — a trace holds request data, so it never opens without a sign-in.
- An open link of a deleted artifact answers 404. A new master key makes every open link answer 404, and Install settings say so beside the master key — Factoree revokes a link by deleting the artifact.
- The run page lists each artifact with its kind, size, SHA-256 and link, as today.
- Evidence is kept until its run is deleted, as in Linear today — evidence is the proof behind a merged change.
- The product page has an optional "Evidence retention" in days, empty by default. The hourly retention pass deletes video and trace objects older than it from the object store. Their rows stay and show "deleted after N days" — screenshots, logs and documents are small and are the proof.
- Signal results and web results stay in Postgres — each is capped at 256 KiB, kept for the retro data retention, and read row by row.
- Every object store call goes through the existing SigV4 signer in `src/adapters/s3` — three object calls and a presign do not earn the AWS SDK.

## Out
- Copying existing Linear or file evidence into the object store.
- Uploading one artifact to two stores.
- A presigned link in a proof pack or a PR body.
- An open link for logs, traces or documents.
- One bucket per tenant or per product.
- Signal results, web results or run events in the object store.
- Retention for screenshots, logs or proof pack documents.

## How I know it works
- `just verify` passes.
- "Test object store" with a wrong secret key shows the S3 error. With the right one it shows success, and the bucket holds no probe object afterwards.
- With S3 as the evidence store, a FAC run's proof pack in Linear shows its screenshots inline, and its video link plays in a private browser window with no sign-in.
- The same run's check log link asks for a Factoree sign-in. After the sign-in it downloads the log.
- A signed-in member of another workspace gets 404 on that `/artifacts/<id>`.
- An open link with a changed token answers 404.
- The object keys of the run start with `evidence/<tenant>/<run>/`.
- A run from before the switch still opens its Linear evidence links.
- With `FACTOREE_EVIDENCE_STORAGE=linear` set, the Evidence store choice shows locked on Linear.
- With `FACTOREE_TRANSCRIPT_S3_BUCKET` set and no `FACTOREE_S3_BUCKET`, the bucket field shows that value, locked.
- With Evidence retention 7 on a product, a video older than 7 days is gone from the bucket, and the run page shows "deleted after 7 days" for it.
- S3 cannot be chosen until the object store test passes.
