// Translation proxy. Lives server-side so the browser never eats a CORS
// preflight on the hot path -- every round trip here is latency the argument pays for.
//
// Cascade: Google's free gtx endpoint first (~120ms), Lingva second, MyMemory last.
// The client has the same cascade minus this function, so the app still works
// on pure static hosting if this ever goes away.

const TIMEOUT_MS = 2500;

async function withTimeout(promise, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await promise(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function viaGoogle(text, from, to, signal) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx' +
    `&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}` +
    `&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`google ${res.status}`);
  const data = await res.json();
  // Shape: [[[translated, original, ...], ...], ...]
  const out = (data?.[0] || []).map((seg) => seg?.[0] || '').join('');
  if (!out) throw new Error('google empty');
  return out;
}

async function viaLingva(text, from, to, signal) {
  const url = `https://lingva.ml/api/v1/${from}/${to}/${encodeURIComponent(text)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`lingva ${res.status}`);
  const data = await res.json();
  if (!data?.translation) throw new Error('lingva empty');
  return data.translation;
}

async function viaMyMemory(text, from, to, signal) {
  const url =
    'https://api.mymemory.translated.net/get' +
    `?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`mymemory ${res.status}`);
  const data = await res.json();
  const out = data?.responseData?.translatedText;
  if (!out) throw new Error('mymemory empty');
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = req.method === 'POST' ? req.body || {} : req.query || {};
  const text = String(q.text || '').slice(0, 1000);
  const from = String(q.from || 'auto');
  const to = String(q.to || 'en');

  if (!text.trim()) return res.status(400).json({ error: 'text required' });
  if (from === to) return res.status(200).json({ text, via: 'passthrough' });

  const providers = [
    ['google', viaGoogle],
    ['lingva', viaLingva],
    ['mymemory', viaMyMemory],
  ];

  for (const [name, fn] of providers) {
    try {
      const out = await withTimeout((signal) => fn(text, from, to, signal), TIMEOUT_MS);
      // Short cache: arguments repeat themselves, and a repeated phrase
      // should come back instantly the second time.
      res.setHeader('Cache-Control', 'public, s-maxage=600');
      return res.status(200).json({ text: out, via: name });
    } catch {
      // try the next provider
    }
  }

  return res.status(502).json({ error: 'all providers failed' });
}
