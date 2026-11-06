/**
 * Distant thunder, made on the spot with Web Audio: brown noise through a low-pass filter that
 * sweeps down, under a slow swell and a long tail. Quiet by design (Bill: "a quiet rumble, not a
 * big, loud, crashing, distracting sound"). No recordings, so nothing to license.
 *
 * Browsers start audio only after a click; call unlock() from one (the Start button).
 */
export class Thunder {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = localStorage.getItem('primundi.muted') === '1';
  /** Overall level, 0..1. */
  volume = 0.55;

  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.muted ? 0 : this.volume;
    // A gentle compressor, so a near roll never jumps out.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24; comp.ratio.value = 4;
    this.out.connect(comp).connect(ctx.destination);
    // Eight seconds of brown noise, reused (each roll starts somewhere else in it).
    const len = ctx.sampleRate * 8, buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    }
    this.noise = buf;
  }

  setMuted(m: boolean) {
    this.muted = m;
    localStorage.setItem('primundi.muted', m ? '1' : '0');
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.1);
  }

  /**
   * One roll of thunder. `near` 0 (far off, a low murmur) .. 1 (close: brighter, with a soft crack
   * first); `delay` seconds after now (light travels faster than sound); `pan` −1..1.
   */
  roll(near: number, delay = 0, pan = 0) {
    const ctx = this.ctx, noise = this.noise, out = this.out;
    if (!ctx || !noise || !out || this.muted || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + delay;
    const dur = 3.5 + Math.random() * 3 + (1 - near) * 2;
    const peak = (0.25 + 0.75 * near) * (0.6 + Math.random() * 0.4);

    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.25;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    const top = 140 + near * 520;
    lp.frequency.setValueAtTime(top, t0);
    lp.frequency.exponentialRampToValueAtTime(55 + near * 40, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    // Rolls come in a few swells, not one bang.
    const swells = 2 + Math.floor(Math.random() * 3);
    let t = t0;
    for (let s = 0; s < swells; s++) {
      const up = 0.15 + Math.random() * 0.5, lvl = peak * (s === 0 ? 1 : 0.4 + Math.random() * 0.5);
      t += up;
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, lvl), t);
      t += 0.2 + Math.random() * 0.6;
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, lvl * 0.35), t);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, Math.max(t + 0.5, t0 + dur));
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(lp).connect(g).connect(p).connect(out);
    src.start(t0, Math.random() * 4, dur + 1);
    src.stop(t0 + dur + 1);

    // Close by: a muffled crack before the roll.
    if (near > 0.6) {
      const c = ctx.createBufferSource();
      c.buffer = noise;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.5;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, t0 - 0.05);
      cg.gain.exponentialRampToValueAtTime(0.18 * (near - 0.5), t0);
      cg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
      c.connect(bp).connect(cg).connect(p);
      c.start(Math.max(ctx.currentTime, t0 - 0.05), Math.random() * 6, 0.8);
    }
  }
}
