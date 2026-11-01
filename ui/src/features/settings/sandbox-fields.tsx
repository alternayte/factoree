import { Field, Input, Select } from "@/components/form";
import { Badge } from "@/components/layout";

export type SandboxProvider = "kiln" | "fly-sprites" | "local";

export type SandboxForm = {
  provider: SandboxProvider;
  url: string;
  apiKey: string;
  image: string;
  registryUsername: string;
  registryToken: string;
  maxLive: string;
  vcpus: string;
  memoryMb: string;
};

/** The Kiln sandbox size an empty field keeps. */
export type SandboxSize = { vcpus: number; memoryMb: number };

export const emptySandboxForm: SandboxForm = {
  provider: "kiln",
  url: "",
  apiKey: "",
  image: "",
  registryUsername: "",
  registryToken: "",
  maxLive: "",
  vcpus: "",
  memoryMb: "",
};

export const PROVIDER_LABELS: Record<SandboxProvider, string> = {
  kiln: "Kiln",
  "fly-sprites": "Fly Sprites",
  local: "Local (development only)",
};

const IMAGE_PATTERN = "[^\\s@]+@sha256:[0-9a-f]{64}";

/**
 * SandboxFields edits the sandbox provider settings. `stored` marks the write-only values the
 * server already holds; an empty input then keeps the stored value.
 */
export function SandboxFields({
  value,
  onChange,
  localAllowed,
  disabled,
  stored,
  pinnedImage,
  defaultSize,
  fieldErrors = {},
}: {
  value: SandboxForm;
  onChange: (next: SandboxForm) => void;
  localAllowed: boolean;
  disabled?: boolean;
  stored?: { apiKey: boolean; registryToken: boolean; image?: boolean };
  pinnedImage?: string | null;
  defaultSize: SandboxSize;
  fieldErrors?: Record<string, string[]>;
}) {
  const set = <K extends keyof SandboxForm>(key: K, next: SandboxForm[K]) => onChange({ ...value, [key]: next });
  const providers: SandboxProvider[] =
    localAllowed || value.provider === "local" ? ["kiln", "fly-sprites", "local"] : ["kiln", "fly-sprites"];
  const keyLabel = value.provider === "fly-sprites" ? "Fly Sprites token" : "API key";
  // A Kiln install with no pinned image and no stored override needs an image (sandboxSettingsProblem).
  const imageRequired = value.provider === "kiln" && !pinnedImage && !stored?.image;
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
      <Field label="Provider" errors={fieldErrors.provider}>
        {(props) => (
          <Select
            {...props}
            value={value.provider}
            disabled={disabled}
            onChange={(e) => set("provider", e.target.value as SandboxProvider)}
          >
            {providers.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {value.provider === "local" ? (
        <p className="t-hint self-end sm:pb-2">
          The local sandbox isolates nothing. The API allows it only with FACTOREE_UNSAFE_LOCAL_SANDBOX=1.
        </p>
      ) : (
        <Field
          label={value.provider === "kiln" ? "Kiln URL" : "API URL (optional)"}
          hint={value.provider === "kiln" ? undefined : "Empty uses the provider default."}
          errors={fieldErrors.url}
        >
          {(props) => (
            <Input
              {...props}
              mono
              type="url"
              required={value.provider === "kiln"}
              disabled={disabled}
              placeholder="https://"
              value={value.url}
              onChange={(e) => set("url", e.target.value)}
            />
          )}
        </Field>
      )}
      {value.provider !== "local" ? (
        <Field
          label={keyLabel}
          trailing={stored?.apiKey ? <Badge tone="success">stored</Badge> : null}
          hint={stored?.apiKey ? "Leave empty to keep the stored value." : undefined}
          errors={fieldErrors.apiKey}
        >
          {(props) => (
            <Input
              {...props}
              mono
              type="password"
              autoComplete="off"
              required={!stored?.apiKey}
              disabled={disabled}
              placeholder={stored?.apiKey ? "Enter a new value to replace it" : undefined}
              value={value.apiKey}
              onChange={(e) => set("apiKey", e.target.value)}
            />
          )}
        </Field>
      ) : null}
      <Field
        label="Live sandbox limit (optional)"
        hint="The provider's limit. At the limit Factoree deletes its oldest retained sandbox or waits for a slot."
        errors={fieldErrors.maxLive}
      >
        {(props) => (
          <Input
            {...props}
            type="number"
            min={1}
            step={1}
            disabled={disabled}
            value={value.maxLive}
            onChange={(e) => set("maxLive", e.target.value)}
          />
        )}
      </Field>
      {value.provider === "kiln" ? (
        <>
          <Field
            label="vCPUs per sandbox (optional)"
            hint={`Empty uses ${defaultSize.vcpus}. A change builds a new Kiln template, and each repository starts cold once.`}
            errors={fieldErrors.vcpus}
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={32}
                step={1}
                disabled={disabled}
                placeholder={String(defaultSize.vcpus)}
                value={value.vcpus}
                onChange={(e) => set("vcpus", e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Memory per sandbox in MB (optional)"
            hint={`Empty uses ${defaultSize.memoryMb}. Memory × the live sandbox limit must fit the memory of the Kiln host.`}
            errors={fieldErrors.memoryMb}
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1024}
                max={1048576}
                step={1}
                disabled={disabled}
                placeholder={String(defaultSize.memoryMb)}
                value={value.memoryMb}
                onChange={(e) => set("memoryMb", e.target.value)}
              />
            )}
          </Field>
        </>
      ) : null}
      <Field
        label={imageRequired ? "Sandbox image" : "Sandbox image override (optional)"}
        className="sm:col-span-2"
        hint={
          pinnedImage ? (
            <>
              Empty uses the image this release pins:{" "}
              <span className="font-mono break-all text-body">{pinnedImage}</span>
            </>
          ) : value.provider === "kiln" ? (
            "This build pins no sandbox image, so Kiln needs one. A reference pinned by digest, such as ghcr.io/acme/sandbox@sha256:…."
          ) : (
            "A reference pinned by digest, such as ghcr.io/acme/sandbox@sha256:…."
          )
        }
        errors={fieldErrors.image}
      >
        {(props) => (
          <Input
            {...props}
            mono
            pattern={IMAGE_PATTERN}
            required={imageRequired}
            disabled={disabled}
            placeholder="registry/image@sha256:…"
            value={value.image}
            onChange={(e) => set("image", e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Registry username (optional)"
        hint="For a private image. Goes with the token."
        errors={fieldErrors.registryUsername}
      >
        {(props) => (
          <Input
            {...props}
            mono
            autoComplete="off"
            disabled={disabled}
            value={value.registryUsername}
            onChange={(e) => set("registryUsername", e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Registry token (optional)"
        trailing={stored?.registryToken ? <Badge tone="success">stored</Badge> : null}
        hint={stored?.registryToken ? "Leave empty to keep the stored token." : undefined}
        errors={fieldErrors.registryToken}
      >
        {(props) => (
          <Input
            {...props}
            mono
            type="password"
            autoComplete="off"
            disabled={disabled}
            value={value.registryToken}
            onChange={(e) => set("registryToken", e.target.value)}
          />
        )}
      </Field>
    </div>
  );
}

/** parseMaxLive turns the input into a positive integer, null for empty, or undefined when it is not valid. */
export function parseMaxLive(input: string): number | null | undefined {
  return parseWhole(input, 1, Number.MAX_SAFE_INTEGER);
}

/** parseSize reads the vCPU and memory inputs: null for empty, or a string that names the bad field. */
export function parseSize(form: SandboxForm): { vcpus: number | null; memoryMb: number | null } | string {
  const vcpus = parseWhole(form.vcpus, 1, 32);
  if (vcpus === undefined) return "The vCPUs must be a whole number from 1 to 32.";
  const memoryMb = parseWhole(form.memoryMb, 1024, 1048576);
  if (memoryMb === undefined) return "The memory must be a whole number of MB from 1024 to 1048576.";
  return { vcpus, memoryMb };
}

function parseWhole(input: string, min: number, max: number): number | null | undefined {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}
