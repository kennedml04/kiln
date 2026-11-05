---
name: cad-part
description: Use when designing, modifying, measuring or reverse-engineering a 3D-printable part or mesh (STL, 3MF, STEP) - brackets, clamps, cases, jigs, bins, test coupons - or when a printed part doesn't fit.
---

# CAD part

Ask first, one question at a time, in plain words:
- What job does the part do in the real world?
- Which way is it installed? Repeat the answer back as named sides (top/bottom, wall side/room side) and use those names from then on.
- Any dimension you only found online: ask for a caliper measurement instead.

Then:
1. **Look for prior work.** Reuse a part or mechanism the Project already has in `cad/` before drawing a new one.
2. **One script per part** in `cad/` (OpenSCAD, CadQuery or build123d), every size in mm as a named parameter at the top. Exports go to `out/`, which git ignores.
3. **Never guess a fit.** Holes, bores, pockets, press and slide fits print smaller than drawn. Use a clearance the person has confirmed on their printer; with none, make a coupon first (step 6).
4. **Heat-set inserts:** use the `heatset-insert` skill. Never a plain cylinder.
5. **Design for the bed.** Decide how the part sits on the plate, and export each STL in that pose (min corner at the origin):
   - biggest flat face down, with a 0.5-1 mm 45 degree chamfer on the bed edge (not a fillet);
   - overhangs no steeper than 45 degrees from vertical; flat ceilings only as bridges of 10 mm or less;
   - sideways holes over about 8 mm get a teardrop or flat top;
   - layer lines run along the load; when strength and no-supports conflict, strength wins: say where the supports go;
   - split a part rather than support it heavily.
6. **Coupons for new fits:** a small ladder of test tabs in 0.05-0.1 mm steps around the design value, notched so each rung can be told apart.
7. **Check the export, not the model in memory.** Reload every exported STL and check it is watertight, has no zero-area faces and has the body count you expect. Common causes of a broken mesh: two coaxial faceted cuts (cut the hole as one revolved profile), a feature that only touches its parent (sink it 0.5 mm in), a cutter that ends exactly on a face (run it 2 mm past). The Project's Exit check fails any STL in the diff that is not watertight.
8. **Report numbers:** the exported paths, overall size and volume, and every fit value used. Show the part with the `visualize` skill.

Never slice, scale an STL to resize it, or describe geometry you did not measure from the mesh.
