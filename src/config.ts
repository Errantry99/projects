/**
 * Every tuning constant, one per line.
 *
 * The build plan's T1 acceptance criterion — "changing any CONFIG value
 * requires editing exactly one line" — survives the TypeScript move
 * deliberately: this stays one flat object, not a nest of grouped sections.
 */
export const CONFIG = {
  debug: false, // log state transitions to the console
  timeScale: 1, // multiplies all session time (20 = 20x faster, for testing)
  maxFrameMs: 60_000, // largest single frame the clock will credit

  buildMinutes: 20, // minutes of continuous WRITING to reach depth 1.0
  thinkingMs: 2_000, // silence after which WRITING -> THINKING
  stoppedMs: 30_000, // silence after which THINKING -> STOPPED
  decayRate: 1 / 3, // depth decay speed in STOPPED, relative to build rate
  recoveryRate: 2, // depth build speed while below the high-water mark

  cvLow: 0.35, // CV at or below this = maximum rhythm gain
  cvHigh: 0.6, // CV at or above this = zero rhythm gain
  gainAtLowCV: 1.0, // rhythm gain when CV <= cvLow
  gainAtHighCV: 0.0, // rhythm gain when CV >= cvHigh
  ikiBufferSize: 24, // rolling inter-keystroke-interval buffer length
  ikiMaxMs: 2_000, // intervals longer than this are pauses, not rhythm
  ikiMinSamples: 6, // samples needed before rhythm gain is trusted
  gainSmoothingMs: 900, // smoothing time constant for the rhythm gain
  gainSilenceDecayMs: 2_500, // rhythm gain falls to zero this fast when not typing

  bpmMin: 70, // derived tempo folded into this range (low end)
  bpmMax: 110, // derived tempo folded into this range (high end)
  bpmSnap: 5, // derived tempo snapped to this grid
  bpmDefault: 90, // tempo before enough samples exist
  tempoGlideMs: 4_000, // time to glide from one tempo to the next

  lineChars: 60, // fixed wrap width, in average characters
  charsAcrossSurface: 60, // characters visible across the viewport at depth 0
  wordsAcrossDeep: 1.5, // words visible across the viewport at depth 1
  charsPerWord: 6.6, // average word length incl. trailing space
  contentWidthFraction: 0.9, // fraction of viewport width the text column may use
  minFontPx: 13, // never render smaller than this
  lineHeight: 1.6, // multiple of font size
  caretAnchor: 0.66, // where the caret sits across a zoomed line
  gutterFraction: 0.07, // whitespace kept at the leading edge of a zoomed line
  gutterMinPx: 18, // floor for that gutter
  followTauMs: 110, // horizontal follow: smoothing time constant

  bgSurface: "#F2E8DB", // background at depth 0
  bgDeep: "#000000", // background at depth 1
  inkSurface: "#1A1714", // text colour near the surface
  inkEmber: "#8C7F6B", // text colour in the dark
  haloColor: "#F6EEE0", // legibility halo through the ink crossover
  haloOnsetContrast: 6.0, // halo fades in as ink/background contrast falls below this
  inkCrossWindow: 0.14, // depth span of the ink crossover
  bloomRadiusEm: 0.42, // ember bloom radius, in em
  bloomAlpha: 0.5, // ember bloom strength at full crossfade

  chromeFadeMs: 90_000, // WRITING time over which the chrome fades away
  caretBlinkMs: 1_100, // caret blink period while idle at the keyboard
  escHintMs: 3_000, // window in which a second Esc surfaces
  surfacingMs: 4_000, // cooling ramp: visuals and audio to the surface

  audioMasterDefault: 0.7, // starting master volume (0..1)
  droneRootHz: 55, // fundamental sine
  droneDetuneHz: 55.4, // triangle partner, slightly detuned
  droneOctaveHz: 110, // octave voice
  droneOctaveDepth: 0.7, // depth above which the octave fades in
  droneGainLow: 0.1, // drone gain at depth 0
  droneGainHigh: 0.5, // drone gain at depth 1
  droneFilterLowHz: 180, // lowpass cutoff at depth 0
  droneFilterHighHz: 780, // lowpass cutoff at depth 1
  droneLfoHz: 0.05, // cutoff LFO rate
  droneLfoDepthHz: 140, // cutoff LFO excursion
  pulseRootHz: 220, // pulse blip root
  pulseFifthRatio: 1.5, // fifth above the root
  pulseGain: 0.22, // pulse gain ceiling
  pulseAttackMs: 18, // blip attack
  pulseDecayMs: 260, // blip decay
  pulseFifthDepth: 0.8, // depth above which root/fifth alternation begins
  surfacingFilterHz: 90, // lowpass sweep target while surfacing
  schedulerLookaheadMs: 220, // audio scheduling horizon

  depthStops: [0.25, 0.55, 0.85] as const, // surface / descending / deep / channel
  depthPhrases: ["surface", "descending", "deep", "channel"] as const,
};

export type Config = typeof CONFIG;
