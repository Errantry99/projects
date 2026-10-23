"""Builds and animates The Voyage of the Arctic Tern intro. Run with bpy (Blender 5):
    python scene.py [out.blend]
Every motion is computed per frame from timeline.py and keyed on every frame."""
import json
import math
import os
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import timeline as T  # noqa: E402
import world  # noqa: E402
from world import *  # noqa: E402,F401,F403  helpers: clamp, smooth, ramp, lerp, vlerp, spring, key, ...

globals().update(vars(world.build(T)))
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
