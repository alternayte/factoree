import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  getRetroSettingsOptions,
  getRetroSettingsQueryKey,
  listProductsOptions,
  listRetrosOptions,
  listRetrosQueryKey,
} from "@/api/@tanstack/react-query.gen";
import { putRetroSettings, retryRetroSchedule, runRetroNow } from "@/api/sdk.gen";
import type { GetRetroSettingsResponse } from "@/api/types.gen";
import { Button } from "@/components/button";
import { Field, Input, SavedNote, Select, Switch } from "@/components/form";
import {
  Alert,
  Badge,
  Empty,
  ErrorAlert,
  KeyValue,
  PageHeader,
  Section,
  SkeletonCard,
  SkeletonRows,
  Stack,
} from "@/components/layout";
import { RetroAgentRow, type RetroAgent } from "@/features/products/model-picker";
import { WorkspacePicker } from "@/features/products/workspace-picker";
import { formatCost } from "@/features/runs/run-format";
import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/session";
import { cn, formatDate } from "@/lib/utils";
import { pickWorkspace } from "@/lib/workspace";
import {
  browserTimeZone,
  HOURS,
  hourLabel,
  isTimeZone,
  retroTone,
  timeZones,
  WEEKDAYS,
  type RetroSummary,
} from "./retro-format";

type View = GetRetroSettingsResponse;
type Settings = View["settings"];
type Schedule = Settings["schedule"];

/** While a retro runs, the page asks again this often. */
const RUNNING_POLL_MS = 5_000;

type SettingsForm = {
  schedule: Schedule;
  weekday: number;
  hour: number;
  timeZone: string;
  productIds: string[];
  agent: RetroAgent;
  costCapUsd: string;
};

/**
 * The stored settings as a form. A tenant that never saved has the zone UTC and the schedule off:
 * the zone then fills in from the browser, and the operator can change it.
 */
function formOf(view: View): SettingsForm {
  const s = view.settings;
  const firstSetup = s.schedule === "off" && s.timeZone === "UTC" && view.last === null;
  return {
    schedule: s.schedule,
    weekday: s.weekday,
    hour: s.hour,
    timeZone: firstSetup ? browserTimeZone() : s.timeZone,
    productIds: s.productIds,
    agent: { runner: s.runner, model: s.model, effort: s.effort },
    costCapUsd: String(s.costCapUsd),
  };
}

/** docs/specs/retro-agent.md. The retro settings of a workspace and its retros. */
export function RetroPage({ ws }: { ws?: string }) {
  const me = useMe();
  const memberships = me.data?.memberships ?? [];
  const workspace = pickWorkspace(memberships, ws);
  const linearWorkspaceId = workspace?.linearWorkspaceId ?? "";
  const query = { query: { linearWorkspaceId } };
  const settings = useQuery({
    ...getRetroSettingsOptions(query),
    enabled: Boolean(workspace),
    refetchInterval: (q) => (q.state.data?.running ? RUNNING_POLL_MS : false),
  });
  const running = settings.data?.running ?? null;
  const retros = useQuery({
    ...listRetrosOptions(query),
    enabled: Boolean(workspace),
    refetchInterval: running ? RUNNING_POLL_MS : false,
  });

  if (!workspace) {
    return (
      <>
        <PageHeader title="Retro" />
        <Alert tone="info">You are a member of no workspace where Factoree is installed.</Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Retro"
        description="A retro agent reads the runs that ended since the last retro and proposes findings, each with the runs and signal results that show it. A human decides what becomes a Linear issue."
      />
      <div className="mb-5">
        <WorkspacePicker memberships={memberships} current={workspace} to="/retro" />
      </div>
      {settings.isPending ? (
        <Stack className="lg:grid lg:grid-cols-2 lg:items-start">
          <SkeletonCard label="Loading the retro settings" fields={6} />
          <SkeletonCard fields={2} />
        </Stack>
      ) : null}
      <ErrorAlert error={settings.error} title="The retro settings did not load" />
      {settings.data ? (
        <Stack className="lg:grid lg:grid-cols-2 lg:items-start">
          <SettingsSection
            key={linearWorkspaceId}
            view={settings.data}
            linearWorkspaceId={linearWorkspaceId}
            canEdit={workspace.admin}
          />
          <StatusSection view={settings.data} linearWorkspaceId={linearWorkspaceId} canEdit={workspace.admin} />
        </Stack>
      ) : null}
      <Section title="Retros" className="mt-4" description="Newest first.">
        {retros.isPending ? <SkeletonRows label="Loading the retros" /> : null}
        <ErrorAlert error={retros.error} title="The retros did not load" />
        {retros.data?.retros.length === 0 ? <Empty>No retro ran yet.</Empty> : null}
        {retros.data && retros.data.retros.length > 0 ? (
          <ul className="stagger -my-2 divide-y divide-hairline">
            {retros.data.retros.map((retro) => (
              <RetroRow key={retro.id} retro={retro} linearWorkspaceId={linearWorkspaceId} />
            ))}
          </ul>
        ) : null}
      </Section>
    </>
  );
}

function RetroRow({ retro, linearWorkspaceId }: { retro: RetroSummary; linearWorkspaceId: string }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
      <Link
        to="/retro/$retroId"
        params={{ retroId: retro.id }}
        search={{ ws: linearWorkspaceId }}
        className="link min-w-0 font-medium no-underline hover:underline"
      >
        {formatDate(retro.startedAt)}
      </Link>
      <Badge tone={retroTone(retro.status)}>{retro.status}</Badge>
      <span className="t-hint">{retro.trigger}</span>
      <span className="ml-auto flex flex-wrap gap-x-3 font-mono text-xs text-body tabular-nums">
        <span>{formatCost(retro.costUsd)}</span>
        <span>
          {retro.findingCount} {retro.findingCount === 1 ? "finding" : "findings"}
        </span>
      </span>
      {retro.failureMessage ? <p className="w-full text-xs text-danger">{retro.failureMessage}</p> : null}
    </li>
  );
}

function SettingsSection({
  view,
  linearWorkspaceId,
  canEdit,
}: {
  view: View;
  linearWorkspaceId: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<SettingsForm>(() => formOf(view));
  const [baseline, setBaseline] = useState<SettingsForm>(() => formOf(view));
  const [problem, setProblem] = useState<string | null>(null);
  const zoneListId = useId();
  const [zones] = useState(timeZones);
  const products = useQuery(listProductsOptions({ query: { linearWorkspaceId } }));
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: async () => {
      const cost = Number(form.costCapUsd.trim());
      return (
        await putRetroSettings({
          body: {
            linearWorkspaceId,
            schedule: form.schedule,
            weekday: form.weekday,
            hour: form.hour,
            timeZone: form.timeZone.trim(),
            productIds: form.productIds,
            runner: form.agent.runner,
            model: form.agent.model,
            effort: form.agent.effort,
            costCapUsd: cost,
          },
          throwOnError: true,
        })
      ).data;
    },
    onSuccess: (next) => {
      qc.setQueryData(getRetroSettingsQueryKey({ query: { linearWorkspaceId } }), next);
      const saved = formOf(next);
      setForm(saved);
      setBaseline(saved);
    },
  });
  const fieldErrors = save.error instanceof ApiError ? save.error.fieldErrors : {};

  const check = (): string | null => {
    const cost = Number(form.costCapUsd.trim());
    if (!form.costCapUsd.trim() || !Number.isFinite(cost) || cost <= 0 || cost > 1000)
      return "The cost cap must be more than 0 and at most 1000 US dollars.";
    if (!isTimeZone(form.timeZone.trim())) return `${form.timeZone || "The time zone"} is not an IANA time zone.`;
    return null;
  };

  const list = products.data ?? [];
  const known = new Set(list.map((product) => product.id));
  const disabled = !canEdit;

  return (
    <Section title="Settings" description="Each save updates the retro schedule in Temporal.">
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          const found = check();
          setProblem(found);
          if (found === null) save.mutate();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="t-label">Schedule</span>
          <div role="radiogroup" aria-label="Schedule" className="segmented">
            {(["off", "daily", "weekly"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={form.schedule === value}
                disabled={disabled}
                className={cn("segment", form.schedule === value && "segment-on")}
                onClick={() => set("schedule", value)}
              >
                {value === "off" ? "Off" : value === "daily" ? "Daily" : "Weekly"}
              </button>
            ))}
          </div>
          <p className="t-hint">
            {form.schedule === "off"
              ? "No retro runs on its own. Run now still starts one."
              : "A retro costs one agent session per product in scope."}
          </p>
        </div>

        {form.schedule !== "off" ? (
          <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-3">
            {form.schedule === "weekly" ? (
              <Field label="Day">
                {(props) => (
                  <Select
                    {...props}
                    disabled={disabled}
                    value={form.weekday}
                    onChange={(e) => set("weekday", Number(e.target.value))}
                  >
                    {WEEKDAYS.map((day, index) => (
                      <option key={day} value={index + 1}>
                        {day}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
            <Field label="Time">
              {(props) => (
                <Select
                  {...props}
                  mono
                  disabled={disabled}
                  value={form.hour}
                  onChange={(e) => set("hour", Number(e.target.value))}
                >
                  {HOURS.map((hour) => (
                    <option key={hour} value={hour}>
                      {hourLabel(hour)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Time zone" className={form.schedule === "weekly" ? undefined : "sm:col-span-2"}>
              {(props) => (
                <>
                  <Input
                    {...props}
                    mono
                    required
                    autoComplete="off"
                    list={zoneListId}
                    disabled={disabled}
                    value={form.timeZone}
                    onChange={(e) => set("timeZone", e.target.value)}
                  />
                  <datalist id={zoneListId}>
                    {zones.map((zone) => (
                      <option key={zone} value={zone} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
          </div>
        ) : null}

        <div className="flex flex-col gap-2.5">
          <span className="t-label">Products in scope</span>
          {form.productIds.length === 0 ? (
            <span className="self-start">
              <Badge tone="accent">Every active product</Badge>
            </span>
          ) : null}
          {products.isPending ? <SkeletonRows rows={2} label="Loading the products" /> : null}
          <ErrorAlert error={products.error} title="The products did not load" />
          {list.map((product) => (
            <Switch
              key={product.id}
              checked={form.productIds.includes(product.id)}
              disabled={disabled}
              label={`${product.name}${product.status === "active" ? "" : " (pending)"}`}
              onCheckedChange={(checked) => {
                const kept = form.productIds.filter((id) => known.has(id) && id !== product.id);
                set("productIds", checked ? [...kept, product.id] : kept);
              }}
            />
          ))}
          <p className="t-hint">With none chosen, a retro reads every active product. Each product gets its own session.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <RetroAgentRow value={form.agent} onChange={(agent) => set("agent", agent)} disabled={disabled} />
          {fieldErrors.model || fieldErrors.effort ? (
            <p className="text-xs text-danger">{[...(fieldErrors.model ?? []), ...(fieldErrors.effort ?? [])].join(" ")}</p>
          ) : null}
        </div>

        <Field
          label="Cost cap (USD)"
          hint="The retro stops before the next product when its sessions spent this much."
          className="max-w-56"
          errors={fieldErrors.costCapUsd}
        >
          {(props) => (
            <Input
              {...props}
              mono
              type="number"
              required
              min={0.01}
              max={1000}
              step={0.01}
              disabled={disabled}
              value={form.costCapUsd}
              onChange={(e) => set("costCapUsd", e.target.value)}
            />
          )}
        </Field>

        {problem ? <Alert tone="danger">{problem}</Alert> : null}
        <ErrorAlert error={save.error} />
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={!dirty} mutation={save}>
              Save retro settings
            </Button>
            <Button variant="ghost" disabled={!dirty || save.isPending} onClick={() => setForm(baseline)}>
              Discard changes
            </Button>
            <SavedNote show={save.isSuccess && !dirty} />
          </div>
        ) : (
          <p className="t-hint">A Linear workspace admin changes the retro settings.</p>
        )}
      </form>
    </Section>
  );
}

function StatusSection({ view, linearWorkspaceId, canEdit }: { view: View; linearWorkspaceId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const settingsKey = getRetroSettingsQueryKey({ query: { linearWorkspaceId } });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: settingsKey });
    void qc.invalidateQueries({ queryKey: listRetrosQueryKey({ query: { linearWorkspaceId } }) });
  };
  const run = useMutation({
    mutationFn: async () => (await runRetroNow({ body: { linearWorkspaceId }, throwOnError: true })).data,
    onSettled: refresh,
  });
  const retry = useMutation({
    mutationFn: async () => (await retryRetroSchedule({ body: { linearWorkspaceId }, throwOnError: true })).data,
    onSuccess: (next) => qc.setQueryData(settingsKey, next),
  });
  const { settings, running, last } = view;
  const schedule =
    settings.schedule === "off"
      ? "Off"
      : `${settings.schedule === "weekly" ? `Every ${WEEKDAYS[settings.weekday - 1] ?? "week"}` : "Every day"} at ${hourLabel(settings.hour)}, ${settings.timeZone}`;

  return (
    <Section title="Status">
      <div className="flex flex-col gap-4">
        {view.scheduleError ? (
          <Alert tone="danger" title={view.scheduleError}>
            <p>The settings are saved. The worker saves the schedule from them when it starts.</p>
            {canEdit ? (
              <Button size="sm" className="mt-2" mutation={retry} onClick={() => retry.mutate()}>
                Retry
              </Button>
            ) : null}
          </Alert>
        ) : null}
        <ErrorAlert error={retry.error} />
        <KeyValue
          items={[
            { label: "Schedule", value: schedule, prose: true },
            {
              label: "Next retro",
              prose: true,
              value: settings.schedule === "off" ? <span className="text-mute">No schedule</span> : formatDate(view.nextRunAt),
            },
            {
              label: "Last retro",
              prose: true,
              value: last ? (
                <span className="flex flex-wrap items-center gap-2">
                  <Link
                    to="/retro/$retroId"
                    params={{ retroId: last.id }}
                    search={{ ws: linearWorkspaceId }}
                    className="link"
                  >
                    {formatDate(last.startedAt)}
                  </Link>
                  <Badge tone={retroTone(last.status)}>{last.status}</Badge>
                  <span className="font-mono text-xs text-body">
                    {formatCost(last.costUsd)} · {last.findingCount} {last.findingCount === 1 ? "finding" : "findings"}
                  </span>
                </span>
              ) : (
                <span className="text-mute">None yet</span>
              ),
            },
          ]}
        />
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-4">
            <Button disabled={running !== null} mutation={run} onClick={() => run.mutate()}>
              {running !== null ? "A retro is running" : "Run now"}
            </Button>
            {running !== null ? (
              <Link to="/retro/$retroId" params={{ retroId: running.id }} search={{ ws: linearWorkspaceId }} className="link text-sm">
                Open the running retro
              </Link>
            ) : null}
          </div>
        ) : null}
        <ErrorAlert error={run.error} title="The retro did not start" />
      </div>
    </Section>
  );
}
