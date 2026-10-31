// docs/specs/release-0-1-0.md, DI-15.03. The image build bakes these values into its environment
// from build arguments (deploy/docker/Dockerfile). A build outside the image reports "dev".
// `sandboxImageDefault` is the sandbox image digest that the release pins (DI-15.04). The install
// settings read it as the default and keep an override for a custom image.
export interface BuildInfo {
  version: string;
  commit: string;
  buildDate: string;
  sandboxImageDefault: string | null;
}

const value = (raw: string | undefined): string | null =>
  raw === undefined || raw.trim() === "" ? null : raw.trim();

export const buildInfo: BuildInfo = {
  version: value(process.env.FACTOREE_VERSION) ?? "dev",
  commit: value(process.env.FACTOREE_COMMIT) ?? "unknown",
  buildDate: value(process.env.FACTOREE_BUILD_DATE) ?? "unknown",
  sandboxImageDefault: value(process.env.FACTOREE_SANDBOX_IMAGE_DEFAULT),
};
