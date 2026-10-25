# Episode 2: The Whale

60 s / 16:9 / 24 fps. The morning after Episode 1: a calm, sunny sea, and Clawd and the tern are
shipmates now.

> The tern shows off: one dive, one fish, one gulp. Clawd wants to try. He walks out to the end of
> the bowsprit, wobbles, and belly-flops into the sea. The tern laughs. Then the water swells under
> him and a whale rises with Clawd on its back. One spout launches him high over the ship and drops
> him back into his barrel. When he peeks out he has a fish in his mouth, and he gives it to the
> tern. They sail on with the whale alongside, and the tern rides home on Clawd's head.

## Scenes

| Time | Scene | Picture | Sound |
|---|---|---|---|
| 0-9.6 s | 1. Morning | the tern leaves the lantern arm, circles, dives, comes up with a fish, gulps it | plucked G major bed, the series theme on a pennywhistle; falling whistle, splash, gulp |
| 10.6-16.2 s | 2. Clawd's turn | three hops out to the bowsprit tip; he looks down and wiggles | rising plucks, a nervous pad |
| 16.4-20.8 s | | a flip and a belly flop; bubbles; he bobs up and spits; the tern laughs | drumroll, slide whistle, a big splash, bubbles, a boing, three squawks |
| 23-28.2 s | 3. The whale | the sea swells; a whale lifts him clear; "uh-oh" | low rumble, bubbles, whale song, the uh-oh notes from Episode 1 |
| 28.5-33 s | | pull wide on the whole whale; a test puff | timpani and brass in G; a small whoosh; snare roll |
| 33-35.5 s | 4. Flight | the big spout launches him tumbling over the ship into the barrel | spout whoosh, crash, a slide whistle up and down, a falling celesta run, rain |
| 38-42 s | | the tail rises, waves, and slaps the water | whale song, strings, a huge splash with timpani |
| 43-49 s | | the tern lands on the barrel; Clawd peeks out with a fish and gives it to the tern; toss, gulp, a nod | flaps, a trill, fish flops, a celesta ta-da, a gulp |
| 49-57 s | 5. Friends | the theme played by the full band; the whale spouts once more alongside, then dives; the tern hops onto Clawd's head | the theme in G major for the full band, whale song |
| 56.5-60 s | | the end card | celesta arpeggio, final G major chord |

## Run it

```sh
python episode2.py                              # build/episode2.blend
BLEND=episode2 python render.py stills 50 8     # preview contact sheets
BLEND=episode2 python render.py all 1 10 700    # render in chunks: 1-700, then 701-1440
python episode2_sound.py                        # build/episode2/sound.wav
python episode2_post.py                         # episode2_the_whale.mp4
```
