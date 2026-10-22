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

/* BEYOND BRAZIL.
 *
 * The region list has always been generic — the query groups by
 * geo.region.iso_code for whatever country was opened — but only Brazil had
 * coordinates, so every other country listed its states and placed none of
 * them. The map said "nothing here" about places the table was counting.
 *
 * These are approximate geographic centroids, to about a tenth of a degree.
 * That is the right precision for a bubble that marks a region: the events
 * themselves carry no coordinate at all (measured — geo.city.latitude is null
 * on every row), so a pin is a label for an area, never a position.
 *
 * A region with no entry here is still counted and still listed; its row says
 * so rather than pretending the place does not exist.
 */
export const REGION_CENTROID_MORE: Record<string, [number, number]> = {
  // United States
  "US-AL": [32.8, -86.8],  "US-AK": [64.0, -152.0], "US-AZ": [34.3, -111.7],
  "US-AR": [34.9, -92.4],  "US-CA": [37.2, -119.5], "US-CO": [39.0, -105.5],
  "US-CT": [41.6, -72.7],  "US-DE": [39.0, -75.5],  "US-DC": [38.9, -77.0],
  "US-FL": [28.6, -82.4],  "US-GA": [32.6, -83.4],  "US-HI": [20.3, -156.4],
  "US-ID": [44.4, -114.6], "US-IL": [40.0, -89.2],  "US-IN": [39.9, -86.3],
  "US-IA": [42.0, -93.5],  "US-KS": [38.5, -98.4],  "US-KY": [37.5, -85.3],
  "US-LA": [31.1, -92.0],  "US-ME": [45.4, -69.2],  "US-MD": [39.0, -76.8],
  "US-MA": [42.3, -71.8],  "US-MI": [44.3, -85.4],  "US-MN": [46.3, -94.3],
  "US-MS": [32.7, -89.7],  "US-MO": [38.4, -92.5],  "US-MT": [47.0, -109.6],
  "US-NE": [41.5, -99.8],  "US-NV": [39.3, -116.6], "US-NH": [43.7, -71.6],
  "US-NJ": [40.2, -74.7],  "US-NM": [34.4, -106.1], "US-NY": [42.9, -75.5],
  "US-NC": [35.5, -79.4],  "US-ND": [47.4, -100.5], "US-OH": [40.3, -82.8],
  "US-OK": [35.6, -97.5],  "US-OR": [43.9, -120.6], "US-PA": [40.9, -77.8],
  "US-RI": [41.7, -71.6],  "US-SC": [33.9, -80.9],  "US-SD": [44.4, -100.2],
  "US-TN": [35.9, -86.4],  "US-TX": [31.5, -99.3],  "US-UT": [39.3, -111.7],
  "US-VT": [44.1, -72.7],  "US-VA": [37.5, -78.9],  "US-WA": [47.4, -120.4],
  "US-WV": [38.6, -80.6],  "US-WI": [44.6, -89.7],  "US-WY": [43.0, -107.6],
  // Canada
  "CA-AB": [54.5, -114.0], "CA-BC": [54.0, -124.5], "CA-MB": [55.0, -97.0],
  "CA-NB": [46.5, -66.0],  "CA-NL": [53.5, -60.0],  "CA-NS": [45.0, -63.0],
  "CA-NT": [64.0, -119.0], "CA-NU": [70.0, -90.0],  "CA-ON": [50.0, -85.0],
  "CA-PE": [46.4, -63.2],  "CA-QC": [53.0, -70.0],  "CA-SK": [54.0, -106.0],
  "CA-YT": [63.0, -135.0],
  // Mexico
  "MX-AGU": [22.0, -102.3], "MX-BCN": [30.0, -115.5], "MX-BCS": [25.5, -111.5],
  "MX-CAM": [19.0, -90.5],  "MX-CHP": [16.5, -92.5],  "MX-CHH": [28.5, -106.0],
  "MX-CMX": [19.4, -99.1],  "MX-COA": [27.3, -102.0], "MX-COL": [19.2, -103.7],
  "MX-DUR": [24.8, -104.7], "MX-GUA": [21.0, -101.1], "MX-GRO": [17.6, -99.9],
  "MX-HID": [20.5, -98.8],  "MX-JAL": [20.6, -103.6], "MX-MEX": [19.4, -99.6],
  "MX-MIC": [19.2, -101.9], "MX-MOR": [18.7, -99.1],  "MX-NAY": [21.7, -104.9],
  "MX-NLE": [25.6, -99.9],  "MX-OAX": [17.0, -96.7],  "MX-PUE": [19.0, -97.9],
  "MX-QUE": [20.7, -100.0], "MX-ROO": [19.6, -88.0],  "MX-SLP": [22.6, -100.4],
  "MX-SIN": [25.0, -107.5], "MX-SON": [29.3, -110.3], "MX-TAB": [18.0, -92.9],
  "MX-TAM": [24.3, -98.6],  "MX-TLA": [19.4, -98.2],  "MX-VER": [19.2, -96.3],
  "MX-YUC": [20.7, -89.0],  "MX-ZAC": [23.2, -102.7],
  // Germany
  "DE-BW": [48.6, 9.0],   "DE-BY": [48.9, 11.4],  "DE-BE": [52.5, 13.4],
  "DE-BB": [52.4, 13.0],  "DE-HB": [53.1, 8.8],   "DE-HH": [53.6, 10.0],
  "DE-HE": [50.6, 9.0],   "DE-MV": [53.6, 12.5],  "DE-NI": [52.8, 9.1],
  "DE-NW": [51.5, 7.5],   "DE-RP": [49.9, 7.5],   "DE-SL": [49.4, 7.0],
  "DE-SN": [51.1, 13.2],  "DE-ST": [51.9, 11.7],  "DE-SH": [54.2, 9.7],
  "DE-TH": [50.9, 11.0],
  // Spain
  "ES-AN": [37.5, -4.8],  "ES-AR": [41.6, -0.9],  "ES-AS": [43.3, -6.0],
  "ES-CB": [43.2, -4.0],  "ES-CE": [35.9, -5.3],  "ES-CL": [41.7, -4.8],
  "ES-CM": [39.5, -3.0],  "ES-CN": [28.3, -16.5], "ES-CT": [41.8, 1.5],
  "ES-EX": [39.2, -6.1],  "ES-GA": [42.7, -8.0],  "ES-IB": [39.6, 2.9],
  "ES-MC": [38.0, -1.5],  "ES-MD": [40.4, -3.7],  "ES-ML": [35.3, -2.9],
  "ES-NC": [42.7, -1.6],  "ES-PV": [43.0, -2.6],  "ES-RI": [42.3, -2.5],
  "ES-VC": [39.5, -0.6],
  // Portugal (districts and autonomous regions)
  "PT-01": [40.6, -8.5],  "PT-02": [38.0, -7.9],  "PT-03": [41.5, -8.4],
  "PT-04": [41.8, -6.8],  "PT-05": [39.8, -7.5],  "PT-06": [40.2, -8.4],
  "PT-07": [38.6, -7.9],  "PT-08": [37.2, -8.0],  "PT-09": [40.5, -7.3],
  "PT-10": [39.7, -8.8],  "PT-11": [38.8, -9.2],  "PT-12": [39.3, -7.4],
  "PT-13": [41.2, -8.4],  "PT-14": [39.3, -8.5],  "PT-15": [38.4, -8.6],
  "PT-16": [41.8, -8.6],  "PT-17": [41.4, -7.6],  "PT-18": [40.7, -7.9],
  "PT-20": [37.8, -25.5], "PT-30": [32.7, -16.9],
  // United Kingdom
  "GB-ENG": [52.5, -1.5], "GB-SCT": [56.5, -4.2],
  "GB-WLS": [52.3, -3.7], "GB-NIR": [54.6, -6.7],
  // Chile
  "CL-AP": [-18.6, -69.6], "CL-TA": [-20.2, -69.3], "CL-AN": [-23.6, -69.0],
  "CL-AT": [-27.5, -70.3], "CL-CO": [-30.5, -71.0], "CL-VS": [-32.9, -71.0],
  "CL-RM": [-33.5, -70.7], "CL-LI": [-34.6, -71.0], "CL-ML": [-35.5, -71.5],
  "CL-NB": [-36.7, -72.3], "CL-BI": [-37.3, -72.5], "CL-AR": [-38.8, -72.6],
  "CL-LR": [-40.2, -72.8], "CL-LL": [-41.5, -73.0], "CL-AI": [-46.0, -72.5],
  "CL-MA": [-52.0, -71.0],
  // Colombia (the departments with traffic worth a pin)
  "CO-DC": [4.6, -74.1],   "CO-ANT": [6.7, -75.5],  "CO-VAC": [3.8, -76.5],
  "CO-ATL": [10.7, -74.9], "CO-SAN": [6.9, -73.1],  "CO-CUN": [4.8, -74.2],
  "CO-BOL": [8.7, -74.3],  "CO-RIS": [5.1, -75.9],  "CO-CAL": [5.3, -75.4],
  "CO-NSA": [8.0, -72.9],  "CO-TOL": [4.0, -75.2],  "CO-HUI": [2.5, -75.6],
  "CO-MET": [3.5, -73.0],  "CO-COR": [8.4, -75.8],  "CO-MAG": [10.2, -74.3],
  "CO-NAR": [1.5, -77.5],  "CO-CAU": [2.5, -76.8],  "CO-BOY": [5.6, -73.1],
  // Argentina, Uruguay, Peru, Paraguay — the neighbours that show up
  "AR-C": [-34.6, -58.4],  "AR-B": [-36.7, -60.0],  "AR-S": [-31.0, -61.0],
  "AR-X": [-32.1, -64.0],  "AR-M": [-34.6, -68.5],  "AR-T": [-26.9, -65.3],
  "UY-MO": [-34.8, -56.2], "PE-LIM": [-12.0, -77.0], "PE-ARE": [-16.4, -71.5],
  "PY-ASU": [-25.3, -57.6], "PY-11": [-25.3, -57.4], "PY-10": [-25.5, -55.1],
  // Belgium, Switzerland, the Emirates
  "BE-BRU": [50.8, 4.4],  "BE-VLG": [51.0, 4.5],  "BE-WAL": [50.3, 4.9],
  "CH-ZH": [47.4, 8.6],   "CH-BE": [46.8, 7.6],   "CH-GE": [46.2, 6.1],
  "CH-VD": [46.6, 6.5],   "CH-TI": [46.3, 8.8],   "CH-BS": [47.6, 7.6],
  "AE-AZ": [23.8, 54.0],  "AE-DU": [25.1, 55.3],  "AE-SH": [25.3, 55.5],
};
