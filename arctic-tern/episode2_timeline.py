"""Episode 2: The Whale. Every event in seconds; episode2.py and episode2_sound.py both read this.

The morning after Episode 1: a calm sunny sea, Clawd and the tern are shipmates now."""

FPS = 24
DURATION = 60.0
FRAMES = int(DURATION * FPS)  # 1440
BPM = 120
DECK_Z = 0.42


def frame(t):
    return t * FPS + 1


SHIP_X0 = 0.0
SHIP_SPEED = 0.12

# Ice: a few distant floes and bergs only.
FLOES = [(4.0, 3.5), (5.2, 2.8), (-6.0, 5.0)]
ICEBERG = (-14.0, 12.0)

# 1. Morning: the tern shows how it's done
TERN_TAKEOFF = 3.5
TERN_DIVE = 7.0                 # hits the water
TERN_SURFACE = 7.7              # back up with a fish
TERN_BACK = 9.0                 # on the bow rail again
GULP = 9.6

# 2. Clawd's turn
BOW_HOPS = [(10.6, 11.1), (11.6, 12.1), (12.6, 13.1)]  # deck -> rail -> bowsprit
LOOK_DOWN = (13.3, 14.8)
WIGGLE = (15.0, 16.2)
DIVE = (16.4, 17.3)             # a flip and a belly flop
UNDER = (17.3, 18.5)
BOB_UP = 18.5
SPIT = 19.4
TERN_LAUGH = [20.0, 20.4, 20.8]

# 3. The whale
BULGE = (23.0, 24.0)            # the water swells under him
WHALE_RISE = (24.0, 27.0)       # the back lifts him clear of the sea
UH_OH = (27.5, 28.2)
REVEAL = (28.5, 31.0)           # pull wide: the whole whale
PUFF = 31.5                     # a small test puff from the blowhole
SPOUT = 33.0                    # the big one

# 4. Flight and landing
FLIGHT = (33.0, 36.5)           # launched, tumbling, into the barrel
RAIN = (34.0, 37.5)             # spout water raining down
FLUKE_UP = (38.0, 40.5)         # the tail rises and waves
TAIL_SLAP = 42.0
TERN_TO_BARREL = (43.0, 44.0)
PEEK = 45.0                     # Clawd peeks up with a fish in his mouth
OFFER = (46.5, 47.2)            # he gives it to the tern
TOSS = 48.0                     # the tern tosses it up and gulps
HAPPY = 49.0

# 5. Sail on
WHALE_DIVE = (50.0, 55.0)       # the whale swims alongside, a last spout, then dives
LAST_SPOUT = 52.0
CARD_IN = 56.5
OPEN_TITLE = (1.0, 4.5)
FADE_IN = (0.0, 0.5)
FADE_OUT = (59.0, 60.0)

# The whale lives in world space, heading -x alongside the ship.
WHALE_LEN = 4.6
