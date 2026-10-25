"""Episode 1: The Stowaway. Every event in seconds; episode1.py and episode1_sound.py both read this.

Picks up where the intro ends: Clawd is out on the ice and the Arctic Tern is sailing on without him."""

FPS = 24
DURATION = 60.0
FRAMES = int(DURATION * FPS)  # 1440
BPM = 120
DECK_Z = 0.42


def frame(t):
    return t * FPS + 1


# Ship: sails toward -x, then turns to port for the gap between the bergs.
SHIP_X0 = -1.2
SHIP_SPEED = 0.12
TURN = (44.5, 53.0)
TURN_Y = -1.3

# Ice. FLOES[0] is where Clawd starts; the rest are the chase.
FLOES = [(0.9, -1.0), (0.35, -1.05), (-0.2, -0.95), (-0.75, -1.08), (-1.3, -0.97), (-1.85, -1.04)]
ICEBERG = (-12.5, 3.2)          # the big one, far off
BERG_AHEAD = (-9.4, 0.2)        # dead ahead in the fog
BERG_SOUTH = (-8.6, -3.5)       # the other side of the gap
GAP = (-8.9, -1.5)

# 1. Left behind
SHIP_LOOK = (0.5, 2.0)          # Clawd watches the ship go
UH_OH = (5.5, 6.2)              # head turn to the lens
BACK_TO_SHIP = (6.6, 7.2)

# 2. The chase
CHASE_LAUNCHES = [8.5, 9.5, 10.5, 11.5, 12.5]
CHASE_LANDINGS = [9.0, 10.0, 11.0, 12.0, 13.0]
LEAP = (14.0, 15.0)             # the big leap onto the stern, with a flip
INTO_BARREL = (15.3, 15.9)
LID_SLAM = 16.0

# 3. Discovered
TERN_TO_DECK = (19.0, 20.0)
PECKS = [21.5, 22.0, 22.5]
PEEK = (23.5, 24.5)             # lid lifts, two glowing eyes
STARTLE = 24.5                  # the tern jumps to the yard
TERN_ON_YARD = 25.5
POP_OUT = (26.5, 27.0)
TO_DECK = (29.0, 29.5)

# 4. Fog and ice
FOG_IN = (29.0, 34.0)
LANTERN_FLICKER = (31.0, 33.0)
TERN_SCOUT = (32.0, 36.0)       # flies ahead into the fog
TERN_BACK = (36.0, 38.0)        # comes back lost
REVEAL = 38.0                   # the berg looms out of the fog, dead ahead
CLIMB_LAUNCHES = [39.8, 40.8, 41.8, 42.8]
CLIMB_LANDINGS = [40.4, 41.4, 42.4, 43.4]  # up the forestay into the crow's nest
BEAMS_ON = 44.0
BEAM_SWEEP = (44.3, 46.3)
BEAM_FIND = (46.3, 47.0)        # settles on the gap
BEAMS_OFF = 50.0
TERN_FOLLOWS = (45.0, 49.0)     # flies out along the beam and guides

# 5. Dawn
FOG_OUT = (49.0, 53.0)
DAWN = (49.0, 57.0)
TERN_TO_NEST = (53.0, 55.0)
LOOK_AT_EACH_OTHER = 55.5
NODS = [56.5, 56.9]
HAPPY = 57.0
CARD_IN = 57.0
OPEN_TITLE = (1.0, 4.5)
FADE_IN = (0.0, 0.5)
FADE_OUT = (59.0, 60.0)
