/** Real Ann Arbor coordinates for the geographic view. Keyed by node id. */

export interface Place {
  lng: number
  lat: number
  zone: string
}

export const PLACES: Record<string, Place> = {
  cpp: { lng: -83.7364, lat: 42.282, zone: 'Central' },
  uh: { lng: -83.7286, lat: 42.2836, zone: 'Medical' },
  north_switch: { lng: -83.7048, lat: 42.2976, zone: 'North' },

  angell: { lng: -83.7394, lat: 42.2769, zone: 'Central' },
  shapiro: { lng: -83.737, lat: 42.2755, zone: 'Central' },
  union: { lng: -83.7416, lat: 42.2752, zone: 'Central' },
  ross: { lng: -83.7383, lat: 42.2709, zone: 'Central' },
  markley: { lng: -83.7298, lat: 42.2807, zone: 'Central' },
  south_quad: { lng: -83.7368, lat: 42.2736, zone: 'Central' },

  mott: { lng: -83.7262, lat: 42.2827, zone: 'Medical' },
  kahn: { lng: -83.7236, lat: 42.2839, zone: 'Medical' },

  beyster: { lng: -83.7161, lat: 42.2927, zone: 'North' },
  duderstadt: { lng: -83.7156, lat: 42.2911, zone: 'North' },
  pierpont: { lng: -83.7178, lat: 42.2914, zone: 'North' },
  bursley: { lng: -83.7202, lat: 42.2948, zone: 'North' },
  gg_brown: { lng: -83.7138, lat: 42.2933, zone: 'North' },
  ncrc: { lng: -83.6925, lat: 42.3052, zone: 'North' },

  city_hall: { lng: -83.7486, lat: 42.2813, zone: 'Downtown' },
  blake: { lng: -83.7483, lat: 42.2786, zone: 'Downtown' },
  fire_1: { lng: -83.7484, lat: 42.2817, zone: 'Downtown' },
}

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
