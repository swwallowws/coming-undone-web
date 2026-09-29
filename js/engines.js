// Engines: where a run happens. Each takes the same input and options and hands back
// one Run, the shape the page renders:
//
//   { res,            the result: tempo, grid, tracks, warnings, prepared, file names
//     roll,           { end, tracks: [{ name, notes }] }, pitched parts only
//     parts,          { end, parts: [{ name, file, drum, notes }] }
//     fileUrl(p),     a URL for a file the result names (stems, instrumental, MIDI)
//     partUrl(name),  a URL for one part's .mid
//     restamp(bpm),   re-stamp the tempo, or null when the engine cannot
//     shiftBar(n) }   move bar "one" by n beats, or null
//
// Options are one object for both engines (see the page's collectOptions); each engine
// sends the ones its backend takes.

export class EngineError extends Error {
  // kind: "quota" (the visitor's daily GPU time is used up), "unreachable", "input", "failed"
  constructor(kind, message, detail = "") {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

const base = p => String(p || "").split(/[\\/]/).pop();

// ---- This computer: the local server's jobs API --------------------------------------

// The first of `bases` whose server answers /api/config within `ms`, or null.
export async function findLocal(bases, ms = 1500, fetchFn = fetch) {
  for (const b of bases) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetchFn(`${b}/api/config`, { signal: ctl.signal });
      const c = r.ok ? await r.json() : null;
      if (c && Array.isArray(c.backends)) return { base: b, config: c };
    } catch (_) { /* not there */ } finally { clearTimeout(timer); }
  }
  return null;
}

export function localFormData(input, opts) {
  const fd = new FormData();
  if (input.file) fd.append("file", input.file);
  else fd.append("url", input.url);
  for (const [k, v] of Object.entries(opts)) {
    if (v === null || v === undefined || v === "") continue;
    fd.append(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return fd;
}

export function localEngine(b, fetchFn = (...a) => fetch(...a)) {
  const api = p => `${b}${p}`;
  const json = async (r) => {
    let body = null;
    try { body = await r.json(); } catch (_) { /* not json */ }
    if (!r.ok) throw new EngineError("failed", (body && body.detail) || `HTTP ${r.status}`);
    return body;
  };
  return {
    id: "local",
    base: b,
    async run(input, opts, on = () => {}) {
      let r;
      try {
        r = await fetchFn(api("/api/jobs"), { method: "POST", body: localFormData(input, opts) });
      } catch (e) {
        throw new EngineError("unreachable", "Could not reach Coming Undone on this computer.", String(e));
      }
      const { id } = await json(r);
      await new Promise((resolve, reject) => {
        const es = new EventSource(api(`/api/jobs/${id}/events`));
        es.onmessage = e => {
          const d = JSON.parse(e.data);
          if (d.stage === "done") { es.close(); resolve(); return; }
          if (d.stage === "error") { es.close(); reject(new EngineError("failed", d.message)); return; }
          on(d);
        };
        es.onerror = () => { es.close(); resolve(); };   // the job's status says how it ended
      });
      const j = await json(await fetchFn(api(`/api/jobs/${id}`)));
      if (j.status !== "done") throw new EngineError("failed", j.error || "the run did not finish");
      const [roll, parts] = await Promise.all([
        fetchFn(api(`/api/jobs/${id}/roll`)).then(json),
        fetchFn(api(`/api/jobs/${id}/parts`)).then(json),
      ]);
      const post = async (path, field, value) => {
        const fd = new FormData(); fd.append(field, value);
        return json(await fetchFn(api(`/api/jobs/${id}/${path}`), { method: "POST", body: fd }));
      };
      return {
        res: j.result, roll, parts,
        fileUrl: p => p ? api(`/api/jobs/${id}/files/${p}`) : null,
        partUrl: name => api(`/api/jobs/${id}/parts/${encodeURIComponent(name)}.mid`),
        restamp: bpm => post("tempo", "bpm", bpm),
        shiftBar: beats => post("bar", "beats", beats),
      };
    },
  };
}

// ---- Online: the Hugging Face Space, through Gradio's JavaScript client ---------------

// ZeroGPU's quota messages ("You have exceeded your GPU quota ... Try again in 3:12:05",
// or the signed-out variant) and anything else that says the visitor is out of GPU time.
const QUOTA = /quota|exceeded your|gpu (?:task|duration).*(?:abort|limit)|no gpu (?:was )?available/i;

export function classifyOnlineError(message) {
  const m = String(message || "");
  if (QUOTA.test(m)) {
    const wait = m.match(/try again in\s+([0-9:]+)/i);
    return new EngineError("quota", "Today's free online time is used up for you.", wait ? wait[1] : "");
  }
  return new EngineError("failed", m || "The online run failed.");
}

// What the Space's `split` endpoint sends back, as a Run. Pure: no network.
// data = [result JSON text, MIDI file, part files[], other files[]]; files are Gradio
// FileData ({ url, orig_name, path }), matched to the result's file names by base name.
export function mapOnline(data) {
  const [text, midi, partFiles, files] = data;
  const res = typeof text === "string" ? JSON.parse(text) : text;
  const urls = {}, partUrls = {};
  for (const f of [midi, ...(files || [])].filter(Boolean)) urls[base(f.orig_name || f.path)] = f.url;
  for (const f of (partFiles || []).filter(Boolean)) partUrls[base(f.orig_name || f.path)] = f.url;
  const parts = res.parts || { end: 0, parts: [] };
  const roll = {
    end: parts.end,
    tracks: parts.parts.filter(p => !p.drum && p.notes.length).map(p => ({ name: p.name, notes: p.notes })),
  };
  return {
    res, roll, parts,
    fileUrl: p => (p ? urls[base(p)] || null : null),
    partUrl: name => partUrls[`${base(name)}.mid`] || null,
    restamp: null,
    shiftBar: null,
  };
}

// ---- Online: what a run asks of the visitor's daily ZeroGPU time --------------------
// A mirror of space/split.py's GPU budget (gpu_seconds, runs_per_day); the numbers and
// where they come from are documented there, and tests/test_space.py checks both agree.
export const ONLINE_BUDGET = {
  maxSeconds: 30,
  base: 8,
  separatePerS: { htdemucs: 0.2, htdemucs_6s: 0.35 },
  gpuBackends: ["muscriptor"],
  pitched: { htdemucs: ["vocals", "bass", "other"], htdemucs_6s: ["vocals", "bass", "guitar", "piano", "other"] },
  stem: [6, 0.3],
  drums: [4, 0.15],
  max: 120,
  quotaCost: 1.5,
  quota: { signedOut: 120, freeAccount: 300 },
};

// seconds of GPU one run asks for: seconds of audio, the page's options
export function onlineGpuSeconds(seconds, opts = {}, B = ONLINE_BUDGET) {
  const s = Math.max(0, Math.min(Number(seconds) || 0, B.maxSeconds));
  const model = B.separatePerS[opts.demucs_model] !== undefined ? opts.demucs_model : "htdemucs";
  let work = B.base + B.separatePerS[model] * s;
  if (B.gpuBackends.includes(opts.backend || "muscriptor")) {
    const n = B.pitched[model].filter(x => opts.include_vocals_melody !== false || x !== "vocals").length;
    work += n * (B.stem[0] + B.stem[1] * s);
  }
  work += B.drums[0] + B.drums[1] * s;
  return Math.min(B.max, Math.ceil(work));     // the same sum, in the same order, as Python
}

// how many runs of `request` seconds a day's quota holds
export function onlineRunsPerDay(request, quota, B = ONLINE_BUDGET) {
  if (request > quota) return 0;
  return Math.floor((quota - request) / (request * B.quotaCost)) + 1;
}

export function onlineOptions(opts) {
  const out = { ...opts, stems_audio: true };
  delete out.audio_format;               // links are a local-only feature
  for (const k of Object.keys(out)) if (out[k] === "" || out[k] === undefined) out[k] = null;
  return out;
}

export function onlineEngine(space, loadClient) {
  return {
    id: "online",
    space,
    async run(input, opts, on = () => {}) {
      if (!input.file) throw new EngineError("input", "Online runs take a file. Links work on This computer.");
      let Client, handle_file;
      try {
        ({ Client, handle_file } = await loadClient());
      } catch (e) {
        throw new EngineError("unreachable", "Could not load the online engine.", String(e));
      }
      on({ stage: "online", message: "connecting to the free GPU at Hugging Face" });
      let app;
      try {
        app = await Client.connect(space, { events: ["data", "status"] });
      } catch (e) {
        throw new EngineError("unreachable", "The online engine is not answering right now.", String(e));
      }
      on({ stage: "upload", message: `sending ${input.file.name}` });
      const job = app.submit("/split", [handle_file(input.file), JSON.stringify(onlineOptions(opts))]);
      let data = null, said = "";
      const say = (stage, message) => {
        if (message === said) return;
        said = message; on({ stage, message });
      };
      for await (const msg of job) {
        if (msg.type === "data") { data = msg.data; continue; }
        if (msg.type !== "status") continue;
        if (msg.stage === "error") throw classifyOnlineError(msg.message);
        if (msg.stage === "pending" && msg.position > 0) say("queue", `waiting in line: ${msg.position} ahead`);
        const p = (msg.progress_data || []).find(x => x && x.desc);
        if (p) {
        const gpu = p.desc === "waiting for a GPU";
        say(gpu ? "gpu" : "online", gpu ? "separating and transcribing on a GPU" : p.desc);
      }
        if (msg.stage === "complete") break;
      }
      if (!data) throw new EngineError("failed", "The online run returned nothing.");
      return mapOnline(data);
    },
  };
}
