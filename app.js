/* ============================================================
   TAKRAAR
   Two people, two languages, one argument.

   The whole design problem is that a translator serialises a
   conversation and an argument is parallel. Everything below
   exists to remove the turn:

   1. We never wait for a sentence to end. Interim speech results
      are committed in chunks, so the other side hears you while
      you are still talking.
   2. We send text, not audio. STT runs on the speaker's device,
      TTS on the listener's. The wire carries ~60 bytes, so the
      network stops being the bottleneck.
   3. The listener translates, not the speaker. The speaker's words
      leave instantly and translation overlaps with more speech.
   4. Interruption is a real event. Starting to talk cancels the
      voice in your ear and tells the other side they were cut off.
   5. Volume and pace survive the trip. A shout arrives as a shout.
   6. A position can be withdrawn. Every finished utterance becomes a
      claim in the rail, and you can take your own back. It strikes
      through on both screens at once, so changing your mind is an act
      the other person watches happen instead of a sentence they have
      to catch and believe.
   ============================================================ */

/* ---------- languages ---------- */
// code: what the translation API wants. stt: BCP-47 for SpeechRecognition.
// tts: locale hint for voice selection.
// Restricted to languages Chrome actually ships a voice for. Tamil,
// Bengali, Marathi and Arabic are deliberately absent: speech
// recognition handles them, but with no voice on the listening end the
// argument arrives as silent subtitles, which is not the product.
const LANGS = [
  { code:'en', stt:'en-IN',  tts:'en-IN', label:'English' },
  { code:'hi', stt:'hi-IN',  tts:'hi-IN', label:'हिन्दी Hindi' },
  { code:'es', stt:'es-ES',  tts:'es-ES', label:'Español' },
  { code:'fr', stt:'fr-FR',  tts:'fr-FR', label:'Français' },
  { code:'de', stt:'de-DE',  tts:'de-DE', label:'Deutsch' },
  { code:'pt', stt:'pt-BR',  tts:'pt-BR', label:'Português' },
  { code:'it', stt:'it-IT',  tts:'it-IT', label:'Italiano' },
  { code:'nl', stt:'nl-NL',  tts:'nl-NL', label:'Nederlands' },
  { code:'pl', stt:'pl-PL',  tts:'pl-PL', label:'Polski' },
  { code:'ru', stt:'ru-RU',  tts:'ru-RU', label:'Русский' },
  { code:'id', stt:'id-ID',  tts:'id-ID', label:'Bahasa Indonesia' },
  { code:'ja', stt:'ja-JP',  tts:'ja-JP', label:'日本語' },
  { code:'ko', stt:'ko-KR',  tts:'ko-KR', label:'한국어' },
  { code:'zh', stt:'zh-CN',  tts:'zh-CN', label:'中文' },
];
const byCode = (c) => LANGS.find((l) => l.code === c) || LANGS[0];

/* ---------- tuning ---------- */
// Chunk size is the central tradeoff. Measured on en→hi: the clause
// "You are not listening to me at all" translates correctly, but the
// 3-word slice "You are not" comes back as "आप नहीं हो", which is noise.
// So we cut on pauses (a settled tail is a clause boundary) and only
// force a cut when someone talks continuously past MAX_WORDS.
const STABLE_MS   = 320;   // how long a tail must stop changing before we ship it
const MIN_WORDS   = 4;     // smallest chunk that still survives translation
const MAX_WORDS   = 10;    // ship regardless, so a non-stop talker still streams
const VAD_ON      = 0.055; // RMS that counts as "started talking"
const VAD_OFF     = 0.030; // RMS that counts as "stopped"
const VAD_OFF_MS  = 700;   // silence before we call the utterance over
const PEER_PREFIX = 'takraar-v1-';

/* ---------- state ---------- */
const S = {
  mine: 'en',
  theirs: null,
  solo: false,
  muted: false,
  peer: null,
  conn: null,
  recog: null,
  recogOn: false,
  emitted: 0,          // words already shipped in the current recognition session
  lastTail: '',
  lastChange: 0,
  heat: 0,
  rms: 0,
  iSpeak: false,
  theySpeak: false,
  quietSince: 0,
  ttsActive: false,
  ttsText: '',
  theirLive: '',       // translated, what we are showing them saying
  myLive: '',
  seq: 0,
  uttSeq: 0,           // utterance counter; a claim is keyed on this
  uttId: 0,
  uttText: '',         // everything said in the utterance now in progress
};

// key ("mine:3" / "theirs:3") -> the <li> holding that claim
const logMap = new Map();

/* ---------- dom ---------- */
const $ = (id) => document.getElementById(id);
const el = {};
['setup','stage','myLang','btnCreate','joinForm','joinCode','btnSolo','waiting','roomCode',
 'waitMsg','btnCancel','netDot','netText','barMine','barTheirs','btnLeave','railThem','railYou',
 'themLabel','youLabel','heatThem','heatYou','liveThem','liveYou','origThem','origYou',
 'cutinThem','cutinYou','log','btnMute','micLamp','latency','toast']
  .forEach((k) => (el[k] = $(k)));

/* ---------- small helpers ---------- */
let toastTimer;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
}
const now = () => performance.now();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function makeCode() {
  // No O/0/I/1 — people read these out loud over a call.
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => A[(Math.random() * A.length) | 0]).join('');
}

/* ============================================================
   TRANSLATION
   Cascade with a cache. The serverless proxy is fastest; the two
   direct endpoints keep the app alive on pure static hosting.
   ============================================================ */
const tcache = new Map();

async function translate(text, from, to) {
  if (!text.trim() || from === to) return text;
  const key = `${from}|${to}|${text}`;
  if (tcache.has(key)) return tcache.get(key);

  // Order is measured, not guessed. Direct Google sends permissive CORS
  // headers and answers in 70-680ms. The proxy is the backup for when
  // that endpoint rate-limits an IP. MyMemory is last because it took
  // 2.7s in testing, which is slower than the argument can tolerate.
  const attempts = [
    async () => {
      const r = await fetch(
        'https://translate.googleapis.com/translate_a/single?client=gtx' +
        `&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`
      );
      if (!r.ok) throw 0;
      const j = await r.json();
      return (j[0] || []).map((s) => s[0] || '').join('');
    },
    async () => {
      const r = await fetch(`/api/translate?text=${encodeURIComponent(text)}&from=${from}&to=${to}`);
      if (!r.ok) throw 0;
      return (await r.json()).text;
    },
    async () => {
      const r = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`
      );
      if (!r.ok) throw 0;
      return (await r.json()).responseData.translatedText;
    },
  ];

  for (const go of attempts) {
    try {
      const out = await go();
      if (out && out.trim()) {
        tcache.set(key, out);
        return out;
      }
    } catch { /* next */ }
  }
  return text; // better to show the original than to show nothing
}

/* ============================================================
   VOICE OUT
   speechSynthesis is the right primitive here for one reason:
   cancel() is instant. That is what makes an interruption land.
   ============================================================ */
let voices = [];
function loadVoices() { voices = speechSynthesis.getVoices() || []; }
loadVoices();
speechSynthesis.onvoiceschanged = loadVoices;

function pickVoice(locale) {
  if (!voices.length) loadVoices();
  const base = locale.split('-')[0];
  return (
    voices.find((v) => v.lang === locale) ||
    voices.find((v) => v.lang.replace('_', '-') === locale) ||
    voices.find((v) => v.lang.toLowerCase().startsWith(base)) ||
    null
  );
}

function say(text, langCode, heat) {
  if (S.muted || !text.trim()) return;
  const L = byCode(langCode);
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(L.tts);
  if (v) u.voice = v;
  u.lang = L.tts;
  // Prosody transfer. Without this a shouted line arrives as a polite
  // murmur and the argument dies on the way across.
  u.rate   = clamp(0.95 + heat * 0.55, 0.6, 2);
  u.pitch  = clamp(0.95 + heat * 0.35, 0.5, 2);
  u.volume = clamp(0.75 + heat * 0.25, 0, 1);

  u.onstart = () => { S.ttsActive = true; S.ttsText = text; };
  u.onend   = () => { S.ttsActive = false; S.ttsText = ''; };
  u.onerror = () => { S.ttsActive = false; S.ttsText = ''; };
  speechSynthesis.speak(u);
}

function cutVoice() {
  speechSynthesis.cancel();
  S.ttsActive = false;
  S.ttsText = '';
}

/* ---------- ordered playback ----------
   Chunks are translated in parallel, so a short one can resolve before
   a long one that was said first. Queue by arrival order and only ever
   release the front, otherwise the argument comes out shuffled.
   A stuck head is released with its original text after HEAD_WAIT_MS
   rather than blocking everything behind it. */
const HEAD_WAIT_MS = 1800;
const outQ = [];

function enqueue(job) {
  outQ.push(job);
  setTimeout(() => {
    if (!job.done) { job.done = true; job.out = job.out || job.src; drain(); }
  }, HEAD_WAIT_MS);
}

function resolve(job, out) {
  job.out = out;
  job.done = true;
  drain();
}

function drain() {
  while (outQ.length && outQ[0].done) {
    const j = outQ.shift();
    if (j.dropped) continue;
    el.origThem.textContent = j.src;
    S.theirLive = `${S.theirLive} ${j.out}`.trim().split(/\s+/).slice(-40).join(' ');
    el.liveThem.textContent = S.theirLive;
    el.latency.textContent = `chunk ${j.ms}ms`;
    say(j.out, j.to, j.heat);
  }
}

function clearQueue() {
  outQ.forEach((j) => (j.dropped = true));
  outQ.length = 0;
}

/* ============================================================
   MIC: loudness and voice activity
   Drives two things — how hot the other side sounds, and the
   moment an interruption begins.
   ============================================================ */
async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
  });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Uint8Array(an.fftSize);

  el.micLamp.classList.add('on');

  (function loop() {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const d = (buf[i] - 128) / 128;
      sum += d * d;
    }
    const rms = Math.sqrt(sum / buf.length);
    S.rms = S.rms * 0.75 + rms * 0.25;

    // Heat is loudness mapped to a usable 0..1, smoothed so it does
    // not flicker on every syllable.
    const raw = clamp((S.rms - 0.02) / 0.16, 0, 1);
    S.heat = S.heat * 0.82 + raw * 0.18;
    el.heatYou.style.width = `${(S.heat * 100).toFixed(0)}%`;

    // While our own TTS is audible the mic hears it too. Headphones
    // solve this properly; this just stops a speaker-user from
    // interrupting themselves.
    const gate = S.ttsActive ? VAD_ON * 2.2 : VAD_ON;

    if (!S.iSpeak && S.rms > gate) onSpeechStart();
    else if (S.iSpeak) {
      if (S.rms < VAD_OFF) {
        if (!S.quietSince) S.quietSince = now();
        else if (now() - S.quietSince > VAD_OFF_MS) onSpeechEnd();
      } else S.quietSince = 0;
    }
    requestAnimationFrame(loop);
  })();
}

function ensureUtterance() {
  if (!S.uttId) { S.uttId = ++S.uttSeq; S.uttText = ''; }
}

function onSpeechStart() {
  S.iSpeak = true;
  S.quietSince = 0;
  S.uttId = ++S.uttSeq;
  S.uttText = '';
  el.railYou.classList.add('active');

  // The interruption. Kill their voice in my ear immediately, drop
  // whatever of theirs was still queued, and tell them they were cut off.
  if (S.theySpeak || S.ttsActive || outQ.length) {
    cutVoice();
    clearQueue();
    flash(el.cutinYou);
    send({ t: 'barge' });
  }
  send({ t: 'start' });
}

function onSpeechEnd() {
  S.iSpeak = false;
  S.quietSince = 0;
  el.railYou.classList.remove('active');

  // The finished utterance is the claim. Chunks were for speed; this is
  // for the record, and it is the thing that can be withdrawn later.
  const utt = S.uttId;
  const text = S.uttText.trim();
  const msg = { t: 'stop', utt, text, lang: S.mine };
  send(msg);
  if (text) claim('you', text, '', `mine:${utt}`, utt);
  if (S.solo) receive(msg);
  S.uttId = 0;
  S.uttText = '';
}

function flash(node) {
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 1400);
}

/* ============================================================
   SPEECH IN
   Chrome gives interim results. We ship stable prefixes of them
   rather than waiting for isFinal, because isFinal is roughly a
   second behind the mouth and a second is an eternity in a row.
   ============================================================ */
function startSTT() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast('This browser has no speech recognition. Use Chrome or Edge.', 6000);
    return;
  }
  const r = new SR();
  r.lang = byCode(S.mine).stt;
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  r.onresult = (ev) => {
    let finalT = '', interimT = '';
    for (let i = 0; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res.isFinal) finalT += res[0].transcript + ' ';
      else interimT += res[0].transcript;
    }
    handleTranscript(finalT, interimT);
  };

  r.onend = () => {
    // Chrome stops recognition on its own every so often. Restart and
    // reset the word pointer, because ev.results starts empty again.
    S.emitted = 0;
    S.lastTail = '';
    if (S.recogOn) { try { r.start(); } catch {} }
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed') toast('Microphone blocked. Allow it and reload.', 6000);
  };

  S.recog = r;
  S.recogOn = true;
  try { r.start(); } catch {}
}

function words(s) { return s.trim().split(/\s+/).filter(Boolean); }

function handleTranscript(finalT, interimT) {
  const all = words(`${finalT} ${interimT}`);
  const tail = all.slice(S.emitted);
  const tailStr = tail.join(' ');

  // show what I am saying, with the not-yet-shipped part dimmed
  el.liveYou.innerHTML = all.length
    ? `${all.slice(0, S.emitted).join(' ')} <span class="pend">${tailStr}</span>`
    : '<span class="idle">silent</span>';

  if (tailStr !== S.lastTail) {
    S.lastTail = tailStr;
    S.lastChange = now();
  }
  if (!tail.length) return;

  const settled = now() - S.lastChange > STABLE_MS;
  const finalDone = words(finalT).length >= all.length; // nothing interim left

  if (finalDone) {
    emit(tail.join(' '), all.length);
  } else if (settled && tail.length >= MIN_WORDS) {
    // A settled tail means the speaker paused, so the last word is no
    // longer in flight. Shipping all of it avoids stranding a word like
    // "all", which on its own translates to nonsense.
    emit(tail.join(' '), all.length);
  } else if (tail.length >= MAX_WORDS) {
    // Still mid-flow. Hold the last word back, it may yet be revised.
    const safe = tail.slice(0, -1);
    if (safe.length) emit(safe.join(' '), S.emitted + safe.length);
  }
}

function emit(text, newPointer) {
  if (!text.trim()) return;
  ensureUtterance();
  S.emitted = newPointer;
  S.uttText = `${S.uttText} ${text}`.trim();
  const msg = { t: 'chunk', id: ++S.seq, utt: S.uttId, text, lang: S.mine, heat: +S.heat.toFixed(3) };
  send(msg);

  // Loop back through the same path so solo mode exercises the real
  // pipeline rather than a shortcut.
  if (S.solo) receive(msg);
}

/* ============================================================
   WIRE
   ============================================================ */
function send(msg) {
  if (S.solo) {
    if (msg.t === 'chunk') return; // handled inline in emit()
    return;
  }
  if (S.conn && S.conn.open) {
    try { S.conn.send(msg); } catch {}
  }
}

async function receive(msg) {
  if (!msg || !msg.t) return;

  if (msg.t === 'hello') {
    S.theirs = msg.lang;
    paintLangs();
    // We synthesise their speech on this device, so a missing voice here
    // is our problem, not theirs. Say so rather than failing silently.
    if (!pickVoice(byCode(msg.lang).tts)) {
      toast(`No ${byCode(msg.lang).label} voice installed. You will see them, not hear them.`, 7000);
    }
    return;
  }

  if (msg.t === 'start') {
    S.theySpeak = true;
    el.railThem.classList.add('active');
    return;
  }

  if (msg.t === 'stop') {
    S.theySpeak = false;
    el.railThem.classList.remove('active');
    el.heatThem.style.width = '0%';

    const full = (msg.text || '').trim();
    if (!full) { S.theirLive = ''; return; }

    // Second pass. The chunks were translated cold, one clause at a
    // time, because that is the only way to be fast. Now that the
    // utterance is complete we translate the whole thing at once, where
    // the engine can see the sentence it is actually translating, and
    // replace the stitched-together version. The audio was already
    // right enough to argue with; this is what gets remembered.
    const to = S.solo ? soloTarget() : S.mine;
    const from = msg.lang || (S.solo ? S.mine : S.theirs) || 'en';
    const t0 = now();
    const fixed = await translate(full, from, to);
    el.latency.textContent = `full pass ${Math.round(now() - t0)}ms`;

    S.theirLive = fixed;
    el.liveThem.textContent = fixed;
    el.origThem.textContent = full;
    claim('them', fixed, full, `theirs:${msg.utt}`, msg.utt);
    return;
  }

  if (msg.t === 'retract') {
    markRetracted(`theirs:${msg.utt}`, msg.on !== false);
    return;
  }

  if (msg.t === 'barge') {
    // They cut in. Stop pushing our words at them and show it.
    flash(el.cutinThem);
    return;
  }

  if (msg.t === 'chunk') {
    const from = msg.lang;
    const to = S.solo ? soloTarget() : S.mine;
    el.heatThem.style.width = `${((msg.heat || 0) * 100).toFixed(0)}%`;

    // Claim a slot in the output order now, fill it when the
    // translation lands. Order is arrival order, never finish order.
    const job = { src: msg.text, to, heat: msg.heat || 0.3, out: null, done: false, ms: 0 };
    enqueue(job);

    const t0 = now();
    const out = await translate(msg.text, from, to);
    job.ms = Math.round(now() - t0);
    if (!job.done) resolve(job, out);
  }
}

function soloTarget() { return S.mine === 'en' ? 'hi' : 'en'; }

/* ---------- claims ----------
   A finished utterance is a claim. Your own are clickable: taking one
   back strikes it through here and on their screen at the same moment.
   That is the mechanism for changing your mind. Saying "I take that
   back" out loud only works if the other person catches it, believes
   it, and knows which part you meant. */
function claim(side, said, src, key, utt) {
  const li = document.createElement('li');
  li.className = side === 'you' ? 'you mine' : 'them';
  li.dataset.key = key;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  li.innerHTML =
    '<div class="meta"></div><div class="said"></div>' + (src ? '<div class="src"></div>' : '');
  li.querySelector('.meta').textContent = `${side === 'you' ? 'YOU' : 'THEM'} · ${time}`;
  li.querySelector('.said').textContent = said;
  if (src) li.querySelector('.src').textContent = src;

  if (side === 'you') {
    li.title = 'Click to take this back';
    li.onclick = () => toggleRetract(key, utt);
  }

  el.log.appendChild(li);
  logMap.set(key, li);
  el.log.scrollTop = 1e9;
  while (el.log.children.length > 200) {
    const first = el.log.firstChild;
    logMap.delete(first.dataset.key);
    el.log.removeChild(first);
  }
}

function toggleRetract(key, utt) {
  const li = logMap.get(key);
  if (!li) return;
  const on = !li.classList.contains('retracted');
  li.classList.toggle('retracted', on);
  send({ t: 'retract', utt, on });
  if (S.solo) markRetracted(`theirs:${utt}`, on);
}

function markRetracted(key, on) {
  const li = logMap.get(key);
  if (!li) return;
  li.classList.toggle('retracted', on);
  li.classList.add('flash');
  setTimeout(() => li.classList.remove('flash'), 900);
}

/* ============================================================
   CONNECTION
   PeerJS over its public signalling server. We only ever send
   text, so a data channel is the whole transport.
   ============================================================ */
function netState(state, text) {
  el.netDot.className = `dot ${state}`;
  el.netText.textContent = text;
}

function wireConn(conn) {
  S.conn = conn;
  conn.on('open', () => {
    netState('live', 'connected');
    conn.send({ t: 'hello', lang: S.mine });
    toast('Connected. Start talking.');
  });
  conn.on('data', receive);
  conn.on('close', () => { netState('bad', 'they left'); S.theirs = null; });
  conn.on('error', () => netState('bad', 'connection error'));
}

function host() {
  const code = makeCode();
  const peer = new Peer(PEER_PREFIX + code, { debug: 0 });
  S.peer = peer;

  peer.on('open', () => {
    el.roomCode.textContent = code;
    el.waiting.classList.remove('hidden');
    el.waitMsg.textContent = 'Waiting for someone to join…';
  });
  peer.on('connection', (conn) => {
    wireConn(conn);
    go();
  });
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id') { peer.destroy(); host(); return; }
    toast(`Network: ${e.type}`, 5000);
  });
}

function join(code) {
  const peer = new Peer({ debug: 0 });
  S.peer = peer;
  peer.on('open', () => {
    const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
    wireConn(conn);
    go();
  });
  peer.on('error', (e) => {
    toast(e.type === 'peer-unavailable' ? 'No argument with that code.' : `Network: ${e.type}`, 5000);
    el.stage.classList.add('hidden');
    el.setup.classList.remove('hidden');
  });
}

/* ============================================================
   SCREENS
   ============================================================ */
function paintLangs() {
  const m = byCode(S.mine);
  const t = S.theirs ? byCode(S.theirs) : null;
  el.barMine.textContent = m.label;
  el.barTheirs.textContent = S.solo ? byCode(soloTarget()).label : (t ? t.label : '…');
  el.youLabel.textContent = `You · ${m.label}`;
  el.themLabel.textContent = S.solo
    ? `Playback · ${byCode(soloTarget()).label}`
    : `Them · ${t ? t.label : '…'}`;
}

async function go() {
  el.setup.classList.add('hidden');
  el.stage.classList.remove('hidden');
  paintLangs();
  try {
    await startMic();
    startSTT();
  } catch {
    toast('Microphone permission is required.', 6000);
  }
}

function boot() {
  LANGS.forEach((l) => {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l.label;
    el.myLang.appendChild(o);
  });
  el.myLang.value = 'en';

  el.myLang.onchange = () => {
    S.mine = el.myLang.value;
    if (S.recog) { S.recog.lang = byCode(S.mine).stt; }
    paintLangs();
    send({ t: 'hello', lang: S.mine });
  };

  el.btnCreate.onclick = () => { S.mine = el.myLang.value; netState('', 'waiting'); host(); };
  el.joinForm.onsubmit = (e) => {
    e.preventDefault();
    const code = el.joinCode.value.trim().toUpperCase();
    if (code.length < 4) return toast('Four characters.');
    S.mine = el.myLang.value;
    netState('', 'connecting');
    join(code);
  };
  el.btnSolo.onclick = () => {
    S.mine = el.myLang.value;
    S.solo = true;
    netState('live', 'solo');
    toast(`Solo: ${byCode(S.mine).label} → ${byCode(soloTarget()).label}`, 4000);
    go();
  };
  el.btnCancel.onclick = () => { S.peer?.destroy(); el.waiting.classList.add('hidden'); };
  el.btnLeave.onclick = () => location.reload();
  el.btnMute.onclick = () => {
    S.muted = !S.muted;
    if (S.muted) { cutVoice(); clearQueue(); }
    el.btnMute.textContent = S.muted ? 'Unmute them' : 'Mute them';
  };

  // Deep link: takraar.app/?c=ABCD drops you straight into the room.
  const c = new URLSearchParams(location.search).get('c');
  if (c) el.joinCode.value = c.toUpperCase();
}

boot();
