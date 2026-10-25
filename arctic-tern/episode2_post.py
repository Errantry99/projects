"""Episode 2 post: an opening caption, the end card, fades through black, then the encode with the
soundtrack.  python episode2_post.py -> episode2_the_whale.mp4"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import episode2_timeline as T  # noqa: E402
from episode_post import run  # noqa: E402

FRAMES = [int(x) for x in sys.argv[1].split(",")] if len(sys.argv) > 1 else None  # a few frames to check, no encode
run(T, "episode2",
    [("THE VOYAGE OF THE ARCTIC TERN", 0.032, 0.06), ("Episode 2 · The Whale", 0.05, 0.11)],
    [("EPISODE 2", 0.04, 0.09), ("THE WHALE", 0.1, 0.155)],
    "episode2_the_whale.mp4", FRAMES)
