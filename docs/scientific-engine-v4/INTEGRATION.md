# Integration checklist

1. Stop calling heavy scientific processing directly from React render/event paths.
2. Convert the existing UI recipe into `MeasurementDefinition[]`.
3. Standardize calibration internally on `mmPerPixel`.
4. Select and persist one `MeasurementConvention`.
5. Route all frame processing through `runInWorker()`.
6. Store `MeasurementResult.status` separately from the numeric value.
7. Never display interpolated values as directly measured values.
8. Export calibration, algorithm version, confidence, uncertainty and measurement convention.
9. Remove the duplicate legacy scientific/recipe execution path after migration.
10. Add fixture tests using known RGB→Lab, CIEDE2000, synthetic masks, calibration and mixed-validity batches.
