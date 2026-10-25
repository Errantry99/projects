"""Builds and animates Episode 2: The Whale (60 s). Run with bpy (Blender 5):
    python episode2.py [out.blend]
Same world as the intro (world.py) in daylight; every motion is computed per frame from episode2_timeline.py."""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import episode2_timeline as T  # noqa: E402
import world  # noqa: E402
from world import *  # noqa: E402,F401,F403  helpers: clamp, smooth, ramp, lerp, vlerp, spring, key, ...

WORLD = world.build(T)
globals().update(vars(WORLD))
scene.cycles.samples = 12

# ---------------------------------------------------------------- daylight
wn = WORLD.world.node_tree
day = wn.nodes.new("ShaderNodeValToRGB")
day.color_ramp.elements[0].color = (0.78, 0.86, 0.95, 1)
day.color_ramp.elements[1].position = 0.55
day.color_ramp.elements[1].color = (0.16, 0.34, 0.72, 1)
wn.links.new(wsep.outputs["Z"], day.inputs["Fac"])
wn.links.new(day.outputs["Color"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 1.0
sun = bpy.data.lights.new("Sun", 'SUN')
sun.color = (1.0, 0.95, 0.88)
sun.energy = 2.6
sun.angle = math.radians(1.5)
sun_o = link(bpy.data.objects.new("Sun", sun))
sun_o.rotation_euler = Vector((0.45, 0.6, -0.65)).to_track_quat('-Z', 'Y').to_euler()
moon.energy = 0.0
fill.energy = 40
keyl.energy = 4
lantern_light.energy = 0.0
M["glass"].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 0.05
for i in range(5):
    bpy.data.objects.remove(bpy.data.objects[f"Aurora{i}"])
M["sea"].node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.01, 0.035, 0.06, 1)
oc.repeat_x = oc.repeat_y = 3
sea.location = (-6 - 48, 14 - 48, -0.03)
lid = bpy.data.objects["LidHinge"]
beam_mat.node_tree.nodes["Strength"].outputs[0].default_value = 0.0  # no eye beams in this one
for sl in beam_lights:
    sl.energy = 0.0
for cone in beam_cones:
    cone.hide_render = True
lid.rotation_euler = (0, -1.9, 0)  # left open since Episode 1

# ---------------------------------------------------------------- the whale (head at -x, origin on the axis under the blowhole)
R, L = 0.55, T.WHALE_LEN
HEAD = 0.9  # head tip is this far ahead of the blowhole
whale = empty("Whale")
whale_mat = principled("WhaleSkin", (0.06, 0.075, 0.09, 1), 0.45, Coat_Weight=0.3)
belly_mat = principled("WhaleBelly", (0.55, 0.58, 0.6, 1), 0.5)


def whale_r(u):
    u = clamp(u)
    return R * abs(math.sin(math.pi * u ** 0.55)) ** 0.9 * (1 - 0.72 * u ** 2.5) + 0.004


NU, NP = 44, 28
wv, wf = [], []
for i in range(NU):
    u = i / (NU - 1)
    x = -HEAD + L * u
    r = whale_r(u)
    for j in range(NP):
        a = TAU * j / NP
        wv.append((x, r * math.cos(a), 0.85 * r * math.sin(a)))
for i in range(NU - 1):
    for j in range(NP):
        a0, a1 = i * NP + j, i * NP + (j + 1) % NP
        wf.append((a0, a1, a1 + NP, a0 + NP))
wbody = mesh_obj("WhaleBody", wv, wf, whale_mat, whale)
wbody.data.materials.append(belly_mat)
for poly in wbody.data.polygons:
    if poly.center.z < -0.12 and poly.center.x < L - HEAD - 0.6:
        poly.material_index = 1
for sy in (-1, 1):
    prim("uv_sphere", "WhaleEye", M["cap"], whale, (-0.55, sy * 0.4, -0.08), scale=(0.035,) * 3, segments=10, ring_count=8)
    fv = [(0.0, 0, 0), (0.35, 0, 0), (0.25, sy * 0.55, -0.12), (0.05, sy * 0.45, -0.1)]
    fl = mesh_obj("Flipper", [(x - 0.25, y + sy * 0.38, z - 0.25) for x, y, z in fv], [(0, 1, 2, 3)], whale_mat, whale)
    fl.modifiers.new("Thick", 'SOLIDIFY').thickness = 0.04
prim("cylinder", "Blowhole", M["cap"], whale, (0, 0, 0.85 * whale_r(HEAD / L) - 0.005), radius=0.04, depth=0.02, vertices=12)
TOP = 0.85 * whale_r(HEAD / L)  # back height above the axis at the blowhole
fluke_hinge = empty("FlukeHinge", (L - HEAD, 0, 0), whale)
fv = [(0, 0, 0), (0.15, 0.7, 0), (0.45, 0.75, 0), (0.3, 0.3, 0), (0.42, 0.0, 0), (0.3, -0.3, 0), (0.45, -0.75, 0), (0.15, -0.7, 0)]
fluke = mesh_obj("Fluke", fv, [(0, 1, 2, 3), (0, 3, 4), (0, 4, 5), (0, 5, 6, 7)], whale_mat, fluke_hinge, smooth_shade=False)
fluke.modifiers.new("Thick", 'SOLIDIFY').thickness = 0.04
bevel(fluke, 0.015, 2)

# ---------------------------------------------------------------- fish, droplets, foam rings, the spout
fish_mat = principled("Fish", (0.7, 0.74, 0.78, 1), 0.25, Metallic=0.6)


def make_fish(name):
    o = empty(name)
    pv, pf = [], []
    for i in range(10):
        u = i / 9
        r = 0.022 * abs(math.sin(math.pi * u ** 0.8)) + 0.001
        for j in range(10):
            a = TAU * j / 10
            pv.append((0.06 - 0.13 * u, r * 0.6 * math.cos(a), r * math.sin(a)))
    for i in range(9):
        for j in range(10):
            a0, a1 = i * 10 + j, i * 10 + (j + 1) % 10
            pf.append((a0, a1, a1 + 10, a0 + 10))
    mesh_obj(name + "Body", pv, pf, fish_mat, o)
    t = mesh_obj(name + "Tail", [(-0.065, 0, 0), (-0.1, 0, 0.03), (-0.1, 0, -0.03)], [(0, 1, 2)], fish_mat, o, smooth_shade=False)
    t.modifiers.new("Thick", 'SOLIDIFY').thickness = 0.004
    o.scale = (0.001,) * 3
    return o


fish_t, fish_c = make_fish("FishTern"), make_fish("FishClawd")
drop_mat = principled("Water", (0.85, 0.92, 1.0, 1), 0.08, Coat_Weight=0.5)
foam_mat = principled("Foam", (0.92, 0.95, 0.98, 1), 0.6)
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1)
drop_mesh = bpy.context.active_object.data
drop_mesh.materials.append(drop_mat)
bpy.data.objects.remove(bpy.context.active_object)
POOL = 170
drops = []
for k in range(POOL):
    o = bpy.data.objects.new(f"Drop{k}", drop_mesh)
    o.visible_shadow = False
    link(o)
    drops.append(o)
rings = [prim("torus", f"Foam{k}", foam_mat, major_radius=1.0, minor_radius=0.06, major_segments=32, minor_segments=6)
         for k in range(4)]
spout_mat = bpy.data.materials.new("Spout")
spout_mat.use_nodes = True
snt = spout_mat.node_tree
sb = snt.nodes["Principled BSDF"]
sb.inputs["Base Color"].default_value = (0.92, 0.96, 1.0, 1)
sb.inputs["Roughness"].default_value = 0.5
sb.inputs["Alpha"].default_value = 0.45
sb.inputs["Coat Weight"].default_value = 0.6
spout = prim("cone", "Spout", spout_mat, radius1=0.05, radius2=0.42, depth=1.0, vertices=24)
sd = spout.modifiers.new("Billow", 'DISPLACE')
sd.texture = bpy.data.textures.new("SpoutNoise", 'CLOUDS')
sd.texture.noise_scale = 0.12
sd.strength = 0.08
spout.modifiers.new("Sub", 'SUBSURF').levels = 1
for v in spout.data.vertices:
    v.co.z += 0.5  # base at the origin, top at z=1
spout.visible_shadow = False


# ---------------------------------------------------------------- motion helpers
def wrap(a):
    return (a + math.pi) % TAU - math.pi


def alerp(a, b, s):
    return a + wrap(b - a) * s


def yaw_to(d):
    return math.atan2(d.x, -d.y)


def heading_of(d):
    return math.atan2(d.y, d.x)


def hop(a, b, s, h):
    p = vlerp(a, b, s)
    p.z += 4 * h * s * (1 - s)
    return p


def flap_wave(t, hz=3.2, amp=0.75):
    return math.sin(TAU * t * hz) * amp


def accel(t):
    """Extra distance once the wind picks up for the sail-on."""
    return 0.025 * max(0.0, t - T.WHALE_DIVE[0]) ** 2


def ship_matrix(t):
    x = T.SHIP_X0 - 0.03 * t - accel(t)
    z = 0.02 * math.sin(TAU * t / 3.4)
    rot = Euler((0.025 * math.sin(TAU * t / 3.9), 0.02 * math.sin(TAU * t / 3.4 + 1.0), 0.0))
    return Matrix.Translation((x, 0, z)) @ rot.to_matrix().to_4x4(), (x, 0, z), rot


def ship_point(t, local):
    return ship_matrix(t)[0] @ Vector(local)


def sea_z(p, t):
    return 0.02 * math.sin(TAU * t / 2.6 + p.x * 1.3) + 0.012 * math.sin(TAU * t / 1.7 + p.y * 2.1)


# local spots on the ship
BARREL_TOP = BARREL + Vector((0, 0, BH))
INSIDE = BARREL_TOP + Vector((0, 0, -0.27))
DECK_SPOT = Vector((-0.08, -0.22, T.DECK_Z))
BOW_SPOTS = [Vector((-0.72, -0.04, T.DECK_Z + 0.03)), Vector((-1.2, 0, 0.69)), Vector((-1.44, 0, 0.76))]
PERCH = Vector((POST_X - 0.1, 0, 1.05 + 0.052))
RIM = BARREL_TOP + Vector((0.16, -0.02, 0.068))
DIVE_LOCAL = Vector((-2.0, -1.15, 0.0))
SPOT = ship_point(T.DIVE[0], DIVE_LOCAL)  # where Clawd lands in the sea: the whale comes up right under it
SPOT.z = 0.0
TERN_DIVE_AT = ship_point(T.TERN_DIVE, (-2.5, 1.0, 0.0))
TERN_DIVE_AT.z = 0.0


# ---------------------------------------------------------------- the whale
def whale_state(t):
    """Returns origin (on the axis below the blowhole), pitch, fluke roll, fluke pitch."""
    x = SPOT.x - 0.05 * max(0.0, t - T.FLIGHT[0]) - accel(t)
    z = -1.6
    z = lerp(z, -0.75, ramp(t, *T.BULGE))
    z = lerp(z, 0.18, ramp(t, *T.WHALE_RISE))
    z += 0.03 * math.sin(TAU * t / 3.0) * ramp(t, *T.WHALE_RISE)
    z = lerp(z, 0.05, ramp(t, T.FLIGHT[0] + 0.5, T.FLIGHT[1]))
    pitch, froll, fpitch = 0.0, 0.0, 0.08 * math.sin(TAU * t / 2.5)
    up = ramp(t, *T.FLUKE_UP) * (1 - ramp(t, T.TAIL_SLAP - 0.35, T.TAIL_SLAP))
    pitch -= 0.5 * up
    z -= 0.35 * up
    froll = 0.35 * math.sin(TAU * 1.6 * (t - T.FLUKE_UP[0])) * ramp(t, T.FLUKE_UP[1] - 1.0, T.FLUKE_UP[1]) * up
    fpitch -= 0.6 * up
    fpitch += spring(t, T.TAIL_SLAP, -0.5, 2.0, 4.0)
    dive = ramp(t, T.WHALE_DIVE[1] - 2.0, T.WHALE_DIVE[1] + 1.0)
    pitch -= 0.35 * math.sin(math.pi * dive)
    z = lerp(z, -1.8, dive)
    return Vector((x, SPOT.y - 0.05, z)), pitch, froll, fpitch


def whale_matrix(t):
    o, pitch, _, _ = whale_state(t)
    return Matrix.Translation(o) @ Euler((0, pitch, 0)).to_matrix().to_4x4()


def whale_top(t):
    return whale_matrix(t) @ Vector((0, 0, TOP))


def whale_tail(t):
    return whale_matrix(t) @ Vector((L - HEAD + 0.25, 0, 0))


# ---------------------------------------------------------------- Clawd
UP = Vector((0, 0, FEET))


def clawd_state(t):
    """Returns centre position, yaw, pitch, roll, squash."""
    sq, pitch, roll = 1.0, 0.0, 0.0
    if t < T.BOW_HOPS[0][0]:  # on deck, watching the tern
        pos = ship_point(t, DECK_SPOT) + UP
        yaw = yaw_to(tern_state(t)[0] - pos)
        sq -= 0.15 * ramp(t, T.BOW_HOPS[0][0] - 0.15, T.BOW_HOPS[0][0])
        return pos, yaw, pitch, roll, sq
    spots = [DECK_SPOT] + BOW_SPOTS
    for i, (t0, t1) in enumerate(T.BOW_HOPS):
        a, b = ship_point(t0, spots[i]), ship_point(t1, spots[i + 1])
        if t < t1:
            s = (t - t0) / (t1 - t0)
            return hop(a, b, s, 0.2) + UP, yaw_to(b - a), 0.0, 0.0, 1.0 + 0.1 * math.sin(math.pi * s)
        nxt = T.BOW_HOPS[i + 1][0] if i + 1 < len(T.BOW_HOPS) else T.DIVE[0]
        if t < nxt:
            pos = ship_point(t, spots[i + 1]) + UP
            yaw = yaw_to(Vector((-1, 0, 0)))
            sq = 1.0 + spring(t, t1, -0.15, 4, 8)
            if i == 2:
                pitch = 0.45 * ramp(t, *T.LOOK_DOWN) * (1 - ramp(t, T.WIGGLE[0], T.WIGGLE[0] + 0.2))
                w = ramp(t, *T.WIGGLE)
                roll = 0.25 * math.sin(TAU * 4 * t) * math.sin(math.pi * w)
                sq += 0.08 * math.sin(TAU * 4 * t + 1) * math.sin(math.pi * w) - 0.25 * ramp(t, T.DIVE[0] - 0.2, T.DIVE[0])
            return pos, yaw, pitch, roll, sq
    if t < T.DIVE[1]:  # a flip, then flat on his belly
        s = ramp(t, *T.DIVE) * 0.4 + 0.6 * (t - T.DIVE[0]) / (T.DIVE[1] - T.DIVE[0])
        a, b = ship_point(T.DIVE[0], BOW_SPOTS[-1]), SPOT + Vector((0, 0, 0.0))
        return hop(a, b, s, 0.45) + UP, yaw_to(b - a), (TAU + math.pi / 2) * smooth(s), 0.0, 1.0
    if t < T.BOB_UP:  # under
        s = ramp(t, *T.UNDER)
        return SPOT + Vector((0, 0, -0.35 * math.sin(math.pi * min(1, s * 1.4)))), yaw_to(Vector((-1, 0, 0))), (math.pi / 2) * (1 - s), 0.0, 1.0
    float_pos = SPOT + Vector((0, 0, sea_z(SPOT, t) - 0.07)) + UP
    if t < T.WHALE_RISE[0]:  # bobbing, dripping
        pos = float_pos + Vector((0, 0, max(0.0, spring(t, T.BOB_UP, 0.12, 1.5, 3.0))))
        yaw = alerp(yaw_to(Vector((-1, 0, 0))), 0.0, ramp(t, T.BOB_UP + 0.3, T.SPIT - 0.1))
        yaw = alerp(yaw, yaw_to(ship_point(t, PERCH) - pos), ramp(t, T.TERN_LAUGH[0], T.TERN_LAUGH[0] + 0.4))
        yaw = alerp(yaw, 0.0, ramp(t, T.BULGE[0], T.BULGE[1]))
        sq += spring(t, T.SPIT, 0.15, 5, 8) + 0.1 * ramp(t, *T.BULGE) * math.sin(TAU * 6 * t)  # the water trembles
        return pos, yaw, 0.0, 0.0, sq
    if t < T.FLIGHT[0]:  # on the whale's back
        top = whale_top(t) + UP
        pos = float_pos.lerp(top, ramp(t, T.WHALE_RISE[0], T.WHALE_RISE[0] + 0.8)) if t < T.WHALE_RISE[0] + 0.8 else top
        pitch = 0.4 * ramp(t, T.WHALE_RISE[1] - 0.5, T.WHALE_RISE[1]) * (1 - ramp(t, *T.UH_OH))
        yaw = 0.0
        pos = pos + Vector((0, 0, max(0.0, spring(t, T.PUFF, 0.12, 2, 5))))
        sq += spring(t, T.PUFF, -0.2, 4, 7) - 0.2 * ramp(t, T.SPOUT - 0.25, T.SPOUT)
        return pos, yaw, pitch, 0.0, sq
    if t < T.FLIGHT[1]:  # launched by the spout, tumbling, into the barrel
        s = (t - T.FLIGHT[0]) / (T.FLIGHT[1] - T.FLIGHT[0])
        a, b = whale_top(T.FLIGHT[0]) + UP, ship_point(T.FLIGHT[1], INSIDE) + UP
        pos = hop(a, b, s, 2.6)
        return pos, yaw_to(b - a), TAU * 2 * smooth(s), 1.3 * math.sin(math.pi * s), 1.0 + 0.15 * math.sin(math.pi * s)
    # back in the barrel; peeks with a fish; climbs onto the rim
    peek = ramp(t, T.PEEK, T.PEEK + 0.4)
    out = ramp(t, T.OFFER[0] - 0.6, T.OFFER[0] - 0.1)
    foot = (INSIDE + Vector((0, 0, 0.19 * peek))).lerp(BARREL_TOP, out) + Vector((0, 0, 0.08 * math.sin(math.pi * out)))
    pos = ship_point(t, foot) + UP
    yaw = yaw_to(ship_point(t, RIM) - pos) if t > T.PEEK + 0.5 else 0.0
    yaw = alerp(0.0, yaw, ramp(t, T.PEEK + 0.5, T.PEEK + 0.9))
    pitch = -0.3 * ramp(t, *T.OFFER) * (1 - ramp(t, T.OFFER[1], T.OFFER[1] + 0.3))
    if t > T.WHALE_DIVE[0]:
        yaw = alerp(yaw, yaw_to(whale_top(t) - pos), ramp(t, T.WHALE_DIVE[0], T.WHALE_DIVE[0] + 0.6) * (1 - ramp(t, 54.0, 54.6)))
    if t > 54.6:  # turns to the lens for the ending
        yaw = alerp(yaw, yaw_to(shot(t)[0] - pos), ramp(t, 54.6, 55.2))
    sq += spring(t, T.FLIGHT[1], -0.3, 4, 6) if t < T.PEEK else 0.0
    return pos, yaw, pitch, 0.0, sq


# ---------------------------------------------------------------- the tern (forward = +X)
def tern_state(t):
    """Returns position, yaw, pitch, roll, flap, head pitch, scale, fold."""
    perch = ship_point(t, PERCH)
    if t < T.TERN_TAKEOFF:  # on the lantern arm, preening
        return perch, math.pi, 0.0, 0.0, 0.0, 0.3 * max(0.0, math.sin(TAU * t / 1.7)) ** 8, 1.0, 1.0
    if t < T.TERN_DIVE - 0.7:  # out over the water, climbing, circling
        s = ramp(t, T.TERN_TAKEOFF, T.TERN_DIVE - 0.7)
        c = TERN_DIVE_AT + Vector((0.3, 0.2, 0))
        ph = math.pi * 0.6 + TAU * 0.9 * s
        ring = c + Vector((1.1 * math.cos(ph), 1.1 * math.sin(ph), 1.2 + 1.2 * s))
        pos = perch.lerp(ring, smooth(s / 0.35)) if s < 0.35 else ring
        return pos, ph + math.pi / 2, 0.0, -0.4, flap_wave(t, 3.4), 0.0, 1.0, 0.0
    if t < T.TERN_DIVE:  # the dive, wings folded back
        s = ramp(t, T.TERN_DIVE - 0.7, T.TERN_DIVE)
        c = TERN_DIVE_AT + Vector((0.3, 0.2, 0))
        ph = math.pi * 0.6 + TAU * 0.9
        a = c + Vector((1.1 * math.cos(ph), 1.1 * math.sin(ph), 2.4))
        pos = a.lerp(TERN_DIVE_AT, s ** 1.6)
        return pos, heading_of(TERN_DIVE_AT - a), 1.2 * smooth(s / 0.4), 0.0, 0.0, 0.0, 1.0, smooth(s / 0.3)
    if t < T.TERN_SURFACE:
        return TERN_DIVE_AT + Vector((0, 0, -0.3)), 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0
    if t < T.TERN_BACK:  # up with a fish, back to the lantern arm
        s = ramp(t, T.TERN_SURFACE, T.TERN_BACK)
        pos = TERN_DIVE_AT.lerp(perch, s)
        pos.z += 0.7 * math.sin(math.pi * s)
        return pos, heading_of(perch - TERN_DIVE_AT), -0.4 * (1 - s), 0.0, flap_wave(t, 4.5, 0.9) * (1 - smooth((s - 0.8) / 0.2)), 0.0, 1.0, smooth((s - 0.85) / 0.15)
    if t < 27.5:  # perched: the gulp, then laughing at Clawd
        hp = -0.6 * math.exp(-((t - T.GULP) / 0.15) ** 2)
        hp += sum(-0.35 * math.exp(-((t - tl_) / 0.1) ** 2) for tl_ in T.TERN_LAUGH)
        face = heading_of(SPOT - perch) if t > T.DIVE[0] else math.pi
        return perch, face, 0.0, 0.0, 0.0, hp, 1.0 + 0.04 * math.sin(TAU * t * 8) * ramp(t, T.TERN_LAUGH[0], T.TERN_LAUGH[-1]) * (t < T.TERN_LAUGH[-1] + 0.3), 1.0
    if t < T.FLIGHT[0]:  # startled up: circling over Clawd and the whale
        s = ramp(t, 27.5, 28.3)
        c = whale_top(t) + Vector((0, 0, 1.0))
        ph = TAU * (t - 27.5) / 1.8
        ring = c + Vector((0.8 * math.cos(ph), 0.8 * math.sin(ph), 0.15 * math.sin(2 * ph)))
        pos = perch.lerp(ring, smooth(s))
        return pos, ph + math.pi / 2, 0.0, -0.5, flap_wave(t, 6, 1.0), -0.2, 1.0, 0.0
    if t < T.TERN_TO_BARREL[0]:  # chases Clawd's flight, then circles the ship
        c = ship_point(t, (MAST_X, 0, 2.0))
        ph = TAU * (t - T.FLIGHT[0]) / 3.0
        ring = c + Vector((1.2 * math.cos(ph), 1.2 * math.sin(ph), 0.2 * math.sin(ph)))
        start = whale_top(T.FLIGHT[0]) + Vector((0.8, 0, 1.0))
        pos = start.lerp(ring, smooth((t - T.FLIGHT[0]) / 1.5))
        return pos, ph + math.pi / 2, 0.0, -0.4, flap_wave(t, 3.5), 0.0, 1.0, 0.0
    if t < T.TERN_TO_BARREL[1]:
        s = ramp(t, *T.TERN_TO_BARREL)
        c = ship_point(t, (MAST_X, 0, 2.0))
        ph = TAU * (T.TERN_TO_BARREL[0] - T.FLIGHT[0]) / 3.0
        a = c + Vector((1.2 * math.cos(ph), 1.2 * math.sin(ph), 0.2 * math.sin(ph)))
        b = ship_point(t, RIM)
        pos = a.lerp(b, s)
        pos.z += 0.3 * math.sin(math.pi * s)
        return pos, heading_of(b - a), 0.0, 0.0, flap_wave(t, 4, 0.8) * (1 - s), 0.0, 1.0, smooth((s - 0.8) / 0.2)
    # on the barrel rim, facing in
    rim = ship_point(t, RIM)
    face = heading_of(ship_point(t, BARREL_TOP) - rim)
    lean = 0.35 * ramp(t, T.PEEK, T.PEEK + 0.3) * (1 - ramp(t, T.OFFER[1], T.OFFER[1] + 0.3))
    toss = math.exp(-((t - T.TOSS) / 0.12) ** 2) * -0.8 + math.exp(-((t - T.TOSS - 0.55) / 0.1) ** 2) * -0.5
    nod = 0.45 * math.exp(-((t - T.HAPPY) / 0.1) ** 2)
    if t >= 55.3:  # onto Clawd's head
        s = ramp(t, 55.3, 55.9)
        head_top = clawd_state(t)[0] + Vector((0, 0, BODY[2] / 2 + 0.068))
        p = rim.lerp(head_top, s)
        p.z += 0.15 * math.sin(math.pi * s)
        face = alerp(face, heading_of(ship_point(t, (-3, 0, 0)) - head_top), s)
        return p, face, 0.0, 0.0, 0.5 * math.sin(math.pi * s), 0.0, 1.0, 1.0 - math.sin(math.pi * s)
    return rim, face, lean * 0.6, 0.0, 0.0, lean + toss + nod, 1.0, 1.0


def tern_matrix(t):
    p, yaw, pitch, roll, *_ = tern_state(t)
    return Matrix.Translation(p) @ Euler((roll, pitch, yaw)).to_matrix().to_4x4()


def beak(t):
    return tern_matrix(t) @ Vector((0.19, 0, 0.025))


# ---------------------------------------------------------------- fish
def fish_state(t):
    """(tern's fish loc, scale), (Clawd's fish loc, scale); both held crosswise."""
    ft, fts = Vector((0, 0, -5)), 0.001
    if T.TERN_SURFACE <= t < T.GULP + 0.2:
        ft, fts = beak(t), 1.0 - ramp(t, T.GULP, T.GULP + 0.2) * 0.999
    fc, fcs = Vector((0, 0, -5)), 0.001
    if T.PEEK <= t < T.TOSS + 0.6:
        c = clawd_state(t)
        mouth = Matrix.Translation(c[0]) @ Euler((c[2], 0, c[1])).to_matrix().to_4x4() @ Vector((0, -BODY[1] / 2 - 0.02, -0.01))
        fc, fcs = mouth, 1.0
        if t >= T.OFFER[0]:
            fc = mouth.lerp(beak(t), ramp(t, *T.OFFER))
        if t >= T.TOSS:
            s = ramp(t, T.TOSS, T.TOSS + 0.55)
            fc = beak(t) + Vector((0, 0, 0.45 * math.sin(math.pi * s)))
            fcs = 1.0 - ramp(t, T.TOSS + 0.5, T.TOSS + 0.6) * 0.999
    return (ft, fts), (fc, fcs)


# ---------------------------------------------------------------- splashes
rng = np.random.default_rng(11)
BURSTS = []  # (t0, centre, count, up speed, side speed, size)


def burst(t0, c, n, up, side, size=0.022):
    BURSTS.append((t0, None if c is None else Vector(c), n, up, side, size))


burst(T.TERN_DIVE, TERN_DIVE_AT, 14, 2.0, 0.6)
burst(T.TERN_SURFACE, TERN_DIVE_AT, 8, 1.4, 0.4, 0.016)
burst(T.DIVE[1], SPOT, 24, 2.6, 0.9, 0.026)
burst(T.BOB_UP, SPOT, 6, 1.2, 0.3, 0.016)
burst(T.WHALE_RISE[0] + 0.3, SPOT, 16, 1.6, 0.8, 0.024)
burst(T.PUFF, None, 10, 2.0, 0.25, 0.018)            # None: from the blowhole at that moment
burst(T.TAIL_SLAP, None, 34, 3.4, 1.3, 0.03)         # None after the puff: from the tail
burst(T.LAST_SPOUT, None, 14, 3.0, 0.3, 0.02)
RINGS = [(T.TERN_DIVE, TERN_DIVE_AT, 0.5), (T.DIVE[1], SPOT, 0.8), (T.WHALE_RISE[0], SPOT, 1.4), (T.TAIL_SLAP, None, 1.6)]
SPOUTS = [(T.PUFF, 0.5, 0.15, 0.2, 0.4), (T.SPOUT, 3.3, 0.25, 0.55, 0.8), (T.LAST_SPOUT, 1.4, 0.2, 0.3, 0.6)]  # t0, height, rise, hold, fall

drop_paths = []  # (t0, p0, v, size, t_end)
k = 0
for t0, c, n, up, side, size in BURSTS:
    if c is None:
        c = whale_tail(t0) if t0 == T.TAIL_SLAP else whale_top(t0) + Vector((0, 0, 0.02))
        c.z = max(c.z, 0.0)
    for _ in range(n):
        a = rng.uniform(0, TAU)
        v = Vector((side * math.cos(a) * rng.uniform(0.4, 1.0), side * math.sin(a) * rng.uniform(0.4, 1.0), up * rng.uniform(0.6, 1.1)))
        drop_paths.append((t0, c.copy(), v, size * rng.uniform(0.6, 1.3)))
for _ in range(40):  # rain from the big spout
    t0 = rng.uniform(T.SPOUT + 0.35, T.SPOUT + 0.9)
    a = rng.uniform(0, TAU)
    c = whale_top(T.SPOUT) + Vector((0, 0, 3.0 * rng.uniform(0.7, 1.0)))
    v = Vector((1.1 * math.cos(a) * rng.uniform(0.3, 1.0), 1.1 * math.sin(a) * rng.uniform(0.3, 1.0), rng.uniform(0.0, 1.2)))
    drop_paths.append((t0, c, v, 0.025 * rng.uniform(0.6, 1.3)))
assert len(drop_paths) <= POOL, len(drop_paths)
G = Vector((0, 0, -9.8))


def drop_pos(path, t):
    t0, p0, v, size = path
    d = t - t0
    if d < 0:
        return None
    p = p0 + v * d + 0.5 * G * d * d
    return None if p.z < -0.05 else p


def spout_height(t):
    h = 0.0
    for t0, hmax, rise, hold, fall in SPOUTS:
        d = t - t0
        if 0 <= d < rise + hold + fall:
            h = max(h, hmax * (smooth(d / rise) if d < rise else 1.0 if d < rise + hold else 1 - smooth((d - rise - hold) / fall)))
    return h


# ---------------------------------------------------------------- camera
def shot(t):
    def sp(local):
        return ship_point(t, local)

    if t < T.TERN_DIVE - 0.8:  # 1. a sunny morning
        return sp((-3.4, -3.7, 1.35)), sp((-0.5, 0, 1.0)), 30.0
    if t < T.GULP + 0.6:  # the tern's dive, from across the deck
        return sp((-1.6, -2.9, 1.25)), vlerp(sp((-1.4, 0.4, 0.9)), tern_state(t)[0], 0.35), 30.0
    if t < T.LOOK_DOWN[0]:  # 2. Clawd heads for the bowsprit
        return sp((-1.5, -2.6, 1.05)), sp((-0.9, -0.1, 0.78)), 32.0
    if t < T.DIVE[0] - 0.1:  # looking down at the water
        return sp((-2.1, -1.45, 0.9)), sp(BOW_SPOTS[-1] + Vector((0, 0, 0.1))), 40.0
    if t < T.BULGE[0] - 0.5:  # the belly flop; the tern laughs
        return SPOT + Vector((1.2, -2.9, 0.85)), vlerp(SPOT, sp(PERCH), 0.42) + Vector((0, 0, 0.1)), 30.0
    if t < T.REVEAL[0]:  # 3. lifted out of the sea
        c = clawd_state(t)[0]
        return SPOT + Vector((0.55, -1.7, 0.35 + 0.5 * ramp(t, *T.WHALE_RISE))), c, 38.0
    if t < T.FLIGHT[0] - 0.1:  # pull wide: the whole whale
        k_ = ramp(t, T.REVEAL[0], T.REVEAL[1])
        return SPOT + Vector((1.0, -2.6, 0.7)).lerp(Vector((1.5, -6.2, 1.5)), k_), SPOT + Vector((1.3, 0, 0.5)), 30.0
    if t < T.FLIGHT[1] + 0.4:  # 4. the flight
        mid = (SPOT + ship_point(T.FLIGHT[1], BARREL)) / 2
        return Vector((mid.x + 0.6, mid.y - 6.4, 1.8)), vlerp(mid + Vector((0, 0, 1.4)), clawd_state(t)[0], 0.5), 28.0
    if t < T.TAIL_SLAP + 0.7:  # the fluke and the slap
        tail = whale_tail(t)
        return Vector((tail.x - 1.0, -6.2, 1.3)), Vector((tail.x - 1.6, -0.6, 0.7)), 30.0
    if t < T.WHALE_DIVE[0] - 0.2:  # the barrel, the fish, the gift
        return sp((-0.3, -1.6, 0.95)), sp((-0.4, 0.0, 0.8)), 38.0
    if t < 54.4:  # 5. sailing on with the whale alongside
        return sp((-4.2, -4.4, 1.5)), sp((0.4, -0.7, 0.75)), 28.0
    k_ = ramp(t, 54.4, T.DURATION)
    return sp(Vector((-1.2, -1.35, 1.15)).lerp(Vector((-1.05, -1.2, 1.1)), k_)), sp((-0.42, 0.04, 0.88)), 36.0


# ---------------------------------------------------------------- bake keys
states_c = [clawd_state((f - 1) / T.FPS) for f in range(1, T.FRAMES + 1)]
states_t = [tern_state((f - 1) / T.FPS) for f in range(1, T.FRAMES + 1)]
c_yaw = np.unwrap([s[1] for s in states_c])
t_yaw = np.unwrap([s[1] for s in states_t])
HIDE = Vector((0, 0, -20))

for f in range(1, T.FRAMES + 1):
    t = (f - 1) / T.FPS
    _, sloc, srot = ship_matrix(t)
    ship.location, ship.rotation_euler = sloc, srot
    key(ship, "location", f)
    key(ship, "rotation_euler", f)
    hinge.rotation_euler = (0.04 * math.sin(TAU * t / 2.1), 0.08 * math.sin(TAU * t / 1.6), 0)
    key(hinge, "rotation_euler", f)

    lid.rotation_euler = (0, -1.9 + spring(t, T.FLIGHT[1], 0.25, 4, 6), 0)
    key(lid, "rotation_euler", f)

    for i, fo in enumerate(floes):
        fx, fy = T.FLOES[i]
        fo.location = (fx, fy, 0.03 + 0.012 * math.sin(TAU * t / 2.3 + i))
        key(fo, "location", f)

    pos, _, pitch, roll, sq = states_c[f - 1]
    clawd.location = pos - Vector((0, 0, (1 - sq) * FEET * 0.8))
    clawd.rotation_euler = (pitch, roll, c_yaw[f - 1])
    k_ = 1 / math.sqrt(max(sq, 0.3))
    clawd.scale = (k_, k_, sq)
    for path in ("location", "rotation_euler", "scale"):
        key(clawd, path, f)
    key_o.location = pos + Vector((-0.4, -1.5, 1.2))
    key(key_o, "location", f)
    happy = ramp(t, T.HAPPY, T.HAPPY + 0.15)
    for e in eyes:
        e.scale = (1.0, 1.0, 1.0 - 0.62 * happy + 0.35 * ramp(t, *T.UH_OH) * (1 - ramp(t, T.SPOUT, T.SPOUT + 0.2)))  # wide-eyed on the whale
        key(e, "scale", f)

    ts = states_t[f - 1]
    tp, _, tpitch, troll, flap, headp, tsc, fold = ts
    hidden = T.TERN_DIVE <= t < T.TERN_SURFACE
    tern.location = HIDE if hidden else tp
    tern.rotation_euler = (troll, tpitch, t_yaw[f - 1])
    tern.scale = (tsc,) * 3
    for path in ("location", "rotation_euler", "scale"):
        key(tern, path, f)
    for sh, sy in wings:
        sh.rotation_euler = (sy * flap * (1 - fold), 0, sy * 1.45 * fold)
        key(sh, "rotation_euler", f)
    head.rotation_euler = (0, headp, 0)
    key(head, "rotation_euler", f)

    (ft, fts), (fc, fcs) = fish_state(t)
    for o, p, s_, owner in ((fish_t, ft, fts, "t"), (fish_c, fc, fcs, "c")):
        o.location = p
        o.scale = (s_,) * 3
        yaw = t_yaw[f - 1] + math.pi / 2 if owner == "t" or t >= T.OFFER[1] else c_yaw[f - 1]
        o.rotation_euler = (0, 0.4 * math.sin(TAU * 3 * t), yaw)
        for path in ("location", "scale", "rotation_euler"):
            key(o, path, f)

    wo, wpitch, froll, fpitch = whale_state(t)
    whale.location, whale.rotation_euler = wo, (0, wpitch, 0)
    key(whale, "location", f)
    key(whale, "rotation_euler", f)
    fluke_hinge.rotation_euler = (froll, fpitch, 0)
    key(fluke_hinge, "rotation_euler", f)

    for path, o in zip(drop_paths, drops):
        p = drop_pos(path, t)
        o.location = HIDE if p is None else p
        o.scale = (path[3],) * 3
        key(o, "location", f)
        key(o, "scale", f)
    for o in drops[len(drop_paths):]:
        if f == 1:
            o.location = HIDE
            key(o, "location", f)

    for o, ring in zip(rings, RINGS):
        t0, c, rmax = ring
        if c is None:
            c = whale_tail(t0)
            c.z = 0
        d = t - t0
        if 0 <= d < 1.6:
            s = smooth(d / 1.6)
            o.location = (c.x, c.y, 0.01 - 0.06 * s)
            o.scale = (0.2 + rmax * s, 0.2 + rmax * s, 1.0 - 0.6 * s)
        else:
            o.location, o.scale = HIDE, (0.001,) * 3
        key(o, "location", f)
        key(o, "scale", f)

    h = spout_height(t)
    spout.location = whale_top(t) + Vector((0, 0, -0.02)) if h > 0.15 else HIDE
    spout.scale = (1.0 + 0.3 * h, 1.0 + 0.3 * h, max(h, 0.001))
    key(spout, "location", f)
    key(spout, "scale", f)

    oc.time = 1.0 + t * 0.9
    oc.keyframe_insert("time", frame=f)

    cl, ctg, lens = shot(t)
    cam.location, cam_target.location, cam_data.lens = cl, ctg, lens
    key(cam, "location", f)
    key(cam_target, "location", f)
    key(cam_data, "lens", f)

fastest, at = 0.0, 0
for f in range(2, T.FRAMES + 1):
    v = (states_c[f - 1][0] - states_c[f - 2][0]).length * T.FPS
    if v > fastest:
        fastest, at = v, f
print(f"fastest Clawd motion: {fastest:.2f} m/s at frame {at}")

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "build", "episode2.blend")
bpy.ops.wm.save_as_mainfile(filepath=out)
print("saved", out)
