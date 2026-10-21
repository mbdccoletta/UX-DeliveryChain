// ISO-3166 alpha-2 → [lat, lng] country centroids.
//
// Measured on a live estate: RUM events carry NO city coordinates
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

/**
 * STATE CENTROIDS — so a state can be a mark on the map, not only a row.
 *
 * Strato's ChoroplethLayer takes an ISO 3166-2 code but ships one geometry
 * file, WORLD-COUNTRIES.json: measured with the layer mounted, the map
 * requested no sub-national shapes and painted nothing. A code with no polygon
 * behind it draws nothing.
 *
 * But this tile never needed polygons. It already positions its country
 * bubbles from CENTROID above, over the platform's map — so a state needs one
 * coordinate, not a border. That keeps the whole thing inside the mechanism
 * the tile already uses, instead of pulling a megabyte of world boundaries in
 * to shade a country at a time.
 *
 * Keyed by full ISO 3166-2, because the platform returns the suffix alone and
 * "CA" is both California and Canada. Brazil first, because that is where the
 * traffic being read is; codes missing here simply do not plot, exactly like
 * countries missing from CENTROID.
 */
export const REGION_CENTROID: Record<string, [number, number]> = {
  "BR-AC": [-9.0, -70.5],   "BR-AL": [-9.6, -36.8],   "BR-AP": [1.4, -51.8],
  "BR-AM": [-4.2, -63.0],   "BR-BA": [-12.6, -41.7],  "BR-CE": [-5.2, -39.6],
  "BR-DF": [-15.8, -47.9],  "BR-ES": [-19.6, -40.6],  "BR-GO": [-15.9, -49.6],
  "BR-MA": [-5.1, -45.3],   "BR-MT": [-13.0, -55.9],  "BR-MS": [-20.5, -54.5],
  "BR-MG": [-18.5, -44.5],  "BR-PA": [-4.0, -53.0],   "BR-PB": [-7.2, -36.7],
  "BR-PR": [-24.6, -51.6],  "BR-PE": [-8.4, -37.9],   "BR-PI": [-7.4, -42.9],
  "BR-RJ": [-22.2, -42.7],  "BR-RN": [-5.8, -36.6],   "BR-RS": [-30.0, -53.2],
  "BR-RO": [-10.9, -63.0],  "BR-RR": [2.1, -61.4],    "BR-SC": [-27.3, -50.5],
  "BR-SP": [-22.2, -48.7],  "BR-SE": [-10.6, -37.4],  "BR-TO": [-10.2, -48.3],
};
