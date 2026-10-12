# PixMatch 1.4

## What changed
- The scientific engine in `src/scientific/` is now used by the app: **Measurement pipeline (scientific engine)** card in the right sidebar.
  Pipeline: ImageData → CIELAB → CIEDE2000 phase mask → ROI-safe morphology → connected components → boundary extraction → pixel height → mm → confidence + uncertainty → audited result.
- New stage: boundary extraction (`geometry/boundary.ts`).
- Engine fixes: confidence terms are measured (five were fixed constants), component count is measured, bad calibration is rejected before processing, exposure match / percentile trim / baseline row / largest-region filter now work (unused settings removed).
- Faster: lookup-table Lab conversion, early-exit ΔE, separable morphology.
- Worker streams frames one at a time, falls back to the main thread automatically, supports cancel.
- Exports: pipeline CSV / JSON / audit from the card and from the Download menu.
- Added `ARCHITECTURE.md`, `docs/ARCHITECTURE.pdf`, `tests/engine.test.ts` (37 tests; `npx tsx tests/engine.test.ts`).

## How to use the pipeline
1. Calibrate with the needle gauge (or type mm per pixel in the card).
2. Point tool → click the phase → **Use probed colour** (or Wand → **Use wand region**).
3. Adjust ΔE tolerance and cleanup while watching the live preview (red mask, yellow boundary, cyan top/bottom).
4. **Run pipeline**. Click a table row to jump to that frame. Export CSV / JSON / Audit.

## Upload to GitHub
Keep the folder structure (drag the folders, not loose files). The repo root must contain `src`, `public`, `docs`, `.lovable`, `tests`, `package.json`, `vite.config.ts`, `tsconfig.json`. Delete any `bun.lock` or `package-lock.json` already in the repo.
