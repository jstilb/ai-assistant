# Motivating Problem: Fourier Transforms — Signal Decomposition

**Concept:** Fourier Transform / Frequency Analysis
**Domain:** Signal Processing / Mathematics
**Forbidden terms (Phases 1–3):** Fourier, frequency domain, frequency analysis, spectrum, harmonic, sinusoid, sine wave, cosine wave, transform, decomposition, spectral analysis, Fourier series, FFT, DFT

---

## PHASE 1: THE HOOK

You press three keys on a piano simultaneously: C4, E4, and G4 — a C major chord. The sound travels through air as a single, combined wave and gets captured by a microphone. Your computer records it as a long list of numbers — the pressure of the air at each moment in time, sampled 44,100 times per second.

You hand that recording to a friend and ask: "Which three keys did I press?"

They look at the waveform. It's a complicated, jagged shape — not three clean waves, just one messy combined one. They can play it back and hear that it sounds like a chord. But looking at the numbers, can they figure out which individual keys were pressed?

More practically: a piano tuner wants to know if your middle C is slightly flat. An audio engineer wants to remove a hum at 60 Hz. A doctor wants to identify a patient's heart rate from a pulse oximeter signal. All of them have the combined wave. All of them need to extract specific individual components from it.

How do you take a messy combined signal and figure out what's inside it?

---

## PHASE 2: NAIVE ATTEMPTS

**Attempt 1: Listen carefully and identify by ear.**

A trained musician can hear a C major chord and identify C, E, and G. But "listen carefully" isn't a method a computer can use. And for more complex signals — an EKG with noise artifacts, a radio signal with static, a geological vibration reading — there's no human ear that can pick out the components. We need a method that works on raw numbers, without human perception.

**Attempt 2: Try matching the recording against known note waveforms.**

Middle C (C4) vibrates at exactly 261.63 Hz. E4 at 329.63 Hz. G4 at 392.00 Hz. You could generate the pure waveform for each note and compare it to the recording.

Try it with C4: generate a 261.63 Hz wave and subtract it from your recording. Does the remainder look like two clean notes? No — subtracting a pure 261.63 Hz wave from a chord recording doesn't cleanly isolate the C, because the combined wave doesn't store each note in a separate "slot." The numbers are all mixed together. Subtraction doesn't undo mixing.

Try it differently: check if the C4 wave "fits" the recording by computing how correlated they are. Multiply each sample of the recording by the corresponding sample of the C4 wave and add up all the products. For your 1-second recording at 44,100 samples/second:

- Sample 1: recording = 0.42, C4 wave = 0.00 → product = 0.000
- Sample 2: recording = 0.61, C4 wave = 0.037 → product = 0.023
- Sample 3: recording = 0.73, C4 wave = 0.074 → product = 0.054
- ... (44,097 more samples)

Sum of all products: some large number. But you don't know if that number is large because C4 is present, or just because the recording itself is large. You'd need to try this for every possible frequency — 261 Hz, 262 Hz, 263 Hz... all the way up to 22,050 Hz (the limit for a 44.1kHz recording). That's 22,050 separate correlation calculations, each requiring 44,100 multiplications. Over a billion operations to check all frequencies — and even then, you'd have a messy correlation curve, not a clean list of which notes are present.

You're drowning in computation, and you're not even sure the correlation approach gives you an exact answer.

---

## PHASE 3: THE AHA MOMENT

**What if the correlation approach actually does work exactly — and there's a mathematical reason that all those messy cross-correlations cancel out, leaving only the frequencies that are truly present?**

Here's a hint: think about what happens when you multiply a 261 Hz wave against itself, sample by sample, over exactly one full second. The products are all positive (positive times positive, or negative times negative). Their sum is large.

Now multiply a 261 Hz wave against a 330 Hz wave, over exactly one second. Sometimes they're in sync (both positive or both negative, product positive). Sometimes they're out of sync (one positive, one negative, product negative). Over exactly one full second, those positives and negatives cancel out almost perfectly.

What does that cancellation property mean for the correlation calculation you were doing?

---

## PHASE 4: NAMING THE CONCEPT

What you just described is called the **Fourier transform** — named after Joseph Fourier, who in 1822 proved that any periodic signal can be decomposed into a sum of simpler waves.

The insight you arrived at: when you compute the correlation between a recording and a pure wave at frequency *f*, over a time window that is an exact multiple of the wave's period, waves at other frequencies cancel out exactly. Only frequency *f* itself produces a non-zero result (if it's present in the recording). This magical cancellation property is what makes the computation exact — not approximate, not statistical. If the signal contains a 261 Hz component, the Fourier correlation at 261 Hz picks it out cleanly.

Fourier's proof shocked mathematicians: that *any* signal — no matter how jagged and complicated — can be built from pure waves, and that the decomposition is unique. The piano chord, the heartbeat, the earthquake tremor, the vowel sound — all of them are sums of simpler waves that the Fourier transform can extract.

---

## PHASE 5: FORMALIZATION BRIDGE

The formal definition of the Fourier transform at frequency *f*:

X(f) = ∫₋∞^∞ x(t) · e^{-2πift} dt

Each piece maps to your experience:
- **x(t)** — the recording (the combined wave), as a function of time
- **e^{-2πift}** — the pure wave at frequency *f* that you're correlating against (using complex exponentials, which encode both sine and cosine — both phases)
- **∫ ... dt** — the sum over all time (the continuous version of multiplying sample by sample and adding)
- **X(f)** — the result: how much of frequency *f* is in the recording

For your piano chord:
- X(261.63) ≈ large number → C4 is present ✓
- X(329.63) ≈ large number → E4 is present ✓
- X(392.00) ≈ large number → G4 is present ✓
- X(300) ≈ 0 → 300 Hz is not present ✓

The magical cancellation you discovered in Phase 3 — that different frequencies don't interfere with each other's correlations — is called **orthogonality**. It's the mathematical property that makes the whole thing work.

Now try it conceptually: if you recorded a pure 440 Hz tone (concert A) and computed X(f) for all frequencies, what would the result look like? A spike at one frequency, or something spread across many?
