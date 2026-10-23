import { describe, expect, it } from "vitest";

import { decodePolyline, encodePolyline } from "./polyline";
import { distanceToPathMeters } from "./route-geometry";

describe("encodePolyline", () => {
  it("matches Google's documented example", () => {
    // From Google's polyline algorithm page: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453).
    expect(
      encodePolyline([
        [-120.2, 38.5],
        [-120.95, 40.7],
        [-126.453, 43.252],
      ]),
    ).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  });

  it("round-trips through decodePolyline to 5 decimal places", () => {
    const path: [number, number][] = [
      [72.84112, 21.20491],
      [72.84154, 21.2032],
      [73.18121, 22.30724],
    ];
    expect(decodePolyline(encodePolyline(path))).toEqual(path);
  });

  it("encodes an empty path as an empty string", () => {
    expect(encodePolyline([])).toBe("");
    expect(decodePolyline("")).toEqual([]);
  });
});

describe("distanceToPathMeters", () => {
  // A north–south line along longitude 72.84, about 2.2 km long.
  const path: [number, number][] = [
    [72.84, 21.2],
    [72.84, 21.22],
  ];

  it("is about zero on the line", () => {
    expect(distanceToPathMeters({ latitude: 21.21, longitude: 72.84 }, path)).toBeLessThan(1);
  });

  it("measures sideways distance to the nearest segment", () => {
    // 0.003° of longitude at 21.21° N is about 311 m.
    const meters = distanceToPathMeters({ latitude: 21.21, longitude: 72.843 }, path);
    expect(meters).toBeGreaterThan(300);
    expect(meters).toBeLessThan(320);
  });

  it("measures to the end point past the end of the line", () => {
    // 0.002° of latitude past the end is about 223 m.
    const meters = distanceToPathMeters({ latitude: 21.222, longitude: 72.84 }, path);
    expect(meters).toBeGreaterThan(215);
    expect(meters).toBeLessThan(230);
  });

  it("is infinite for an empty path", () => {
    expect(distanceToPathMeters({ latitude: 21.2, longitude: 72.84 }, [])).toBe(Number.POSITIVE_INFINITY);
  });
});
