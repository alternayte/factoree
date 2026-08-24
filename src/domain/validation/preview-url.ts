/**
 * SDD section 37 and section 38. Every Validation Plan path resolves against the exposed preview
 * base URL. A fresh agent session authors that plan, so a path is untrusted text. A
 * protocol-relative path such as `//example.com` passes a naive `startsWith("/")` guard, and
 * `new URL` then replaces the origin of the base URL. An assertion against a foreign host can
 * report PASS while the implementation under test never ran. Two controls stop that. The plan
 * parser rejects such a path, and this module checks the resolved origin again at the moment of
 * use. The second control does not trust the first one.
 */

export class PreviewUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewUrlError";
  }
}

/** An ASCII tab, a line feed, or a carriage return, found anywhere in the path. */
const STRIPPED_BY_URL_PARSER = /[\t\n\r]/;

/**
 * True when the path is a single-slash relative path. A bare `/` is legal. A second `/` or a
 * second `\` is not, because the WHATWG URL parser treats both as the start of an authority for
 * an HTTP base URL.
 *
 * The WHATWG URL parser also removes every ASCII tab, line feed, and carriage return from the
 * input before it parses the input. A path such as `"/\t/example.com"` holds neither a second
 * slash nor a second backslash at position 1, so it would pass the checks above. The parser
 * then reads it as `"//example.com"` and resolves it against a foreign origin. This predicate
 * must agree with the parser, so it rejects a path that carries any of those three characters,
 * at any position, not only at position 1.
 */
export const isPreviewRelativePath = (path: string): boolean => {
  if (!path.startsWith("/")) return false;
  if (STRIPPED_BY_URL_PARSER.test(path)) return false;
  if (path.length === 1) return true;
  const second = path[1];
  return second !== "/" && second !== "\\";
};

/**
 * Resolves one plan path against the preview base URL. It throws when the path is not a
 * single-slash relative path, and it throws again when the resolved origin differs from the
 * origin of the base URL.
 */
export const resolvePreviewUrl = (baseUrl: string, path: string): string => {
  if (!isPreviewRelativePath(path)) {
    throw new PreviewUrlError(
      `The path "${path}" is not a relative preview path. A path must begin with a single ` +
        "slash, and the character after that slash must be neither a slash nor a backslash.",
    );
  }

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new PreviewUrlError(`The preview base URL "${baseUrl}" is not a valid URL.`);
  }

  let resolved: URL;
  try {
    resolved = new URL(path, base);
  } catch {
    throw new PreviewUrlError(`The path "${path}" does not resolve against the preview base URL.`);
  }

  if (resolved.origin !== base.origin) {
    throw new PreviewUrlError(
      `The path "${path}" resolves to the origin "${resolved.origin}", which is not the ` +
        `preview origin "${base.origin}". Factoree refuses to drive an assertion at another host.`,
    );
  }

  return resolved.toString();
};
