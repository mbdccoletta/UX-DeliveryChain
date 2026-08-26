// ISO-3166 alpha-2 → [lat, lng] country centroids.
//
// Measured on this tenant: RUM events carry NO city coordinates
// (geo.city.latitude/longitude are null on every row), only country codes.
// The platform's DotLayer wants latitude/longitude — so the bubbles the
// standard component draws are placed at COUNTRY centroids, which is the
// honest grain of the data we actually have. Static, because the CSP blocks
// outside hosts; codes missing here simply do not plot.
export const CENTROID: Record<string, [number, number]> = {
  US: [39.8, -98.6], CA: [56.1, -106.3], MX: [23.6, -102.5], BR: [-14.2, -51.9],
  AR: [-38.4, -63.6], CL: [-35.7, -71.5], CO: [4.6, -74.1], PE: [-9.2, -75.0],
  GB: [55.4, -3.4], IE: [53.4, -8.2], FR: [46.2, 2.2], DE: [51.2, 10.4],
  ES: [40.5, -3.7], PT: [39.4, -8.2], IT: [41.9, 12.6], CH: [46.8, 8.2],
  AT: [47.5, 14.6], BE: [50.5, 4.5], NL: [52.1, 5.3], DK: [56.3, 9.5],
  NO: [60.5, 8.5], SE: [60.1, 18.6], FI: [61.9, 25.7], PL: [51.9, 19.1],
  CZ: [49.8, 15.5], SK: [48.7, 19.7], HU: [47.2, 19.5], RO: [45.9, 25.0],
  BG: [42.7, 25.5], GR: [39.1, 21.8], TR: [38.9, 35.2], UA: [48.4, 31.2],
  RU: [61.5, 105.3], IL: [31.0, 34.8], SA: [23.9, 45.1], AE: [23.4, 53.8],
  QA: [25.4, 51.2], EG: [26.8, 30.8], MA: [31.8, -7.1], ZA: [-30.6, 22.9],
  NG: [9.1, 8.7], KE: [-0.0, 37.9], IN: [20.6, 79.0], PK: [30.4, 69.3],
  BD: [23.7, 90.4], CN: [35.9, 104.2], JP: [36.2, 138.3], KR: [35.9, 127.8],
  TW: [23.7, 121.0], HK: [22.4, 114.1], TH: [15.9, 101.0], VN: [14.1, 108.3],
  MY: [4.2, 101.9], SG: [1.35, 103.8], ID: [-0.8, 113.9], PH: [12.9, 121.8],
  AU: [-25.3, 133.8], NZ: [-40.9, 174.9],
};
