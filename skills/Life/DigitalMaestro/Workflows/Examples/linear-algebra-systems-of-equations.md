# Motivating Problem: Linear Algebra — Systems of Equations

**Concept:** System of Linear Equations (and solving via elimination/substitution)
**Domain:** Linear Algebra / Mathematics
**Forbidden terms (Phases 1–3):** system of equations, linear equations, simultaneous equations, matrix, substitution method, elimination method, Gaussian elimination, variables, coefficients, linear system

---

## PHASE 1: THE HOOK

Three friends — Alice, Ben, and Cara — go out for dinner. They're splitting the bill, but not evenly: they each ordered different things and agreed to pay for what they ate.

The waiter forgot to itemize the receipt. All they have is:

- Alice and Ben's food together cost $43
- Ben and Cara's food together cost $51
- Alice and Cara's food together cost $48

They need to figure out how much each person individually owes. No phone calculators — the restaurant's in a dead zone. They have a pen and the back of a napkin.

What's each person's share?

---

## PHASE 2: NAIVE ATTEMPTS

**Attempt 1: Just average it.**

Total spending: We know Alice+Ben = $43, Ben+Cara = $51, Alice+Cara = $48. Together those add to $142, but we've counted every person twice (Alice appears in two totals, Ben in two, Cara in two). So the real total is $142 ÷ 2 = **$71**.

Each person's average share: $71 ÷ 3 ≈ **$23.67**.

But the averages aren't the actual amounts. We know Alice and Ben together cost $43 — if they both paid $23.67, that's $47.34, not $43. The averages smooth away the actual differences. Alice might have ordered a salad and Ben a steak. Averaging gives the wrong answer for everyone.

**Attempt 2: Use one equation to guess, then adjust.**

From the first fact: Alice + Ben = $43. Let's guess Alice paid $20. Then Ben paid $43 - $20 = **$23**.

Now use Ben's amount in the second fact: Ben + Cara = $51. So Cara paid $51 - $23 = **$28**.

Now check the third fact: Alice + Cara should be $48. But $20 + $28 = **$48**. ✓

Wait — it worked! So... Alice = $20, Ben = $23, Cara = $28?

Let's try a different guess: Alice paid $15. Then Ben = $43 - $15 = $28. Then Cara = $51 - $28 = $23. Then Alice + Cara = $15 + $23 = $38 ≠ $48. ✗

With the first guess, we got lucky. With the second guess, we didn't. Guessing-and-checking sometimes works, but it requires luck, and with three people you might spend half the night trying numbers. What if there were ten friends? The guessing approach doesn't scale — and you can't trust an answer that depends on a lucky first guess.

---

## PHASE 3: THE AHA MOMENT

**What if the numbers themselves could tell you the answer — without any guessing?**

Here's a hint: you have three facts, and three unknowns. That feels like exactly enough information. What if you could use the facts to *cancel out* unknowns one at a time, until only one unknown is left?

Think about it: Alice+Ben = $43, and Ben+Cara = $51. Both facts include Ben. If you subtract the first from the second, Ben disappears entirely:

(Ben + Cara) - (Alice + Ben) = $51 - $43
Cara - Alice = $8

Now you have a much simpler fact: Cara costs exactly $8 more than Alice. And you already know Alice + Cara = $48. Can you see the rest from here?

---

## PHASE 4: NAMING THE CONCEPT

What you just used is called a **system of equations** — and the technique of subtracting one equation from another to eliminate an unknown is called **elimination**.

The key insight: when you have multiple facts that each involve multiple unknowns, you can combine the facts strategically to cancel unknowns one at a time. Each step simplifies the problem until only one unknown remains — and then you work backwards.

Mathematicians formalized this approach over centuries, from ancient Chinese texts (the Nine Chapters, ~200 BCE) through Gaussian elimination in the 19th century. The same technique that cracked your dinner receipt is used to solve problems in physics, economics, engineering, and machine learning — just with thousands of unknowns instead of three.

---

## PHASE 5: FORMALIZATION BRIDGE

The formal setup writes your three facts as:

a + b = 43   (equation 1)
b + c = 51   (equation 2)
a + c = 48   (equation 3)

Where *a*, *b*, *c* represent Alice's, Ben's, and Cara's amounts.

The elimination step you took:
- Subtract equation 1 from equation 2: (b + c) - (a + b) = 51 - 43 → **c - a = 8**
- Add this result to equation 3: (a + c) + (c - a) = 48 + 8 → **2c = 56 → c = 28**
- Substitute c = 28 into equation 3: a + 28 = 48 → **a = 20**
- Substitute a = 20 into equation 1: 20 + b = 43 → **b = 23**

Answer: Alice = $20, Ben = $23, Cara = $28.

The formal method works because:
- Each equation constrains the space of possible solutions
- Combining equations lets you reduce the number of unknowns
- Once you have one unknown's value, you substitute back (back-substitution)

Now try it: Four friends split a bill. Anya + Bo = $60, Bo + Cal = $74, Cal + Di = $68, Anya + Di = $54. How much does each person owe?
