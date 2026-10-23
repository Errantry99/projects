"""The shared world of The Voyage of the Arctic Tern: helpers plus build(T), which makes the sea,
the ship, Clawd, the tern, the ice, the aurora, the lights and the camera. T is a timeline-like
module (FPS, FRAMES, DECK_Z, FLOES, ICEBERG). Run with bpy (Blender 5)."""
import math
import os
from types import SimpleNamespace

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
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



def build(T):
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

    return SimpleNamespace(**locals())
