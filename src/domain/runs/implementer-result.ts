import { z } from "zod";
import type { MissingHost } from "./egress.js";

// The schema is not strict. A field the implementer adds must not hide a host it named, because a
// named host can only stop a Run.
const resultSchema = z.object({
  missingHosts: z.array(z.object({ host: z.string().min(1), reason: z.string().default("") })).max(20).default([]),
  // docs/specs/change-sets.md, DI-21.142. The repositories outside the set the change needs.
  missingRepositories: z.array(z.object({ repository: z.string().min(1), reason: z.string().default("") })).max(20).default([]),
});

/** docs/specs/change-sets.md, DI-21.142. One repository outside the set that the implementer needs. */
export interface MissingRepository {
  repository: string;
  reason: string;
}

/**
 * docs/specs/egress-honesty-and-issue-status.md, DI-21.47. The hosts of the implementer result
 * file, or null when the text is not a valid result.
 */
export const parseImplementerResult = (text: string): MissingHost[] | null => parseResult(text)?.missingHosts ?? null;

/** DI-21.142. The repositories of the implementer result file, or null when the text is not a valid result. */
export const parseImplementerRepositories = (text: string): MissingRepository[] | null => parseResult(text)?.missingRepositories ?? null;

const parseResult = (text: string): z.infer<typeof resultSchema> | null => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = resultSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
};
