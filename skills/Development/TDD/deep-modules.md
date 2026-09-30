# Deep Modules

TDD's quick-reference for spotting deepening opportunities during refactor (`SKILL.md` step 4).
Canonical vocabulary lives in
[`ImproveCodebaseArchitecture/LANGUAGE.md`](../ImproveCodebaseArchitecture/LANGUAGE.md) — this file
restates it for TDD's context, it doesn't redefine it.

**Deep module** = small interface, large amount of behaviour behind it. Depth is **leverage**: how much
behaviour a caller (or test) can exercise per unit of interface they have to learn.

**Shallow module** = interface nearly as complex as the implementation (avoid — the caller learns almost
as much as if the interface didn't exist).

```
┌─────────────────────┐
│   Small Interface   │  ← few methods, simple params — callers learn little
├─────────────────────┤
│                     │
│  Deep Implementation│  ← lots of behaviour hidden — high leverage
│                     │
└─────────────────────┘
```

```
┌─────────────────────────────────┐
│       Large Interface           │  ← many methods/params — callers learn a lot
├─────────────────────────────────┤
│  Thin Implementation            │  ← barely more than a pass-through
└─────────────────────────────────┘
```

Depth is **not** a line-count ratio (implementation-lines ÷ interface-lines, per Ousterhout) — that
framing rewards padding the implementation with bulk instead of hiding real complexity. See
`LANGUAGE.md`'s "Rejected framings" for why Kaya doesn't use it.

When refactoring toward a deeper module, ask:

- Can I reduce the number of methods or parameters a caller has to learn?
- Can I hide more complexity behind the same interface, instead of exposing it?
- **The deletion test:** if I deleted this module, would complexity vanish (it was a pass-through — stay
  shallow) or reappear across its callers (it was earning its keep — worth deepening)?
