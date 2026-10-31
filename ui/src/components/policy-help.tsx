import { HelpList, HelpPopover } from "@/components/help";
import {
  ALLOWED_DOMAINS_HELP,
  AUTONOMY_HELP,
  AUTONOMY_NOTES,
  autonomyOptionLabel,
  RISK_CAPS_HELP,
} from "@/lib/policy-help";
import { AUTONOMY_LEVELS } from "@/lib/workspace";

/** The options of an autonomy dropdown. Each option shows its one-line description. */
export function AutonomyOptions() {
  return (
    <>
      {AUTONOMY_LEVELS.map((level) => (
        <option key={level} value={level}>
          {autonomyOptionLabel(level)}
        </option>
      ))}
    </>
  );
}

export function AutonomyHelp() {
  return (
    <HelpPopover label="About autonomy levels" title="Autonomy levels">
      <dl className="flex flex-col gap-2">
        {AUTONOMY_HELP.map((help) => (
          <div key={help.level} className="grid grid-cols-[2rem_1fr] gap-x-2">
            <dt className="t-value pt-px text-ink">{help.level}</dt>
            <dd className="leading-snug">
              <span className="font-medium text-ink">{help.name}.</span> {help.detail}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 border-t border-hairline pt-3 text-mute">
        <HelpList items={AUTONOMY_NOTES} />
      </div>
    </HelpPopover>
  );
}

export function RiskCapsHelp() {
  return (
    <HelpPopover label="About risk caps" title="Risk caps">
      <HelpList items={RISK_CAPS_HELP} />
    </HelpPopover>
  );
}

export function AllowedDomainsHelp() {
  return (
    <HelpPopover label="About allowed domains" title="Allowed domains">
      <HelpList items={ALLOWED_DOMAINS_HELP} />
    </HelpPopover>
  );
}
