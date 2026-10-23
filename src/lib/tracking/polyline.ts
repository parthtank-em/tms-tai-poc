/**
 * Google's encoded polyline format (precision 5) — the compact string the
 * phone's Google Maps SDK draws directly (`PolyUtil.decode` on Android,
 * `GMSPath(fromEncodedPath:)` on iOS).
 *
 * Paths here are `[longitude, latitude]` pairs, GeoJSON order, as stored.
 *
 * @see https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */

const FACTOR = 1e5;

function encodeValue(value: number): string {
  let shifted = value < 0 ? ~(value << 1) : value << 1;
  let encoded = "";

  while (shifted >= 0x20) {
    encoded += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
    shifted >>= 5;
  }
  return encoded + String.fromCharCode(shifted + 63);
}

export function encodePolyline(path: [number, number][]): string {
  let previousLatitude = 0;
  let previousLongitude = 0;
  let encoded = "";

  for (const [longitude, latitude] of path) {
    const lat = Math.round(latitude * FACTOR);
    const lng = Math.round(longitude * FACTOR);
    encoded += encodeValue(lat - previousLatitude) + encodeValue(lng - previousLongitude);
    previousLatitude = lat;
    previousLongitude = lng;
  }

  return encoded;
}

export function decodePolyline(encoded: string): [number, number][] {
  const path: [number, number][] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  const next = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    latitude += next();
    longitude += next();
    path.push([longitude / FACTOR, latitude / FACTOR]);
  }

  return path;
}
