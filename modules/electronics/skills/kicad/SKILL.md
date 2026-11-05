---
name: kicad
description: Check and export a KiCad project from the command line with kicad-cli (DRC, ERC, BOM, gerbers). Use when working on a board in a KiCad project, before saying a board change is done, or when a "DRC passes" check fails.
---

# KiCad from the command line

`kicad-cli` comes with KiCad. It is on PATH, or at the path the person set in Kiln's
Settings > Tool paths. Put every generated file under `out/`, which git ignores.

- **DRC** (what Kiln's "DRC passes" check runs):
  `kicad-cli pcb drc --format json --severity-all --output out/drc.json pcb/<board>.kicad_pcb`.
  Errors fail the check, warnings don't. Fix the cause in the board; never loosen the rules to pass.
- **ERC:** `kicad-cli sch erc --format json --output out/erc.json pcb/<board>.kicad_sch`.
- **BOM:** `kicad-cli sch export bom --output out/bom.csv pcb/<board>.kicad_sch`, then the
  bom-shopping skill turns it into a shopping list.
- **Gerbers and drill files:** `kicad-cli pcb export gerbers --output out/gerbers/ pcb/<board>.kicad_pcb`
  and `kicad-cli pcb export drill --output out/gerbers/ pcb/<board>.kicad_pcb`.

`kicad-cli <command> --help` lists the options of the installed version. Ordering the board or its
parts is the person's move, in the "Order parts" Stage.
