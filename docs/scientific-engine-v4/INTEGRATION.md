# Integration status (updated for 1.4)

The engine is now integrated; see `/ARCHITECTURE.md` for the current design. Checklist from the original plan:

1. Heavy processing off the render path — done (worker, frames streamed one at a time, main-thread fallback).
2. Convert UI settings into `MeasurementDefinition[]` — done for the pipeline card (`buildHeightRecipe`). The older interactive-tool recipe (tracked lines/angles) is intentionally not converted.
3. Calibration standardised on `mmPerPixel` — done (`mmPerPixelFromScale`).
4. One `MeasurementConvention` selectable — done (inclusive / pixel-centre).
5. Frame processing through the worker client — done (`createRunner`).
6. `status` stored separately from the value — done.
7. Interpolated values never shown as measured — done (`INTERPOLATED` status, note, off by default).
8. Exports include calibration, version, confidence, uncertainty, convention — done.
9. Remove the duplicate legacy path — NOT done: the interactive tools remain a separate implementation by design.
10. Fixture tests — done (`tests/engine.test.ts`).
