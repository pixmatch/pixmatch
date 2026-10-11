# PixMatch Scientific Phase Workflow

## Goal
Build a physically meaningful composite phase from multiple CIELAB traces.

Example:
- Water (target): red water + black/dark water components
- Oil (secondary): grey oil component

The scientific water height is measured from the **top of the composite Water mask** to the **user-selected baseline**, rather than using a region bounding-box height.

## Reference frame setup
1. Calibrate the frame using the existing needle/known-distance workflow.
2. Select **Wand (CIELAB)** and click the red water region.
3. In **Scientific phase composition**, enter `Water`, choose `Target / water`, and click **Add current CIELAB region to phase**.
4. Click the black/dark part of the water with the Wand.
5. Add it again to the same `Water` target phase. These components are unioned for the physical measurement.
6. Click the grey oil region, enter `Oil`, choose `Secondary / oil`, and add it.
7. Draw the experimental substrate/base reference line and click **Use selected line as height baseline**.
8. Run **Scientific measurement on all frames**.

## Output
For every frame the engine stores:
- target phase name
- height in pixels
- calibrated physical height
- contact diameter in pixels and physical units when the baseline intersects the mask
- top boundary Y
- baseline Y
- number of successfully detected components
- confidence
- status

The overlay renders the detected composite target boundary and the measured top-to-baseline height on each frame. The table and graph show the frame-by-frame evolution.

## Why multiple components matter
A single color seed is not sufficient for this experiment because the water appearance contains visually different regions. PixMatch therefore treats a scientific phase as a **union of independently learned components** instead of assuming one color represents the entire physical phase.

This is also the foundation for later contact-angle work: the target phase, secondary phase, and substrate baseline are represented separately instead of being conflated into one region.
