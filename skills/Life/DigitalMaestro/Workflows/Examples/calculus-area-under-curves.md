# Motivating Problem: Calculus — Area Under Curves

**Concept:** Integration / Definite Integral
**Domain:** Calculus / Mathematics
**Forbidden terms (Phases 1-3):** integral, integration, antiderivative, calculus, Riemann, area under the curve, definite integral, indefinite integral, fundamental theorem

---

## PHASE 1: THE HOOK

You're a tax assessor in 1680, and your job is to figure out how much a farmer owes based on the size of their land. Most farms are rectangles — easy. Length times width, done.

But this farmer's land runs along a river, and rivers don't respect rectangles. The boundary curves: wide near the bend, narrow upstream, then widening again. The deed says the farm stretches 1 mile along the river, and the width at any point along the river is described by a formula someone scratched on parchment: width = 3 + 2x - x², where x is how far along the river you are (in miles).

You need the total area. You know how to find the area of rectangles. You know the formula for width at any given point. You have a ruler and all day.

How do you find the total area?

---

## PHASE 2: NAIVE ATTEMPTS

**Attempt 1: Measure at the midpoint and multiply.**

The farm is 1 mile long. At the midpoint — x = 0.5 miles — the width is:
3 + 2(0.5) - (0.5)² = 3 + 1 - 0.25 = 3.75 miles.

So the area is about 3.75 × 1 = **3.75 square miles**.

But wait. At x = 0, the width is 3. At x = 1, the width is 3 + 2 - 1 = 4. At x = 0.5, it's 3.75. Those are three different widths. The farm isn't uniformly 3.75 miles wide — it's varying. Taking the midpoint width and multiplying by the length assumed the whole farm was 3.75 miles wide, which it isn't. You've smoothed over real variation. The error might be small... or it might be large. You have no way to know.

**Attempt 2: Divide it into strips.**

Smarter: divide the mile into 4 equal strips, each 0.25 miles wide. Calculate the width at the left edge of each strip, multiply by 0.25, and add them up.

- Strip 1 (x=0): width = 3.0, area = 3.0 × 0.25 = **0.750**
- Strip 2 (x=0.25): width = 3 + 0.5 - 0.0625 = **3.4375**, area = 3.4375 × 0.25 = **0.859**
- Strip 3 (x=0.5): width = 3.75, area = 3.75 × 0.25 = **0.938**
- Strip 4 (x=0.75): width = 3 + 1.5 - 0.5625 = **3.9375**, area = 3.9375 × 0.25 = **0.984**

Total: 0.750 + 0.859 + 0.938 + 0.984 = **3.531 square miles**

Better — but 4 strips seems arbitrary. Why 4? If you use 10 strips, you get 3.617. If you use 100 strips, you get 3.663. Each time you use more strips, you get a slightly different answer. The more strips, the closer to something... but what? And how do you know when you're close enough? There's no stopping point — no exact answer.

You're getting closer to something with more and more work, but you can't reach it. You're stuck in an endless approximation spiral.

---

## PHASE 3: THE AHA MOMENT

Here's the question: **what if, instead of counting up all those thin rectangles, you found a formula that already has the accumulation built into it?**

Sit with that for a moment.

The width formula tells you the width at any single point: 3 + 2x - x². But what you need isn't the width at a point — you need the *total of all widths* as you walk from x = 0 to x = 1.

Is there a formula that, at any point x, tells you how much area you've accumulated so far from the start? If such a formula existed — call it A(x) — then the total area would just be A(1) - A(0). No strips. No approximation. Exact.

The question is: can you reverse-engineer A(x) from the width formula? What property would A(x) need to have, given that its "rate of growing" at any point x must equal the width at that point?

---

## PHASE 4: NAMING THE CONCEPT

What you just discovered is called **integration** — specifically, finding the definite integral.

The insight you arrived at: if you can find a function whose rate of change at every point equals the width function, then evaluating that function at the endpoints gives you the exact total. No strips, no approximation, no infinite sums.

Mathematicians in the 1670s — Newton and Leibniz, working independently — spent years grappling with exactly this problem. They called the accumulation function the "integral" and the process of finding it "integration." The land-measurement problem, the motion problem, the area problem — all the same structure.

---

## PHASE 5: FORMALIZATION BRIDGE

The formal notation writes the total area as:

∫₀¹ (3 + 2x - x²) dx

Each piece maps to your experience:
- **∫** — the elongated "S" stands for "sum" — it's the infinite version of adding up all those strips
- **₀¹** — the limits, from x=0 to x=1, are the start and end of your farm
- **(3 + 2x - x²)** — the width formula at each point x
- **dx** — the infinitely thin strip width; when you had 4 strips, each was 0.25 miles; this is the limit as each strip becomes infinitely thin

To evaluate this exactly, we find the accumulation function A(x) whose rate of change equals 3 + 2x - x²:

A(x) = 3x + x² - x³/3

Then: A(1) - A(0) = (3 + 1 - 1/3) - 0 = **3⅔ square miles** (≈ 3.667)

Notice: your strip approximation with 100 strips gave 3.663 — you were within 0.004 of the exact answer. The integral gives the answer your strips were converging toward.

Now try it yourself: the same farm, but the width formula is 2 + x - x². What's the total area from x=0 to x=1?
