import type { Redactor } from "~/telemetry/redaction.js";
import type { Logger } from "~/telemetry/logger.js";
import type { SecretStore } from "~/domain/products/secret-store.js";

/**
 * A Project secret this short still passes the redaction floor. A common word or a short
 * number at this length is more likely to appear by accident elsewhere in a log line. The
 * threshold is a heuristic, not a hard rule, so it triggers a warning rather than a rejection.
 */
const SHORT_SECRET_WARNING_THRESHOLD = 8;

/**
 * SDD section 60. Loads every Project secret value into the redactor before any agent output is
 * captured. Phase 1 registered only the three environment secrets, which left every Project
 * secret unredacted. Returns the count of registered values and never returns a value.
 *
 * The optional logger receives a warning for a short secret. The warning goes through the
 * redacted `Logger`, not a bare console call, so it carries tenant and Project context and
 * reaches whatever sink an operator actually watches. The warning names the secret and states
 * its length only. It never carries the value.
 */
export const registerProjectSecrets = async (
  redactor: Redactor,
  secrets: SecretStore,
  tenantId: string,
  productId: string,
  logger?: Logger,
): Promise<number> => {
  const names = await secrets.listNames(tenantId, productId);
  let registered = 0;
  for (const name of names) {
    const value = await secrets.get(tenantId, productId, name);
    if (value === null || value.length === 0) continue;
    if (value.length < SHORT_SECRET_WARNING_THRESHOLD) {
      logger?.warn("Project secret is short and can produce noisy redaction", {
        tenant_id: tenantId,
        product_id: productId,
        secret_name: name,
        secret_length: value.length,
      });
    }
    redactor.addSecret(value);
    registered += 1;
  }
  return registered;
};
