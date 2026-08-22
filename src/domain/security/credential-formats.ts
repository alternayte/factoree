/**
 * The one list of provider credential value formats.
 *
 * A key name cannot reveal a credential reliably. A value can. A value that starts with `ghp_`
 * is a GitHub token whatever the key is called. This module holds the formats, and both the
 * Implementer input control and the telemetry redactor read them from here. Two separate lists
 * would drift apart, and the weaker one would then decide what leaks.
 *
 * The list lives in `src/domain` because the domain is the innermost layer. A domain module must
 * not import from a provider adapter, so a shared definition must sit at or below the domain.
 *
 * Every pattern is non-global on purpose. A global regular expression keeps `lastIndex` between
 * calls, which makes `test` return a different answer on the same input. A caller that needs a
 * global copy must build one with `globalCredentialValuePatterns`.
 */
export const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  // GitHub personal, OAuth, user-to-server, server-to-server, and refresh tokens.
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  // GitHub fine-grained personal access tokens.
  /github_pat_[A-Za-z0-9_]{20,}/,
  // Anthropic API keys.
  /sk-ant-[A-Za-z0-9-]{20,}/,
  // OpenAI-style API keys. The word boundary stops a match inside an ordinary word such as
  // `risk-` or `disk-` that a long alphanumeric run follows.
  /\bsk-[A-Za-z0-9]{20,}/,
  // Linear API keys and OAuth tokens.
  /lin_(?:api|oauth)_[A-Za-z0-9]{20,}/,
];

/** Builds a global copy of every credential pattern, for a caller that replaces every match. */
export const globalCredentialValuePatterns = (): RegExp[] =>
  CREDENTIAL_VALUE_PATTERNS.map((pattern) => new RegExp(pattern.source, "g"));

/** Reports whether a value holds a string in a known provider credential format. */
export const looksLikeCredentialValue = (value: string): boolean =>
  CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value));
