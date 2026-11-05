---
name: heatset-insert
description: Use when a 3D-printed part needs a brass heat-set (threaded) insert - M2 to M6 screw bosses, board standoffs, lid or plate fasteners, sizing an insert hole or boss - or when an insert won't sit in its hole, sets crooked, or ends up with plastic in the thread. Normally called from the cad-part skill.
---

# Heat-set insert holes

Never cut a plain constant-diameter hole. Cut one stack, top to bottom, as a single revolved profile:

| Zone | Size | Job |
|---|---|---|
| Mouth | 45 degree edge break, at most 0.25 mm, smaller than the knurl | guides the pilot in; the knurl never enters cold |
| Seat | pilot slip fit as printed, insert length deep | cold, only the pilot drops in and the insert stands by itself; hot, the full knurl grips |
| Melt well | seat diameter, 20% of the insert length (at least 1 mm) below it | displaced plastic pools here, not in the thread |
| Relief (optional) | thread + 0.5 mm, 45 degree cone in | room for a screw longer than the insert |

No knurl-diameter counterbore at the top: the insert sets too deep.

## Rules

1. **Size the boss first.** Boss outer diameter at least the knurl diameter + 2 x 1.6 mm (2.4 mm walls when there is room). Boss height at least the seat depth + 1.2 mm floor, else make the hole go through.
2. **Relief depth = screw reach + 2 mm**, where reach is the screw length minus the clamped thickness. Unknown screw: ask which one.
3. **Three caliper numbers make any hole:** knurl diameter (boss and mouth cap), pilot diameter (the narrow shouldered end) and length (depths). Seat = pilot + about 0.35 mm for pilots under 5 mm, + about 0.15 mm above, because small holes print undersize. Ask for the numbers the first time an insert is used; never assume which insert family the person stocks.
4. **A seat no print has confirmed gets a coupon:** a ladder of seat diameters, smallest first, notched so each rung can be told apart, handed over with the part. Say which rung is the design value and what to test (cold: the pilot drops in and the insert stands; hot: it grips, sits flush and the screw runs clean).
5. **Record results** where the Project keeps its fits, with the date and material, so the next part reuses the confirmed seat.
6. **Report numbers** for every distinct insert hole: seat, well and relief diameters and depths, measured from the mesh.
