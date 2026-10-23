"""Builds and animates The Voyage of the Arctic Tern. Run with bpy (Blender 5):
    python scene.py [out.blend]
Every motion is computed per frame from timeline.py and keyed on every frame."""
import json
import math
import os
import sys

import bpy
import bmesh
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import timeline as T  # noqa: E402

RES = (960, 540)
TAU = math.tau


# ---------------------------------------------------------------- helpers
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def smooth(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)


def ramp(t, a, b):
    return smooth((t - a) / (b - a)) if b > a else float(t >= a)


def lerp(a, b, s):
    return a + (b - a) * s


def vlerp(a, b, s):
    return Vector(a).lerp(Vector(b), s)


def spring(t, t0, amp, freq=6.0, damp=7.0):
    """Damped oscillation that starts at t0 with displacement amp."""
    if t < t0:
        return 0.0
    d = t - t0
    return amp * math.exp(-damp * d) * math.cos(TAU * freq * d)


def srgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c) + (1.0,)


def link(obj, parent=None):
    bpy.context.scene.collection.objects.link(obj)
    if parent:
        obj.parent = parent
    return obj


def empty(name, loc=(0, 0, 0), parent=None):
    o = bpy.data.objects.new(name, None)
    o.location = loc
    return link(o, parent)


def mesh_obj(name, verts, faces, mat=None, parent=None, smooth_shade=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    if smooth_shade:
        me.shade_smooth()
    o = bpy.data.objects.new(name, me)
    if mat:
        me.materials.append(mat)
    return link(o, parent)


def prim(kind, name, mat=None, parent=None, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), smooth_shade=True, **kw):
    getattr(bpy.ops.mesh, f"primitive_{kind}_add")(**kw)
    o = bpy.context.active_object
    o.name = name
    for c in o.users_collection:
        c.objects.unlink(o)
    bpy.context.scene.collection.objects.link(o)
    o.location, o.rotation_euler, o.scale = loc, rot, scale
    if smooth_shade:
        o.data.shade_smooth()
    if mat:
        o.data.materials.append(mat)
    if parent:
        o.parent = parent
    return o


def bevel(o, width, segments=3):
    m = o.modifiers.new("Bevel", 'BEVEL')
    m.width, m.segments, m.limit_method = width, segments, 'ANGLE'
    return m


def rounded_box(name, size, mat, parent=None, loc=(0, 0, 0), radius=0.02):
    o = prim("cube", name, mat, parent, loc, scale=(size[0] / 2, size[1] / 2, size[2] / 2), size=2)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.select_set(False)
    bevel(o, radius, 4)
    return o


def principled(name, color, rough=0.5, **inputs):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color
    b.inputs["Roughness"].default_value = rough
    for k, v in inputs.items():
        b.inputs[k.replace("_", " ")].default_value = v
    return m


def glow_material(name, color, kind="beam"):
    """Additive emission (emission + transparent): aurora ribbons and beam cones."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    add = nt.nodes.new("ShaderNodeAddShader")
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = color
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    strength = nt.nodes.new("ShaderNodeValue")
    strength.name = "Strength"
    strength.outputs[0].default_value = 1.0
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = 'MULTIPLY'
    if kind == "beam":
        # brightest at the eye, fading along the length and towards the silhouette
        nt.links.new(tc.outputs["Object"], sep.inputs[0])
        along = nt.nodes.new("ShaderNodeMath")
        along.operation = 'MULTIPLY_ADD'
        along.inputs[1].default_value = -1 / 3.2
        along.inputs[2].default_value = 1.0
        nt.links.new(sep.outputs["Y"], along.inputs[0])
        pw = nt.nodes.new("ShaderNodeMath")
        pw.operation = 'POWER'
        pw.use_clamp = True
        pw.inputs[1].default_value = 1.6
        nt.links.new(along.outputs[0], pw.inputs[0])
        lw = nt.nodes.new("ShaderNodeLayerWeight")
        lw.inputs["Blend"].default_value = 0.35
        inv = nt.nodes.new("ShaderNodeMath")
        inv.operation = 'SUBTRACT'
        inv.inputs[0].default_value = 1.0
        inv.use_clamp = True
        nt.links.new(lw.outputs["Facing"], inv.inputs[1])
        m2 = nt.nodes.new("ShaderNodeMath")
        m2.operation = 'MULTIPLY'
        nt.links.new(pw.outputs[0], m2.inputs[0])
        nt.links.new(inv.outputs[0], m2.inputs[1])
        nt.links.new(m2.outputs[0], mul.inputs[0])
    else:
        # aurora: bright lower edge, fading up, with vertical rays
        nt.links.new(tc.outputs["Generated"], sep.inputs[0])
        up = nt.nodes.new("ShaderNodeFloatCurve")
        cm = up.mapping
        pts = cm.curves[0].points
        pts[0].location = (0.0, 0.0)
        pts[1].location = (1.0, 0.0)
        pts.new(0.06, 1.0)
        pts.new(0.35, 0.35)
        cm.update()
        nt.links.new(sep.outputs["Z"], up.inputs["Value"])
        wave = nt.nodes.new("ShaderNodeTexWave")
        wave.wave_type = 'BANDS'
        wave.bands_direction = 'X'
        wave.inputs["Scale"].default_value = 3.0
        wave.inputs["Distortion"].default_value = 1.5
        wave.inputs["Detail"].default_value = 1.0
        nt.links.new(tc.outputs["Generated"], wave.inputs["Vector"])
        rays = nt.nodes.new("ShaderNodeMapRange")
        rays.inputs["To Min"].default_value = 0.6
        nt.links.new(wave.outputs["Fac"], rays.inputs["Value"])
        m2 = nt.nodes.new("ShaderNodeMath")
        m2.operation = 'MULTIPLY'
        side = nt.nodes.new("ShaderNodeFloatCurve")
        sp = side.mapping.curves[0].points
        sp[0].location, sp[1].location = (0.0, 0.0), (1.0, 0.0)
        sp.new(0.3, 1.0)
        sp.new(0.7, 1.0)
        side.mapping.update()
        nt.links.new(sep.outputs["X"], side.inputs["Value"])
        m3 = nt.nodes.new("ShaderNodeMath")
        m3.operation = 'MULTIPLY'
        nt.links.new(up.outputs["Value"], m3.inputs[0])
        nt.links.new(side.outputs["Value"], m3.inputs[1])
        nt.links.new(m3.outputs[0], m2.inputs[0])
        nt.links.new(rays.outputs["Result"], m2.inputs[1])
        nt.links.new(m2.outputs[0], mul.inputs[0])
        # colour: green at the bottom, violet at the top
        cr = nt.nodes.new("ShaderNodeValToRGB")
        cr.color_ramp.elements[0].color = color
        cr.color_ramp.elements[1].position = 0.75
        cr.color_ramp.elements[1].color = (0.25, 0.08, 0.6, 1)
        nt.links.new(sep.outputs["Z"], cr.inputs["Fac"])
        nt.links.new(cr.outputs["Color"], em.inputs["Color"])
    nt.links.new(strength.outputs[0], mul.inputs[1])
    nt.links.new(mul.outputs[0], em.inputs["Strength"])
    nt.links.new(em.outputs[0], add.inputs[0])
    nt.links.new(tr.outputs[0], add.inputs[1])
    nt.links.new(add.outputs[0], out.inputs["Surface"])
    return m


def key(owner, path, frame):
    owner.keyframe_insert(data_path=path, frame=frame)


# ---------------------------------------------------------------- scene setup
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = T.FPS
scene.frame_start, scene.frame_end = 1, T.FRAMES
scene.render.resolution_x, scene.render.resolution_y = RES
scene.render.engine = 'CYCLES'
cy = scene.cycles
cy.device = 'CPU'
cy.samples = 48
cy.use_adaptive_sampling = True
cy.adaptive_threshold = 0.03
cy.use_denoising = True
cy.denoiser = 'OPENIMAGEDENOISE'
cy.max_bounces = 6
cy.diffuse_bounces = 2
cy.glossy_bounces = 2
cy.transmission_bounces = 2
cy.transparent_max_bounces = 12
cy.caustics_reflective = cy.caustics_refractive = False
cy.blur_glossy = 1.0
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.render.image_settings.file_format = 'PNG'

# world: night gradient with stars
world = bpy.data.worlds.new("Night")
scene.world = world
world.use_nodes = True
wn = world.node_tree
wn.nodes.clear()
wout = wn.nodes.new("ShaderNodeOutputWorld")
bg = wn.nodes.new("ShaderNodeBackground")
wtc = wn.nodes.new("ShaderNodeTexCoord")
wsep = wn.nodes.new("ShaderNodeSeparateXYZ")
wn.links.new(wtc.outputs["Generated"], wsep.inputs[0])
grad = wn.nodes.new("ShaderNodeValToRGB")
grad.color_ramp.elements[0].position = 0.0
grad.color_ramp.elements[0].color = (0.010, 0.020, 0.048, 1)
grad.color_ramp.elements[1].position = 0.45
grad.color_ramp.elements[1].color = (0.0015, 0.0025, 0.009, 1)
wn.links.new(wsep.outputs["Z"], grad.inputs["Fac"])
vor = wn.nodes.new("ShaderNodeTexVoronoi")
vor.inputs["Scale"].default_value = 260.0
wn.links.new(wtc.outputs["Generated"], vor.inputs["Vector"])
star = wn.nodes.new("ShaderNodeMapRange")
star.inputs["From Min"].default_value = 0.06
star.inputs["From Max"].default_value = 0.0
star.inputs["To Max"].default_value = 1.2
wn.links.new(vor.outputs["Distance"], star.inputs["Value"])
above = wn.nodes.new("ShaderNodeMapRange")
above.inputs["From Min"].default_value = 0.03
above.inputs["From Max"].default_value = 0.15
wn.links.new(wsep.outputs["Z"], above.inputs["Value"])
smul = wn.nodes.new("ShaderNodeMath")
smul.operation = 'MULTIPLY'
wn.links.new(star.outputs["Result"], smul.inputs[0])
wn.links.new(above.outputs["Result"], smul.inputs[1])
sadd = wn.nodes.new("ShaderNodeMix")
sadd.data_type = 'RGBA'
sadd.blend_type = 'ADD'
sadd.inputs["Factor"].default_value = 1.0
wn.links.new(grad.outputs["Color"], sadd.inputs[6])
wn.links.new(smul.outputs[0], sadd.inputs[7])
wn.links.new(sadd.outputs[2], bg.inputs["Color"])
wn.links.new(bg.outputs[0], wout.inputs["Surface"])

# ---------------------------------------------------------------- materials
M = dict(
    clawd=principled("Clawd", srgb("D97757"), 0.42, Coat_Weight=0.15),
    eye=principled("Eye", (0.006, 0.006, 0.006, 1), 0.3, Emission_Color=(1.0, 0.78, 0.5, 1), Emission_Strength=0.0),
    hull=principled("Hull", (0.09, 0.035, 0.018, 1), 0.55),
    band=principled("HullBand", (0.55, 0.06, 0.04, 1), 0.45),
    deck=principled("Deck", (0.32, 0.18, 0.08, 1), 0.7),
    wood=principled("Wood", (0.16, 0.08, 0.035, 1), 0.6),
    iron=principled("Iron", (0.05, 0.05, 0.055, 1), 0.35, Metallic=1.0),
    brass=principled("Brass", (0.75, 0.5, 0.2, 1), 0.3, Metallic=1.0),
    glass=principled("LanternGlass", (1.0, 0.75, 0.4, 1), 0.2, Emission_Color=(1.0, 0.55, 0.18, 1), Emission_Strength=6.0),
    ice=principled("Ice", (0.82, 0.9, 1.0, 1), 0.25, Emission_Color=(0.2, 0.9, 0.75, 1), Emission_Strength=0.0,
                   Subsurface_Weight=0.0),
    berg=principled("Berg", (0.75, 0.86, 1.0, 1), 0.3),
    sea=principled("Sea", (0.004, 0.012, 0.026, 1), 0.14, Specular_IOR_Level=0.6),
    feather=principled("Feather", (0.85, 0.87, 0.9, 1), 0.7),
    wingtop=principled("WingTop", (0.55, 0.6, 0.66, 1), 0.7),
    cap=principled("BlackCap", (0.01, 0.01, 0.012, 1), 0.5),
    bill=principled("Bill", (0.75, 0.05, 0.03, 1), 0.35),
)

# sail with a tern emblem (texture drawn with Pillow)
from PIL import Image, ImageDraw  # noqa: E402

sail_png = os.path.join(HERE, "build", "sail.png")
os.makedirs(os.path.dirname(sail_png), exist_ok=True)
im = Image.new("RGB", (512, 512), (226, 214, 186))
d = ImageDraw.Draw(im)
for y in range(0, 512, 64):
    d.line([(0, y), (512, y)], fill=(205, 192, 162), width=3)
tern_shape = [(256, 210), (330, 150), (430, 120), (350, 205), (300, 240), (330, 330), (290, 300),
              (262, 360), (252, 300), (205, 330), (232, 250), (150, 215), (80, 150), (190, 175)]
d.polygon(tern_shape, fill=(40, 46, 58))
d.ellipse([240, 190, 278, 228], fill=(40, 46, 58))
im.save(sail_png)
sail_mat = principled("Sail", (1, 1, 1, 1), 0.85, Subsurface_Weight=0.0)
tex = sail_mat.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = bpy.data.images.load(sail_png)
sail_mat.node_tree.links.new(tex.outputs["Color"], sail_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"])

# ---------------------------------------------------------------- the sea
sea = prim("plane", "Sea", M["sea"], size=2, smooth_shade=False)
oc = sea.modifiers.new("Ocean", 'OCEAN')
oc.geometry_mode = 'GENERATE'
oc.size = 1.0
oc.spatial_size = 48
oc.resolution = 10
oc.wave_scale = 0.14
oc.choppiness = 0.6
oc.wind_velocity = 6
oc.wave_alignment = 0.4
oc.wave_direction = 0.3
oc.random_seed = 3
oc.use_normals = True
sea.location = (-6, 14, -0.03)
sea.data.shade_smooth()

# ---------------------------------------------------------------- the ship
ship = empty("Ship")
N, P = 26, 14


def hull_w(u):
    u = clamp(u)
    w = 0.36 * math.sin(0.5 * math.pi * min(u / 0.5, 1.0)) ** 0.75
    return max(w * (1 - 0.12 * max(0.0, u - 0.75) / 0.25), 0.008)


def hull_top(u):
    u = clamp(u)
    return 0.47 + 0.14 * (1 - u) ** 2.2


def hull_keel(u):
    u = clamp(u)
    return -0.16 + 0.32 * (1 - u) ** 4


verts, faces = [], []
for i in range(N):
    u = i / (N - 1)
    x = -1.0 + 2.0 * u
    w, zt, zk = hull_w(u), hull_top(u), hull_keel(u)
    for j in range(P):
        ph = math.pi * j / (P - 1)
        y = w * math.cos(ph)
        z = zt - (zt - zk) * abs(math.sin(ph)) ** 0.55
        verts.append((x, y, z))
for i in range(N - 1):
    for j in range(P - 1):
        a = i * P + j
        faces.append((a, a + 1, a + P + 1, a + P))
faces.append(tuple((N - 1) * P + j for j in range(P)))
hull = mesh_obj("Hull", verts, faces, M["hull"], ship)
hull.data.materials.append(M["band"])
for poly in hull.data.polygons:  # a painted band under the gunwale
    if poly.center.z > hull_top((poly.center.x + 1) / 2) - 0.07:
        poly.material_index = 1
sol = hull.modifiers.new("Thick", 'SOLIDIFY')
sol.thickness = 0.025

deck_v, deck_f = [], []
for i in range(N):
    u = i / (N - 1)
    w = hull_w(u) * 0.93
    deck_v += [(-1.0 + 2.0 * u, w, T.DECK_Z), (-1.0 + 2.0 * u, -w, T.DECK_Z)]
for i in range(1, N - 1):
    deck_f.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1))
mesh_obj("Deck", deck_v, deck_f, M["deck"], ship, smooth_shade=False)

MAST_X = 0.18
prim("cylinder", "Mast", M["wood"], ship, (MAST_X, 0, T.DECK_Z + 1.1), radius=0.03, depth=2.2, vertices=16)
prim("cylinder", "Yard", M["wood"], ship, (MAST_X - 0.04, 0, 2.15), (math.pi / 2, 0, 0), radius=0.018, depth=1.3, vertices=12)
prim("cylinder", "Boom", M["wood"], ship, (MAST_X - 0.04, 0, 0.98), (math.pi / 2, 0, 0), radius=0.016, depth=1.2, vertices=12)
prim("cylinder", "Bowsprit", M["wood"], ship, (-1.2, 0, 0.66), (0, math.radians(-75), 0), radius=0.018, depth=0.7, vertices=12)
prim("cylinder", "Nest", M["wood"], ship, (MAST_X, 0, 2.3), radius=0.09, depth=0.08, vertices=16)

# billowing square sail between yard and boom, bellied towards the bow
sv, sf = [], []
SU, SV = 12, 10
for a in range(SU + 1):
    for b in range(SV + 1):
        y = -0.6 + 1.2 * a / SU
        z = 1.0 + 1.13 * b / SV
        belly = 0.16 * math.sin(math.pi * a / SU) * math.sin(math.pi * b / SV)
        sv.append((MAST_X - 0.06 - belly, y, z))
for a in range(SU):
    for b in range(SV):
        i0 = a * (SV + 1) + b
        sf.append((i0, i0 + SV + 1, i0 + SV + 2, i0 + 1))
sail = mesh_obj("Sail", sv, sf, sail_mat, ship)
uvl = sail.data.uv_layers.new()
for poly in sail.data.polygons:
    for li in poly.loop_indices:
        v = sail.data.vertices[sail.data.loops[li].vertex_index].co
        uvl.data[li].uv = (1 - (v.y + 0.6) / 1.2, (v.z - 1.0) / 1.13)
sail.modifiers.new("Thick", 'SOLIDIFY').thickness = 0.006

# rigging lines
for y in (-0.33, 0.33):
    a, b = Vector((-1.45, 0, 0.83)), Vector((MAST_X, 0, 2.3))
    if y:
        a = Vector((MAST_X + 0.9, y, T.DECK_Z + 0.06))
    mid, dvec = (a + b) / 2, b - a
    r = prim("cylinder", "Stay", M["iron"], ship, mid, radius=0.004, depth=dvec.length, vertices=6)
    r.rotation_euler = dvec.to_track_quat('Z', 'Y').to_euler()
a, b = Vector((-1.45, 0, 0.83)), Vector((MAST_X, 0, 2.3))
r = prim("cylinder", "Forestay", M["iron"], ship, (a + b) / 2, radius=0.004, depth=(b - a).length, vertices=6)
r.rotation_euler = (b - a).to_track_quat('Z', 'Y').to_euler()

# lantern post at the bow, a hook arm and a hanging lantern
POST_X = -0.86
prim("cylinder", "LanternPost", M["wood"], ship, (POST_X, 0, 0.75), radius=0.02, depth=0.62, vertices=12)
prim("cylinder", "HookArm", M["iron"], ship, (POST_X - 0.1, 0, 1.05), (0, math.pi / 2, 0), radius=0.01, depth=0.22, vertices=8)
HINGE = Vector((POST_X - 0.19, 0, 1.04))
hinge = empty("LanternHinge", HINGE, ship)
prim("cylinder", "LanternRod", M["iron"], hinge, (0, 0, -0.05), radius=0.004, depth=0.1, vertices=6)
prim("cylinder", "LanternCap", M["brass"], hinge, (0, 0, -0.105), radius=0.045, depth=0.02, vertices=16)
prim("cone", "LanternRoof", M["brass"], hinge, (0, 0, -0.085), radius1=0.045, radius2=0.01, depth=0.04, vertices=16)
glass = prim("cylinder", "LanternGlass", M["glass"], hinge, (0, 0, -0.17), radius=0.035, depth=0.11, vertices=16)
prim("cylinder", "LanternBase", M["brass"], hinge, (0, 0, -0.235), radius=0.045, depth=0.02, vertices=16)
lantern_light = bpy.data.lights.new("Lantern", 'POINT')
lantern_light.color = (1.0, 0.62, 0.28)
lantern_light.shadow_soft_size = 0.03
lantern = link(bpy.data.objects.new("Lantern", lantern_light), hinge)
lantern.location = (0, 0, -0.17)
glass.visible_shadow = False

# barrel with a hinged lid
BARREL = Vector((-0.42, 0.06, T.DECK_Z))
BR, BH = 0.16, 0.26
bv, bfaces = [], []
for k in range(7):
    z = BH * k / 6
    r = BR * (1 + 0.1 * math.sin(math.pi * k / 6))
    for s in range(20):
        a = TAU * s / 20
        bv.append((r * math.cos(a), r * math.sin(a), z))
for k in range(6):
    for s in range(20):
        a0, a1 = k * 20 + s, k * 20 + (s + 1) % 20
        bfaces.append((a0, a1, a1 + 20, a0 + 20))
barrel = mesh_obj("Barrel", bv, bfaces, M["wood"], ship)
barrel.location = BARREL
barrel.modifiers.new("Thick", 'SOLIDIFY').thickness = 0.012
for z in (0.03, BH - 0.03):
    prim("torus", "Hoop", M["iron"], ship, BARREL + Vector((0, 0, z)), major_radius=BR * 1.02 + 0.01 * (z < 0.1),
         minor_radius=0.007, major_segments=24, minor_segments=6)
lid_hinge = empty("LidHinge", BARREL + Vector((BR, 0, BH)), ship)
prim("cylinder", "Lid", M["deck"], lid_hinge, (-BR, 0, 0.01), radius=BR + 0.01, depth=0.022, vertices=24)

# ---------------------------------------------------------------- Clawd
clawd = empty("Clawd")
U = 0.26 / 12
BODY = (12 * U, 6 * U, 8 * U)
LEG = 0.035
FEET = BODY[2] / 2 + LEG  # centre-of-body height above the feet
rounded_box("ClawdBody", BODY, M["clawd"], clawd, radius=0.016)
for sx in (-1, 1):
    rounded_box("ClawdNub", (2 * U, 3 * U, 2.4 * U), M["clawd"], clawd, (sx * (BODY[0] / 2 + U * 0.7), 0, 0.2 * U), 0.007)
for sx in (-4.2, -1.6, 1.6, 4.2):
    rounded_box("ClawdLeg", (1.3 * U, 2.4 * U, LEG + 0.01), M["clawd"], clawd, (sx * U, 0, -BODY[2] / 2 - LEG / 2 + 0.004), 0.004)
eyes = []
for sx in (-1, 1):
    e = rounded_box("ClawdEye", (0.9 * U, 0.01, 2.6 * U), M["eye"], clawd, (sx * 2.6 * U, -BODY[1] / 2 - 0.002, 1.0 * U), 0.002)
    eyes.append(e)

# eye beams: spot lights plus visible cones, aimed at a target empty
beam_target = empty("BeamTarget")
beam_lights, beam_cones = [], []
beam_mat = glow_material("Beam", (1.0, 0.82, 0.55, 1), "beam")
L_BEAM = 3.2
cv = [(0, 0, 0)]
for s in range(24):
    a = TAU * s / 24
    cv.append((0.22 * math.cos(a), L_BEAM, 0.22 * math.sin(a)))
cf = [(0, 1 + (s + 1) % 24, 1 + s) for s in range(24)]
for e in eyes:
    holder = empty("BeamHolder", e.location + Vector((0, -0.01, 0)), clawd)
    dt = holder.constraints.new('DAMPED_TRACK')
    dt.target, dt.track_axis = beam_target, 'TRACK_Y'
    cone = mesh_obj("BeamCone", cv, cf, beam_mat, holder, smooth_shade=True)
    cone.visible_shadow = False
    sl = bpy.data.lights.new("EyeBeam", 'SPOT')
    sl.color = (1.0, 0.82, 0.55)
    sl.spot_size = math.radians(14)
    sl.spot_blend = 0.6
    sl.shadow_soft_size = 0.01
    lo = link(bpy.data.objects.new("EyeBeam", sl), holder)
    lo.rotation_euler = (-math.pi / 2, 0, 0)  # spot points -Z; turn it to +Y
    beam_lights.append(sl)
    beam_cones.append(cone)

# ---------------------------------------------------------------- the tern (forward = +X)
tern = empty("Tern")
prim("uv_sphere", "TernBody", M["feather"], tern, scale=(0.11, 0.042, 0.045), segments=20, ring_count=12)
head = empty("TernHead", (0.1, 0, 0.035), tern)
prim("uv_sphere", "TernHeadBall", M["feather"], head, scale=(0.036, 0.03, 0.032), segments=16, ring_count=10)
prim("uv_sphere", "TernCap", M["cap"], head, (0.002, 0, 0.011), scale=(0.037, 0.031, 0.024), segments=16, ring_count=10)
prim("cone", "TernBill", M["bill"], head, (0.06, 0, -0.004), (0, math.pi / 2, 0), radius1=0.009, radius2=0.0, depth=0.055, vertices=10)
for sy in (-1, 1):
    prim("uv_sphere", "TernEyeDot", M["cap"], head, (0.026, sy * 0.022, 0.008), scale=(0.006,) * 3, segments=8, ring_count=6)
wings = []
for sy in (-1, 1):
    sh = empty("Shoulder", (0.025, sy * 0.03, 0.02), tern)
    wv = [(0.03, 0, 0), (-0.05, 0, 0), (-0.06, sy * 0.13, 0.0), (-0.02, sy * 0.25, 0.0), (-0.09, sy * 0.33, 0.0)]
    w = mesh_obj("Wing", wv, [(0, 1, 2), (0, 2, 3), (2, 4, 3)], M["wingtop"], sh, smooth_shade=False)
    w.modifiers.new("Thick", 'SOLIDIFY').thickness = 0.006
    wings.append((sh, sy))
for sy in (-1, 1):  # forked tail
    tv = [(-0.09, 0, 0.005), (-0.1, sy * 0.012, 0.005), (-0.22, sy * 0.05, 0.0)]
    mesh_obj("Tail", tv, [(0, 1, 2)], M["feather"], tern, smooth_shade=False).modifiers.new("T", 'SOLIDIFY').thickness = 0.004
for sy in (-1, 1):
    prim("cylinder", "TernLeg", M["bill"], tern, (0.0, sy * 0.012, -0.05), radius=0.003, depth=0.035, vertices=6)

# ---------------------------------------------------------------- ice
floes = []
for i, (fx, fy) in enumerate(T.FLOES):
    fv = []
    k = 11
    rad = [0.24 + 0.06 * math.sin(3.1 * s + i * 1.7) + 0.03 * math.cos(5.3 * s + i) for s in range(k)]
    for z in (-0.06, 0.045):
        for s in range(k):
            a = TAU * s / k
            fv.append((rad[s] * math.cos(a), rad[s] * math.sin(a) * 0.8, z))
    ff = [tuple(range(k))[::-1], tuple(range(k, 2 * k))] + [(s, (s + 1) % k, k + (s + 1) % k, k + s) for s in range(k)]
    fm = M["ice"].copy()
    fm.name = f"Floe{i}"
    fo = mesh_obj(f"Floe{i}", fv, ff, fm, smooth_shade=False)
    bevel(fo, 0.025, 3)
    fo.location = (fx, fy, 0)
    floes.append(fo)

bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=4, radius=1)
berg = bpy.context.active_object
berg.name = "Iceberg"
berg.data.materials.append(M["berg"])
berg.location = (T.ICEBERG[0], T.ICEBERG[1], 0.5)
berg.scale = (1.4, 1.0, 2.7)
berg.data.shade_smooth()
btex = bpy.data.textures.new("BergNoise", 'VORONOI')
btex.noise_scale = 0.55
disp = berg.modifiers.new("Disp", 'DISPLACE')
disp.texture, disp.strength = btex, 0.45
berg.modifiers.new("Smooth", 'SMOOTH').iterations = 2
berg.rotation_euler = (0.1, 0.05, 0.7)
for (bx, by, s) in [(-8.5, 7.5, 0.8), (3.5, 9.0, 0.6), (-1.2, 8.5, 0.35)]:
    b2 = berg.copy()
    b2.data = berg.data
    b2.location, b2.scale = (bx, by, 0.0), (s * 1.1, s, s * 1.3)
    b2.rotation_euler = (0, 0, bx)
    scene.collection.objects.link(b2)
# little loose ice bits around the floes
for k, (bx, by) in enumerate([(-1.1, -0.9), (-2.9, -0.7), (-4.9, -0.4), (-3.4, 0.9), (0.9, -1.2), (-5.4, -1.1)]):
    o = prim("ico_sphere", "Bit", M["ice"], loc=(bx, by, 0.0), scale=(0.12, 0.09, 0.04), subdivisions=1, smooth_shade=False)

# ---------------------------------------------------------------- aurora
aurora_mats = []
AUR = [(-24, 42), (-13, 46), (-2, 43), (9, 47), (20, 44)]
for i, (ax, ay) in enumerate(reversed(AUR)):  # band 0 is the rightmost: Clawd travels right to left
    av, af = [], []
    W, H, CU, CV = 16.0, 9.0, 40, 6
    for a in range(CU + 1):
        for b in range(CV + 1):
            x = -W / 2 + W * a / CU
            av.append((x, 2.0 * math.sin(x * 0.45 + i * 1.3), H * b / CV))
    for a in range(CU):
        for b in range(CV):
            i0 = a * (CV + 1) + b
            af.append((i0, i0 + CV + 1, i0 + CV + 2, i0 + 1))
    hue = [(0.1, 1.0, 0.45, 1), (0.05, 0.9, 0.7, 1), (0.15, 1.0, 0.35, 1), (0.05, 0.8, 0.8, 1), (0.2, 1.0, 0.4, 1)][i]
    am = glow_material(f"Aurora{i}", hue, "aurora")
    ao = mesh_obj(f"Aurora{i}", av, af, am)
    ao.location = (ax - 2.0, ay, 7.0 + 1.2 * (i % 2))
    ao.rotation_euler = (0, math.radians(4 * (i - 2)), 0)
    ao.visible_shadow = False
    aurora_mats.append(am)

# ---------------------------------------------------------------- lights and camera
moon = bpy.data.lights.new("Moon", 'SUN')
moon.energy = 0.45
moon.color = (0.62, 0.75, 1.0)
moon.angle = math.radians(1.5)
mo = link(bpy.data.objects.new("Moon", moon))
mo.rotation_euler = (math.radians(-58), 0, math.radians(-30))

fill = bpy.data.lights.new("Fill", 'AREA')
fill.size = 4.0
fill.energy = 110
fill.color = (0.55, 0.68, 1.0)
fo_ = link(bpy.data.objects.new("Fill", fill))
fo_.location = (-1.5, -6.5, 3.5)
fo_.rotation_euler = (math.radians(60), 0, 0)

keyl = bpy.data.lights.new("ClawdKey", 'AREA')
keyl.size = 0.8
keyl.energy = 14
keyl.color = (1.0, 0.94, 0.88)
key_o = link(bpy.data.objects.new("ClawdKey", keyl))
kt = key_o.constraints.new('TRACK_TO')
kt.target = clawd
for lo_ in (key_o, fo_):
    lo_.visible_camera = lo_.visible_glossy = False

cam_data = bpy.data.cameras.new("Cam")
cam_data.sensor_width = 36
cam = link(bpy.data.objects.new("Cam", cam_data))
scene.camera = cam
cam_target = empty("CamTarget")
ct = cam.constraints.new('TRACK_TO')
ct.target, ct.track_axis, ct.up_axis = cam_target, 'TRACK_NEGATIVE_Z', 'UP_Y'


# ---------------------------------------------------------------- motion
def ship_matrix(t):
    x = T.SHIP_X0 - T.SHIP_SPEED * t
    z = 0.025 * math.sin(TAU * t / 3.1)
    rot = Euler((0.03 * math.sin(TAU * t / 3.7), 0.025 * math.sin(TAU * t / 3.1 + 1.0), 0.0))
    return Matrix.Translation((x, 0, z)) @ rot.to_matrix().to_4x4(), (x, 0, z), rot


def ship_point(t, local):
    return ship_matrix(t)[0] @ Vector(local)


def floe_state(t, i):
    fx, fy = T.FLOES[i]
    z = 0.03 + 0.012 * math.sin(TAU * t / 2.3 + i * 1.9)
    land = T.FLOE_LANDINGS[i]
    z += spring(t, land, -0.05, freq=2.2, damp=3.5)
    glow = 0.0 if t < land else 1.2 * math.exp(-(t - land) * 1.5) + 0.2
    tilt = (0.03 * math.sin(TAU * t / 2.9 + i), 0.03 * math.cos(TAU * t / 3.3 + i))
    return Vector((fx, fy, z)), glow, tilt


def floe_top(t, i):
    p, _, _ = floe_state(t, i)
    return p + Vector((0, 0, 0.045 + 0.025))  # top plus bevel


def yaw_to(d):
    return math.atan2(d.x, -d.y)


PERCH_LOCAL = (POST_X - 0.1, 0, 1.05 + 0.052)
BARREL_TOP = BARREL + Vector((0, 0, BH))


def hop(a, b, s, h):
    p = vlerp(a, b, s)
    p.z += 4 * h * s * (1 - s)
    return p


def clawd_state(t):
    """Returns centre position, yaw, pitch, scale (x, z), visible."""
    sq = 1.0
    pitch = 0.0
    cam_dir_yaw = 0.0  # facing -Y (the lens)
    if t < T.LAUNCH:
        rise = ramp(t, T.CLAWD_OUT[0], T.CLAWD_OUT[1])
        foot = BARREL_TOP + Vector((0, 0, lerp(-0.26, 0.0, rise)))
        foot.z += 0.06 * math.sin(math.pi * rise)  # a little hop out
        pos = ship_point(t, foot + Vector((0, 0, FEET)))
        to_tern = ship_point(t, PERCH_LOCAL) - pos
        yaw = lerp(cam_dir_yaw - 0.4, yaw_to(to_tern), ramp(t, *T.LOOK_TERN))
        yaw = lerp(yaw, cam_dir_yaw, ramp(t, *T.HEAD_TURN))
        if t > T.CLAWD_OUT[1]:
            sq += spring(t, T.CLAWD_OUT[1], -0.12, 5, 9)
        sq -= 0.18 * ramp(t, T.LAUNCH - 0.12, T.LAUNCH)  # anticipation
        return pos, yaw, pitch, sq, t >= T.LID_UP - 0.05
    starts = [T.LAUNCH] + T.FLOE_LANDINGS[:-1]
    for i, land in enumerate(T.FLOE_LANDINGS):
        t0 = starts[i]
        if t < land:
            a = ship_point(t0, BARREL_TOP) if i == 0 else floe_top(t0, i - 1)
            b = floe_top(land, i)
            s = (t - t0) / (land - t0)
            pos = hop(a, b, s, 0.32 if i == 0 else 0.26) + Vector((0, 0, FEET))
            yaw = yaw_to(b - a)
            if i == 0:
                yaw = lerp(0.0, yaw, smooth(s / 0.3))
            if i == 4:
                pitch = TAU * smooth(s)
            sq = 1.0 + 0.12 * math.sin(math.pi * s)
            return pos, yaw, pitch, sq, True
    # on the last floe
    pos = floe_top(t, 4) + Vector((0, 0, FEET))
    sq = 1.0 + spring(t, T.FLOE_LANDINGS[-1], -0.2, 4, 7)
    yaw = yaw_to(Vector((-1, 0, 0)))
    if t >= T.BEAMS_ON - 0.3:
        tgt = beam_target_pos(t)
        yaw = lerp(yaw, yaw_to(tgt - pos), ramp(t, T.BEAMS_ON - 0.3, T.BEAMS_ON))
    if t >= T.BEAMS_OFF:
        yaw = lerp(yaw_to(cam_pos(t) - pos), yaw_to(tern_state(t)[0] - pos) if t > T.TERN_TAKEOFF else yaw_to(cam_pos(t) - pos),
                   ramp(t, T.TERN_WAKE, T.TERN_WAKE + 0.4))
    return pos, yaw, pitch, sq, True


def floe_squash(t):
    """Extra squash on each landing (applied whilst on a floe)."""
    s = 0.0
    for land in T.FLOE_LANDINGS[:-1]:
        s += spring(t, land, -0.22, 4, 9) if land <= t < land + 0.5 else 0.0
    return s


def beam_target_pos(t):
    b = Vector((T.ICEBERG[0], T.ICEBERG[1], 0.9))
    right, left = b + Vector((1.4, -0.4, 0.2)), b + Vector((-1.5, 0.3, 0.0))
    if t < T.BEAM_SWEEP[1]:
        return vlerp(right, left, ramp(t, *T.BEAM_SWEEP))
    return vlerp(left, cam_pos(t), ramp(t, *T.BEAM_TO_LENS))


# camera: shot positions (location, target, lens)
def shot(name, t):
    sx = T.SHIP_X0 - T.SHIP_SPEED * t
    if name == "voyage":
        return Vector((sx - 1.45, -4.9, 1.05)), Vector((sx - 0.25, 0, 1.3)), 35.0
    if name == "push":
        c = ship_point(t, BARREL_TOP + Vector((0, 0, 0.12)))
        return c + Vector((-0.55, -2.0, 0.25)), c, 43.0
    if name == "wide":
        return Vector((-1.9, -4.0, 1.55)), Vector((-1.9, 0.4, 0.42)), 35.0
    if name == "card":
        return Vector((-2.0, -4.8, 1.45)), Vector((-2.0, 0.4, 0.95)), 35.0


def cam_state(t):
    if t < T.HEAD_TURN[0] - 0.2:
        return shot("voyage", t)
    if t < T.LAUNCH:
        return blend(shot("voyage", t), shot("push", t), ramp(t, T.HEAD_TURN[0] - 0.2, T.HEAD_TURN[1]))
    if t < T.FLASH:
        return blend(shot("push", t), shot("wide", t), ramp(t, T.LAUNCH - 0.05, T.LAUNCH + 0.55))
    return blend(shot("wide", t), shot("card", t), ramp(t, T.FLASH, T.DURATION))


def blend(a, b, s):
    return vlerp(a[0], b[0], s), vlerp(a[1], b[1], s), lerp(a[2], b[2], s)


def cam_pos(t):
    return cam_state(t)[0]


def _glide_heading():
    ph = 1.25 * TAU - 0.6
    start = ship_point(2.35, (MAST_X, 0, 0)) + Vector((0.95 * math.cos(ph), 0.95 * math.sin(ph) * 0.9, 1.75))
    d = ship_point(T.TERN_LAND, PERCH_LOCAL) - start
    return math.atan2(d.y, d.x)


def tern_state(t):
    """Returns position, heading yaw, pitch, roll, flap angle, head pitch, scale."""
    mast = ship_point(t, (MAST_X, 0, 0))
    perch = ship_point(t, PERCH_LOCAL)
    head_p = 0.0
    sc = 1.0
    if t < 2.35:
        ph = 1.25 * TAU * (t / 2.35) - 0.6
        r = 0.95
        pos = mast + Vector((r * math.cos(ph), r * math.sin(ph) * 0.9, 1.75 + 0.12 * math.sin(2 * ph)))
        vel = Vector((-math.sin(ph), math.cos(ph) * 0.9, 0))
        yaw = math.atan2(vel.y, vel.x)
        flap = math.sin(TAU * t * 3.2) * 0.75
        return pos, yaw, 0.0, -0.45, flap, 0.0, 1.0
    if t < T.TERN_LAND:
        s = ramp(t, 2.35, T.TERN_LAND)
        ph = 1.25 * TAU - 0.6
        start = mast + Vector((0.95 * math.cos(ph), 0.95 * math.sin(ph) * 0.9, 1.75))
        pos = vlerp(start, perch, s)
        pos.z += 0.25 * math.sin(math.pi * s)
        d = perch - start
        h0 = math.atan2(d.y, d.x)
        yaw = lerp(h0, math.copysign(math.pi, h0), smooth((s - 0.6) / 0.4))
        flap = 0.9 * math.sin(TAU * t * 4) * (1 - s) + 1.1 * smooth((s - 0.7) / 0.3)
        return pos, yaw, 0.0, 0.0, flap, 0.0, 1.0
    if t < T.TERN_TAKEOFF:
        pos = perch.copy()
        flap = 1.1 * (1 - ramp(t, T.TERN_LAND, T.TERN_LAND + 0.25)) - 0.15
        sleeping = ramp(t, T.TERN_SLEEP[0], T.TERN_SLEEP[0] + 0.5) * (1 - ramp(t, T.TERN_WAKE, T.TERN_WAKE + 0.12))
        head_p = 0.9 * sleeping
        breathe = 0.03 * math.sin(TAU * t / 1.5) * sleeping
        sc = 1.0 + breathe + 0.05 * sleeping
        stir = spring(t, 8.55, 0.25, 3, 4)  # the flash makes it stir
        head_p -= stir
        startle = spring(t, T.TERN_WAKE, 0.35, 5, 6)
        pos.z += max(0.0, startle) * 0.2
        flap += 1.0 * max(0.0, startle) * 3
        pitch = 0.0
        yaw = math.copysign(math.pi, glide_heading)
        if t >= T.TERN_GLARE[0]:
            to_clawd = floe_top(t, 4) - pos
            g = math.atan2(to_clawd.y, to_clawd.x)
            g += TAU * round((yaw - g) / TAU)
            yaw = lerp(yaw, g, ramp(t, *T.TERN_GLARE))
            pitch = 0.25 * ramp(t, *T.TERN_GLARE)
            head_p = 0.2 * ramp(t, *T.TERN_GLARE)
            sc = 1.0 + 0.08 * ramp(t, *T.TERN_GLARE)  # puffed up
        return pos, yaw, pitch, 0.0, flap, head_p, sc
    s = ramp(t, T.TERN_TAKEOFF, T.TERN_GONE)
    start = perch
    end = Vector((-6.8, 1.2, 2.6))
    pos = vlerp(start, end, s)
    pos.z += 0.5 * math.sin(math.pi * s) + 0.08 * math.sin(TAU * t * 4)
    over = floe_top(t, 4) + Vector((0, 0, 0.5))  # buzz past Clawd on the way out
    pos = pos.lerp(over, 0.5 * math.sin(math.pi * clamp(s * 1.6)) * (s < 0.6))
    d = end - start
    yaw = math.atan2(d.y, d.x)
    flap = math.sin(TAU * t * 5.0) * 0.9
    return pos, yaw, -0.15, 0.0, flap, 0.0, 1.0


def aurora_level(t, i):
    base = 0.35 + 0.15 * ramp(t, 0, 1.0)
    land = T.FLOE_LANDINGS[i]
    if t >= land:
        base += 1.6 * math.exp(-(t - land) * 0.9) + 0.9
    if t >= T.FLASH:
        base += 6.0 * math.exp(-(t - T.FLASH) * 2.2) + 0.6
    return base * (1 + 0.12 * math.sin(TAU * t / 2.7 + i))


def lantern_level(t):
    if t < T.TERN_LAND:
        return 1.0
    if t < T.LANTERN_OUT:
        s = ramp(t, T.TERN_LAND, T.LANTERN_OUT)
        return (1 - s) * (0.6 + 0.4 * abs(math.sin(t * 90)))
    if t < T.LANTERN_ON:
        return 0.0
    s = ramp(t, T.LANTERN_ON, T.LANTERN_ON + 0.35)
    flick = 1.0 if s >= 1 else (0.5 + 0.5 * math.sin(t * 140)) ** 2
    return s * flick


def eye_level(t):
    on = ramp(t, T.BEAMS_ON - 0.15, T.BEAMS_ON + 0.1) * (1 - ramp(t, T.BEAMS_OFF - 0.1, T.BEAMS_OFF + 0.2))
    flash = math.exp(-((t - T.FLASH) / 0.06) ** 2)
    return on, flash


glide_heading = _glide_heading()

# ---------------------------------------------------------------- bake keys
flash_track = {}
lid = bpy.data.objects["LidHinge"]
for f in range(1, T.FRAMES + 1):
    t = (f - 1) / T.FPS
    scene.frame_set(f)
    _, sloc, srot = ship_matrix(t)
    ship.location, ship.rotation_euler = sloc, srot
    key(ship, "location", f)
    key(ship, "rotation_euler", f)

    lid.rotation_euler = (0, -1.9 * ramp(t, T.LID_UP, T.LID_UP + 0.18) + spring(t, T.LID_UP + 0.18, 0.15, 4, 8), 0)
    key(lid, "rotation_euler", f)

    swing = 0.12 * math.sin(TAU * t / 1.6) + spring(t, T.TERN_LAND, 0.45, 1.3, 1.6) + spring(t, T.TERN_WAKE, 0.3, 1.3, 2.0)
    hinge.rotation_euler = (0.06 * math.sin(TAU * t / 2.1), swing, 0)
    key(hinge, "rotation_euler", f)
    ll = lantern_level(t)
    lantern_light.energy = 14 * ll
    key(lantern_light, "energy", f)
    gin = M["glass"].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"]
    gin.default_value = 3.5 * ll + 0.05
    gin.keyframe_insert("default_value", frame=f)

    for i, fo in enumerate(floes):
        p, glow, tilt = floe_state(t, i)
        fo.location = p
        fo.rotation_euler = (tilt[0], tilt[1], i * 0.7)
        key(fo, "location", f)
        key(fo, "rotation_euler", f)
        es = fo.material_slots[0].material.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"]
        es.default_value = glow
        es.keyframe_insert("default_value", frame=f)

    pos, yaw, pitch, sq, vis = clawd_state(t)
    if T.FLOE_LANDINGS[0] <= t < T.FLOE_LANDINGS[-1] + 0.5:
        sq += floe_squash(t)
    clawd.location = pos - Vector((0, 0, (1 - sq) * FEET * 0.8))
    clawd.rotation_euler = (pitch, 0, yaw)
    clawd.scale = (1 / math.sqrt(max(sq, 0.3)), 1 / math.sqrt(max(sq, 0.3)), sq) if vis else (0.001,) * 3
    for o in (clawd,):
        key(o, "location", f)
        key(o, "rotation_euler", f)
        key(o, "scale", f)
    key_o.location = pos + Vector((-0.4, -1.5, 1.2))
    key(key_o, "location", f)

    on, flash = eye_level(t)
    happy = ramp(t, T.CARD_IN, T.CARD_IN + 0.15) * (1 - ramp(t, T.TERN_WAKE, T.TERN_WAKE + 0.2))
    for e in eyes:
        e.scale = (1.0, 1.0, 1.0 - 0.62 * happy)
        key(e, "scale", f)
    ei = M["eye"].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"]
    ei.default_value = 40 * on + 400 * flash
    ei.keyframe_insert("default_value", frame=f)
    beam_target.location = beam_target_pos(t) if t >= T.BEAMS_ON - 0.3 else pos + Vector((-2, 0, 0))
    key(beam_target, "location", f)
    for sl in beam_lights:
        sl.energy = 45 * on
        key(sl, "energy", f)
    bs = beam_mat.node_tree.nodes["Strength"].outputs[0]
    bs.default_value = 2.2 * on * (1 - ramp(t, T.FLASH - 0.05, T.FLASH + 0.05))
    bs.keyframe_insert("default_value", frame=f)

    tp, tyaw, tpitch, troll, flap, headp, tsc = tern_state(t)
    tern.location = tp
    tern.rotation_euler = (troll, tpitch, tyaw)
    tern.scale = (tsc,) * 3
    key(tern, "location", f)
    key(tern, "rotation_euler", f)
    key(tern, "scale", f)
    for sh, sy in wings:
        sh.rotation_euler = (sy * flap, 0, 0)
        key(sh, "rotation_euler", f)
    head.rotation_euler = (0, headp, 0)
    key(head, "rotation_euler", f)

    for i, am in enumerate(aurora_mats):
        v = am.node_tree.nodes["Strength"].outputs[0]
        v.default_value = aurora_level(t, i)
        v.keyframe_insert("default_value", frame=f)

    oc.time = 1.0 + t * 0.9
    oc.keyframe_insert("time", frame=f)

    cl, ctg, lens = cam_state(t)
    cl = cl + Vector((0.01 * math.sin(t * 1.3), 0, 0.008 * math.sin(t * 0.9)))
    cam.location, cam_target.location, cam_data.lens = cl, ctg, lens
    key(cam, "location", f)
    key(cam_target, "location", f)
    key(cam_data, "lens", f)

    # exposure bump on the flash (the bloom itself is added in post)
    scene.view_settings.exposure = 0.9 * math.exp(-max(0.0, t - T.FLASH) * 4) * (t >= T.FLASH - 0.02)
    scene.view_settings.keyframe_insert("exposure", frame=f)

# screen positions of the eyes around the flash, for the bloom in post
for f in range(195, 216):
    scene.frame_set(f)
    bpy.context.view_layer.update()
    pts = []
    for e in eyes:
        p = world_to_camera_view(scene, cam, e.matrix_world.translation)
        pts.append((p.x, 1 - p.y))
    flash_track[f] = pts
with open(os.path.join(HERE, "build", "flash_track.json"), "w") as fh:
    json.dump(flash_track, fh)

# report hop speeds (a teleport shows up here before the render)
prev = None
fastest = 0.0
for f in range(1, T.FRAMES + 1):
    p = clawd_state((f - 1) / T.FPS)[0]
    if prev is not None and (f - 1) / T.FPS > T.CLAWD_OUT[0]:
        v = (p - prev).length * T.FPS
        if v > fastest:
            fastest, at = v, f
    prev = p
print(f"fastest Clawd motion: {fastest:.2f} m/s at frame {at}")

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "build", "arctic_tern.blend")
bpy.ops.wm.save_as_mainfile(filepath=out)
print("saved", out)
