# Mesh prep in Blender (free, blender.org), run headless:
#
#   blender -b -P tools/mesh-prep/mesh_prep.py -- --input ~/Scan/out/body.obj \
#       --output ~/Scan/body.glb --height-cm 193 --target-tris 150000
#
# What it does, in order: imports OBJ or USDZ, merges the pieces into one
# mesh, deletes loose fragments (floor bits, noise) keeping the largest
# connected piece, merges duplicate vertices, fills small holes, decimates
# while keeping UVs and the photo texture, rotates Z-up to Y-up, scales so
# the height is exactly the given centimetres, puts the feet on the floor,
# and exports a GLB with the texture embedded.
#
# Not run here (no Blender in this environment). Written for Blender 4.x.

import sys
import argparse
import bpy
import bmesh
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--input", required=True)
ap.add_argument("--output", required=True)
ap.add_argument("--height-cm", type=float, required=True)
ap.add_argument("--target-tris", type=int, default=150000)
ap.add_argument("--keep-small-parts", action="store_true")
args = ap.parse_args(argv)

bpy.ops.wm.read_factory_settings(use_empty=True)

ext = args.input.lower().rsplit(".", 1)[-1]
if ext == "obj":
    bpy.ops.wm.obj_import(filepath=args.input)
elif ext in ("usdz", "usd", "usda", "usdc"):
    bpy.ops.wm.usd_import(filepath=args.input)
elif ext in ("glb", "gltf"):
    bpy.ops.import_scene.gltf(filepath=args.input)
elif ext == "ply":
    bpy.ops.wm.ply_import(filepath=args.input)
else:
    raise SystemExit(f"unsupported input {args.input}")

meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not meshes:
    raise SystemExit("no mesh found in input")
for o in bpy.context.scene.objects:
    o.select_set(o.type == "MESH")
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Clean up in edit mode via bmesh.
bm = bmesh.new()
bm.from_mesh(obj.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bm.verts.ensure_lookup_table()
# Keep only the largest connected component unless asked otherwise.
if not args.keep_small_parts:
    seen = set()
    comps = []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack = [v]; comp = []
        seen.add(v.index)
        while stack:
            cur = stack.pop(); comp.append(cur)
            for e in cur.link_edges:
                o = e.other_vert(cur)
                if o.index not in seen:
                    seen.add(o.index); stack.append(o)
        comps.append(comp)
    comps.sort(key=len, reverse=True)
    if len(comps) > 1:
        small = [v for c in comps[1:] for v in c]
        bmesh.ops.delete(bm, geom=small, context="VERTS")
        print(f"mesh_prep: removed {len(comps) - 1} loose parts ({len(small)} vertices)")
# Fill small holes (boundary loops with few edges).
boundary = [e for e in bm.edges if e.is_boundary]
if boundary:
    try:
        bmesh.ops.holes_fill(bm, edges=boundary, sides=64)
    except Exception as ex:  # noqa: BLE001
        print(f"mesh_prep: hole fill skipped: {ex}")
bm.to_mesh(obj.data)
bm.free()
obj.data.update()

tris_before = sum(len(p.vertices) - 2 for p in obj.data.polygons)
if tris_before > args.target_tris:
    mod = obj.modifiers.new("decimate", "DECIMATE")
    mod.ratio = args.target_tris / tris_before
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
tris_after = sum(len(p.vertices) - 2 for p in obj.data.polygons)
print(f"mesh_prep: triangles {tris_before} -> {tris_after}")

# Upright and scaled. Blender is Z-up; glTF export converts to Y-up.
bbox = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
size = Vector((max(v.x for v in bbox) - min(v.x for v in bbox),
               max(v.y for v in bbox) - min(v.y for v in bbox),
               max(v.z for v in bbox) - min(v.z for v in bbox)))
# If the tallest axis is Y (a Y-up source), rotate it to Z-up for Blender.
if size.y > size.z * 1.3 and size.y >= size.x:
    obj.rotation_euler = (1.5707963, 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    bbox = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
zmin = min(v.z for v in bbox); zmax = max(v.z for v in bbox)
scale = (args.height_cm / 100.0) / (zmax - zmin)
obj.scale = (scale, scale, scale)
bpy.ops.object.transform_apply(scale=True)
bbox = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
cx = (min(v.x for v in bbox) + max(v.x for v in bbox)) / 2
cy = (min(v.y for v in bbox) + max(v.y for v in bbox)) / 2
obj.location = (-cx, -cy, -min(v.z for v in bbox))
bpy.ops.object.transform_apply(location=True)
print(f"mesh_prep: scaled by {scale:.4f}, height now {args.height_cm} cm")

bpy.ops.export_scene.gltf(filepath=args.output, export_format="GLB", export_apply=True,
                          export_image_format="AUTO", export_yup=True, use_selection=False)
print(f"mesh_prep: wrote {args.output}")
