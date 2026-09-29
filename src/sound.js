import { TAU, clamp } from './util.js';
const LINE_H = 1 / 6;

// ---------------------------------------------------------------- sound (all synthesized)
export const Sound = (() => {
  let ctx = null, out = null, nb = null, master = null;
  const S = { get ready() { return !!ctx; } };
  const T = () => ctx.currentTime + .004;
  function link(...n) { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; }
  function noise(t, dur) { const s = ctx.createBufferSource(); s.buffer = nb; s.start(t, Math.random() * 1.7, dur + .05); return s; }
  function osc(type, f, t, dur) { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.start(t); o.stop(t + dur + .06); return o; }
  function filt(type, f, q = 1) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
  function env(t, peak, a, d) { const g = ctx.createGain(); g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(.0001, t + a + d); return g; }
  function panner(p) { const s = ctx.createStereoPanner(); s.pan.value = clamp(p, -1, 1); s.connect(out); return s; }
  function impulse(sec) {
    const rate = ctx.sampleRate, len = rate * sec | 0, b = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch); let lp = 0;
      for (let i = 0; i < len; i++) { const t = i / rate; lp = lp * .55 + (Math.random() * 2 - 1) * .45; d[i] = lp * Math.pow(1 - t / sec, 4) * (t < .006 ? 0 : 1); }
    }
    return b;
  }
  S.init = () => {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 14; comp.ratio.value = 3.5; comp.attack.value = .002; comp.release.value = .15;
    master = ctx.createGain(); master.gain.value = S.muted ? 0 : 1; comp.connect(master); master.connect(ctx.destination);
    out = ctx.createGain(); out.gain.value = .9; out.connect(comp);
    const conv = ctx.createConvolver(); conv.buffer = impulse(1.5);
    const wet = ctx.createGain(); wet.gain.value = .16; out.connect(conv); conv.connect(wet); wet.connect(comp);
    if (S.muted) ctx.suspend();
    nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // room tone + faint transformer hum of a powered machine
    const bb = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate), bd = bb.getChannelData(0);
    let l = 0; for (let i = 0; i < bd.length; i++) { l = (l + .02 * (Math.random() * 2 - 1)) / 1.02; bd[i] = l * 3.5; }
    const room = ctx.createBufferSource(); room.buffer = bb; room.loop = true;
    const rg = ctx.createGain(); rg.gain.value = .012; link(room, filt('lowpass', 320, .7), rg, comp); room.start();
    const hum = ctx.createOscillator(); hum.frequency.value = 120; const hg = ctx.createGain(); hg.gain.value = .001;
    link(hum, hg, comp); hum.start();
  };
  S.muted = false;
  S.resume = () => ctx && !S.muted && !document.hidden && ctx.state !== 'running' && ctx.resume();
  // a hidden tab goes quiet: the room tone and hum stop, and the page can be throttled
  document.addEventListener('visibilitychange', () => { if (!ctx || S.muted) return; if (document.hidden) ctx.suspend(); else ctx.resume(); });
  // mute fades the master out, then suspends the audio thread entirely (no CPU while silent)
  S.setMuted = m => {
    S.muted = m; if (!ctx) return;
    const t = ctx.currentTime; master.gain.cancelScheduledValues(t); master.gain.setValueAtTime(master.gain.value, t);
    if (m) { master.gain.linearRampToValueAtTime(0, t + .15); setTimeout(() => S.muted && ctx.suspend(), 200); }
    else { ctx.resume(); master.gain.linearRampToValueAtTime(1, t + .15); }
  };

  // ---- mechanism sounds, modelled on a recorded Canon Typestar 220-II ------------------------
  // Measured from the recording: the carriage stepper while printing sits at ~654 Hz with strong
  // 2nd–4th harmonics, a body resonance cluster at 2.3–2.6 kHz and a 27 Hz pulse from the head;
  // the return runs at ~506 Hz with a dominant 2nd harmonic; line feed is a ~330 Hz motor tone.
  // The clicks and clacks are short (16–50 ms), bright (centroid ~4 kHz) filtered-noise bursts
  // ringing a few body modes, and they are ~25 dB louder than the printing whine.
  const PRINT_PARTIALS = [[654, 1], [818, .18], [1087, .16], [1308, .72], [1497, .14], [1637, .22], [1960, .46], [2288, .42], [2315, .5], [2401, .46], [2449, .4], [2514, .36], [2611, .5], [3270, .3], [3924, .18]];
  const RETURN_PARTIALS = [[210, .2], [506, .32], [845, .2], [1012, 1], [1265, .28], [1518, .36], [1685, .28], [1895, .44], [2024, .24], [2320, .45], [2444, .45], [2525, .55], [3036, .25], [3542, .18]];
  const LF_PARTIALS = [[329, 1], [658, .45], [987, .25], [1316, .18], [2400, .12]];
  let bank = null;
  const RATE = () => ctx.sampleRate;
  function toBuffer(arr, peak = .9) {
    let m = 0; for (let i = 0; i < arr.length; i++) m = Math.max(m, Math.abs(arr[i]));
    const b = ctx.createBuffer(1, arr.length, ctx.sampleRate), d = b.getChannelData(0), g = m ? peak / m : 1;
    for (let i = 0; i < arr.length; i++) d[i] = arr[i] * g; return b;
  }
  // RBJ band-pass run over an array (used to ring body modes from a noise burst)
  function bandpass(x, f, q) {
    const w = TAU * f / RATE(), al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
    const b0 = al / a0, b2 = -al / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
    const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
    return y;
  }
  // a plastic-and-steel clack: sharp broadband tick + noise ringing a handful of body modes
  function clack(modes, { len = .09, tick = .5, excite = .003, low = 0 } = {}) {
    const n = Math.ceil(len * RATE()), ex = new Float32Array(n);
    const en = Math.ceil(excite * RATE());
    for (let i = 0; i < en; i++) ex[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / en, 2);
    const out = new Float32Array(n);
    for (const [f, q, a] of modes) { const y = bandpass(ex, f * (1 + (Math.random() - .5) * .05), q); for (let i = 0; i < n; i++) out[i] += y[i] * a * q * .5; }
    const tn = Math.ceil(.0012 * RATE());
    for (let i = 0; i < tn; i++) out[i] += (Math.random() * 2 - 1) * tick * (1 - i / tn);
    if (low) { let lp = 0; for (let i = 0; i < Math.min(n, RATE() * .04); i++) { lp = lp * .93 + (Math.random() * 2 - 1) * .07; out[i] += lp * low * Math.exp(-i / RATE() / .012); } }
    // gentle fade so nothing clicks at the tail
    for (let i = 0; i < n; i++) out[i] *= Math.min(1, (n - i) / (RATE() * .01));
    return toBuffer(out, .95);
  }
  // steady stepper whine: partials follow the speed curve, with a pulse, jitter and mechanical hiss
  function whine(dur, partials, { ramp = .06, pulse = 0, pulseDepth = 0, hiss = .25, air = .5, jitter = .004, fScale = 1 } = {}) {
    const rate = RATE(), n = Math.ceil(dur * rate), out = new Float32Array(n);
    const ph = partials.map(() => Math.random() * TAU);
    let wob = 0, lp = 0, bp1 = 0, bp2 = 0, h1 = 0;
    // three slow random walks give each partial its own wander, so the lines are rough, not pure
    const w3 = [0, 0, 0], a3 = [0, 0, 0];
    const sp = t => { const a = Math.min(1, t / ramp), b = Math.min(1, (dur - t) / ramp); return Math.max(.3, Math.min(Math.sin(a * Math.PI / 2), Math.sin(b * Math.PI / 2))); };
    for (let i = 0; i < n; i++) {
      const t = i / rate, s = sp(t);
      wob = wob * .999 + (Math.random() - .5) * .002;
      const k = s * fScale * (1 + wob * jitter * 50);
      let v = 0;
      for (let j = 0; j < 3; j++) { w3[j] = w3[j] * .9995 + (Math.random() - .5) * .00009; a3[j] = a3[j] * .998 + (Math.random() - .5) * .008; }
      for (let p = 0; p < partials.length; p++) { const j = p % 3; ph[p] += TAU * partials[p][0] * k * (1 + w3[j] * 6) / rate; v += Math.sin(ph[p]) * partials[p][1] * (1 + a3[j] * 4); }
      // mechanical hiss band 600–2.4k (cheap: difference of two one-poles)
      const nz = Math.random() * 2 - 1; bp1 += (nz - bp1) * .3; bp2 += (bp1 - bp2) * .08; lp = bp1 - bp2;
      h1 += (nz - h1) * .45; const hi = nz - h1;          // air: 2.5 kHz and up
      v = v * .35 + lp * hiss * 2.2 + hi * air * .5;
      if (pulse) { const q = Math.pow(.5 + .5 * Math.cos(TAU * pulse * t), 6); v *= 1 - pulseDepth + pulseDepth * (.4 + 1.2 * q); }
      const env = Math.min(1, t / .015, (dur - t) / .02);
      out[i] = v * env * (.55 + .45 * s);
    }
    return toBuffer(out, .9);
  }
  function play(buf, t, gain, pan = 0, rate = 1, lp = 0, hp = 0) {
    const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
    const g = ctx.createGain(); g.gain.value = gain;
    const nodes = [s]; if (hp) nodes.push(filt('highpass', hp, .7)); if (lp) nodes.push(filt('lowpass', lp, .7)); nodes.push(g, panner(pan));
    link(...nodes); s.start(t); return s;
  }
  function panned(buf, t, gain, p0, p1, dur, hp = 120) {
    const s = ctx.createBufferSource(); s.buffer = buf;
    const g = ctx.createGain(); g.gain.value = gain;
    const P = ctx.createStereoPanner(); P.pan.setValueAtTime(p0 * .55, t); P.pan.linearRampToValueAtTime(p1 * .55, t + dur); P.connect(out);
    link(s, filt('highpass', hp, .7), g, P); s.start(t);
  }
  function build() {
    const V = (fn, k = 6) => Array.from({ length: k }, fn);
    bank = {
      // head solenoid pulling the thermal head onto the platen
      lock: V(() => clack([[180, 4, .9], [370, 5, .7], [560, 7, .6], [960, 8, .45], [2450, 10, .3], [4070, 9, .25]], { len: .1, tick: .45, low: .9 })),
      // ribbon clutch / small plastic tick
      tick: V(() => clack([[540, 8, .5], [900, 10, .5], [2450, 12, .5], [3400, 10, .4]], { len: .05, tick: .7, excite: .0015 })),
      // head release: the loud pair of clacks
      release: V(() => clack([[520, 7, .6], [840, 9, .9], [880, 12, .6], [1550, 10, .6], [1770, 9, .4], [3380, 10, .45]], { len: .08, tick: .9, low: .6 })),
      rattle: V(() => clack([[600, 6, .4], [880, 8, .5], [2600, 10, .4], [2650, 12, .3]], { len: .06, tick: .3, excite: .004 }), 4),
      // platen advance clack
      lfClack: V(() => clack([[860, 9, .8], [1055, 10, .5], [2430, 11, .45], [330, 6, .5]], { len: .09, tick: .7, low: .5 }), 4),
      // carriage hitting its left stop
      stop: V(() => clack([[180, 5, .8], [280, 6, .6], [600, 8, .5], [2200, 10, .3]], { len: .12, tick: .4, low: 1 }), 4),
      detent: V(() => clack([[1900, 9, .6], [3600, 10, .4], [800, 7, .3]], { len: .03, tick: .5, excite: .001 }), 4),
    };
    bank.lf = whine(.4, LF_PARTIALS, { ramp: .05, hiss: .15, air: .05 });
  }
  const pick = arr => arr[Math.random() * arr.length | 0];
  const ensure = () => { if (!ctx || S.muted) return false; if (!bank) build(); return true; };
  const vary = () => .96 + Math.random() * .08;

  // head goes down onto the platen: thunk, then two small ribbon-clutch ticks
  S.lock = (p = 0, soft = false) => {
    if (!ensure()) return; const t = T();
    play(pick(bank.lock), t, soft ? .14 : .22, p * .55, vary());
    if (!soft) { play(pick(bank.tick), t + .065, .12, p * .55, vary()); play(pick(bank.tick), t + .17, .09, p * .55, vary()); }
  };
  // the head printing its way across: quiet, steady, pulsing
  S.print = (dur, p0 = 0, p1 = 0) => {
    if (!ensure() || dur < .02) return;
    panned(whine(dur, PRINT_PARTIALS, { ramp: Math.min(.05, dur / 4), pulse: 27.2, pulseDepth: .45, hiss: .3, air: .7 }), T(), .05, p0, p1, dur, 300);
  };
  // head lifts off: the loud clack pair and a little rattle
  S.release = (p = 0, soft = false) => {
    if (!ensure()) return; const t = T(), P = p * .55;
    if (soft) { play(pick(bank.release), t, .38, P, vary() * 1.05); return; }
    play(pick(bank.tick), t, .25, P, vary());
    play(pick(bank.release), t + .1, 1, P, vary());
    play(pick(bank.release), t + .2, .8, P, vary() * .97);
    play(pick(bank.rattle), t + .29, .25, P, vary()); play(pick(bank.rattle), t + .325, .3, P, vary());
  };
  // carriage travelling without printing (return, repositioning)
  S.travel = (dur, dist, p0 = 0, p1 = 0, knock = true) => {
    if (!ensure() || dist < .01) return; const t = T();
    if (dur > .12) { play(pick(bank.tick), t, .16, p0 * .55, vary()); play(pick(bank.tick), t + .06, .12, p0 * .55, vary()); }
    panned(whine(dur, RETURN_PARTIALS, { ramp: Math.min(.12, dur / 3), hiss: .25, air: .7 }), t, dur > .12 ? .045 : .025, p0, p1, dur, 200);
    if (knock && dist > 1) play(pick(bank.stop), t + dur, .3, p1 * .55, vary());
  };
  S.step = (p = 0) => S.travel(.03, .1, p, p, false);
  // platen line feed: clack, then the short motor tone
  S.lf = (dur = .3, dist = LINE_H) => {
    if (!ensure()) return; const t = T();
    play(pick(bank.lfClack), t, .4, 0, vary());
    const d = Math.max(.12, dur);
    const b = d <= .42 ? bank.lf : whine(d, LF_PARTIALS, { ramp: .06, hiss: .15, air: .05 });
    const s = ctx.createBufferSource(); s.buffer = b; const g = ctx.createGain();
    g.gain.setValueAtTime(.03, t + .02); g.gain.setValueAtTime(.03, t + .02 + d - .03); g.gain.linearRampToValueAtTime(.0001, t + .02 + d);
    link(s, filt('highpass', 150, .7), g, out); s.start(t + .02, 0, d);
  };
  S.knob = () => {
    if (!ensure()) return; const t = T();
    for (let i = 0; i < 3; i++) play(pick(bank.detent), t + i * .024, .28, 0, vary());
  };
  S.lift = () => { };
  S.strike = () => { };
  S.select = () => { };
  // a key on the keyboard (quiet membrane with click)
  // ---- the keyboard: a mechanical board, modelled on how switches actually sound ----------------------
  // Each press has two events. The downstroke is the stem bottoming out: a body "thock" (200–800 Hz,
  // the plate and case) with a brighter click on top (1.5–3 kHz). The upstroke, on release, is the stem
  // returning to the top of its housing: a quieter, higher "tic". Long keys (space, return, backspace,
  // shift) are deeper and carry a faint stabiliser rattle. Every key sounds a little different depending
  // on where it sits on the board, and is placed left-to-right in the stereo field.
  S.key = () => { };                                       // (presses are voiced by keyDown / keyUp)
  const ROWS = ['Backquote Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal Backspace',
    'Tab KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight Backslash',
    'CapsLock KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote Enter',
    'ShiftLeft KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash ShiftRight',
    'ControlLeft AltLeft MetaLeft Space MetaRight AltRight ArrowLeft ArrowDown ArrowRight'];
  const KEYPOS = {};
  ROWS.forEach((r, row) => r.split(' ').forEach((c, i, arr) => { KEYPOS[c] = { x: (i + .5) / arr.length * 2 - 1, row }; }));
  const LONG = new Set(['Space', 'Enter', 'Backspace', 'ShiftLeft', 'ShiftRight', 'Tab', 'CapsLock', 'NumpadEnter']);
  const hashCode = c => { let h = 7; for (const ch of c || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
  // each key a little different: centre keys slightly lower, edges higher, plus a fixed per-key detune; placed in stereo
  const keyVoice = code => {
    const p = KEYPOS[code] || { x: 0, row: 2 }, h = hashCode(code);
    return { pan: p.x * .4, rate: .96 + Math.abs(p.x) * .05 + (p.row - 2) * .012 + ((h % 17) / 17 - .5) * .04, long: LONG.has(code) };
  };
  // The voices build on the original key sound (a filtered click plus a short low thud), refined:
  //  · downstroke: the switch click (~1.9–2.3 kHz), a soft body band (~480 Hz) that gives the "thock",
  //    and the low thud of the keycap bottoming out on the plate
  //  · upstroke (on release): the original little tick, a touch brighter, never before 45 ms after the press
  //  · long keys: the same, lower and a little longer
  //  · space bar: deeper and softer (its cap is long and light), with a quiet stabiliser wire that ticks
  //    twice as it settles, on the way down and again on the way up
  const down = new Map();
  function thud(t, f0, f1, gain, dur, P) { const o = osc('sine', f0, t, dur + .02); o.frequency.exponentialRampToValueAtTime(f1, t + dur * .8); link(o, env(t, gain, .001, dur), P); }
  function band(t, f, q, gain, dur, P) { link(noise(t, dur + .01), filt('bandpass', f, q), env(t, gain, .0005, dur), P); }
  S.keyDown = (code, repeat = false) => {
    if (!ctx || S.muted || repeat) return;                 // a held key doesn't re-strike
    const t = T(), v = keyVoice(code), r = v.rate, P = panner(v.pan), g = .9 + Math.random() * .2;
    if (code === 'Space') {
      band(t, 1250 * r, 1.1, .1 * g, .016, P);            // broad, soft click
      band(t, 300 * r, 1.6, .15 * g, .034, P);            // long cap: deeper body
      thud(t, 125 * r, 58, .15 * g, .04, P);
      band(t + .007, 2900, 3, .028, .01, P);              // stabiliser wire settling…
      band(t + .019, 3300, 3, .014, .008, P);             // …and once more, fainter
    } else if (v.long) {
      band(t, 1550 * r, 1.2, .14 * g, .016, P);
      band(t, 400 * r, 2, .14 * g, .028, P);
      thud(t, 155 * r, 72, .13 * g, .03, P);
      band(t + .006, 2700, 3, .02, .009, P);
    } else {
      band(t, (1900 + Math.random() * 400) * r, 1.3, .15 * g, .014, P);
      band(t, 480 * r, 2.2, .1 * g, .022, P);
      thud(t, 195 * r, 85, .1 * g, .024, P);
    }
    down.set(code, t);
  };
  S.keyUp = code => {
    if (!ctx || S.muted) return;
    const t0 = down.get(code); down.delete(code);
    const t = Math.max(T(), (t0 ?? 0) + .045), v = keyVoice(code), r = v.rate, P = panner(v.pan);
    if (code === 'Space') {
      band(t, 1700 * r, 1.4, .05, .012, P); band(t, 380 * r, 2, .04, .018, P);
      band(t + .005, 3200, 3, .02, .008, P);
    } else if (v.long) {
      band(t, 2300 * r, 1.8, .05, .011, P); band(t + .004, 3000, 3, .012, .007, P);
    } else band(t, 2650 * r, 2, .05, .01, P);
  };
  S.beep = (f = 2080, dur = .085, vol = .05) => {
    if (!ctx) return; const t = T();
    const o = osc('square', f, t, dur); const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.setValueAtTime(vol, t + dur - .005); g.gain.linearRampToValueAtTime(.0001, t + dur);
    link(o, filt('lowpass', 5200, .7), g, out);
  };
  S.error = () => { S.beep(1040, .07, .05); setTimeout(() => S.beep(1040, .07, .05), 110); };
  // lift-off correction: softer double strike on correction tape
  S.correct = (p = 0) => { if (!ensure()) return; play(pick(bank.lock), T(), .4, p * .55, .85); };
  // the film letting go of the ink it just re-melted: a short, dry hiss that falls in pitch
  S.peel = (p = 0) => {
    if (!ensure()) return; const t = T();
    const bp = filt('bandpass', 5200, 1.3); bp.frequency.setValueAtTime(5200, t); bp.frequency.exponentialRampToValueAtTime(1700, t + .16);
    link(noise(t, .18), bp, filt('highpass', 900, .7), env(t, .045, .012, .15), panner(p * .55));
  };
  S.tear = () => {
    if (!ctx) return; const t = T(), rate = ctx.sampleRate, dur = .62, len = rate * dur | 0;
    const b = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch); let lp = 0;
      for (let i = 0; i < len; i++) {
        const x = i / len; const e = Math.pow(Math.sin(Math.PI * Math.min(1, x * 1.12)), .5) * (1 - x * .55);
        let v = (Math.random() * 2 - 1) * .22 * e;
        if (Math.random() < (.02 + .09 * e)) v += (Math.random() * 2 - 1) * 1.5 * e;
        lp = lp * .35 + v * .65; d[i] = lp;
      }
    }
    const s = ctx.createBufferSource(); s.buffer = b; const g = ctx.createGain(); g.gain.value = 1.1;
    link(s, filt('highpass', 450, .7), filt('peaking', 2600, .8), g, out); s.start(t);
    link(noise(t, .3), filt('lowpass', 380, .8), env(t, .2, .02, .25), out);
  };
  // a sheet settling: a soft air-cushion puff and the faint tick of an edge touching down
  S.flop = (v = .3) => {
    if (!ctx) return; const t = T(), k = v * .3;
    link(noise(t, .1), filt('lowpass', 900, .7), env(t, k, .006, .06), out);
    link(noise(t + .03, .02), filt('bandpass', 4200, 1.5), env(t + .03, k * .25, .001, .012), out);
  };
  // lifting or sliding a sheet: a short, airy brush
  S.rustle = () => {
    if (!ctx) return; const t = T();
    const n = noise(t, .22); const g = ctx.createGain(); g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(.022, t + .05); g.gain.linearRampToValueAtTime(.0001, t + .2);
    link(n, filt('highpass', 1800, .7), filt('lowpass', 7000, .7), g, out);
  };
  // balling up a sheet: a burst of dense crackles that thins out
  S.crumple = () => {
    if (!ctx) return; const t = T(), rate = ctx.sampleRate, dur = .55, len = rate * dur | 0;
    const b = ctx.createBuffer(1, len, rate), d = b.getChannelData(0); let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len, e = Math.pow(1 - x, 1.6);
      let v = (Math.random() * 2 - 1) * .08 * e;
      if (Math.random() < .03 * e + .004) v += (Math.random() * 2 - 1) * e;
      lp = lp * .4 + v * .6; d[i] = lp;
    }
    const s = ctx.createBufferSource(); s.buffer = b; const g = ctx.createGain(); g.gain.value = .45;
    link(s, filt('highpass', 900, .7), filt('lowpass', 9000, .7), g, out); s.start(t);
  };
  // the ball landing in the wire basket
  S.bin = () => {
    if (!ctx) return; const t = T();
    link(noise(t, .08), filt('bandpass', 1400, 2), env(t, .12, .002, .05), out);
    link(noise(t, .15), filt('lowpass', 500, .8), env(t, .08, .004, .1), out);
  };
  return S;
})();
