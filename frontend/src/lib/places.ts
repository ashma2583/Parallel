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
  logo?: string | null
  monogram?: string
  badgeColor?: string
  collection: 'featured' | 'extra' | 'nearby'
  center: [number, number]
  zoom: number
  landmarks: { name: string; point: [number, number] }[]
  routes: { id: string; name: string; coordinates: [number, number][] }[]
}

function nearbyCampus(
  id: string,
  name: string,
  monogram: string,
  badgeColor: string,
  center: [number, number],
  landmarks: { name: string; point: [number, number] }[],
  logo: string,
): Campus {
  return {
    id,
    name,
    logo,
    monogram,
    badgeColor,
    collection: 'nearby',
    center,
    zoom: 14.8,
    landmarks,
    routes: [{
      id: `${id}-loop`,
      name: 'Campus loop (illustrative)',
      coordinates: [center, ...landmarks.map((landmark) => landmark.point), center],
    }],
  }
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
    collection: 'featured',
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
    collection: 'featured',
    center: [-75.1932, 39.9522],
    zoom: 15.2,
    landmarks: [
      { name: 'College Green', point: [-75.1932, 39.9526] },
      { name: 'The Quad', point: [-75.1938, 39.9533] },
      { name: 'Penn Museum', point: [-75.1918, 39.9525] },
      { name: 'Franklin Field', point: [-75.1899748, 39.950067] },
      { name: 'Penn Park', point: [-75.1815, 39.9484] },
      { name: 'Huntsman Hall', point: [-75.1947, 39.9526] },
      { name: 'Annenberg Center', point: [-75.1964, 39.9518] },
      { name: 'The Palestra', point: [-75.1897, 39.9513] },
      { name: 'Hill College House', point: [-75.1978, 39.9537] },
      { name: 'Harnwell College House', point: [-75.1984, 39.9516] },
    ],
    routes: [
      { id: 'upenn-loop', name: 'Campus shuttle loop (illustrative)', coordinates: [
        [-75.198, 39.955], [-75.194, 39.954], [-75.190, 39.953], [-75.188, 39.950],
        [-75.192, 39.948], [-75.197, 39.950], [-75.198, 39.955],
      ] },
      { id: 'upenn-east-west', name: 'East-west campus route (illustrative)', coordinates: [
        [-75.199, 39.953], [-75.196, 39.952], [-75.193, 39.951], [-75.190, 39.950],
        [-75.186, 39.949],
      ] },
    ],
  },
  {
    id: 'uchicago',
    name: 'University of Chicago',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/8/8f/Chicago_Maroons_logo.svg',
    collection: 'featured',
    center: [-87.5995, 41.7887],
    zoom: 15.1,
    landmarks: [
      { name: 'Harper Memorial Library', point: [-87.599589, 41.787977] },
      { name: 'Reynolds Club', point: [-87.5977, 41.7884] },
      { name: 'Main Quadrangles', point: [-87.5994, 41.7892] },
      { name: 'Rockefeller Chapel', point: [-87.602, 41.7904] },
      { name: 'Ratner Athletics Center', point: [-87.6005, 41.7932] },
      { name: 'Snell-Hitchcock Hall', point: [-87.6006, 41.7896] },
      { name: 'Max Palevsky Residential Commons', point: [-87.6002, 41.7906] },
      { name: 'South Campus Residence Hall', point: [-87.599, 41.7848] },
      { name: 'Stagg Field', point: [-87.6003, 41.7873] },
      { name: 'David Rubenstein Forum', point: [-87.6002, 41.7933] },
    ],
    routes: [
      { id: 'uchicago-loop', name: 'Campus shuttle loop (illustrative)', coordinates: [
        [-87.603, 41.793], [-87.601, 41.790], [-87.598, 41.789], [-87.596, 41.786],
        [-87.599, 41.785], [-87.603, 41.788], [-87.603, 41.793],
      ] },
      { id: 'uchicago-south', name: 'South campus route (illustrative)', coordinates: [
        [-87.601, 41.793], [-87.600, 41.790], [-87.599, 41.787], [-87.598, 41.784],
        [-87.595, 41.783],
      ] },
    ],
  },
  {
    id: 'uiuc',
    name: 'University of Illinois Urbana-Champaign',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/7/7c/Illinois_Block_I.png',
    collection: 'featured',
    center: [-88.2265, 40.1085],
    zoom: 15.1,
    landmarks: [
      { name: 'Altgeld Hall', point: [-88.2283953, 40.1093345] },
      { name: 'Illini Union', point: [-88.2274493, 40.1104057] },
      { name: 'Grainger Engineering Library', point: [-88.22686, 40.1124737] },
      { name: 'Illinois Street Residence Halls', point: [-88.2212824, 40.1097515] },
      { name: 'Memorial Stadium', point: [-88.2365, 40.0992] },
      { name: 'Siebel Center for Computer Science', point: [-88.2241, 40.1132] },
      { name: 'Beckman Institute', point: [-88.2271, 40.1133] },
      { name: 'Krannert Center for the Performing Arts', point: [-88.2272, 40.1046] },
      { name: 'Busey-Evans Residence Halls', point: [-88.2283, 40.1101] },
      { name: 'State Farm Center', point: [-88.241, 40.0964] },
    ],
    routes: [
      { id: 'uiuc-loop', name: 'Campus shuttle loop (illustrative)', coordinates: [
        [-88.235, 40.114], [-88.228, 40.114], [-88.222, 40.111], [-88.222, 40.106],
        [-88.228, 40.102], [-88.235, 40.105], [-88.235, 40.114],
      ] },
      { id: 'uiuc-south-campus', name: 'South campus route (illustrative)', coordinates: [
        [-88.229, 40.114], [-88.227, 40.109], [-88.230, 40.104], [-88.237, 40.100],
        [-88.241, 40.096],
      ] },
    ],
  },
  {
    id: 'msu',
    name: 'Michigan State University',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/f/fd/Michigan_State_Spartans_alternate_logo.svg',
    collection: 'featured',
    center: [-84.4804, 42.7284],
    zoom: 14.4,
    landmarks: [
      { name: 'Spartan Stadium', point: [-84.4857621, 42.7281648] },
      { name: 'Wharton Center', point: [-84.4706903, 42.7239252] },
      { name: 'MSU Library', point: [-84.4765, 42.727] },
      { name: 'Beaumont Tower', point: [-84.4775, 42.731] },
      { name: 'Breslin Center', point: [-84.4921, 42.7259] },
      { name: 'Mason-Abbot Residence Hall', point: [-84.4813, 42.7314] },
      { name: 'Case Hall', point: [-84.4785, 42.7331] },
      { name: 'Munn Ice Arena', point: [-84.488, 42.7277] },
      { name: 'Wells Hall', point: [-84.4806, 42.725] },
      { name: 'Eli and Edythe Broad Art Museum', point: [-84.4833, 42.7331] },
    ],
    routes: [
      { id: 'msu-loop', name: 'Campus shuttle loop (illustrative)', coordinates: [
        [-84.490, 42.731], [-84.484, 42.733], [-84.477, 42.731], [-84.472, 42.726],
        [-84.479, 42.722], [-84.488, 42.724], [-84.490, 42.731],
      ] },
      { id: 'msu-south-campus', name: 'South campus route (illustrative)', coordinates: [
        [-84.486, 42.734], [-84.480, 42.731], [-84.478, 42.727], [-84.483, 42.723],
        [-84.491, 42.721],
      ] },
    ],
  },
  {
    id: 'purdue',
    name: 'Purdue University',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/5/51/Purdue_University_wordmark.svg',
    collection: 'extra',
    center: [-86.9165, 40.4272],
    zoom: 14.8,
    landmarks: [
      { name: 'Bell Tower', point: [-86.9138, 40.4287] },
      { name: 'Purdue Memorial Union', point: [-86.9091, 40.4238] },
      { name: 'Armstrong Hall', point: [-86.9109, 40.4237] },
      { name: 'Hicks Undergraduate Library', point: [-86.9116, 40.4271] },
      { name: 'Ross-Ade Stadium', point: [-86.9189, 40.4346] },
      { name: 'Wiley Hall', point: [-86.9128, 40.4296] },
      { name: 'Windsor Halls', point: [-86.9143, 40.4248] },
      { name: 'Co-Rec', point: [-86.9162, 40.4207] },
      { name: 'Mackey Arena', point: [-86.9168, 40.4342] },
      { name: 'Neil Armstrong Hall', point: [-86.9114, 40.4292] },
    ],
    routes: [
      { id: 'purdue-loop', name: 'Campus shuttle loop (illustrative)', coordinates: [
        [-86.920, 40.432], [-86.915, 40.434], [-86.910, 40.431], [-86.908, 40.425],
        [-86.913, 40.421], [-86.919, 40.425], [-86.920, 40.432],
      ] },
      { id: 'purdue-south-campus', name: 'South campus route (illustrative)', coordinates: [
        [-86.919, 40.432], [-86.916, 40.428], [-86.913, 40.424], [-86.911, 40.420],
        [-86.906, 40.418],
      ] },
    ],
  },
  {
    id: 'northwestern',
    name: 'Northwestern University',
    logo: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/56/Northwestern_University_seal.svg/250px-Northwestern_University_seal.svg.png',
    monogram: 'NU',
    badgeColor: '#4E2A84',
    collection: 'extra',
    center: [-87.6755, 42.0552],
    zoom: 14.7,
    landmarks: [
      { name: 'Deering Library', point: [-87.6734, 42.0537] },
      { name: 'University Library', point: [-87.6753, 42.0526] },
      { name: 'Norris University Center', point: [-87.6751, 42.0511] },
      { name: 'Ryan Fieldhouse', point: [-87.6735, 42.0585] },
      { name: 'Welsh-Ryan Arena', point: [-87.6712, 42.0575] },
      { name: 'Elder Hall', point: [-87.6771, 42.0527] },
      { name: '1838 Chicago Residence Hall', point: [-87.6758, 42.0545] },
      { name: 'Shepard Residential College', point: [-87.6778, 42.0535] },
      { name: 'Technological Institute', point: [-87.6746, 42.0571] },
      { name: 'Shirley Ryan AbilityLab Sports Field', point: [-87.6717, 42.0601] },
    ],
    routes: [
      { id: 'northwestern-loop', name: 'Campus shuttle loop (illustrative)', coordinates: [
        [-87.679, 42.058], [-87.675, 42.059], [-87.671, 42.057], [-87.671, 42.053],
        [-87.675, 42.050], [-87.679, 42.053], [-87.679, 42.058],
      ] },
      { id: 'northwestern-north-south', name: 'North-south campus route (illustrative)', coordinates: [
        [-87.678, 42.060], [-87.676, 42.056], [-87.675, 42.053], [-87.674, 42.050],
      ] },
    ],
  },
  {
    id: 'mit',
    name: 'Massachusetts Institute of Technology',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/6/61/Massachusetts_Institute_of_Technology_logo.svg',
    collection: 'extra',
    center: [-71.0941, 42.3591],
    zoom: 14.8,
    landmarks: [
      { name: 'Great Dome', point: [-71.0942, 42.3597] },
      { name: 'Killian Court', point: [-71.0892, 42.3583] },
      { name: 'Stata Center', point: [-71.0903, 42.3612] },
      { name: 'Kresge Auditorium', point: [-71.0955, 42.3582] },
      { name: 'Simmons Hall', point: [-71.1007, 42.3589] },
      { name: 'Baker House', point: [-71.0958, 42.3578] },
      { name: 'MacGregor House', point: [-71.0931, 42.3582] },
      { name: 'MIT Media Lab', point: [-71.0887, 42.3608] },
      { name: 'Zesiger Sports and Fitness Center', point: [-71.0961, 42.3593] },
      { name: 'Koch Institute', point: [-71.0886, 42.3621] },
    ],
    routes: [
      { id: 'mit-loop', name: 'Campus shuttle loop (illustrative)', coordinates: [
        [-71.102, 42.362], [-71.096, 42.363], [-71.089, 42.362], [-71.087, 42.358],
        [-71.093, 42.356], [-71.101, 42.357], [-71.102, 42.362],
      ] },
      { id: 'mit-kendall', name: 'Kendall campus route (illustrative)', coordinates: [
        [-71.099, 42.360], [-71.094, 42.360], [-71.090, 42.361], [-71.087, 42.363],
      ] },
    ],
  },
  {
    id: 'berkeley',
    name: 'University of California, Berkeley',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/8/82/University_of_California%2C_Berkeley_logo.svg',
    collection: 'extra',
    center: [-122.2585, 37.8719],
    zoom: 14.8,
    landmarks: [
      { name: 'Sather Tower', point: [-122.2576, 37.8719] },
      { name: 'Doe Memorial Library', point: [-122.2598, 37.8725] },
      { name: 'Memorial Glade', point: [-122.259, 37.873] },
      { name: 'Greek Theatre', point: [-122.2542, 37.8744] },
      { name: 'California Memorial Stadium', point: [-122.2526, 37.8703] },
      { name: 'Unit 1 Residence Halls', point: [-122.2604, 37.8727] },
      { name: 'Unit 2 Residence Halls', point: [-122.261, 37.8741] },
      { name: 'Unit 3 Residence Halls', point: [-122.2574, 37.8737] },
      { name: 'Haas Pavilion', point: [-122.262, 37.8699] },
      { name: 'Hearst Memorial Mining Building', point: [-122.2577, 37.8731] },
    ],
    routes: [
      { id: 'berkeley-loop', name: 'Campus shuttle loop (illustrative)', coordinates: [
        [-122.263, 37.873], [-122.259, 37.875], [-122.254, 37.874], [-122.252, 37.870],
        [-122.257, 37.869], [-122.262, 37.870], [-122.263, 37.873],
      ] },
      { id: 'berkeley-south-campus', name: 'South campus route (illustrative)', coordinates: [
        [-122.260, 37.875], [-122.259, 37.872], [-122.261, 37.869], [-122.263, 37.866],
      ] },
    ],
  },
  nearbyCampus('eastern-michigan', 'Eastern Michigan University', 'EMU', '#006633', [-83.6244, 42.2508], [
    { name: 'McKenny Hall', point: [-83.6253, 42.2495] },
    { name: 'Eastern Eateries', point: [-83.6234, 42.2518] },
    { name: 'Bowen Field House', point: [-83.6206, 42.2503] },
    { name: 'Rynearson Stadium', point: [-83.6246, 42.2650] },
  ], 'https://upload.wikimedia.org/wikipedia/commons/d/d8/Eastern-mich_logo_from_NCAA.svg'),
  nearbyCampus('wayne-state', 'Wayne State University', 'WSU', '#006B3F', [-83.0677, 42.3593], [
    { name: 'Main Library', point: [-83.0722, 42.3568] },
    { name: 'Old Main', point: [-83.0692, 42.3589] },
    { name: 'Student Center', point: [-83.0674, 42.3579] },
    { name: 'Tom Adams Field', point: [-83.0737, 42.3622] },
  ], 'https://upload.wikimedia.org/wikipedia/commons/8/8f/Wayne_State_University_logo.svg'),
  nearbyCampus('oakland', 'Oakland University', 'OU', '#B59A57', [-83.2150, 42.6736], [
    { name: 'Elliott Tower', point: [-83.2153, 42.6748] },
    { name: 'Oakland Center', point: [-83.2166, 42.6738] },
    { name: 'Pawley Hall', point: [-83.2182, 42.6758] },
    { name: 'Grizz Dome', point: [-83.2119, 42.6711] },
  ], 'https://upload.wikimedia.org/wikipedia/commons/6/61/Oakland_Golden_Grizzlies_alternate_logo.svg'),
  nearbyCampus('western-michigan', 'Western Michigan University', 'WMU', '#8B6F4E', [-85.6161, 42.2839], [
    { name: 'Waldo Library', point: [-85.6159, 42.2830] },
    { name: 'Student Center', point: [-85.6146, 42.2845] },
    { name: 'Sangren Hall', point: [-85.6180, 42.2833] },
    { name: 'Waldo Stadium', point: [-85.6272, 42.2840] },
  ], 'https://upload.wikimedia.org/wikipedia/commons/9/9d/Western_Michigan_Athletics_wordmark.svg'),
  nearbyCampus('central-michigan', 'Central Michigan University', 'CMU', '#6A0032', [-84.7758, 43.5875], [
    { name: 'Warriner Hall', point: [-84.7751, 43.5880] },
    { name: 'Park Library', point: [-84.7769, 43.5874] },
    { name: 'Bovee University Center', point: [-84.7782, 43.5860] },
    { name: 'Kelly / Shorts Stadium', point: [-84.7725, 43.5904] },
  ], 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ed/Central_Michigan_University_wordmark.svg/250px-Central_Michigan_University_wordmark.svg.png'),
  nearbyCampus('grand-valley', 'Grand Valley State University', 'GVSU', '#00563F', [-85.8878, 42.9636], [
    { name: 'Mary Idema Pew Library', point: [-85.8886, 42.9635] },
    { name: 'Kirkhof Center', point: [-85.8895, 42.9650] },
    { name: 'Holton-Hooker Living Center', point: [-85.8868, 42.9661] },
    { name: 'Lubbers Stadium', point: [-85.8944, 42.9630] },
  ], 'https://upload.wikimedia.org/wikipedia/commons/d/d2/Grand_Valley_State_Lakers_logo.svg'),
  nearbyCampus('ferris-state', 'Ferris State University', 'FSU', '#C41230', [-85.4817, 43.6856], [
    { name: 'FLITE Library', point: [-85.4811, 43.6860] },
    { name: 'University Center', point: [-85.4825, 43.6838] },
    { name: 'West Campus Community Center', point: [-85.4848, 43.6840] },
    { name: 'Top Taggart Field', point: [-85.4784, 43.6881] },
  ], 'https://upload.wikimedia.org/wikipedia/commons/2/29/Ferris_State_University_logo.svg'),
  nearbyCampus('michigan-tech', 'Michigan Technological University', 'MTU', '#D47A00', [-88.5489, 47.1183], [
    { name: 'Administration Building', point: [-88.5484, 47.1189] },
    { name: 'Van Pelt and Opie Library', point: [-88.5471, 47.1178] },
    { name: 'Rozsa Center', point: [-88.5461, 47.1167] },
    { name: 'John MacInnes Student Ice Arena', point: [-88.5506, 47.1155] },
  ], 'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/10/Seal_of_Michigan_Technological_University.svg/250px-Seal_of_Michigan_Technological_University.svg.png'),
  nearbyCampus('detroit-mercy', 'University of Detroit Mercy', 'UDM', '#006747', [-83.1390, 42.4150], [
    { name: 'Fisher Administration Center', point: [-83.1390, 42.4146] },
    { name: 'Library', point: [-83.1402, 42.4157] },
    { name: 'Student Fitness Center', point: [-83.1377, 42.4166] },
    { name: 'Calihan Hall', point: [-83.1372, 42.4144] },
  ], 'https://upload.wikimedia.org/wikipedia/commons/0/07/University_of_Detroit_Mercy_new_logo.svg'),
  nearbyCampus('um-dearborn', 'University of Michigan-Dearborn', 'UMD', '#00274C', [-83.2311, 42.3195], [
    { name: 'Mardigian Library', point: [-83.2311, 42.3195] },
    { name: 'University Center', point: [-83.2328, 42.3203] },
    { name: 'Institute for Advanced Vehicle Systems', point: [-83.2291, 42.3185] },
    { name: 'Fairlane Center', point: [-83.2355, 42.3168] },
  ], 'https://upload.wikimedia.org/wikipedia/commons/a/a7/UMDearborn_Vertical_Logo.svg'),
  nearbyCampus('lawrence-tech', 'Lawrence Technological University', 'LTU', '#005A9C', [-83.2268, 42.4758], [
    { name: 'Buick Automotive Gallery', point: [-83.2266, 42.4765] },
    { name: 'Taubman Complex', point: [-83.2252, 42.4752] },
    { name: 'University Housing', point: [-83.2282, 42.4747] },
    { name: 'Don Ridler Field House', point: [-83.2242, 42.4740] },
  ], 'https://upload.wikimedia.org/wikipedia/commons/4/41/Logo_of_Lawrence_Technological_University.svg'),
  nearbyCampus('kettering', 'Kettering University', 'KU', '#002F6C', [-83.7100, 43.0126], [
    { name: 'Campus Center', point: [-83.7095, 43.0124] },
    { name: 'Learning Commons', point: [-83.7110, 43.0128] },
    { name: 'Connie and Jim John Recreation Center', point: [-83.7086, 43.0109] },
    { name: 'Atwood Stadium', point: [-83.7143, 43.0144] },
  ], 'https://www.google.com/s2/favicons?domain=kettering.edu&sz=128'),
  nearbyCampus('notre-dame', 'University of Notre Dame', 'ND', '#0C2340', [-86.2389, 41.7032], [
    { name: 'Main Building', point: [-86.2389, 41.7032] },
    { name: 'Hesburgh Library', point: [-86.2359, 41.7034] },
    { name: 'LaFortune Student Center', point: [-86.2379, 41.6997] },
    { name: 'Notre Dame Stadium', point: [-86.2339, 41.6983] },
  ], 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e2/University_of_Notre_Dame_seal_%282%29.svg/250px-University_of_Notre_Dame_seal_%282%29.svg.png'),
  nearbyCampus('indiana', 'Indiana University Bloomington', 'IU', '#990000', [-86.5264, 39.1709], [
    { name: 'Sample Gates', point: [-86.5162, 39.1661] },
    { name: 'Wells Library', point: [-86.5262, 39.1725] },
    { name: 'Indiana Memorial Union', point: [-86.5238, 39.1663] },
    { name: 'Assembly Hall', point: [-86.5268, 39.1804] },
  ], 'https://www.google.com/s2/favicons?domain=iu.edu&sz=128'),
  nearbyCampus('ohio-state', 'The Ohio State University', 'OSU', '#BB0000', [-83.0147, 40.0067], [
    { name: 'Thompson Library', point: [-83.0141, 40.0036] },
    { name: 'Ohio Union', point: [-83.0080, 40.0025] },
    { name: 'Wexner Center for the Arts', point: [-83.0117, 40.0067] },
    { name: 'Ohio Stadium', point: [-83.0198, 40.0017] },
  ], 'https://commons.wikimedia.org/wiki/Special:FilePath/Ohio_State_Buckeyes_logo.svg'),
  nearbyCampus('toledo', 'The University of Toledo', 'UT', '#005A9C', [-83.6130, 41.6580], [
    { name: 'University Hall', point: [-83.6144, 41.6579] },
    { name: 'Carlson Library', point: [-83.6123, 41.6585] },
    { name: 'Student Union', point: [-83.6113, 41.6573] },
    { name: 'Savage Arena', point: [-83.6187, 41.6571] },
  ], 'https://upload.wikimedia.org/wikipedia/commons/b/b8/UT_Hortz.svg'),
  nearbyCampus('bowling-green', 'Bowling Green State University', 'BGSU', '#FE5000', [-83.6374, 41.3780], [
    { name: 'Bowen-Thompson Student Union', point: [-83.6379, 41.3788] },
    { name: 'Jerome Library', point: [-83.6389, 41.3799] },
    { name: 'Olscamp Hall', point: [-83.6394, 41.3777] },
    { name: 'Doyt Perry Stadium', point: [-83.6304, 41.3768] },
  ], 'https://www.google.com/s2/favicons?domain=bgsu.edu&sz=128'),
  nearbyCampus('case-western', 'Case Western Reserve University', 'CWRU', '#0A304E', [-81.6083, 41.5043], [
    { name: 'Kelvin Smith Library', point: [-81.6083, 41.5037] },
    { name: 'Thwing Center', point: [-81.6067, 41.5027] },
    { name: 'Tinkham Veale University Center', point: [-81.6087, 41.5016] },
    { name: 'Case Quad', point: [-81.6044, 41.5052] },
  ], 'https://www.google.com/s2/favicons?domain=case.edu&sz=128'),
  nearbyCampus('cincinnati', 'University of Cincinnati', 'UC', '#E00122', [-84.5150, 39.1329], [
    { name: 'Langsam Library', point: [-84.5148, 39.1318] },
    { name: 'TUC Student Center', point: [-84.5158, 39.1304] },
    { name: 'DAAP', point: [-84.5175, 39.1350] },
    { name: 'Nippert Stadium', point: [-84.5163, 39.1310] },
  ], 'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/63/University_of_Cincinnati_seal.svg/250px-University_of_Cincinnati_seal.svg.png'),
  nearbyCampus('miami-ohio', 'Miami University', 'MU', '#C41230', [-84.7340, 39.5070], [
    { name: 'King Library', point: [-84.7334, 39.5080] },
    { name: 'Armstrong Student Center', point: [-84.7357, 39.5076] },
    { name: 'Upham Hall', point: [-84.7319, 39.5062] },
    { name: 'Yager Stadium', point: [-84.7444, 39.5085] },
  ], 'https://commons.wikimedia.org/wiki/Special:FilePath/Miami_University_logo.svg'),
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
