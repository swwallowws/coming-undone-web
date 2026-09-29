// Guided stemscribe demo over one frozen run (data.json from scripts/freeze_try.py):
// press play, solo a part, flip it from its audio stem to the MIDI stemscribe wrote.
// Every source runs off one AudioContext clock, made inside the first Play click.
// The MIDI plays on real instruments: spessasynth with the design system's shared
// General MIDI soundfont (vendor/design/sound/gm.sf3), each part on its own program,
// drums on channel 10's Standard kit. Notes are timed on the AudioContext clock.
import { demoShell } from "../vendor/design/demoshell.js";
import { iconButton } from "../vendor/design/iconbutton.js";
import { noteColor } from "../vendor/design/tokens.js";
import { seekable } from "../vendor/design/playhead.js";

const $ = (id) => document.getElementById(id);
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

const shell = demoShell($("demo"), {
  product: "Coming Undone",
  title: "Split a recording and write down every note.",
  intro: "One song, processed ahead of time.",
  steps: [
    { id: "play", label: "Press Play" },
    { id: "solo", label: "Solo a part" },
    { id: "midi", label: "Switch it to MIDI" },
  ],
  full: { coming: true },
  endText: "Done. Explore freely.",
  onReset: startOver,
  primary: { toggle: () => playBtn.toggle() },   // Space plays; no "Space: play" hint under the rail
});
const rail = shell.rail;

const playBtn = iconButton($("play"), {
  onPress: (pressed) => {
    if (!data) return;
    if (pressed) {
      startPlayback();
      did.play = true;
      progress();
    } else {
      stopPlayback();
    }
  },
});

// what the visitor has done so far; the rail ticks in order, so a step done early
// is ticked as soon as the ones before it are
const did = { play: false, solo: false, midi: false };
function progress() {
  for (const id of ["play", "solo", "midi"]) if (did[id]) rail.done(id);
}

let data = null;
let buffers = {}; // part id -> AudioBuffer
let peaks = null;
const stemPeaks = {}; // part id -> the stem's own peaks, drawn while you hear it as audio
let ctx = null, master = null, gains = {}, sources = [];
let synth = null, synthOut = null, synthLoad = null, channelOf = {}, quietUntil = 0;
let playing = false, pos = 0, t0 = 0, scheduledTo = 0, timer = 0;

const VENDOR = new URL("../vendor/", import.meta.url);
const SOUNDFONT = new URL("design/sound/gm.sf3", VENDOR).href;
// a part's General MIDI program when data.json (an older freeze) does not say
const PROGRAM = { vocals: 53, bass: 33, other: 0, guitar: 25, piano: 0 };
const LOOKAHEAD = 0.2;
let solo = null; // part id or null
const modes = {}; // part id -> "audio" | "midi"

// playback starts 50 ms after the click, so clamp that lead-in to the start
const songTime = () => (playing ? Math.max(pos, pos + (ctx.currentTime - t0)) : pos);
// where the playhead is drawn: under the pointer while a drag moves it during playback
let scrubAt = null;
const headTime = () => scrubAt ?? songTime();
const part = (id) => data.parts.find((p) => p.id === id);
const midiOn = () => solo !== null && modes[solo] === "midi";

// ---------- loading

async function load() {
  let res;
  try {
    res = await fetch("data.json");
  } catch {
    res = null;
  }
  if (!res || !res.ok) {
    notBuilt();
    return;
  }
  data = await res.json();
  $("song").textContent = data.title;
  $("time").textContent = `0:00 / ${fmtT(data.duration)}`;
  buildParts();
  try {
    // decode ahead of the click, so Play sounds at once; an AudioBuffer is not
    // tied to the context that decoded it
    const dec = new OfflineAudioContext(2, 1, 44100);
    const get = async (url) => dec.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const [mix, ...stems] = await Promise.all([get(data.mix), ...data.parts.map((p) => get(p.audio))]);
    peaks = computePeaks(mix, 1200);
    data.parts.forEach((p, i) => {
      buffers[p.id] = stems[i];
      stemPeaks[p.id] = computePeaks(stems[i], Math.ceil(data.duration * 100)); // 10 ms columns
    });
  } catch (e) {
    $("message").textContent = "The audio did not load. Reload to try again.";
    console.warn(e);
    return;
  }
  $("message").textContent = "";
  $("play").disabled = false;
  drawWave();
  drawRoll();
}

function notBuilt() {
  const m = $("message");
  m.innerHTML = "demo data not built: run <code>stemscribe/scripts/freeze_try.py</code>";
  $("play").disabled = true;
  $("empty").textContent = "No song frozen yet.";
}

function buildParts() {
  const box = $("parts");
  box.innerHTML = "";
  const all = document.createElement("button");
  all.type = "button";
  all.textContent = "all";
  all.dataset.part = "";
  box.append(all);
  for (const p of data.parts) {
    modes[p.id] = "audio";
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.name;
    b.dataset.part = p.id;
    box.append(b);
  }
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    setSolo(b.dataset.part || null);
  });
  paintControls();
}

// ---------- audio

function ensureContext() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    for (const p of data.parts) {
      gains[p.id] = ctx.createGain();
      gains[p.id].connect(master);
    }
    synthOut = ctx.createGain();
    synthOut.gain.value = 0.8;
    synthOut.connect(master);
    setGains(true);
    loadSynth();
  }
  if (ctx.state === "suspended") ctx.resume();
}

// the synth and the soundfont (4.6 MB) load in the background after the first Play;
// the MIDI is silent until they are in, the audio stems play at once
function loadSynth() {
  synthLoad ||= (async () => {
    const lib = await import(new URL("design/sound/spessasynth/spessasynth_lib.min.js", VENDOR).href);
    await ctx.audioWorklet.addModule(new URL("design/sound/spessasynth/spessasynth_processor.min.js", VENDOR).href);
    const s = new lib.WorkletSynthesizer(ctx);
    s.connect(synthOut);
    const sf = await (await fetch(SOUNDFONT)).arrayBuffer();
    await s.soundBankManager.addSoundBank(sf, "gm");
    await s.isReady;
    // one channel per part, skipping 10, which is the drum kit's
    let ch = 0;
    for (const p of data.parts) {
      if (p.drums) { channelOf[p.id] = 9; continue; }
      if (ch === 9) ch++;
      channelOf[p.id] = ch;
      s.programChange(ch, p.program ?? PROGRAM[p.id] ?? 0);
      ch++;
    }
    synth = s;
  })();
  synthLoad.catch((e) => { console.warn("the MIDI player did not load", e); synthLoad = null; });
  return synthLoad;
}

function audible(id) {
  if (solo === null) return true;
  return id === solo && modes[id] === "audio";
}

function setGains(now = false) {
  if (!ctx) return;
  for (const p of data.parts) {
    const g = gains[p.id].gain, v = audible(p.id) ? 1 : 0;
    if (now) g.value = v;
    else g.setTargetAtTime(v, ctx.currentTime, 0.015);
  }
}

// silence the MIDI for a switch (stop, solo, audio/MIDI): notes already queued on the
// synth cannot be taken back, so fade it out until they have all passed (the lookahead),
// release everything, and schedule nothing new before then
function newSynthBus() {
  const now = ctx.currentTime, until = now + LOOKAHEAD + 0.05;
  const g = synthOut.gain;
  g.cancelScheduledValues(now);
  g.setTargetAtTime(0, now, 0.01);
  g.setValueAtTime(0.8, until);
  quietUntil = until;
  setTimeout(() => { if (synth) synth.stopAll(true); }, (until - now) * 1000 - 10);
  scheduledTo = songTime() + (until - now);
}

function startPlayback() {
  ensureContext();
  if (pos >= data.duration - 0.05) pos = 0;
  t0 = ctx.currentTime + 0.05;
  sources = data.parts.map((p) => {
    const s = ctx.createBufferSource();
    s.buffer = buffers[p.id];
    s.connect(gains[p.id]);
    s.start(t0, Math.min(pos, s.buffer.duration));
    return s;
  });
  playing = true;
  scheduledTo = Math.max(pos, pos + (quietUntil - t0));
  schedule();
  timer = setInterval(schedule, 50);
  playBtn.setPressed(true);
  requestAnimationFrame(frame);
}

function stopPlayback(to = songTime()) {
  if (!playing) return;
  pos = Math.max(0, Math.min(to, data.duration));
  playing = false;
  clearInterval(timer);
  for (const s of sources) {
    try { s.stop(); } catch {}
  }
  sources = [];
  newSynthBus();
  playBtn.setPressed(false);
  paintTime();
  drawWave();
  drawRoll();
}

// look ahead 200 ms and queue the soloed part's notes on the shared clock
function schedule() {
  if (!playing) return;
  const now = songTime();
  if (now >= data.duration) {
    stopPlayback(data.duration);
    pos = 0;
    return;
  }
  if (!midiOn() || !synth) {
    scheduledTo = Math.max(scheduledTo, now + LOOKAHEAD);
    return;
  }
  const from = Math.max(scheduledTo, now), to = now + LOOKAHEAD;
  const p = part(solo);
  for (const n of p.notes) {
    if (n[0] >= from && n[0] < to) note(p, n, t0 + (n[0] - pos));
  }
  scheduledTo = Math.max(scheduledTo, to);
}

// one note on the soloed part's instrument, at `at` on the AudioContext clock
function note(p, [s, e, pitch, vel], at) {
  const ch = channelOf[p.id];
  const v = Math.max(1, Math.min(127, Math.round(vel)));
  // a drum hit is an onset; the kit's samples ring on by themselves
  const len = p.drums ? 0.1 : Math.min(Math.max(e - s, 0.06), 8);
  synth.noteOn(ch, pitch, v, { time: at });
  synth.noteOff(ch, pitch, { time: at + len });
}

// for the sound check (browser/verify/try_sound.mjs): the synth's state and its output
window.__trySound = () => ({ loaded: !!synth, channels: { ...channelOf }, ctx, out: synthOut,
  programs: data ? Object.fromEntries(data.parts.map((p) => [p.id, p.drums ? "drums" : p.program ?? PROGRAM[p.id] ?? 0])) : {} });

// ---------- controls

function setSolo(id) {
  // "all", or pressing the soloed part again, goes back to the full mix
  solo = id === null || id === solo ? null : id;
  if (solo !== null) did.solo = true;
  if (ctx) {
    setGains();
    newSynthBus();
  }
  paintControls();
  drawRoll();
  progress();
}

function setMode(m) {
  if (solo === null) return;
  modes[solo] = m;
  if (m === "midi") did.midi = true;
  if (ctx) {
    setGains();
    newSynthBus();
  }
  paintControls();
  drawRoll();
  progress();
}
$("mode-audio").addEventListener("click", () => setMode("audio"));
$("mode-midi").addEventListener("click", () => setMode("midi"));

function paintControls() {
  for (const b of $("parts").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String((b.dataset.part || null) === solo));
  }
  const m = solo === null ? "audio" : modes[solo];
  $("mode-audio").disabled = $("mode-midi").disabled = solo === null;
  $("mode-audio").setAttribute("aria-pressed", String(m === "audio"));
  $("mode-midi").setAttribute("aria-pressed", String(m === "midi"));
}

function startOver() {
  stopPlayback();
  pos = 0;
  solo = null;
  for (const id of Object.keys(modes)) modes[id] = "audio";
  did.play = did.solo = did.midi = false;
  if (ctx) setGains();
  paintControls();
  paintTime();
  drawWave();
  drawRoll();
}

// a click, tap or drag on the waveform or the roll moves the playhead there (design
// playhead.js). Paused, the place moves with the pointer and Play starts from it.
// Playing, the head follows the pointer and the sound moves once, on release: a seek
// on every move would restart the stems and the notes over and over. The roll shows
// four bars at a time: a drag on it maps across the page it started on (rollPage),
// and that page holds still until the pointer is let go.
let rollPage = null;
function scrub(t) {
  if (playing) scrubAt = t;
  else pos = t;
  paintTime();
  drawWave();
  drawRoll();
}
function seekTo(t) {
  scrubAt = null;
  if (playing) {
    stopPlayback(t);
    startPlayback();
  } else {
    scrub(t);
  }
}
function endScrub() {
  scrubAt = null;
  rollPage = null;
  paintTime();
  drawWave();
  drawRoll();
}
seekable($("wave"), {
  duration: () => data.duration,
  enabled: () => !!data,
  onScrub: scrub,
  onSeek: seekTo,
  onCancel: endScrub,
});
seekable($("roll"), {
  toTime: (x, r) => {
    const [a, b] = (rollPage ??= view(headTime()));
    const t = a + (Math.min(Math.max(x - r.left, 0), r.width) / r.width) * (b - a);
    return Math.min(Math.max(t, 0, a), b - 1e-3, data.duration);
  },
  enabled: () => !!data && solo !== null && !$("roll").classList.contains("off"),
  onScrub: scrub,
  onSeek: (t) => { rollPage = null; seekTo(t); },
  onCancel: endScrub,
});

// ---------- drawing (tokens are light-dark() pairs a canvas can't read: resolve them on an element)

function resolved(token) {
  const el = document.createElement("span");
  el.style.color = `var(${token})`;
  document.body.appendChild(el);
  const c = getComputedStyle(el).color;
  el.remove();
  return c;
}
const toRgb = (token) => resolved(token).match(/[\d.]+/g).slice(0, 3).map(Number);
const rgbStr = (c) => `rgb(${c.map(Math.round).join(",")})`;
const mixRgb = (a, b, p) => rgbStr(a.map((x, i) => x * p + b[i] * (1 - p)));

function computePeaks(buf, n) {
  const chans = [...Array(buf.numberOfChannels).keys()].map((c) => buf.getChannelData(c));
  const step = Math.max(1, Math.floor(buf.length / n)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const d of chans) for (let j = i * step, e = Math.min(d.length, j + step); j < e; j += 16) m = Math.max(m, Math.abs(d[j]));
    out[i] = m;
  }
  return out;
}

function sizeCanvas(cv) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return null;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);
  return { g, w, h };
}

// the mix: thin vertical strokes in the accent; what has played full strength, the rest faint
function drawWave() {
  const c = sizeCanvas($("wave"));
  if (!c) return;
  const { g, w, h } = c;
  g.clearRect(0, 0, w, h);
  g.fillStyle = resolved("--line");
  g.fillRect(0, h / 2, w, 1);
  if (!peaks || !data) return;
  const acc = resolved("--acc"), now = headTime(), cols = Math.floor(w / 3);
  let top = 0;
  for (const p of peaks) top = Math.max(top, p);
  const scale = top > 0 ? 1 / top : 1;
  g.fillStyle = acc;
  for (let x = 0; x < cols; x++) {
    const p = peaks[Math.floor((x / cols) * peaks.length)] * scale, t = (x / cols) * data.duration;
    g.globalAlpha = t <= now && now > 0 ? 1 : 0.28;
    const a = Math.max(1, p * (h / 2 - 4));
    g.fillRect(x * 3, h / 2 - a, 2, a * 2);
  }
  g.globalAlpha = 1;
}

// the soloed part's MIDI (design/roll.md): key bands, bar lines from the grid, softer
// notes paler, sounding notes full strength. Four bars at a time; the view turns a
// page when the playhead reaches its edge, so nothing scrolls under the eye.
function barLen() {
  const b = data.bars;
  return b.length > 1 ? b[1] - b[0] : 2;
}
function view(now) {
  const len = 4 * barLen(), b = data.bars;
  const first = b.length ? b[0] - Math.ceil(b[0] / barLen()) * barLen() : 0;
  const k = Math.max(0, Math.floor((now - first) / len));
  return [first + k * len, first + (k + 1) * len];
}

// the soloed part's audio stem, in the same four-bar view as its notes: bar lines, the
// stem's waveform in the accent (what has played full strength), the playhead in ink
function drawStem(cv) {
  const c = sizeCanvas(cv);
  if (!c) return;
  const { g, w, h } = c;
  const pk = stemPeaks[solo], now = headTime();
  g.fillStyle = resolved("--ground-2");
  g.fillRect(0, 0, w, h);
  const [a, b] = view(now), xs = w / (b - a), x = (t) => (t - a) * xs;
  g.fillStyle = resolved("--line");
  for (const t of data.bars) if (t >= a && t <= b) g.fillRect(Math.round(x(t)), 0, 1, h);
  g.fillRect(0, h / 2, w, 1);
  if (pk) {
    let top = 0;
    for (const v of pk) top = Math.max(top, v);
    const scale = top > 0 ? 1 / top : 1;
    g.fillStyle = resolved("--acc");
    for (let px = 0; px < w; px += 3) {
      const t = a + px / xs;
      if (t < 0 || t >= data.duration) continue;
      const v = pk[Math.floor((t / data.duration) * pk.length)] * scale;
      g.globalAlpha = playing && t <= now ? 1 : 0.4;
      const amp = Math.max(1, v * (h / 2 - 6));
      g.fillRect(px, h / 2 - amp, 2, amp * 2);
    }
    g.globalAlpha = 1;
  }
  if (now > 0 && !reduced.matches) {
    g.fillStyle = resolved("--ink");
    g.fillRect(Math.round(x(now)), 0, 1, h);
  }
}

function drawRoll() {
  const cv = $("roll");
  // a soloed part shows what you hear: its audio stem as a waveform, or its notes once
  // you flip it to the MIDI
  const show = !!data && solo !== null;
  cv.classList.toggle("off", !show);
  $("empty").hidden = show || !data;
  if (!data) return;
  if (!show) {
    $("empty").textContent = "Pick a part to see it on its own.";
  } else if (!midiOn()) {
    drawStem(cv);
    return;
  } else if (!part(solo).notes.length) {
    // a stem can come out with no notes (nothing above the floor); say so plainly
    cv.classList.add("off");
    $("empty").hidden = false;
    $("empty").textContent = `No notes for ${part(solo).name} in this section.`;
    return;
  }
  const c = sizeCanvas(cv);
  if (!c || !show) return;
  const { g, w, h } = c;
  const p = part(solo), now = headTime();
  const ground = toRgb("--ground-2"), band = toRgb("--band"), ink = toRgb("--ink"), acc = toRgb("--acc");
  g.fillStyle = rgbStr(ground);
  g.fillRect(0, 0, w, h);
  // the pitch range in view: notes within an octave and a half of the part's median, at
  // least an octave, so a few stray notes (bleed from another instrument) don't squash the
  // part's own line; the strays fall outside the view
  const ps = p.notes.map((n) => n[2]).sort((m, n) => m - n);
  const mid = ps.length ? ps[Math.floor(ps.length / 2)] : 60;
  const near = ps.filter((q) => Math.abs(q - mid) <= 18);
  let nlo = near.length ? near[0] : 48, nhi = near.length ? near[near.length - 1] : 72;
  if (nhi - nlo < 12) { const pad = Math.ceil((12 - (nhi - nlo)) / 2); nlo -= pad; nhi += pad; }
  const lo = nlo - 1, hi = nhi + 1;
  const rh = h / (hi - lo + 1), y = (q) => h - (q - lo + 1) * rh;
  if (!p.drums) {
    g.fillStyle = rgbStr(band);
    for (let q = lo; q <= hi; q++) if ([1, 3, 6, 8, 10].includes(((q % 12) + 12) % 12)) g.fillRect(0, y(q), w, rh);
  }
  const [a, b] = view(now), xs = w / (b - a), x = (t) => (t - a) * xs;
  g.fillStyle = resolved("--line");
  for (const t of data.bars) if (t >= a && t <= b) g.fillRect(Math.round(x(t)), 0, 1, h);
  for (const [s, e, q, v] of p.notes) {
    if (e < a || s > b) continue;
    const on = playing && now >= s && now < e + (p.drums ? 0.08 : 0);
    // roll.md: pitched notes shaded by pitch (40 to 100 percent accent, low to high), drums by velocity
    g.fillStyle = on ? rgbStr(acc) : p.drums ? mixRgb(acc, ground, 0.35 + 0.65 * (v / 127))
      : noteColor(rgbStr(acc), rgbStr(ground), q, nlo, nhi);
    const nx = x(s), nw = Math.max(p.drums ? 3 : 1, (e - s) * xs - 1), ny = y(q), nh = Math.max(1, rh - 1);
    g.fillRect(nx, ny, nw, nh);
    if (on && nh > 2) {
      g.strokeStyle = rgbStr(ink);
      g.strokeRect(nx + 0.5, ny + 0.5, nw - 1, nh - 1);
    }
  }
  g.globalAlpha = 1;
  if (now > 0 && !reduced.matches) {
    g.fillStyle = rgbStr(ink);
    g.fillRect(Math.round(x(now)), 0, 1, h);
  }
}

function paintTime() {
  if (data) $("time").textContent = `${fmtT(headTime())} / ${fmtT(data.duration)}`;
}

let lastWave = 0;
function frame(ts) {
  if (!playing) return;
  paintTime();
  drawRoll();
  if (ts - lastWave > 250) {
    drawWave();
    lastWave = ts;
  }
  requestAnimationFrame(frame);
}

addEventListener("resize", () => {
  drawWave();
  drawRoll();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  drawWave();
  drawRoll();
});

load();
