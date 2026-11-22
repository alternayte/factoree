# Floor full screen, look and collapsible sidebar

Amends `docs/specs/factory-floor.md` (the Floor page) and `docs/specs/run-visibility.md` (the app shell).

## What it does
The factory floor fills the main area of the page, and a button puts it in full screen for a demo or a wall screen. On every page, the sidebar collapses to a rail of icons and expands again, and the browser remembers the choice.

## Decisions
- The floor has a full screen button in its player bar. It calls `requestFullscreen` on the floor stage, and Esc or the same button leaves — one click turns the floor into a wall screen.
- A browser with no full screen API for the stage, such as iPhone Safari, gets the stage fixed over the whole window instead, and Esc or the button leaves — the button works on every browser.
- The Floor page has no 1440 px cap and no page header. Its title stays as the accessible name of the stage, and the stage takes the height of the window less the main padding — the floor is the page.
- The floor fits its lines to the stage again when the stage changes size, until the viewer pans or zooms — full screen shows the whole factory at once.
- From the `sm` breakpoint, a button at the foot of the sidebar collapses it to a 56 px rail. The rail shows the brand mark, the navigation icons with their names as tooltips and accessible names, and the account initials — every page gets the width.
- The choice is kept in `localStorage` under `factoree.sidebar`, and a missing or blocked store means expanded — the choice survives a reload without a server setting.
- Below `sm`, the navigation stays the horizontal row it is today — a phone has no sidebar to collapse.
- The Kenney models keep their own colour map, turned to the theme grey, and the warm accent parts of the map turn to a dim cyan. No hairline outlines — the models keep their detail and read as solid machines, as the concept page did.
- A machine where a session or a check runs breathes its glow and lets off cyan steam. Nothing moves on an idle machine — motion is still a fact.
- The stations stand 5.4 units apart and the camera looks down at about 55 degrees — the lines fill the stage instead of a third of it.
- Crates are larger and light grey with a band in their state colour — a crate reads at the default zoom.
- Crates in the same step stand side by side on the belt, then stack one level up. A machine shows four, the intake and the yard twelve, the bin six, and a "+N" count names the rest — several runs in one step stay apart and countable.
- A live floor with nothing running shows "Quiet now · Replay the last 7 days" — an idle install still shows its factory.
- A GitHub token mint that answers 422 quotes GitHub's message and names the repositories it asked for — GitHub answers 422 for a repository outside the installation as well as for a missing permission (FAC-103).

## Out
- A keyboard shortcut for full screen or for the sidebar.
- A server-side setting for the sidebar.
- Full screen for any page other than the floor.

## How I know it works
- On the floor, the full screen button fills the screen with the floor, the lines fit the screen, and Esc returns to the page.
- At 390 px width, the button fixes the floor over the window, and the button returns to the page.
- On a 1440 px window the floor stage reaches the right edge of the main area and the foot of the window, with no page header above it.
- The sidebar button collapses the sidebar to icons on the Runs page and on the floor, the floor refits, and after a reload the sidebar stays collapsed.
- Each rail icon names its page as a tooltip, and a screen reader reads the page name.
- Seven runs on one line, five implementing and two verifying, show four crates and "+2" at the Workshop and two crates apart at the Test bench.
- A working machine shows steam, and an idle machine shows none.
- With no running crate, the live floor offers the 7-day replay.
- A token mint for a repository outside the installation fails with GitHub's message and the repository names in the Linear notice.
- `just verify` passes.
