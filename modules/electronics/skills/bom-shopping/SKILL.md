---
name: bom-shopping
description: Turn a bill of materials (a KiCad BOM CSV, any parts CSV, a project folder or a pasted parts list) into a vendor-grouped shopping list with live prices and stock, written as SHOPPING.md and shopping.csv. Use when asked to make a shopping list, price a BOM, or work out what to buy for a board. Not for designing the board.
---

# BOM to shopping list

## Inputs
- **The BOM:** a KiCad BOM export (Reference, Value, Footprint, Quantity), any CSV with part and
  quantity columns, a pasted list, or the project folder (look for `*bom*.csv`, the `.kicad_sch`,
  and notes in the README that say what a part is). `kicad-cli sch export bom` makes one from the
  schematic.
- **Notes from the person:** parts they already own, parts left off (DNP), decisions made.
- **Vendors:** use the ones the person names. Otherwise: bare components from a distributor by
  manufacturer part number, hobby modules from their maker, hardware (screws, inserts) from a
  hardware supplier, and the PCB from a board house.

## Steps
1. **Work out what every line is** from its value, footprint, reference and the notes. Collapse
   lines that are one purchase (two sockets for one module are one module plus headers).
2. **Drop what isn't bought:** owned, DNP, test points, mounting holes, net ties, logos. List
   owned and dropped lines in their own sections, so nothing silently vanishes.
3. **Pick a buyable part for each line:** a manufacturer part number or vendor SKU, never just
   "10k". Passives get a value, package and sane rating. Keep any part the notes mark critical
   exactly as it is and say why. If you can't tell what a part is, don't invent a part number:
   put it under **Unresolved** and ask.
4. **Check price and stock live** on the vendor's page and write the date you checked. Never use
   a remembered price: one you couldn't check is written `?`. Out of stock: say so and give the
   in-stock alternative.
5. **Quantities:** "needed" is what the board takes; "to buy" adds spares for cheap small parts
   (about double, or the next price break) and stays exact for modules and expensive parts.
6. **Write the files** in the project folder. Copy an existing `SHOPPING.md` to
   `SHOPPING.prev.md` before replacing it.
   - `SHOPPING.md`: the date, the BOM it came from and the decisions at the top; then one section
     per vendor with a table `Qty | Part # | Part | Each | Line | Board ref | Notes` and a
     subtotal; then **Off-board** (PCB fab, wire, enclosure, supply), **Already owned**,
     **Unresolved**; the grand total of the priced lines last.
   - `shopping.csv`, one row per line to buy:
     `vendor,qty_needed,qty_to_buy,part_number,manufacturer,description,refs,unit_price,line_total,stock,url,checked,notes`
     (the shape distributor BOM upload tools take).
7. **Report** the vendors, subtotals, grand total, anything out of stock, the critical parts and
   the unresolved lines.

## Never
- Order, add to a cart, log in, or enter payment or address details. Buying is the person's move.
- Swap a part the notes mark critical, or change the design to fit a part.
- Copy secrets (tokens, credentials) out of the project folder.
