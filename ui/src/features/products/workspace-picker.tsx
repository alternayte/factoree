import { useNavigate } from "@tanstack/react-router";
import { Field, Select } from "@/components/form";
import type { Membership } from "@/lib/session";

/** WorkspacePicker switches the Linear workspace that the product pages show. */
export function WorkspacePicker({ memberships, current }: { memberships: Membership[]; current: Membership }) {
  const navigate = useNavigate();
  if (memberships.length < 2) {
    return (
      <p className="flex items-baseline gap-2">
        <span className="t-label text-mute">Workspace</span>
        <span className="text-sm text-ink">{current.workspaceName}</span>
      </p>
    );
  }
  return (
    <Field label="Linear workspace" className="w-64">
      {(props) => (
        <Select
          {...props}
          value={current.linearWorkspaceId}
          onChange={(e) => void navigate({ to: "/products", search: { ws: e.target.value } })}
        >
          {memberships.map((m) => (
            <option key={m.linearWorkspaceId} value={m.linearWorkspaceId}>
              {m.workspaceName}
              {m.admin ? " (admin)" : ""}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
