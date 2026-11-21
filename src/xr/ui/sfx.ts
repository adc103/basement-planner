/** Tiny synthesized UI sounds (no audio files). */
export class Sfx {
  private ctx: AudioContext | null = null;
  enabled = true;

  private ac(): AudioContext | null {
    if (!this.enabled) return null;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  private blip(freq: number, ms: number, gain: number): void {
    const ac = this.ac();
    if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.7, t + ms / 1000);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.01);
  }

  click(): void {
    this.blip(1400, 45, 0.06);
  }

  tick(): void {
    this.blip(2200, 18, 0.015);
  }
}
