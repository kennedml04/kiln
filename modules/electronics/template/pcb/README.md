# pcb

The KiCad project: the `.kicad_pro`, its schematic (`.kicad_sch`) and its board (`.kicad_pcb`).

Generated files (DRC and ERC reports, BOM exports, gerbers) go in `out/` at the top of the
Project, which git ignores. Kiln's "DRC passes" check runs `kicad-cli pcb drc` on every board.
