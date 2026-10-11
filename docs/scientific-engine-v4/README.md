# PixMatch Scientific Engine v4

This folder is the refactored scientific execution layer for PixMatch. It is intentionally independent of the UI.

## Pipeline

ImageData → RGB → XYZ → CIELAB → perceptual phase segmentation → morphology → connected components → boundary extraction → calibrated physical quantity → confidence → uncertainty → MeasurementResult → batch audit/export.

## Main entry points

- `src/scientific/execution/processFrame.ts` — one-frame execution.
- `src/scientific/execution/processBatch.ts` — safe batch execution + optional interpolation.
- `src/scientific/worker/client.ts` — browser Web Worker boundary.
- `src/scientific/types.ts` — canonical scientific contracts.
- `src/scientific/export/export.ts` — reproducible CSV/JSON output.

## Integration

Replace the existing scientific execution path with `runInWorker()` from `src/scientific/worker/client.ts`. Keep React/UI state out of the scientific engine.

## Important

The reference frame should be converted by the application layer into a `MeasurementDefinition` (phase, appearance, ROI/spatial model, geometry and quantity). Do not use a raw click/seed as the final scientific definition.
