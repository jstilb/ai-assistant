# Effort controls UX/UI scope and depth, never whether states get specced

On a `browser`/`native` surface, both the UX and UI skills always run; **effort tier** controls only scope (how many screens) and depth (how much per screen), never *whether* the UI skill runs. Small = only the touched screens/components at lean depth (changed-area wireframe + its states + acceptance criteria); Large = all screens + full package + journey maps / personas.

We explicitly reject skipping the UI skill on Small effort: empty / loading / error states and accessibility are the highest-ROI gaps (research finds happy-path-only specs are the #1 rework cause), and they matter even on a one-screen change.
