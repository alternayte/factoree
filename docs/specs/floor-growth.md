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
- Every repository has a silo — a product has up to about 200 repositories, and the floor shows them all, best effort. Up to 8 stand in one row behind the dock, each named, with labels that alternate below and above. More fill a field across the back of the line, behind its buildings, at the largest scale (0.8 down to 0.4) that keeps the field at most 6 rows deep. A line with a field stands further from the line above it. In a field only the silos of busy repositories show their name; the silo under the pointer shows its name too. A long name is cut with an ellipsis, and a click opens the line panel with every repository.
- A silo cap lights while a run of that repository is on the line and not ended — the busy repositories stand out at any count.
- The floor API returns `mergedTotal` per line: the merged pull requests of the product over its life, up to the window end — replay shows the factory as it was.
- The buildings unlock at 5 (storage racks), 25 (tank farm), 100 (warehouse) and 250 (truck bay) merged pull requests — a new product starts small and grows from its own results.
- The props come from a random seed of the product id — a line looks the same on every load.
- The props and the buildings are drawn in code in the theme greys — the Kenney archives are not in the repository.
- A warm key light casts soft shadows, the bodies are solid and lighter, and each station carries one muted colour in place of the warm parts of its model — the owner chose a hybrid of Lit factory and Night shift; the floor reads as a game and not as a blueprint.
- Cyan, yellow, red and green appear only on state: crate bands, machine strips, crew at work, silo caps and badges — decoration uses graphite and warm neutrals.
- A crate stands on the belt in front of its machine as the camera shows it: the machine stands behind the belt, so the crate stops 1.33 units further along the belt — on screen it sits under the machine, as the concept places it. One crate stands at the centre, two side by side, then a second level.
- The stations follow the workflow order: intake, prep, refinery, workshop, test bench, user lab, inspection, shipping dock, PR yard, deploy gate. The ticket read (the first REFINING) and the first context resolution happen before the work sprite exists, so they are intake work. The refiner runs in the work sprite, after prep. A later PREPARING (the sprite of a change set, a fresh sandbox after an unreachable provider) keeps the crate where it is — a crate never walks back except on the repair belt.
- A crate walks from where it is drawn, without its lift and bounce, and the oldest run takes the first slot of a place — a crate never jumps when its step changes or another crate arrives.
- The PR yard is a pad in front of the belt past the dock. It shows 36 crates, four rows of three stacked up to three high, and counts the rest as "+N". Its crate bands glow at half strength — a full yard does not outshine the line. The yard is a raised concrete slab lighter than the floor, with a painted border, a bay line between crate rows and a bollard at each corner — a few crates read as standing in a yard and not loose beside the belt.
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
- A product with 200 repositories shows 200 silos in a field behind its line; the silos of busy repositories glow and show their names, and the pointer names any other silo.
- Three runs at once stand side by side at a shared station and never jump; replay shows each crate pass intake, prep, refinery and workshop in that order.
- 40 runs with open pull requests fill the yard with 36 crates and a "+4" count.
- At 390 × 844 the line reads, and the sign and labels do not overlap the HUD.
