# TAKRAAR

*Do log. Do zubaan. Ek bahas.*

Two people who share no language, having a real argument. Interrupting, getting
loud, changing their minds.

**Live:** https://rider315.github.io/takraar/
**Browser:** Chrome or Edge, desktop. Headphones required.

---

## The problem is not translation

Translation is a solved-enough commodity. I measured three free engines in the
first twenty minutes and one of them does a usable job in under half a second.
That is not where this falls down.

It falls down because **a translator serialises a conversation and an argument is
parallel.**

A normal pipeline goes: you talk → it waits for you to stop → it transcribes →
it translates → it speaks. By the time the other person hears your sentence you
have already started your next one. They cannot interrupt you, because they have
not heard you yet. The lag does not make the argument slow. It makes it
impossible, because interruption is not a rude edge case in an argument, it is
the mechanism. People interrupt by *predicting* where your sentence is going, and
you cannot predict a sentence you have not started hearing.

So the entire job is removing the turn.

## Six things that do that

**1. Never wait for the sentence to end.**
Chrome's speech recognition emits interim results while you are still talking. I
commit stable prefixes of those instead of waiting for `isFinal`, which runs
about a second behind the mouth. A second is an eternity in a row.

**2. Send text, not audio.**
Recognition runs on the speaker's device, synthesis on the listener's. The wire
carries about sixty bytes per chunk. Streaming audio between two people is heavy
and lossy and adds its own delay; this way the network stops being a factor at
all, and each side renders speech locally where it can be cancelled instantly.

**3. The listener translates, not the speaker.**
The speaker's words leave the moment they are recognised, and translation happens
on the other end while more speech is still arriving. It also means that adding a
third person in a third language changes nothing about the sender.

**4. Interruption is a real event, not a UI state.**
Both microphones stay open. The instant you start talking, the voice in your ear
is cancelled, everything still queued from them is dropped, and they are told
they were cut off. That last part matters: being interrupted is a social signal,
and if the other person does not *feel* cut off, you have not interrupted them,
you have just talked over a recording.

**5. Volume and pace survive the trip.**
I measure loudness off the microphone continuously and send a single "heat"
number with each chunk. The listening device maps it onto speech rate, pitch and
volume. Without this, a shouted accusation arrives as a calm librarian reading it
aloud, and the argument dies in transit. This is the cheapest high-leverage thing
in the whole build.

**6. A position can be taken back.**
Every finished utterance becomes a claim in the rail at the bottom. Your own are
clickable, and taking one back strikes it through on both screens at the same
moment. This is the mechanism for changing your mind, and it needs to be a
mechanism rather than a sentence. Saying "fine, I take that back" out loud only
works if the other person catches it, believes it, and knows which part of the
last five minutes you meant — and across a language barrier all three of those
fail more often than they work. Pointing at the exact claim and withdrawing it
is unambiguous in a way that speech is not.

It also gives the second translation pass somewhere to live. Chunks are
translated cold, one clause at a time, because that is the only way to be fast.
When the utterance ends, the whole thing is translated again as a single unit,
where the engine can see the sentence it is actually translating, and that
corrected version is what becomes the claim and what replaces the text on the
rail. The audio was already good enough to argue with. This is what gets
remembered.

## What I measured, and what it changed

Everything below came out of testing, not planning. All of it changed the design.

| Finding | What I did about it |
|---|---|
| Lingva: dead (CORS failure) | Dropped it |
| MyMemory: correct, **2701ms** | Demoted to last resort. Slower than the argument tolerates |
| Google gtx: **70–680ms**, permissive CORS | Promoted to first. Works straight from the browser, so there is no backend on the hot path |
| `"You are not"` → `"आप नहीं हो"` (noise) | Stopped chunking by word count |
| `"You are not listening to me at all"` → `"तुम मेरी बात सुन ही नहीं रहे हो"` (correct) | Chunk on **pauses**, which are clause boundaries, not every N words |
| Short chunks overtook long ones and played out of order | Added an ordered output queue. Arrival order, never finish order |
| A held-back final word shipped alone: `"all"` → `"सभी"` | Only hold a word back mid-flow, never after a pause |
| Chunked: `"and you never have"` → `"और आपके पास कभी नहीं होगा"` ("and you will never *have*") | Added a second pass over the finished utterance. Same sentence, translated whole: `"और कभी सुनोगे भी नहीं"` ("and never will listen"). Correct |
| Second pass costs 113–583ms, after the audio has already played | Kept it off the hot path entirely. It corrects the record, never the speed |

The chunk-size tradeoff is the real tension in the product. Smaller chunks mean
lower latency and worse translation, because a fragment has no context to
translate against. Cutting on pauses rather than word counts gets both, and it is
roughly what human simultaneous interpreters do — they work in units of sense
with a two to four second ear-voice span, not word by word.

## Honest limits

- **Headphones are not a suggestion.** Both mics are open. On speakers, each side
  transcribes the other's synthesised voice and the thing feeds back on itself.
- **Chrome and Edge only.** `SpeechRecognition` is not in Firefox or Safari.
- **Fourteen languages,** because that is what Chrome ships a voice for. Tamil,
  Bengali, Marathi and Arabic are recognised fine but have no voice on most
  machines, and silent subtitles are not this product. The app warns you if your
  partner's language has no voice on your device rather than failing quietly.
- **The translation endpoint is unofficial** and could rate-limit or vanish. There
  is a three-way cascade behind it and a serverless proxy in `/api`, but a real
  version of this buys a proper MT contract on day one.
- **Prosody is inferred from loudness,** not from real emotion detection. It is a
  proxy, and a good one for its cost, but it is a proxy.
- Voice activity detection is a plain RMS threshold. It will trip on a slammed
  door. A real version uses a proper VAD model.
- **Two-person mode leans on PeerJS's free public signalling server** to
  introduce the two browsers to each other. Nothing is routed through it once
  they are connected, but if it is down, room codes stop working. Solo mode is
  unaffected. Running our own signalling is an afternoon of work and the only
  reason it is not done is that it is not the interesting part.

## What I would build next

**Translate the argument, not the sentences.** The second pass fixed the
sentence-level damage, which was the worst of it, but each utterance is still
translated with no idea what the fight is about. The same five words mean
different things depending on the subject, and pronouns in particular go wrong
when the thing being referred to was named a minute ago. Feeding the running
claims in as context is the next step, and it is the difference between a
translator and something that is actually following the fight.

Second: the on-screen text should run *ahead* of the audio, not with it. Reading
is about three times faster than listening, so showing text early is what gives
back the ability to predict a sentence and interrupt at the right moment. The
rails already stream; they just need to stop waiting for the voice.

## Running it

Pure static, no build step, no install.

```bash
python -m http.server 8099
```

Then open `http://localhost:8099` in Chrome. Two tabs works for testing, two
machines is the real thing. **Try it alone first** runs your own voice back at
you in the other language through the full pipeline, so you can check it works
without a second person.

`/api/translate.js` is a Vercel serverless function used only as a fallback. The
app is fully functional without it.

## Stack

Browser `SpeechRecognition` for streaming recognition · `speechSynthesis` for
output, chosen because `cancel()` is instant and that is what makes an
interruption land · PeerJS data channel for transport · Google gtx with a
cascade behind it for translation · no framework, no build, one HTML file, one
stylesheet, one script.
