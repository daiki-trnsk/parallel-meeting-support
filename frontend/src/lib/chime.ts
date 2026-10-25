// Short synthesized "ピン!" played the moment a summon starts a response, so
// the 同時参加者 doesn't miss the switch into 応答中. Generated with Web Audio
// (no asset file): a high sine with a near-instant attack and a quick
// exponential decay.

const FREQ_HZ = 1568; // G6 — bright, cuts through meeting audio
const PEAK_GAIN = 0.9; // just under 1.0 (clipping)
const ATTACK_S = 0.005;
const DECAY_S = 0.35;

let ctx: AudioContext | null = null;

/** Create/resume the AudioContext. Call from a user gesture (the 開始 click)
 * so the browser's autoplay policy lets later chimes play unprompted. */
export function unlockChime(): void {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') {
    ctx.resume().catch((e) => console.error('[chime] resume failed', e));
  }
}

export function playChime(): void {
  unlockChime();
  const c = ctx!;
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = FREQ_HZ;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(PEAK_GAIN, t0 + ATTACK_S);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ATTACK_S + DECAY_S);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + ATTACK_S + DECAY_S + 0.05);
}
