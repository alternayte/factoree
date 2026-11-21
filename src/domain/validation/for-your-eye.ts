import type { BrowserRunResult } from "~/domain/validation/browser-driver.js";
import type { EvidenceArtifact } from "~/domain/validation/validation-result.js";

/**
 * docs/specs/by-eye-criteria-and-selector-recheck.md. A criterion a person judges by eye. The gate
 * never freezes it, so it is never an automated pass or fail. Factoree captures one screenshot of
 * its route per attempt, and the Proof Pack shows it under "Needs your eye".
 */
export interface ForYourEyeCriterion {
  /** The gate identifier of the criterion, `AC-R<n>`, as a frozen criterion would carry. */
  id: string;
  statement: string;
  /** The page route, a relative preview path. */
  route: string;
}

/**
 * The capture of one for-your-eye route in one attempt. A failed capture is a line for the human,
 * never a run failure: the screenshot is a help, not evidence.
 */
export type ForYourEyeCapture = ForYourEyeCriterion & {
  /** What the browser saw that explains a wrong page: a blank page, console errors, failed requests. */
  notes: string[];
} & ({ captured: true; artifact: EvidenceArtifact } | { captured: false; reason: string });

const MAX_CONSOLE_NOTES = 3;
const MAX_REQUEST_NOTES = 5;
const MAX_NOTE_LENGTH = 200;

const shortened = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_NOTE_LENGTH ? flat : `${flat.slice(0, MAX_NOTE_LENGTH - 1)}…`;
};

/** The path of a URL on the preview, or the whole URL of another host. */
const shownUrl = (url: string, baseUrl: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(baseUrl).origin ? `${parsed.pathname}${parsed.search}` : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
};

/**
 * The notes of one capture, so a person who sees a white screenshot also sees why: the page is
 * blank, the first console errors, and the first requests that failed or got a status of 400 or
 * more. A single-page app shows a white page when its API, its config or its sign-in cookie fails.
 */
export const captureNotesOf = (run: Pick<BrowserRunResult, "consoleLines" | "network" | "blankPage">, baseUrl: string): string[] => {
  const notes: string[] = [];
  if (run.blankPage === true) notes.push("the page shows no text and no image");
  const errors = [...new Set(run.consoleLines.filter((entry) => entry.startsWith("error: ")).map((entry) => shortened(entry)))];
  for (const entry of errors.slice(0, MAX_CONSOLE_NOTES)) notes.push(`console ${entry}`);
  if (errors.length > MAX_CONSOLE_NOTES) notes.push(`${String(errors.length - MAX_CONSOLE_NOTES)} more console errors`);
  const failed = [
    ...new Set(
      run.network
        .filter((entry) => entry.status === null || entry.status >= 400)
        .map((entry) => `${entry.method} ${shortened(shownUrl(entry.url, baseUrl))} ${entry.status === null ? "failed" : String(entry.status)}`),
    ),
  ];
  for (const entry of failed.slice(0, MAX_REQUEST_NOTES)) notes.push(entry);
  if (failed.length > MAX_REQUEST_NOTES) notes.push(`${String(failed.length - MAX_REQUEST_NOTES)} more failed requests`);
  return notes;
};

/** The evidence source of the screenshot of one for-your-eye criterion. */
export const forYourEyeSource = (id: string): string => `for-your-eye:${id}:screenshot`;
