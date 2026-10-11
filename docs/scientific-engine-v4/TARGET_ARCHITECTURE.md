# Target PixMatch architecture

```text
src/
├── scientific/
│   ├── types.ts
│   ├── index.ts
│   ├── color/
│   │   ├── rgbToLab.ts
│   │   └── ciede2000.ts
│   ├── segmentation/
│   │   ├── phaseClassifier.ts
│   │   ├── segmentFrame.ts
│   │   ├── morphology.ts
│   │   └── connectedComponents.ts
│   ├── geometry/
│   │   ├── bounds.ts
│   │   └── metrics.ts
│   ├── calibration/
│   │   ├── calibration.ts
│   │   └── uncertainty.ts
│   ├── quality/
│   │   └── confidence.ts
│   ├── execution/
│   │   ├── processFrame.ts
│   │   └── processBatch.ts
│   ├── audit/
│   │   └── audit.ts
│   ├── export/
│   │   └── export.ts
│   ├── worker/
│   │   ├── engine.worker.ts
│   │   └── client.ts
│   └── validation/
│       └── referenceTests.ts
├── components/
│   └── ...existing UI...
└── routes/
    └── ...existing UI...
```

The UI owns experiment editing and visualization. The scientific layer owns all measurement computation. The worker owns expensive execution.
