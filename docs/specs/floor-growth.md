# Floor crew and growth

Amends docs/specs/factory-floor.md and docs/specs/floor-full-screen.md.

## What it does
The floor shows each line at the angle and scale of the concept, lit as the Lit factory concept with the Night shift state colours. Each station has its crew. A crew member stands dim and still while the station is idle. It lights and works while a session or a check runs there. Props stand around each line: lamps, pallets, barrels, walkways and one silo per repository. The line grows with use: new buildings appear at 5, 25, 100 and 250 merged pull requests of the product. The line sign shows the merged total and the next building.

## Decisions
- The camera looks from (22, 40, 48) relative to its target, as the concept does — the line runs on the diagonal and uses the width and the height of the stage.
- The default view fits every line with its silos, buildings and front yard. The product sign is a compact plate in the front yard left of the intake, anchored by its left edge and kept inside the stage. It counts the repositories, cuts a long product name with an ellipsis, and shows the whole name on hover and in the line panel on click — a product name of any length never runs off the stage.
- The machines are larger and closer to the concept boxes — the line reads at a glance on a wall screen.
- Each station has one crew member. The refinery, workshop, user lab and inspection crew are the refiner, implementer, validator and reviewer. The prep, test bench and dock crew are Factoree bots — every station has a person or a bot, as a builder game has.
- A crew member works only while its station is lit by real state: a session pulse or a crate in a running step. Only a session pulse shows a tool pill — the floor never shows work that does not happen.
- A second session at the same station adds a second figure next to the crew member — several runs in one step stay countable.
- A silo per repository stands behind the dock, up to 6 in a row, with the short repository name. Labels alternate below and above the silos, a long name is cut with an ellipsis and shown whole on hover, and more repositories show as a "+N repositories" sign that opens the line panel. Its cap lights while a run of that repository is on the line — the structure of the product is visible at any repository count, and the back left of a line stays clear for the sign of the line above.
- The floor API returns `mergedTotal` per line: the merged pull requests of the product over its life, up to the window end — replay shows the factory as it was.
- The buildings unlock at 5 (storage racks), 25 (tank farm), 100 (warehouse) and 250 (truck bay) merged pull requests — a new product starts small and grows from its own results.
- The props come from a random seed of the product id — a line looks the same on every load.
- The props and the buildings are drawn in code in the theme greys — the Kenney archives are not in the repository.
- A warm key light casts soft shadows, the bodies are solid and lighter, and each station carries one muted colour in place of the warm parts of its model — the owner chose a hybrid of Lit factory and Night shift; the floor reads as a game and not as a blueprint.
- Cyan, yellow, red and green appear only on state: crate bands, machine strips, crew at work, silo caps and badges — decoration uses graphite and warm neutrals.
- A crate stands on the belt in line with its machine: one at the centre, two side by side, then a second level — as the concept places it.
- A setup run shows a solid half-built building with a yellow work light — no wireframe.
- Decoration moves only in place: lamps breathe, fans turn, the stack smokes — moving things on the floor mean work.

## Out
- Buildings or props that a viewer places or buys.
- Growth from cost, speed or any metric other than merged pull requests.
- New Kenney models.

## How I know it works
- At 1440 × 900 the deployed floor shows the line on the diagonal, with the sign above the intake and no text cut off.
- With no run on the floor, every station shows a dim crew member and no tool pill.
- During a run, the crew member at its station lights and moves, and an agent station shows the tool pill of its session.
- `GET /admin/floor` returns `mergedTotal` on each line. The integration test pins the lifetime count and the replay cut-off.
- A product with 25 merged pull requests shows the storage racks and the tank farm, and its sign names the warehouse at 100.
- At 390 × 844 the line reads, and the sign and labels do not overlap the HUD.
