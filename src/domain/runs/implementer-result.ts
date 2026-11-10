import { z } from "zod";
import type { MissingHost } from "./egress.js";

// The schema is not strict. A field the implementer adds must not hide a host it named, because a
// named host can only stop a Run.
const resultSchema = z.object({
  missingHosts: z.array(z.object({ host: z.string().min(1), reason: z.string().default("") })).max(20),
});

/**
 * docs/specs/egress-honesty-and-issue-status.md, DI-21.47. The hosts of the implementer result
 * file, or null when the text is not a valid result.
 */
export const parseImplementerResult = (text: string): MissingHost[] | null => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = resultSchema.safeParse(json);
  return parsed.success ? parsed.data.missingHosts : null;
};
