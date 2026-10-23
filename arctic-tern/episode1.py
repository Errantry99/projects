"""Builds and animates Episode 1: The Stowaway (60 s). Run with bpy (Blender 5):
    python episode1.py [out.blend]
Same world as the intro (world.py); every motion is computed per frame from episode1_timeline.py."""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import episode1_timeline as T  # noqa: E402
import world  # noqa: E402
from world import *  # noqa: E402,F401,F403  helpers: clamp, smooth, ramp, lerp, vlerp, spring, key, ...

WORLD = world.build(T)
globals().update(vars(WORLD))
scene.cycles.samples = 12

# ---------------------------------------------------------------- additions to the world
# a crow's nest big enough for Clawd
NEST_Z = 2.34
bpy.data.objects.remove(bpy.data.objects["Nest"])
prim("cylinder", "NestFloor", M["wood"], ship, (MAST_X, 0, NEST_Z - 0.02), radius=0.25, depth=0.04, vertices=24)
rim = prim("cylinder", "NestRim", M["wood"], ship, (MAST_X, 0, NEST_Z + 0.05), radius=0.25, depth=0.1, vertices=24,
           end_fill_type='NOTHING')
rim.modifiers.new("Thick", 'SOLIDIFY').thickness = 0.02
prim("torus", "NestHoop", M["iron"], ship, (MAST_X, 0, NEST_Z + 0.1), major_radius=0.255, minor_radius=0.01,
     major_segments=32, minor_segments=6)

# the two bergs either side of the gap
for name, (bx, by), s in (("BergAhead", T.BERG_AHEAD, (0.8, 0.8, 1.7)), ("BergSouth", T.BERG_SOUTH, (1.0, 0.9, 2.1))):
    b2 = berg.copy()
    b2.data = berg.data
    b2.name = name
    b2.location, b2.scale = (bx, by, 0.3), s
    b2.rotation_euler = (0.05, -0.04, bx)
    scene.collection.objects.link(b2)

# a sea big enough that its edge never shows at dawn
oc.repeat_x = oc.repeat_y = 3
sea.location = (-6 - 48, 14 - 48, -0.03)

# longer beams to cut through the fog
for cone in beam_cones:
    cone.scale = (1.4, 2.6, 1.4)


# depth fog: camera-facing cards at increasing distances; each one veils whatever lies behind it
def fog_material():
    m = bpy.data.materials.new("Fog")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    mix = nt.nodes.new("ShaderNodeMixShader")
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    em = nt.nodes.new("ShaderNodeEmission")
    col = nt.nodes.new("ShaderNodeRGB")
    col.name = "FogColor"
    nt.links.new(col.outputs[0], em.inputs["Color"])
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.name = "Drift"
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 0.35
    nz.inputs["Detail"].default_value = 3.0
    nt.links.new(mp.outputs[0], nz.inputs["Vector"])
    rng_ = nt.nodes.new("ShaderNodeMapRange")
    rng_.inputs["From Min"].default_value = 0.3
    rng_.inputs["From Max"].default_value = 0.7
    rng_.inputs["To Min"].default_value = 0.55
    nt.links.new(nz.outputs["Fac"], rng_.inputs["Value"])
    dens = nt.nodes.new("ShaderNodeValue")
    dens.name = "Density"
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = 'MULTIPLY'
    mul.use_clamp = True
    nt.links.new(rng_.outputs["Result"], mul.inputs[0])
    nt.links.new(dens.outputs[0], mul.inputs[1])
    nt.links.new(mul.outputs[0], mix.inputs["Fac"])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return m


fog_mat = fog_material()
for d in (2.2, 3.4, 5.0, 7.5, 11.0, 16.0):
    w, h = 1.9 * d, 1.1 * d
    card = mesh_obj("FogCard", [(-w / 2, -h / 2, -d), (w / 2, -h / 2, -d), (w / 2, h / 2, -d), (-w / 2, h / 2, -d)],
                    [(0, 1, 2, 3)], fog_mat, cam, smooth_shade=False)
    card.visible_shadow = False
    for attr in ("visible_diffuse", "visible_glossy", "visible_transmission", "visible_volume_scatter"):
        setattr(card, attr, False)

# dawn: a second sky mixed over the night one, plus a low warm sun
wn = WORLD.world.node_tree
dawn_ramp = wn.nodes.new("ShaderNodeValToRGB")
dawn_ramp.color_ramp.elements[0].color = (0.95, 0.38, 0.16, 1)
dawn_ramp.color_ramp.elements[1].position = 0.5
dawn_ramp.color_ramp.elements[1].color = (0.06, 0.1, 0.26, 1)
dawn_ramp.color_ramp.elements.new(0.12).color = (0.75, 0.42, 0.42, 1)
wn.links.new(wsep.outputs["Z"], dawn_ramp.inputs["Fac"])
sky_mix = wn.nodes.new("ShaderNodeMix")
sky_mix.data_type = 'RGBA'
wn.links.new(sadd.outputs[2], sky_mix.inputs[6])
wn.links.new(dawn_ramp.outputs["Color"], sky_mix.inputs[7])
wn.links.new(sky_mix.outputs[2], bg.inputs["Color"])
dawn_fac = sky_mix.inputs["Factor"]

sun = bpy.data.lights.new("Sun", 'SUN')
sun.color = (1.0, 0.62, 0.38)
sun.angle = math.radians(2)
sun_o = link(bpy.data.objects.new("Sun", sun))
sun_o.rotation_euler = Vector((-1.0, 0.25, -0.12)).to_track_quat('-Z', 'Y').to_euler()

lid = bpy.data.objects["LidHinge"]


# ---------------------------------------------------------------- motion helpers
def wrap(a):
    return (a + math.pi) % TAU - math.pi


def alerp(a, b, s):
    return a + wrap(b - a) * s


def yaw_to(d):
    return math.atan2(d.x, -d.y)


def hop(a, b, s, h):
    p = vlerp(a, b, s)
    p.z += 4 * h * s * (1 - s)
    return p


def ship_y(t):
    return T.TURN_Y * smooth((t - T.TURN[0]) / (T.TURN[1] - T.TURN[0]))


def ship_matrix(t):
    x = T.SHIP_X0 - T.SHIP_SPEED * t
    y = ship_y(t)
    dy = (ship_y(t + 0.05) - ship_y(t - 0.05)) / 0.1
    heading = math.atan2(dy, T.SHIP_SPEED)  # 0 when sailing straight along -x
    z = 0.025 * math.sin(TAU * t / 3.1)
    rot = Euler((0.03 * math.sin(TAU * t / 3.7) - 0.25 * heading, 0.025 * math.sin(TAU * t / 3.1 + 1.0), -heading))
    return Matrix.Translation((x, y, z)) @ rot.to_matrix().to_4x4(), (x, y, z), rot


def ship_point(t, local):
    return ship_matrix(t)[0] @ Vector(local)


def ship_yaw(t):
    return ship_matrix(t)[2].z


def floe_state(t, i):
    fx, fy = T.FLOES[i]
    z = 0.03 + 0.012 * math.sin(TAU * t / 2.3 + i * 1.9)
    lands = ([0.0] + T.CHASE_LANDINGS)
    z += spring(t, lands[i], -0.05, freq=2.2, damp=3.5) if i else 0.0
    if i == 5:
        z += spring(t, T.LEAP[0], -0.07, freq=2.2, damp=3.0)  # the push-off for the leap
    tilt = (0.03 * math.sin(TAU * t / 2.9 + i), 0.03 * math.cos(TAU * t / 3.3 + i))
    return Vector((fx, fy, z)), tilt


def floe_top(t, i):
    return floe_state(t, i)[0] + Vector((0, 0, 0.07))


# local positions on the ship
BARREL_TOP = BARREL + Vector((0, 0, BH))
STERN_LAND = Vector((0.6, -0.08, T.DECK_Z))
DECK_SPOT = Vector((-0.08, -0.2, T.DECK_Z))
FORESTAY = [Vector((-1.45, 0, 0.83)).lerp(Vector((MAST_X, 0, 2.3)), s) + Vector((0, 0, 0.012)) for s in (0.35, 0.6, 0.85)]
NEST_SPOT = Vector((MAST_X - 0.06, -0.13, NEST_Z))
TERN_DECK = Vector((-0.14, 0.2, T.DECK_Z + 0.068))
TERN_YARD = Vector((MAST_X - 0.04, -0.55, 2.15 + 0.018 + 0.068))
TERN_RAIL = Vector((MAST_X - 0.06, 0.24, NEST_Z + 0.1 + 0.068))


# ---------------------------------------------------------------- Clawd
def clawd_state(t):
    """Returns centre position, yaw, pitch, squash, visible, eye glow."""
    sq, pitch, glow = 1.0, 0.0, 0.0
    up = Vector((0, 0, FEET))
    # 1. left behind, on the first floe
    if t < T.CHASE_LAUNCHES[0]:
        pos = floe_top(t, 0) + up
        to_ship = ship_point(t, (0, 0, 0)) - pos
        yaw = alerp(yaw_to(Vector((-1, 0.3, 0))), yaw_to(to_ship), ramp(t, *T.SHIP_LOOK))
        yaw = alerp(yaw, 0.0, ramp(t, *T.UH_OH))
        yaw = alerp(yaw, yaw_to(to_ship), ramp(t, *T.BACK_TO_SHIP))
        sq += spring(t, T.UH_OH[1], -0.1, 3, 6) - 0.18 * ramp(t, T.CHASE_LAUNCHES[0] - 0.15, T.CHASE_LAUNCHES[0])
        return pos, yaw, pitch, sq, True, glow
    # 2. the chase across the floes
    for i, (t0, t1) in enumerate(zip(T.CHASE_LAUNCHES, T.CHASE_LANDINGS)):
        if t < t1:
            a, b = floe_top(t0, i), floe_top(t1, i + 1)
            s = (t - t0) / (t1 - t0)
            return hop(a, b, s, 0.24) + up, yaw_to(b - a), 0.0, 1.0 + 0.12 * math.sin(math.pi * s), True, glow
        nxt = T.CHASE_LAUNCHES[i + 1] if i + 1 < len(T.CHASE_LAUNCHES) else T.LEAP[0]
        if t < nxt:
            pos = floe_top(t, i + 1) + up
            sq = 1.0 + spring(t, t1, -0.2, 4, 8)
            if i == 4:  # the run-up: a deep crouch, eyeing the ship
                sq -= 0.3 * ramp(t, T.LEAP[0] - 0.45, T.LEAP[0] - 0.05)
                return pos, yaw_to(ship_point(t, STERN_LAND) - pos), 0.0, sq, True, glow
            return pos, yaw_to(Vector((-1, 0, 0))), 0.0, sq, True, glow
    if t < T.LEAP[1]:
        a, b = floe_top(T.LEAP[0], 5), ship_point(T.LEAP[1], STERN_LAND)
        s = ramp(t, *T.LEAP) * 0.3 + 0.7 * (t - T.LEAP[0]) / (T.LEAP[1] - T.LEAP[0])
        return hop(a, b, s, 0.7) + up, yaw_to(b - a), -TAU * smooth(s), 1.0 + 0.15 * math.sin(math.pi * s), True, glow
    if t < T.INTO_BARREL[0]:
        pos = ship_point(t, STERN_LAND) + up
        return pos, yaw_to(ship_point(t, BARREL) - pos), 0.0, 1.0 + spring(t, T.LEAP[1], -0.35, 3, 7), True, glow
    # 3. into the barrel, the peek, out again
    inside = BARREL_TOP + Vector((0, 0, -0.27))
    if t < T.INTO_BARREL[1]:
        s = (t - T.INTO_BARREL[0]) / (T.INTO_BARREL[1] - T.INTO_BARREL[0])
        a, b = ship_point(T.INTO_BARREL[0], STERN_LAND), ship_point(T.INTO_BARREL[1], inside)
        return hop(a, b, s, 0.45) + up, yaw_to(b - a), 0.0, 1.0, True, glow
    if t < T.POP_OUT[0]:
        peek = ramp(t, T.PEEK[0] + 0.2, T.PEEK[0] + 0.6) * (1 - ramp(t, T.STARTLE + 0.05, T.STARTLE + 0.2))
        foot = inside + Vector((0, 0, 0.19 * peek))
        pos = ship_point(t, foot) + up
        glow = 6.0 * peek
        return pos, ship_yaw(t) + 0.0, 0.0, 1.0, True, glow
    if t < T.TO_DECK[0]:
        rise = ramp(t, *T.POP_OUT)
        foot = BARREL_TOP + Vector((0, 0, lerp(-0.27, 0.0, rise) + 0.08 * math.sin(math.pi * rise)))
        pos = ship_point(t, foot) + up
        yaw = alerp(ship_yaw(t), yaw_to(tern_state(t)[0] - pos), ramp(t, T.POP_OUT[1], T.POP_OUT[1] + 0.4))
        return pos, yaw, -0.25 * ramp(t, T.POP_OUT[1], T.POP_OUT[1] + 0.4), 1.0 + spring(t, T.POP_OUT[1], -0.12, 5, 9), True, glow
    if t < T.TO_DECK[1]:
        s = ramp(t, *T.TO_DECK)
        a, b = ship_point(T.TO_DECK[0], BARREL_TOP), ship_point(T.TO_DECK[1], DECK_SPOT)
        return hop(a, b, s, 0.2) + up, yaw_to(b - a), 0.0, 1.0, True, glow
    # 4. on deck in the fog, then up the forestay
    if t < T.CLIMB_LAUNCHES[0]:
        pos = ship_point(t, DECK_SPOT) + up
        yaw = ship_yaw(t) + 0.6 * math.sin(TAU * (t - 30) / 5.0) * ramp(t, 30, 31)  # peering about
        yaw = alerp(yaw, yaw_to(ship_point(t, (-3, 0, 0)) - pos), ramp(t, T.REVEAL - 0.2, T.REVEAL + 0.2))
        sq = 1.0 + spring(t, T.REVEAL + 0.05, 0.3, 4, 6) - 0.2 * ramp(t, T.CLIMB_LAUNCHES[0] - 0.15, T.CLIMB_LAUNCHES[0])
        lift = max(0.0, spring(t, T.REVEAL + 0.05, 0.08, 2, 5))  # a startled jump
        return pos + Vector((0, 0, lift)), yaw, 0.0, sq, True, glow
    spots = [DECK_SPOT] + FORESTAY + [NEST_SPOT]
    for i, (t0, t1) in enumerate(zip(T.CLIMB_LAUNCHES, T.CLIMB_LANDINGS)):
        a, b = ship_point(t0, spots[i]), ship_point(t1, spots[i + 1])
        if t < t1:
            s = (t - t0) / (t1 - t0)
            return hop(a, b, s, 0.25) + up, yaw_to(b - a), 0.0, 1.0 + 0.1 * math.sin(math.pi * s), True, glow
        if i + 1 < len(T.CLIMB_LAUNCHES) and t < T.CLIMB_LAUNCHES[i + 1]:
            pos = ship_point(t, spots[i + 1]) + up
            wobble = 0.12 * math.sin(TAU * 3 * (t - t1)) * math.exp(-3 * (t - t1))  # balancing on the rope
            return pos, yaw_to(b - a), wobble, 1.0 + spring(t, t1, -0.15, 4, 8), True, glow
    # 5. in the crow's nest: the beams, then dawn
    pos = ship_point(t, NEST_SPOT) + up
    sq = 1.0 + spring(t, T.CLIMB_LANDINGS[-1], -0.2, 4, 7)
    yaw = ship_yaw(t)
    on = ramp(t, T.BEAMS_ON - 0.15, T.BEAMS_ON + 0.1) * (1 - ramp(t, T.BEAMS_OFF - 0.2, T.BEAMS_OFF + 0.2))
    if t >= T.BEAMS_ON - 0.4:
        yaw = alerp(yaw, yaw_to(beam_target_pos(t) - pos), ramp(t, T.BEAMS_ON - 0.4, T.BEAMS_ON) * (1 - ramp(t, T.BEAMS_OFF, T.BEAMS_OFF + 0.8)))
    if t >= T.LOOK_AT_EACH_OTHER - 0.3:
        yaw = alerp(yaw, yaw_to(tern_state(t)[0] - pos), ramp(t, T.LOOK_AT_EACH_OTHER - 0.3, T.LOOK_AT_EACH_OTHER + 0.3))
    return pos, yaw, 0.0, sq, True, 40.0 * on


def beam_target_pos(t):
    right, left = Vector((-8.6, 2.8, 1.3)), Vector((-8.4, -4.2, 0.9))
    gap = Vector((T.GAP[0], T.GAP[1], 0.5))
    if t < T.BEAM_SWEEP[1]:
        return vlerp(right, left, ramp(t, *T.BEAM_SWEEP))
    return vlerp(left, gap, ramp(t, *T.BEAM_FIND))


# ---------------------------------------------------------------- the tern
def flap_wave(t, hz=3.2, amp=0.75):
    return math.sin(TAU * t * hz) * amp


def heading_of(d):
    return math.atan2(d.y, d.x)


def tern_state(t):
    """Returns position, yaw (forward = +X), pitch, roll, flap, head pitch, scale."""
    mast = ship_point(t, (MAST_X, 0, 0))
    if t < T.TERN_TO_DECK[0]:  # circling the mast, flapping in bursts with glides
        ph = TAU * t / 3.6 + 0.4
        r = 1.05 + 0.2 * math.sin(t * 0.7)
        pos = mast + Vector((r * math.cos(ph), r * math.sin(ph) * 0.9, 1.8 + 0.15 * math.sin(2 * ph)))
        burst = 0.5 + 0.5 * math.sin(TAU * t / 2.2)
        return pos, ph + math.pi / 2, 0.0, -0.4, flap_wave(t) * burst + 0.25 * (1 - burst), 0.0, 1.0
    if t < T.TERN_TO_DECK[1]:  # glide down beside the barrel
        s = ramp(t, *T.TERN_TO_DECK)
        ph = TAU * T.TERN_TO_DECK[0] / 3.6 + 0.4
        r = 1.05 + 0.2 * math.sin(T.TERN_TO_DECK[0] * 0.7)
        a = ship_point(T.TERN_TO_DECK[0], (MAST_X, 0, 0)) + Vector((r * math.cos(ph), r * math.sin(ph) * 0.9, 1.8 + 0.15 * math.sin(2 * ph)))
        b = ship_point(t, TERN_DECK)
        pos = vlerp(a, b, s)
        pos.z += 0.3 * math.sin(math.pi * s)
        face = heading_of(ship_point(t, BARREL) - b)
        return pos, alerp(heading_of(b - a), face, smooth((s - 0.6) / 0.4)), 0.0, 0.0, 0.6 * flap_wave(t, 4) + 1.0 * smooth((s - 0.7) / 0.3), 0.0, 1.0
    if t < T.STARTLE:  # on deck, pecking at the lid, then staring at the eyes
        pos = ship_point(t, TERN_DECK)
        face = heading_of(ship_point(t, BARREL) - pos)
        hp = sum(0.9 * math.exp(-((t - p) / 0.08) ** 2) for p in T.PECKS)
        lean = 0.35 * ramp(t, T.PEEK[0] + 0.3, T.PEEK[0] + 0.6)
        return pos, face, 0.3 * hp, 0.0, -0.15, hp + lean, 1.0 + 0.04 * lean
    if t < T.TERN_ON_YARD:  # startled up onto the yard
        s = ramp(t, T.STARTLE, T.TERN_ON_YARD)
        a, b = ship_point(T.STARTLE, TERN_DECK), ship_point(t, TERN_YARD)
        pos = vlerp(a, b, s)
        pos.z += 0.35 * math.sin(math.pi * s) + 0.12 * max(0.0, spring(t, T.STARTLE, 1.0, 2, 6))
        return pos, heading_of(b - a) * (1 - s) + 0.0, 0.0, 0.0, flap_wave(t, 6, 1.0), 0.0, 1.0 + 0.1 * (1 - s)
    if t < T.TERN_SCOUT[0]:  # glaring down from the yard
        pos = ship_point(t, TERN_YARD)
        c = ship_point(t, BARREL_TOP if t < T.TO_DECK[0] else DECK_SPOT)
        face = heading_of(c - pos)
        g = ramp(t, T.TERN_ON_YARD, T.TERN_ON_YARD + 0.4)
        return pos, face, 0.3 * g, 0.0, -0.15 + spring(t, T.TERN_ON_YARD, 0.6, 3, 5), 0.25 * g, 1.0 + 0.08 * g
    if t < T.TERN_SCOUT[1]:  # off ahead into the fog
        s = ramp(t, *T.TERN_SCOUT)
        a, b = ship_point(T.TERN_SCOUT[0], TERN_YARD), ship_point(t, (-7.0, 0.8, 2.4))
        pos = vlerp(a, b, s)
        pos.z += 0.3 * math.sin(math.pi * s)
        return pos, heading_of(b - a), -0.1, 0.0, flap_wave(t, 4.0, 0.9), 0.0, 1.0
    if t < T.REVEAL:  # back again, lost, zig-zagging
        s = ramp(t, *T.TERN_BACK)
        a, b = ship_point(t, (-7.0, -0.8, 2.2)), ship_point(t, (-1.4, 0.2, 1.9))
        pos = vlerp(a, b, s) + Vector((0, 0.6 * math.sin(TAU * t * 0.9), 0.15 * math.sin(TAU * t * 1.3)))
        return pos, heading_of(b - a) + 0.7 * math.cos(TAU * t * 0.9), 0.0, 0.4 * math.cos(TAU * t * 0.9), flap_wave(t, 5, 0.9), 0.0, 1.0
    if t < T.TERN_FOLLOWS[0]:  # panicking round the masthead
        ph = TAU * (t - T.REVEAL) / 1.1
        pos = mast + Vector((0.5 * math.cos(ph), 0.5 * math.sin(ph), 2.0 + 0.1 * math.sin(3 * ph)))
        if t < T.REVEAL + 0.6:
            pos = vlerp(ship_point(T.REVEAL, (-1.4, 0.2, 1.9)), pos, smooth((t - T.REVEAL) / 0.6))
        return pos, ph + math.pi / 2, 0.0, -0.6, flap_wave(t, 7, 1.0), -0.3, 1.0
    if t < T.TERN_TO_NEST[0]:
        # along the beam to the gap, then circling there as the guide
        s = ramp(t, *T.TERN_FOLLOWS)
        start = mast + Vector((0.5, 0, 2.0))
        gap = Vector((T.GAP[0], T.GAP[1], 1.3))
        pos = vlerp(start, gap, s)
        pos.z += 0.3 * math.sin(math.pi * s)
        yaw = heading_of(gap - start)
        if t >= T.TERN_FOLLOWS[1]:
            ph = TAU * (t - T.TERN_FOLLOWS[1]) / 2.5
            pos = gap + Vector((0.5 * math.sin(ph), 0.5 * (1 - math.cos(ph)), 0.1 * math.sin(2 * ph)))
            yaw = heading_of(gap - start) + ph
        return pos, yaw, 0.0, -0.3, flap_wave(t, 3.6, 0.8), 0.0, 1.0
    if t < T.TERN_TO_NEST[1]:  # back to the nest rail
        s = ramp(t, *T.TERN_TO_NEST)
        ph = TAU * (T.TERN_TO_NEST[0] - T.TERN_FOLLOWS[1]) / 2.5
        gap = Vector((T.GAP[0], T.GAP[1], 1.3))
        a = gap + Vector((0.5 * math.sin(ph), 0.5 * (1 - math.cos(ph)), 0.1 * math.sin(2 * ph)))
        b = ship_point(t, TERN_RAIL)
        pos = vlerp(a, b, s)
        pos.z += 0.4 * math.sin(math.pi * s)
        return pos, heading_of(b - a), 0.0, 0.0, flap_wave(t, 4, 0.8) * (1 - s) + 1.0 * smooth((s - 0.75) / 0.25), 0.0, 1.0
    # perched beside Clawd: a look, two nods
    pos = ship_point(t, TERN_RAIL)
    c = ship_point(t, NEST_SPOT) + Vector((0, 0, FEET))
    face = alerp(ship_yaw(t) + math.pi, heading_of(c - pos), ramp(t, T.LOOK_AT_EACH_OTHER - 0.2, T.LOOK_AT_EACH_OTHER + 0.4))
    nod = sum(0.5 * math.exp(-((t - n) / 0.09) ** 2) for n in T.NODS)
    return pos, face, 0.0, 0.0, -0.15 + spring(t, T.TERN_TO_NEST[1], 0.8, 3, 5), nod, 1.0



def tern_fold(t):
    """1 while perched (wings folded back along the body), 0 in flight."""
    perches = [(T.TERN_TO_DECK[1], T.STARTLE), (T.TERN_ON_YARD, T.TERN_SCOUT[0]), (T.TERN_TO_NEST[1], T.DURATION + 1)]
    return max(ramp(t, a, a + 0.25) * (1 - ramp(t, b - 0.05, b + 0.1)) for a, b in perches)


# ---------------------------------------------------------------- camera
def shot(t):
    """Returns camera location, target, lens. Scenes cut; inside a scene the camera moves."""
    def sp(local):
        return ship_point(t, local)

    if t < T.UH_OH[0] - 0.4:  # 1. wide: Clawd on his floe, the ship sailing away
        f0 = floe_top(t, 0)
        return Vector((1.9, -4.4, 0.95)) + Vector((-0.04 * t, 0, 0)), vlerp(f0, sp((0, 0, 0.9)), 0.45) + Vector((0, 0, 0.2)), 34.0
    if t < T.CHASE_LAUNCHES[0] - 0.3:  # the uh-oh close-up
        f0 = floe_top(t, 0)
        return f0 + Vector((0.15, -1.25, 0.25)), f0 + Vector((0, 0, 0.13)), 45.0
    if t < T.LID_SLAM + 0.6:  # 2. the chase, tracking sideways
        c = clawd_state(min(t, T.LEAP[0]))[0]
        cx = lerp(c.x, sp((0.5, 0, 0)).x, ramp(t, T.LEAP[0], T.LEAP[1]))
        return Vector((cx + 0.4, -4.4, 1.15)), Vector((cx - 0.55, -0.6, 0.5)), 30.0
    if t < T.STARTLE:  # 3. on deck: the tern and the barrel
        push = ramp(t, T.PEEK[0] - 0.5, T.PEEK[0] + 0.5)
        return (sp(Vector((-0.2, -2.4, 1.15)).lerp(Vector((-0.4, -1.2, 0.74)), push)),
                sp(Vector((-0.35, 0.05, 0.8)).lerp(Vector((-0.38, 0.0, 0.66)), push)), lerp(35.0, 42.0, push))
    if t < T.FOG_IN[0] + 1.5:  # the standoff: barrel below, tern on the yard above
        return sp((-0.2, -3.2, 1.2)), sp((-0.15, 0.0, 1.5)), 30.0
    if t < T.REVEAL:  # 4. fog: three-quarter from ahead
        k = ramp(t, T.FOG_IN[0] + 1.5, T.REVEAL)
        return sp(Vector((-2.6, -2.6, 1.3)).lerp(Vector((-2.1, -2.1, 1.25)), k)), sp((-0.2, 0, 1.0)), 32.0
    if t < T.CLIMB_LAUNCHES[0] - 0.3:  # the reveal, looking forward over the bow
        return sp((-0.55, -1.05, 1.2)), Vector((T.BERG_AHEAD[0], T.BERG_AHEAD[1], 1.1)), 30.0
    if t < T.BEAMS_ON - 0.2:  # the climb up the forestay
        return sp((-0.55, -3.3, 1.7)), sp((-0.6, 0, 1.75)), 32.0
    if t < T.BEAMS_OFF + 0.5:  # the beams, over the shoulder from the nest
        nest = sp(NEST_SPOT)
        return sp((1.7, 0.95, 3.25)), vlerp(nest, beam_target_pos(t), 0.4), 30.0
    if t < T.LOOK_AT_EACH_OTHER - 0.6:  # 5. dawn: the ship heading for the gap
        k = ramp(t, T.BEAMS_OFF + 0.5, T.LOOK_AT_EACH_OTHER)
        return Vector((-10.9, -2.2, 1.25)) + Vector((0.4 * k, 0, 0.1 * k)), sp((0, 0, 1.25)), 28.0
    # the two of them in the nest
    k = ramp(t, T.LOOK_AT_EACH_OTHER - 0.6, T.DURATION)
    return sp(Vector((-1.5, -0.55, 2.75)).lerp(Vector((-1.3, -0.48, 2.72)), k)), sp((MAST_X - 0.06, 0.05, NEST_Z + 0.14)), 40.0


# ---------------------------------------------------------------- levels
def fog_density(t):
    d = 0.4 * ramp(t, *T.FOG_IN) * (1 - ramp(t, *T.FOG_OUT))
    return d * (1 - 0.25 * math.exp(-((t - T.REVEAL - 0.4) / 0.6) ** 2))


def lantern_level(t):
    if T.LANTERN_FLICKER[0] <= t < T.LANTERN_FLICKER[1]:
        return 0.5 + 0.5 * abs(math.sin(t * 37) * math.sin(t * 11))
    return 1.0 if t < T.LANTERN_FLICKER[0] else 0.6 + 0.4 * ramp(t, *T.DAWN)


def aurora_level(t, i):
    return (0.55 + 0.1 * math.sin(TAU * t / 2.7 + i)) * (1 - ramp(t, T.DAWN[0], T.DAWN[0] + 5))


# ---------------------------------------------------------------- bake keys
fog_nodes = fog_mat.node_tree.nodes
states_c = [clawd_state((f - 1) / T.FPS) for f in range(1, T.FRAMES + 1)]
states_t = [tern_state((f - 1) / T.FPS) for f in range(1, T.FRAMES + 1)]
c_yaw = np.unwrap([s[1] for s in states_c])
t_yaw = np.unwrap([s[1] for s in states_t])

for f in range(1, T.FRAMES + 1):
    t = (f - 1) / T.FPS
    _, sloc, srot = ship_matrix(t)
    ship.location, ship.rotation_euler = sloc, srot
    key(ship, "location", f)
    key(ship, "rotation_euler", f)

    lid_open = -1.9 * (1 - ramp(t, T.LID_SLAM - 0.12, T.LID_SLAM)) + spring(t, T.LID_SLAM, 0.12, 6, 10)
    lid_open += sum(0.05 * math.exp(-((t - p - 0.03) / 0.05) ** 2) for p in T.PECKS)
    lid_open -= 0.45 * ramp(t, T.PEEK[0], T.PEEK[0] + 0.3) * (1 - ramp(t, T.STARTLE + 0.05, T.STARTLE + 0.15))
    lid_open -= 1.9 * ramp(t, T.POP_OUT[0] - 0.1, T.POP_OUT[0] + 0.1)
    lid.rotation_euler = (0, lid_open if t >= T.LID_SLAM - 0.12 else -1.9, 0)
    key(lid, "rotation_euler", f)

    hinge.rotation_euler = (0.06 * math.sin(TAU * t / 2.1), 0.12 * math.sin(TAU * t / 1.6), 0)
    key(hinge, "rotation_euler", f)
    ll = lantern_level(t)
    lantern_light.energy = 14 * ll
    key(lantern_light, "energy", f)
    gin = M["glass"].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"]
    gin.default_value = 3.5 * ll + 0.05
    gin.keyframe_insert("default_value", frame=f)

    for i, fo in enumerate(floes):
        p, tilt = floe_state(t, i)
        fo.location, fo.rotation_euler = p, (tilt[0], tilt[1], i * 0.7)
        key(fo, "location", f)
        key(fo, "rotation_euler", f)

    pos, _, pitch, sq, vis, glow = states_c[f - 1]
    clawd.location = pos - Vector((0, 0, (1 - sq) * FEET * 0.8))
    clawd.rotation_euler = (pitch, 0, c_yaw[f - 1])
    k_ = 1 / math.sqrt(max(sq, 0.3))
    clawd.scale = (k_, k_, sq)
    for path in ("location", "rotation_euler", "scale"):
        key(clawd, path, f)
    key_o.location = pos + Vector((-0.4, -1.5, 1.2))
    key(key_o, "location", f)
    happy = ramp(t, T.HAPPY, T.HAPPY + 0.15)
    for e in eyes:
        e.scale = (1.0, 1.0, 1.0 - 0.62 * happy)
        key(e, "scale", f)
    ei = M["eye"].node_tree.nodes["Principled BSDF"].inputs["Emission Strength"]
    ei.default_value = glow
    ei.keyframe_insert("default_value", frame=f)
    on = clamp(glow / 40.0) if t >= T.BEAMS_ON - 0.5 else 0.0
    beam_target.location = beam_target_pos(t) if t >= T.BEAMS_ON - 0.5 else pos + Vector((-2, 0, 0))
    key(beam_target, "location", f)
    for sl in beam_lights:
        sl.energy = 60 * on
        key(sl, "energy", f)
    bs = beam_mat.node_tree.nodes["Strength"].outputs[0]
    bs.default_value = 0.9 * on
    bs.keyframe_insert("default_value", frame=f)

    tp, _, tpitch, troll, flap, headp, tsc = states_t[f - 1]
    tern.location, tern.rotation_euler, tern.scale = tp, (troll, tpitch, t_yaw[f - 1]), (tsc,) * 3
    for path in ("location", "rotation_euler", "scale"):
        key(tern, path, f)
    fold = tern_fold(t)
    for sh, sy in wings:
        sh.rotation_euler = (sy * flap * (1 - fold), 0, sy * 1.45 * fold)
        key(sh, "rotation_euler", f)
    head.rotation_euler = (0, headp, 0)
    key(head, "rotation_euler", f)

    for i, am in enumerate(aurora_mats):
        v = am.node_tree.nodes["Strength"].outputs[0]
        v.default_value = aurora_level(t, i)
        v.keyframe_insert("default_value", frame=f)

    dn = ramp(t, *T.DAWN)
    dawn_fac.default_value = dn
    dawn_fac.keyframe_insert("default_value", frame=f)
    sun.energy = 3.0 * dn
    key(sun, "energy", f)
    moon.energy = 0.45 * (1 - 0.8 * dn) + 0.6 * math.exp(-((t - T.REVEAL) / 0.15) ** 2)
    key(moon, "energy", f)
    fd = fog_nodes["Density"].outputs[0]
    fd.default_value = fog_density(t)
    fd.keyframe_insert("default_value", frame=f)
    fc = fog_nodes["FogColor"].outputs[0]
    fc.default_value = tuple(lerp(a, b, dn) for a, b in zip((0.035, 0.045, 0.06), (0.5, 0.33, 0.28))) + (1,)
    fc.keyframe_insert("default_value", frame=f)
    drift = fog_nodes["Drift"].inputs["Location"]
    drift.default_value = (0.25 * t, 0.0, 0.08 * t)
    drift.keyframe_insert("default_value", frame=f)

    oc.time = 1.0 + t * 0.9
    oc.keyframe_insert("time", frame=f)

    cl, ctg, lens = shot(t)
    cam.location, cam_target.location, cam_data.lens = cl, ctg, lens
    key(cam, "location", f)
    key(cam_target, "location", f)
    key(cam_data, "lens", f)

# hop speeds (a teleport shows up here before the render)
fastest, at = 0.0, 0
for f in range(2, T.FRAMES + 1):
    v = (states_c[f - 1][0] - states_c[f - 2][0]).length * T.FPS
    if v > fastest:
        fastest, at = v, f
print(f"fastest Clawd motion: {fastest:.2f} m/s at frame {at}")

out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "build", "episode1.blend")
bpy.ops.wm.save_as_mainfile(filepath=out)
print("saved", out)
