/** Real Ann Arbor coordinates for the geographic view. Keyed by node id. */

export const ZONES = ['Central', 'Medical', 'North', 'Downtown'] as const

export interface Place {
  lng: number
  lat: number
  zone: string
  /** Label that fits under a node on the schematic. */
  short: string
}

export interface Campus {
  id: string
  name: string
  logo: string
  center: [number, number]
  zoom: number
  landmarks: { name: string; point: [number, number] }[]
  routes: { id: string; name: string; coordinates: [number, number][] }[]
}

export const PLACES: Record<string, Place> = {
  cpp: { lng: -83.7364, lat: 42.282, zone: 'Central', short: "Central Power Plant" },
  uh: { lng: -83.7286, lat: 42.2836, zone: 'Medical', short: "University Hospital" },
  north_switch: { lng: -83.7048, lat: 42.2976, zone: 'North', short: "North Switching Stn" },

  angell: { lng: -83.7394, lat: 42.2769, zone: 'Central', short: "Angell Hall" },
  shapiro: { lng: -83.737, lat: 42.2755, zone: 'Central', short: "Shapiro Library" },
  union: { lng: -83.7416, lat: 42.2752, zone: 'Central', short: "Michigan Union" },
  ross: { lng: -83.7383, lat: 42.2709, zone: 'Central', short: "Ross School" },
  markley: { lng: -83.7298, lat: 42.2807, zone: 'Central', short: "Markley Hall" },
  south_quad: { lng: -83.7368, lat: 42.2736, zone: 'Central', short: "South Quad" },

  mott: { lng: -83.7262, lat: 42.2827, zone: 'Medical', short: "Mott Children's" },
  kahn: { lng: -83.7236, lat: 42.2839, zone: 'Medical', short: "Kahn Pavilion" },

  beyster: { lng: -83.7161, lat: 42.2927, zone: 'North', short: "Beyster" },
  duderstadt: { lng: -83.7156, lat: 42.2911, zone: 'North', short: "Duderstadt" },
  pierpont: { lng: -83.7178, lat: 42.2914, zone: 'North', short: "Pierpont Commons" },
  bursley: { lng: -83.7202, lat: 42.2948, zone: 'North', short: "Bursley Hall" },
  gg_brown: { lng: -83.7138, lat: 42.2933, zone: 'North', short: "G.G. Brown" },
  ncrc: { lng: -83.6925, lat: 42.3052, zone: 'North', short: "NCRC" },

  city_hall: { lng: -83.7486, lat: 42.2813, zone: 'Downtown', short: "City Hall" },
  blake: { lng: -83.7483, lat: 42.2786, zone: 'Downtown', short: "Blake Transit" },
  fire_1: { lng: -83.7484, lat: 42.2817, zone: 'Downtown', short: "Fire Station 1" },
}

export const CAMPUSES: Campus[] = [
  {
    id: 'umich',
    name: 'University of Michigan',
    logo: 'https://brand.umich.edu/assets/brand/style-guide/logo-guidelines/Block_M-Hex.png',
    center: [-83.7425, 42.2724],
    zoom: 14.4,
    landmarks: [
      { name: 'West Quadrangle', point: [-83.7425634, 42.2749075] },
      { name: 'East Quadrangle', point: [-83.7351593, 42.2729288] },
      { name: 'Alice Lloyd Hall', point: [-83.7317587, 42.2812501] },
      { name: 'Couzens Hall', point: [-83.7326617, 42.2819308] },
      { name: 'Michigan Stadium', point: [-83.7478267, 42.2658285] },
    ],
    routes: [],
  },
  {
    id: 'upenn',
    name: 'University of Pennsylvania',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7c/Shield_of_the_University_of_Pennsylvania.svg/120px-Shield_of_the_University_of_Pennsylvania.svg.png',
    center: [-75.1932, 39.9522],
    zoom: 15.2,
    landmarks: [
      { name: 'College Green', point: [-75.1932, 39.9526] },
      { name: 'The Quad', point: [-75.1938, 39.9533] },
      { name: 'Penn Museum', point: [-75.1918, 39.9525] },
      { name: 'Franklin Field', point: [-75.1899748, 39.950067] },
      { name: 'Penn Park', point: [-75.1815, 39.9484] },
    ],
    routes: [
      { id: 'upenn-loop', name: 'Campus shuttle loop (illustrative)', coordinates: [
        [-75.198, 39.955], [-75.194, 39.954], [-75.190, 39.953], [-75.188, 39.950],
        [-75.192, 39.948], [-75.197, 39.950], [-75.198, 39.955],
      ] },
    ],
  },
  {
    id: 'uchicago',
    name: 'University of Chicago',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/8/8f/Chicago_Maroons_logo.svg',
    center: [-87.5995, 41.7887],
    zoom: 15.1,
    landmarks: [
      { name: 'Harper Memorial Library', point: [-87.599589, 41.787977] },
      { name: 'Reynolds Club', point: [-87.5977, 41.7884] },
      { name: 'Main Quadrangles', point: [-87.5994, 41.7892] },
      { name: 'Rockefeller Chapel', point: [-87.602, 41.7904] },
      { name: 'Ratner Athletics Center', point: [-87.6005, 41.7932] },
    ],
    routes: [
      { id: 'uchicago-loop', name: 'Campus shuttle loop (illustrative)', coordinates: [
        [-87.603, 41.793], [-87.601, 41.790], [-87.598, 41.789], [-87.596, 41.786],
        [-87.599, 41.785], [-87.603, 41.788], [-87.603, 41.793],
      ] },
    ],
  },
  {
    id: 'uiuc',
    name: 'University of Illinois Urbana-Champaign',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/7/7c/Illinois_Block_I.png',
    center: [-88.2265, 40.1085],
    zoom: 15.1,
    landmarks: [
      { name: 'Altgeld Hall', point: [-88.2283953, 40.1093345] },
      { name: 'Illini Union', point: [-88.2274493, 40.1104057] },
      { name: 'Grainger Engineering Library', point: [-88.22686, 40.1124737] },
      { name: 'Illinois Street Residence Halls', point: [-88.2212824, 40.1097515] },
      { name: 'Memorial Stadium', point: [-88.2365, 40.0992] },
    ],
    routes: [
      { id: 'uiuc-loop', name: 'Campus shuttle loop (illustrative)', coordinates: [
        [-88.235, 40.114], [-88.228, 40.114], [-88.222, 40.111], [-88.222, 40.106],
        [-88.228, 40.102], [-88.235, 40.105], [-88.235, 40.114],
      ] },
    ],
  },
  {
    id: 'msu',
    name: 'Michigan State University',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/f/fd/Michigan_State_Spartans_alternate_logo.svg',
    center: [-84.4804, 42.7024],
    zoom: 14.4,
    landmarks: [
      { name: 'Spartan Stadium', point: [-84.4857621, 42.7281648] },
      { name: 'Wharton Center', point: [-84.4706903, 42.7239252] },
      { name: 'MSU Library', point: [-84.4765, 42.727] },
      { name: 'Beaumont Tower', point: [-84.4775, 42.731] },
      { name: 'Breslin Center', point: [-84.4921, 42.7259] },
    ],
    routes: [
      { id: 'msu-loop', name: 'Campus shuttle loop (illustrative)', coordinates: [
        [-84.490, 42.731], [-84.484, 42.733], [-84.477, 42.731], [-84.472, 42.726],
        [-84.479, 42.722], [-84.488, 42.724], [-84.490, 42.731],
      ] },
    ],
  },
] as const

/** Vector basemap with streets, parks, and building heights. */
export const VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

export const MAP_STYLE = {
  version: 8 as const,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    osm: {
      type: 'raster' as const,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap',
    },
  },
  layers: [{ id: 'osm', type: 'raster' as const, source: 'osm' }],
}
