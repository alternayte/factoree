---
name: factoree-ui
description: Dark-only operator UI. Near-black surfaces, one electric cyan accent with a controlled glow, Geist Sans for reading and Geist Mono for identity, and quick, quiet motion.

colors:
  canvas: "#0b0d0e"
  sidebar: "#090b0c"
  panel: "#0f1315"
  raised: "#131a1d"
  hairline: "#1a2427"
  hairline-strong: "#24343a"
  ink: "#e8fbfe"
  body: "#b9cdd2"
  mute: "#6f878d"
  accent: "#00e5ff"
  accent-ink: "#00191d"
  accent-soft: "rgba(0,229,255,0.10)"
  accent-text: "#5ff0ff"
  success: "#3dffa8"
  success-soft: "rgba(61,255,168,0.10)"
  warning: "#ffd84d"
  warning-soft: "rgba(255,216,77,0.10)"
  danger: "#ff5d73"
  danger-soft: "rgba(255,93,115,0.10)"

effects:
  glow: "0 0 0 1px rgba(0,229,255,0.55), 0 0 22px rgba(0,229,255,0.35)"
  glow-focus: "0 0 0 1px #00e5ff, 0 0 16px rgba(0,229,255,0.45)"

typography:
  sans: "Geist, system-ui, sans-serif"
  mono: "Geist Mono, ui-monospace, monospace"
  title: { font: mono, size: 22px, weight: 600, tracking: -0.01em }
  section: { font: mono, size: 14px, weight: 500 }
  body: { font: sans, size: 14px, weight: 400, line-height: 1.5 }
  hint: { font: sans, size: 12px, color: mute }
  label: { font: mono, size: 12px, weight: 500, case: uppercase, tracking: 0.03em }
  badge: { font: mono, size: 11px, weight: 500 }
  value: { font: mono, size: 12.5px }

shape:
  radius: 4px
  radius-control: 2px
  radius-pill: 999px

motion:
  fast: 120ms
  base: 180ms
  slow: 260ms
  ease-out: "cubic-bezier(0.16, 1, 0.3, 1)"
  ease-in-out: "cubic-bezier(0.65, 0, 0.35, 1)"
---

# Factoree UI

The look of the preview "B": an electric cyan on near-black, for a premium developer tool. Dark mode only. `color-scheme: dark`.

## Rules for the accent
- Cyan marks four things only: the primary action, the focused control, the current step, and a running state.
- One primary action per view. Other buttons are `raised` with a `hairline-strong` border, or ghost.
- Glow (`effects.glow`) appears only on the primary action, the current step marker and the brand mark. Focus uses `effects.glow-focus`. Nothing else glows.
- Cyan is never body text. Links and code use `accent-text`.
- Status colours: success for ready, accent for running, warning for queued, danger for failed or hung. Each status is a pill badge with a dot, on its `-soft` background.

## Type
- Geist Sans for every sentence: body, hints, field values that are prose, and errors.
- Geist Mono for identity: titles, section headings, labels, table headers, badges, ids, SHAs, hashes, keys and URLs.
- Upper case only for labels and table headers. Never for a sentence.
- Fonts come from `@fontsource/geist-sans` and `@fontsource/geist-mono`, bundled. The page loads nothing from another origin.

## Layout
- A 200px sidebar with the brand and the navigation on wide screens. Below 640px, the navigation becomes a horizontal scroll row under the brand.
- Content padding is 28px 32px on wide screens and 20px on narrow screens. A form is at most 640px wide.
- A card is a `panel` with a `hairline` border and `radius`. A card header has a `hairline` bottom border.
- Tables scroll horizontally inside their card. The page never scrolls horizontally.

## Motion
- Hover and press: background and border colour change in `fast` with `ease-out`. Press scales a button to 0.98.
- Focus: the glow fades in over `fast`.
- Route change: the View Transitions API cross-fades the main area in `base`. The sidebar does not move.
- Lists and cards enter with a 4px rise and a fade in `base`, staggered 30ms, at most 6 items.
- A button that starts a request shows a spinner in place of its label and keeps its width. It stays disabled until the request settles, then shows a check for 900ms on success.
- A save confirms in place, next to its button, never with a toast for a form on the same screen.
- Loading data shows skeleton rows in the shape of the content, with a slow shimmer. A spinner on its own appears only inside a button.
- The current setup step marker pulses its glow once on arrival.
- `prefers-reduced-motion: reduce` removes movement, scale and shimmer. Colour changes stay.

## Content Security Policy
- The server sends `default-src 'self'`. UI code never injects `<style>` or `<script>` elements, and never renders inline `style` attributes from HTML.
- Motion uses CSS classes and transitions, the View Transitions API, or the Web Animations API (`element.animate`). These are all allowed under the policy.

## Do not
- Do not add a light mode.
- Do not add a second accent colour or a gradient.
- Do not glow a card, a table row, a badge or text.
- Do not animate layout properties such as width, height or top. Animate `opacity` and `transform`.
- Do not copy the look of Linear: no lavender, no Linear marks.
