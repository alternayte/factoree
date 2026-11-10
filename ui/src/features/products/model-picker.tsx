import { useQuery } from "@tanstack/react-query";
import { Check, Search, TriangleAlert } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { getModelCatalogOptions } from "@/api/@tanstack/react-query.gen";
import type { GetModelCatalogResponse } from "@/api/types.gen";
import { Button } from "@/components/button";
import { Field, Input, Switch } from "@/components/form";
import { Alert, Section } from "@/components/layout";
import { cn } from "@/lib/utils";
import { EFFORT_ROLES } from "@/lib/workspace";
import { CLAUDE_EFFORTS, DEFAULT_EFFORT, DEFAULT_MODEL } from "./model-defaults";
import { resolvedRole, type ProductForm, type Runner } from "./product-form";

/**
 * docs/specs/model-picker.md. One summary row per role, and a dialog that offers only valid
 * combinations: the models of the chosen runner, the efforts of the chosen model, and the key
 * each provider needs. The catalog comes from the Factoree API, never from models.dev directly.
 */

type Role = (typeof EFFORT_ROLES)[number];
type Catalog = GetModelCatalogResponse;
type Provider = Catalog["providers"][number];
type Model = Provider["models"][number];

const RUNNERS: Runner[] = ["opencode", "claude"];
export const RUNNER_LABEL: Record<Runner, string> = { opencode: "opencode", claude: "Claude Code" };
/** The keys Claude Code reads. The catalog names only the first. */
const CLAUDE_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
/** The most rows the list renders. Search narrows the rest. */
const SHOWN = 150;

const ROLE_LABEL: Record<Role, string> = {
  implementer: "Implementer",
  refiner: "Refiner",
  validator: "Validator",
  reviewer: "Reviewer",
  setup: "Setup",
};

function useCatalog(runner: Runner) {
  return useQuery({ ...getModelCatalogOptions({ query: { runner } }), staleTime: 60 * 60 * 1000 });
}

/** The listed model a runner model names. opencode names `provider/model`, claude the Anthropic id. */
function lookup(
  catalog: Catalog | undefined,
  runner: Runner,
  model: string,
): { provider: Provider; model: Model } | null {
  if (!catalog || !model) return null;
  const slash = model.indexOf("/");
  const providerId = runner === "claude" ? "anthropic" : model.slice(0, slash);
  const modelId = runner === "claude" ? model : model.slice(slash + 1);
  const provider = catalog.providers.find((p) => p.id === providerId);
  const found = provider?.models.find((m) => m.id === modelId);
  return provider && found ? { provider, model: found } : null;
}

const runnerModelOf = (runner: Runner, provider: Provider, model: Model): string =>
  runner === "claude" ? model.id : `${provider.id}/${model.id}`;

/** The key names a runner and provider accept, and the one to add. */
function keyNamesOf(runner: Runner, provider: Provider | null): string[] {
  if (runner === "claude") return CLAUDE_KEYS;
  return provider?.env ?? [];
}

const formatTokens = (n: number | null) =>
  n === null ? null : n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`;
const formatCost = (n: number | null) => (n === null ? "?" : n === 0 ? "free" : `$${n}`);

export function AgentsSection({
  form,
  setForm,
  disabled,
  secretNames,
  onAddKey,
}: {
  form: ProductForm;
  setForm: React.Dispatch<React.SetStateAction<ProductForm>>;
  disabled: boolean;
  /** The names of the product secrets. A provider key counts when its name is here. */
  secretNames: Set<string> | null;
  onAddKey: (name: string) => void;
}) {
  const opencode = useCatalog("opencode");
  const claude = useCatalog("claude");
  const catalogs: Record<Runner, Catalog | undefined> = { opencode: opencode.data, claude: claude.data };
  const [editing, setEditing] = useState<Role | "default" | null>(null);

  const summary = (runner: Runner, model: string, effort: string | null) => {
    const found = lookup(catalogs[runner], runner, model);
    const keys = keyNamesOf(runner, found?.provider ?? null);
    const missing =
      model && secretNames !== null && keys.length > 0 && !keys.some((name) => secretNames.has(name)) ? keys[0]! : null;
    return { name: found?.model.name ?? (model || DEFAULT_MODEL[runner]), missing, effort };
  };

  const rows: {
    key: Role | "default";
    label: string;
    runner: Runner;
    model: string;
    effort: string | null;
    inherits: boolean;
  }[] = [
    {
      key: "default",
      label: "Default",
      runner: form.defaultRunner,
      model: form.model.trim(),
      effort: null,
      inherits: false,
    },
    ...EFFORT_ROLES.map((role) => {
      const resolved = resolvedRole(form, role);
      return {
        key: role,
        label: ROLE_LABEL[role],
        runner: resolved.runner,
        model: resolved.model,
        effort: resolved.effort,
        inherits: !form.runners[role] && !form.models[role].trim(),
      };
    }),
  ];

  return (
    <Section
      title="Agents per role"
      description="The coding agent, the model and the reasoning effort of each role. A role without its own choice takes the default."
    >
      {opencode.data?.available === false ? (
        <Alert tone="warning" className="mb-3">
          The model catalog did not load, because Factoree could not reach models.dev. Type the model ids by hand.
        </Alert>
      ) : null}
      <ul className="-my-2 divide-y divide-hairline">
        {rows.map((row) => {
          const s = summary(row.runner, row.model, row.effort);
          return (
            <li key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium text-ink">{row.label}</span>
                  {row.inherits ? <span className="text-xs text-mute">default</span> : null}
                </div>
                <p className="text-sm text-body">
                  {RUNNER_LABEL[row.runner]} · <span className="font-mono text-ink">{s.name}</span>
                  {row.key === "default" ? null : (
                    <>
                      {" "}
                      · effort <span className="font-mono text-ink">{s.effort || DEFAULT_EFFORT}</span>
                    </>
                  )}
                </p>
                {s.missing ? (
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-warning">
                    <TriangleAlert className="size-3.5" aria-hidden />
                    needs <span className="font-mono">{s.missing}</span>
                    {!disabled ? (
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() => onAddKey(s.missing!)}
                      >
                        Add key
                      </button>
                    ) : null}
                  </p>
                ) : null}
              </div>
              <Button size="sm" disabled={disabled} onClick={() => setEditing(row.key)}>
                Change
              </Button>
            </li>
          );
        })}
      </ul>
      {editing !== null ? (
        <PickerDialog
          key={editing}
          target={editing}
          form={form}
          catalogs={catalogs}
          loading={opencode.isPending || claude.isPending}
          secretNames={secretNames}
          onAddKey={(name) => {
            setEditing(null);
            onAddKey(name);
          }}
          onClose={() => setEditing(null)}
          onApply={(choice) => {
            setForm((f) =>
              editing === "default"
                ? { ...f, defaultRunner: choice.runner, model: choice.model }
                : {
                    ...f,
                    runners: { ...f.runners, [editing]: choice.inherit ? "" : choice.runner },
                    models: { ...f.models, [editing]: choice.inherit ? "" : choice.model },
                    effort: { ...f.effort, [editing]: choice.effort },
                  },
            );
            setEditing(null);
          }}
        />
      ) : null}
    </Section>
  );
}

type Choice = { runner: Runner; model: string; effort: string; inherit: boolean };

function PickerDialog({
  target,
  form,
  catalogs,
  loading,
  secretNames,
  onAddKey,
  onApply,
  onClose,
}: {
  target: Role | "default";
  form: ProductForm;
  catalogs: Record<Runner, Catalog | undefined>;
  loading: boolean;
  secretNames: Set<string> | null;
  onAddKey: (name: string) => void;
  onApply: (choice: Choice) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const listId = useId();
  const isDefault = target === "default";
  const [inherit, setInherit] = useState(!isDefault && !form.runners[target] && !form.models[target].trim());
  const [runner, setRunner] = useState<Runner>(
    isDefault ? form.defaultRunner : form.runners[target] || form.defaultRunner,
  );
  const [model, setModel] = useState(
    isDefault
      ? form.model.trim()
      : form.models[target].trim() || (runner === form.defaultRunner ? form.model.trim() : ""),
  );
  const [effort, setEffort] = useState(isDefault ? "" : form.effort[target].trim());
  const [query, setQuery] = useState("");
  const catalog = catalogs[runner];
  const listed = lookup(catalog, runner, model);
  const [custom, setCustom] = useState(Boolean(model) && catalog?.available === true && listed === null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // What the role runs while it keeps the default: the default runner and model.
  const effectiveRunner = inherit ? form.defaultRunner : runner;
  const effectiveModel = inherit ? form.model.trim() : model;
  const effective = lookup(catalogs[effectiveRunner], effectiveRunner, effectiveModel);
  const efforts: string[] | null = effective
    ? effective.model.efforts
    : effectiveRunner === "claude"
      ? [...CLAUDE_EFFORTS]
      : null;

  const matches = useMemo(() => {
    if (!catalog?.available) return [] as { provider: Provider; model: Model }[];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out: { provider: Provider; model: Model }[] = [];
    // The providers the product holds a key for come first, so the usual choice is at the top.
    const hasKey = (provider: Provider) => {
      const keys = keyNamesOf(runner, provider);
      return secretNames !== null && keys.some((name) => secretNames.has(name));
    };
    const ordered = [...catalog.providers].sort((a, b) => Number(hasKey(b)) - Number(hasKey(a)));
    for (const provider of ordered) {
      for (const m of provider.models) {
        const text = `${provider.name} ${provider.id} ${m.name} ${m.id}`.toLowerCase();
        if (terms.every((term) => text.includes(term))) out.push({ provider, model: m });
      }
    }
    return out;
  }, [catalog, query, runner, secretNames]);
  const shown = matches.slice(0, SHOWN);

  const choose = (entry: { provider: Provider; model: Model }) => {
    setModel(runnerModelOf(runner, entry.provider, entry.model));
    // An effort the new model does not take would fail the save.
    if (effort && !entry.model.efforts.includes(effort)) setEffort("");
  };

  const onListKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, Math.min(shown.length - 1, i + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter" && shown[active]) {
      event.preventDefault();
      choose(shown[active]!);
    }
  };

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  const title = isDefault ? "Default runner and model" : `${ROLE_LABEL[target]} agent`;
  let lastProvider = "";

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="dialog m-auto flex max-h-[min(44rem,calc(100dvh-2rem))] w-[min(40rem,calc(100vw-2rem))] flex-col rounded-card border border-hairline-strong bg-panel p-0 text-body"
    >
      <div className="border-b border-hairline p-4">
        <h2 id={titleId} className="t-section">
          {title}
        </h2>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {!isDefault ? (
          <Switch
            checked={inherit}
            onCheckedChange={setInherit}
            label={`Use the default: ${RUNNER_LABEL[form.defaultRunner]} · ${lookup(catalogs[form.defaultRunner], form.defaultRunner, form.model.trim())?.model.name ?? (form.model.trim() || DEFAULT_MODEL[form.defaultRunner])}`}
          />
        ) : null}

        {!inherit ? (
          <>
            <div role="radiogroup" aria-label="Runner" className="segmented">
              {RUNNERS.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={runner === r}
                  className={cn("segment", runner === r && "segment-on")}
                  onClick={() => {
                    if (r === runner) return;
                    setRunner(r);
                    setModel("");
                    setEffort("");
                    setCustom(false);
                    setActive(0);
                  }}
                >
                  {RUNNER_LABEL[r]}
                </button>
              ))}
            </div>

            {catalog?.available && !custom ? (
              <div className="flex min-h-0 flex-col gap-2">
                <label className="relative block">
                  <span className="sr-only">Search models</span>
                  <Search
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mute"
                    aria-hidden
                  />
                  <Input
                    autoFocus
                    role="combobox"
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
                    className="pl-9"
                    placeholder={runner === "claude" ? "Search Anthropic models" : "Search models or providers"}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setActive(0);
                    }}
                    onKeyDown={onListKey}
                  />
                </label>
                <ul
                  id={listId}
                  role="listbox"
                  aria-label="Models"
                  className="max-h-72 overflow-y-auto rounded-control border border-hairline"
                >
                  <li
                    role="option"
                    aria-selected={!model}
                    className={cn("model-option", !model && "model-option-on")}
                    onClick={() => {
                      setModel("");
                      setEffort("");
                    }}
                  >
                    <span className="flex-1">{DEFAULT_MODEL[runner]}</span>
                    {!model ? <Check className="size-4 text-accent-text" aria-hidden /> : null}
                  </li>
                  {shown.map((entry, index) => {
                    const id = runnerModelOf(runner, entry.provider, entry.model);
                    const header = entry.provider.id !== lastProvider;
                    lastProvider = entry.provider.id;
                    const keys = keyNamesOf(runner, entry.provider);
                    const hasKey =
                      secretNames === null || keys.length === 0 || keys.some((name) => secretNames.has(name));
                    return (
                      <li key={id} role="presentation">
                        {header ? (
                          <div className="flex flex-wrap items-center gap-2 border-t border-hairline bg-raised/60 px-3 py-1.5 text-xs first:border-t-0">
                            <span className="font-medium text-ink">{entry.provider.name}</span>
                            {keys[0] ? (
                              hasKey ? (
                                <span className="text-success">
                                  key{" "}
                                  <span className="font-mono">
                                    {keys.find((name) => secretNames?.has(name)) ?? keys[0]}
                                  </span>{" "}
                                  ✓
                                </span>
                              ) : (
                                <span className="flex items-center gap-1.5 text-warning">
                                  needs <span className="font-mono">{keys[0]}</span>
                                  <button
                                    type="button"
                                    className="underline underline-offset-2"
                                    onClick={() => onAddKey(keys[0]!)}
                                  >
                                    Add key
                                  </button>
                                </span>
                              )
                            ) : null}
                          </div>
                        ) : null}
                        <div
                          id={`${listId}-${index}`}
                          role="option"
                          aria-selected={model === id}
                          className={cn(
                            "model-option",
                            model === id && "model-option-on",
                            index === active && "model-option-active",
                          )}
                          onMouseEnter={() => setActive(index)}
                          onClick={() => choose(entry)}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-ink">{entry.model.name}</span>
                            <span className="block truncate font-mono text-xs text-mute">{id}</span>
                          </span>
                          <span className="hidden shrink-0 text-right text-xs text-mute sm:block">
                            {formatTokens(entry.model.contextTokens)
                              ? `${formatTokens(entry.model.contextTokens)} ctx · `
                              : ""}
                            {formatCost(entry.model.costInput)}/{formatCost(entry.model.costOutput)}
                            {entry.model.efforts.length > 0 ? " · effort" : ""}
                          </span>
                          {model === id ? <Check className="size-4 shrink-0 text-accent-text" aria-hidden /> : null}
                        </div>
                      </li>
                    );
                  })}
                  {matches.length > SHOWN ? (
                    <li className="px-3 py-2 text-xs text-mute">
                      {matches.length - SHOWN} more. Type to narrow the list.
                    </li>
                  ) : null}
                  {matches.length === 0 ? <li className="px-3 py-2 text-xs text-mute">No model matches.</li> : null}
                </ul>
                <p className="text-xs text-mute">
                  Prices are US dollars per million input and output tokens, from models.dev.
                </p>
              </div>
            ) : loading ? (
              <p className="text-sm text-mute">Loading the model catalog…</p>
            ) : (
              <Field
                label="Model id"
                hint={runner === "opencode" ? "provider/model." : "opus, sonnet, haiku, fable or a full claude-* id."}
              >
                {(props) => (
                  <Input
                    {...props}
                    mono
                    autoFocus
                    placeholder={runner === "opencode" ? "provider/model" : "claude-sonnet-5-5"}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  />
                )}
              </Field>
            )}
            {catalog?.available ? (
              <button
                type="button"
                className="self-start text-xs text-mute underline underline-offset-2"
                onClick={() => setCustom((c) => !c)}
              >
                {custom ? "Pick from the list" : "Use a model id not in the list"}
              </button>
            ) : null}
          </>
        ) : null}

        {!isDefault ? (
          efforts === null ? (
            <Field
              label="Effort"
              hint={target === "setup" ? "Empty takes the implementer effort." : "Empty takes the model default."}
            >
              {(props) => (
                <Input
                  {...props}
                  placeholder="low, high, max"
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                />
              )}
            </Field>
          ) : efforts.length === 0 ? (
            <p className="text-sm text-mute">This model takes no reasoning effort.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="t-label">Effort</span>
              <div role="radiogroup" aria-label="Effort" className="segmented flex-wrap">
                {["", ...efforts].map((value) => (
                  <button
                    key={value || "default"}
                    type="button"
                    role="radio"
                    aria-checked={effort === value}
                    className={cn("segment", effort === value && "segment-on")}
                    onClick={() => setEffort(value)}
                  >
                    {value || (target === "setup" ? "implementer" : "default")}
                  </button>
                ))}
              </div>
            </div>
          )
        ) : null}
        {!isDefault && efforts !== null && effort && !efforts.includes(effort) ? (
          <p className="text-sm text-warning">The effort {effort} does not fit this model. Pick one above.</p>
        ) : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-hairline px-4 py-3">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => onApply({ runner, model: model.trim(), effort: effort.trim(), inherit })}
        >
          Use these
        </Button>
      </div>
    </dialog>
  );
}
