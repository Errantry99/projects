# Episode 1: The Stowaway

60 s / 16:9 / 24 fps. Picks up where the intro ends: Clawd is out on the ice, and the Arctic Tern
is sailing on without him.

> Left behind on the ice, Clawd chases the ship floe by floe and makes one big leap onto the stern,
> straight into the barrel. The tern finds him, and they don't get along. Then fog rolls in and an
> iceberg looms dead ahead. The tern is lost, so Clawd climbs to the crow's nest and his eye beams
> find the gap. The tern flies out along the beam to guide the ship through. At dawn the two of them
> share the crow's nest, and the tern gives him a nod.

## Scenes

| Time | Scene | Picture | Sound |
|---|---|---|---|
| 0-8 s | 1. Left behind | Clawd alone on a floe as the ship sails off; an "uh-oh" close-up | sea, D minor strings, the theme on celesta; two falling notes |
| 8.5-13 s | 2. The chase | five hops across the floes, one per second | 120 BPM pizzicato bed, the theme on a bowed lead, a bloop per landing |
| 14-16 s | | a big flipping leap onto the stern, then a hop into the barrel; the lid slams | slide whistle, thump, boing, the lid clunk, then silence |
| 19-24.5 s | 3. Discovered | the tern lands by the barrel, pecks the lid three times; two glowing eyes peek out | knocks, a creak, a glowing-eyes trill |
| 24.5-29 s | | the tern jumps to the yard; standoff; Clawd pops out | squawk, brass stab, tremolo, grumpy squawks |
| 29-38 s | 4. Fog and ice | fog thickens, the lantern flickers; the tern scouts ahead and comes back lost | wind, low drone, sputters, distant calls |
| 38 s | | an iceberg looms dead ahead | timpani, low brass, crash |
| 39.8-43.4 s | | Clawd hops up the forestay into the crow's nest | rising plucks D F A D, rope squeaks |
| 44-50 s | | eye beams sweep the fog and find the gap; the tern flies out along the beam; the ship turns | whoom, hum, strings, celesta "found it", snare roll |
| 49-57 s | 5. Dawn | fog clears, the sky warms; the ship heads for the gap | the theme in D major: strings, brass, timpani |
| 55-60 s | | the tern lands beside Clawd in the nest: a look, two nods, happy eyes; the end card | two celesta notes, an arpeggio, a final D major chord |

The theme is original, written in eighth notes at 120 BPM (see `THEME` in `episode1_sound.py`).

## Run it

```sh
python episode1.py                              # build/episode1.blend
BLEND=episode1 python render.py stills 50 8     # preview contact sheets
BLEND=episode1 python render.py all 1 10        # 1440 frames (~12 s/frame on 4 CPU cores)
python episode1_sound.py                        # build/episode1/sound.wav
python episode1_post.py                         # episode1_the_stowaway.mp4
```
