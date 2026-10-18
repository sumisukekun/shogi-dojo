/*
 * sound.js — 効果音（音声ファイルを使わず、その場で合成。駒音・王手・対局開始/終了）
 */
(function () {
  'use strict';
  let ctx = null;
  const store = window.DojoStore || { get: () => null, set: () => {} };
  const Sound = {
    get enabled() { return store.get('dojo_sound') !== 'off'; },
    set enabled(v) { store.set('dojo_sound', v ? 'on' : 'off'); },
    unlock() {
      if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; } }
      if (ctx && ctx.state === 'suspended') ctx.resume();
    },
    // 駒を盤に置く音：短い打撃音＋木の響き
    koma(strong) {
      if (!this.enabled || !ctx) return;
      const t = ctx.currentTime;
      const len = 0.09, buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * len), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 6);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = strong ? 1500 : 1900; bp.Q.value = 1.4;
      const g = ctx.createGain(); g.gain.value = strong ? 1.3 : 0.9;
      src.connect(bp).connect(g).connect(ctx.destination);
      src.start(t);
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.frequency.setValueAtTime(strong ? 170 : 210, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.08);
      og.gain.setValueAtTime(0.35, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      o.connect(og).connect(ctx.destination); o.start(t); o.stop(t + 0.12);
    },
    tone(freqs, dur = 0.18, vol = 0.18) {
      if (!this.enabled || !ctx) return;
      const t = ctx.currentTime;
      freqs.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const s = t + i * dur * 0.8;
        g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(vol, s + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
        o.connect(g).connect(ctx.destination); o.start(s); o.stop(s + dur + 0.02);
      });
    },
    start() { this.tone([523, 659, 784], 0.16); },
    end(win) { this.tone(win ? [784, 988, 1175] : [523, 440, 349], 0.22); },
    tick() { this.tone([1046], 0.06, 0.08); },
  };
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => Sound.unlock(), { once: false, passive: true }));
  window.DojoSound = Sound;
})();
