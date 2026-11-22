# Floor replay controls

Amends docs/specs/factory-floor.md and docs/specs/floor-full-screen.md.

## What it does
Replay shows the work of a window, not its quiet time. It plays at its speed while a run is on the line and jumps over the time between runs. The timeline carries one mark per work item, and the bar has previous and next buttons, so a viewer goes straight to a work item. Full screen stays on while the viewer switches between live and replay or between the day and the week.

## Decisions
- The stage stays mounted while the other mode or window loads, and the floor shows the last answer until the next one arrives — full screen and the camera survive every switch.
- A new mode, window or run starts the clock again at the window start, or 20 seconds before the run in focus.
- The default replay speed is 10× — a five-minute run plays in thirty seconds, slow enough to see each step. 1×, 60× and 120× stay.
- While no run is on the line, replay jumps to 20 seconds before the next change — a day or a week of mostly quiet time shows its work at once.
- The timeline has one mark per work item at its first status, coloured by its end: cyan for a delivered run, yellow for a run that waits for a human or still runs, red for a failed one. Hover names the work item and its time. A click plays it from 20 seconds before its first status and selects it.
- Previous and next buttons jump to the work item before or after the clock. Previous skips the work item that started in the last three seconds on screen, as a media player does.
- The PR yard fills its middle rows first — a few crates stand in the yard and not against the belt.

## Out
- Keyboard shortcuts for previous and next.
- A zoomable timeline.

## How I know it works
- In full screen, Replay, 7d, 24h and Live switch the floor and keep full screen.
- Replay of the last day starts at the first run of the window, not at its start.
- A click on a timeline mark plays that work item at 10×, and its crate passes every station of its run.
- Next and previous step through the work items in time order.
- 1×, 60× and 120× move the clock 1, 60 and 120 seconds per second.
- Three crates in the PR yard stand in its middle row.
