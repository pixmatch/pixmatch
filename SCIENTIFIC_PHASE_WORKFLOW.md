# PixMatch Scientific Measurement Workflow

## Principle
Everything is defined once, by hand, on reference frame 1. The other frames replay **only** what was
defined there, using CIELAB (derived from RGB) appearance. Nothing that was not set up on frame 1 is computed.

## Reference lines and what they mean
Draw a line (or click a saved line so it is selected), pick its meaning, then press **Use selected line as …**.

| Meaning | What the line is | What is measured in every frame |
| --- | --- | --- |
| Height | The line *is* the measurement | Both endpoints are re-located from the CIELAB profile learned around them on frame 1; the new length is reported. Several height lines are allowed. |
| Base level | A reference level | Distance from the top boundary of the target phase to this level. Needs a target phase. |
| Chord span | A cut through the phase | Width of the target phase mask along this line. Needs a target phase. |

Base level and chord span are one definition each; height lines can be many.

## Phases (only needed for base level / chord span)
1. Use **Wand (CIELAB)** and click a region.
2. Name a phase, choose Target or Secondary, click **Add current CIELAB region to phase**.
3. Add more components to the same phase to build a composite (their masks are unioned).

Phases are segmented in other frames only if a base-level or chord-span line exists.

## How endpoint tracking works
For height, the drawn line defines the measurement axis. PixMatch stores the reference appearance and uses the target phase mask to recompute the current full extent along that axis. Endpoint appearance is retained only as an auxiliary tracking signal.
In each frame it searches near the previous frame's position, mostly along the axis and slightly across it, for the
position whose profile has the lowest ΔE. Confidence is derived from that residual. The search radius is the value set in the detection panel.

## Output
Per frame: tracked line length (px and calibrated units), phase extent and chord span when defined, confidence and status.
CSV and HTML exports include a tracked-lines section.

## Detection controls
- **Lightness weight (L*)** lowers how much brightness counts in ΔE, so exposure drift between frames does not break matching. It is used by the wand, phase relocation and line tracking.
- **Histogram · detection limits**: choose Gray, L*, a* or b*. On L*/a*/b* click the histogram (or type Min/Max) to set a hard window; **Fit to selected region** derives all three windows from a traced region (2nd–98th percentile). Windows are extra limits on top of ΔE and are stored with each phase you add.
- **Match illumination to frame 1** (optional): before matching, each frame's CIELAB is shifted so its border colour equals frame 1's border colour.
- Line tracking uses sub-pixel matching and clips per-sample ΔE so glare or occluders do not dominate.

## Menus
- **File**: open images, export CSV/HTML, close frame / all frames.
- **Edit**: selections, saved marks, clear results, clear scientific setup.
- **View**: frame stepping, zoom, overlay, magnifier.
- **Analyze**: measure selection, histogram limits, auto-measure.
- **Batch**: run the scientific measurement or the legacy recipe over all frames, clear results.

## Sequence list (right-click an image)
- **Set as reference (frame 1)** moves that image to the top. Phase/line setups from the old reference are cleared, because they belong to the old frame.
- **Delete image** removes it (and its recovery copy). Deleting frame 1 also clears setups.
