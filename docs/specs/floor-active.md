# Floor active stations

Amends docs/specs/floor-growth.md.

## What it does
A station that works stands out on the floor. It glows in its own colour, shakes a little and runs moving parts drawn in code. An idle station stays graphite and still. The cyan glow strip sits flush on the front face of each machine. The repair belt joins the main belt at each check station and at the workshop, and lights while a crate rides it.

## Decisions
- The Kenney models are single meshes with no animation clips, so the moving parts are drawn in code — the kit has no parts to animate.
- Each working station glows in its own colour: refinery violet, prep teal, workshop orange, test bench mint, user lab blue, inspection pink, dock lime — never the state colours cyan, yellow, red or green, which keep their meaning.
- The parts: a pipe ring that pulses at the refinery, a piston at prep, a turning flywheel at the workshop, a scanner beam that sweeps over the crate on the belt at the test bench, a blinking lamp at the user lab, a turning beacon at inspection and a blinking lamp at the dock.
- A station works only from real state: a crate in its running step, or a waiting crate there. Reduced motion keeps the colour and stops the motion.
- Each machine has its own materials, so one station glows without lighting the same model elsewhere.
- The glow strip is measured from the model as drawn: flush on its front face at the middle of its height, 84% of its width. A lit strip is brighter, so bloom carries it.
- The repair belt runs from the workshop to inspection at the crate stop points. A transfer plate joins it to the main belt at the workshop, test bench, user lab and inspection. While a crate rides it, the belt and the plates glow red — a repair reads as sent back.
- The repair belt stays thinner than the main belt — it is the side loop.
- The reject bin shows 6 crates and counts the rest. A failed crate leaves the floor 24 hours after its run ended — the bin shows the last day of failures, not a backlog.

## Out
- New models or animation clips in the kit.
- Sound.

## How I know it works
- With a run at every station, each working station glows in its own colour and its part moves; idle stations stay graphite.
- The cyan strip of each machine touches its front face.
- In replay at the moment a check fails into a repair, the repair belt and its plates glow red while the crate rides back to the workshop.
- With reduced motion on, the stations keep their colour and nothing moves.
