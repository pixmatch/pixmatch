# PixMatch interaction and stability fixes

## Outcome
Upgrade the uploaded PixMatch workspace without changing its core analysis model: calibration becomes distance-first, existing marks gain direct context actions, the magnifier follows the cursor accurately, the interface shifts to blue-black, and batch recipe runs stop crashing or losing the current image sequence.

## Implementation
- Import the uploaded PixMatch source while excluding archive metadata and generated files.
- Rework known-distance calibration so users enter the physical distance first, receive an explicit “draw the reference line” prompt while drawing, and may enter the pixel length manually instead.
- Add a context menu on permanent measurements. Right-click will select the mark and offer Measure, Set scale (for lines), appearance controls, and Delete.
- Store per-mark stroke color and width, render them consistently, and expose practical presets including a bold option.
- Drive the magnifier from the cursor’s image coordinates and source image, keeping the sampled point centered across pan and zoom.
- Replace cyan/teal styling with a high-contrast blue-black design system and restrained blue gradients while preserving the dense analysis workspace.
- Make recipe replay defensive: preload frames safely, isolate per-frame failures, avoid stale state overwrites, show progress/results, and preserve the uploaded sequence across a recoverable app error during the same browser session.
- Keep page metadata app-specific.

## Verification
- Load multiple images and verify distance-first calibration with both drawn and manually entered pixels.
- Right-click a saved line to measure it, set scale, change appearance, and delete it.
- Confirm the magnifier tracks the image point under the cursor at different zoom/pan levels.
- Capture a recipe and run it across all frames without a crash; verify failures are reported without discarding other results.
- Check the final workspace at desktop and mobile widths and confirm the preview build is clean.
