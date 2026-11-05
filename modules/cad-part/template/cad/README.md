# cad

The part's source: one script per part (OpenSCAD `.scad`, or a Python CadQuery / build123d script),
with every size in mm as a named parameter at the top.

Exports go to `out/`, which git ignores. Commit an STL here only when it is the part as printed: the
CAD part module's Exit check fails any STL in a Ticket's diff that is not watertight.
