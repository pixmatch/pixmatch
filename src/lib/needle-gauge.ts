/**
 * Birmingham (stubs) needle gauge reference table.
 * Outer and inner diameters in millimetres — used as a physical ruler for
 * spatial calibration when a needle is visible in the frame.
 */

export type NeedleGauge = {
  gauge: string;
  od: number; // mm
  id: number; // mm
  wall: "regular" | "thin" | "extra-thin";
};

export const NEEDLE_GAUGES: NeedleGauge[] = [
  { gauge: "10 G", od: 3.404, id: 2.693, wall: "regular" },
  { gauge: "11 G", od: 3.048, id: 2.388, wall: "regular" },
  { gauge: "12 G", od: 2.769, id: 2.159, wall: "regular" },
  { gauge: "13 G", od: 2.413, id: 1.804, wall: "regular" },
  { gauge: "14 G", od: 2.108, id: 1.6, wall: "regular" },
  { gauge: "15 G", od: 1.829, id: 1.372, wall: "regular" },
  { gauge: "16 G", od: 1.651, id: 1.194, wall: "regular" },
  { gauge: "17 G", od: 1.473, id: 1.067, wall: "regular" },
  { gauge: "18 G", od: 1.27, id: 0.838, wall: "regular" },
  { gauge: "19 G", od: 1.067, id: 0.686, wall: "regular" },
  { gauge: "20 G", od: 0.908, id: 0.603, wall: "regular" },
  { gauge: "21 G", od: 0.819, id: 0.514, wall: "regular" },
  { gauge: "22 G", od: 0.718, id: 0.413, wall: "regular" },
  { gauge: "23 G", od: 0.641, id: 0.337, wall: "regular" },
  { gauge: "24 G", od: 0.565, id: 0.311, wall: "regular" },
  { gauge: "25 G", od: 0.514, id: 0.26, wall: "regular" },
  { gauge: "26 G", od: 0.464, id: 0.26, wall: "regular" },
  { gauge: "27 G", od: 0.413, id: 0.21, wall: "regular" },
  { gauge: "28 G", od: 0.362, id: 0.184, wall: "regular" },
  { gauge: "29 G", od: 0.337, id: 0.184, wall: "regular" },
  { gauge: "30 G", od: 0.311, id: 0.159, wall: "regular" },
  { gauge: "31 G", od: 0.26, id: 0.133, wall: "regular" },
  { gauge: "32 G", od: 0.235, id: 0.108, wall: "regular" },
  { gauge: "33 G", od: 0.21, id: 0.108, wall: "regular" },
  { gauge: "34 G", od: 0.184, id: 0.083, wall: "regular" },
];

export const UNITS = ["mm", "µm", "cm", "m", "in", "px"] as const;
export type Unit = (typeof UNITS)[number];

/** Convert a millimetre reference value into the working unit. */
export function mmTo(value: number, unit: Unit) {
  switch (unit) {
    case "mm":
      return value;
    case "µm":
      return value * 1000;
    case "cm":
      return value / 10;
    case "m":
      return value / 1000;
    case "in":
      return value / 25.4;
    default:
      return value;
  }
}
