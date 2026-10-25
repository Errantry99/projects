"""Every event of the film in seconds. scene.py and sound.py both read this."""

FPS = 24
DURATION = 12.0
FRAMES = int(DURATION * FPS)  # 288
BPM = 120
BEAT = 60.0 / BPM  # 0.5 s = 12 frames


def frame(t):
    return t * FPS + 1


# Ship: sails toward -x, the camera dollies with it.
SHIP_SPEED = 0.06  # m/s
SHIP_X0 = 0.3
DECK_Z = 0.42

# Tern
TERN_CIRCLE = (0.0, 2.5)        # circles the mast (two laps)
TERN_LAND = 2.75                # on the lantern hook
LANTERN_OUT = 3.00
TERN_SLEEP = (3.0, 9.45)
TERN_WAKE = 9.45
LANTERN_ON = 9.60
TERN_GLARE = (10.0, 10.3)
TERN_TAKEOFF = 10.4
TERN_GONE = 11.6

# Clawd
LID_UP = 3.20
CLAWD_OUT = (3.25, 3.75)        # climbs out onto the barrel rim
LOOK_TERN = (3.40, 3.80)
HEAD_TURN = (3.85, 4.45)
LAUNCH = 4.50
FLOE_LANDINGS = [5.0, 5.5, 6.0, 6.5, 7.0]
FLIP = (6.5, 7.0)               # front flip on the last hop
BEAMS_ON = 7.50
BEAM_SWEEP = (7.50, 8.25)
BEAM_TO_LENS = (8.25, 8.50)
FLASH = 8.50
CARD_IN = 8.55
BEAMS_OFF = 8.75

FADE_IN = (0.0, 0.30)
FADE_OUT = (11.55, 12.0)

# Floes: world positions (x, y), one per landing.
FLOES = [(-1.45, -0.32), (-1.95, -0.18), (-2.45, -0.34), (-2.95, -0.16), (-3.45, -0.28)]
ICEBERG = (-4.4, 7.5)

# Sound-only events
SNORES = [3.45, 4.75]
CELESTA_PASSES = [0.6, 1.85]    # tern passes in front of the mast
DING = 3.95
GLARE_SQUAWK = 10.05
