# Seascape map (test pages)

Two test pages draw the seafloor around a point in 3D, from the best depth data available there.
They are a local experiment modelled on the "Site Seascape" view in
[Submersion](https://github.com/submersion-app/submersion). They are not linked from the app.

| Page               | What it does                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/seascape-map`    | A map. **Double-click the sea** to open a dialog with that spot's seafloor in 3D. `?at=lat,lon,zoom` opens the map somewhere else, e.g. `?at=25.13,-80.40,11` for the Florida Keys. |
| `/seascape-sample` | One fixed view: Beomseom, off Seogwipo, Jeju (33.217549° N, 126.514413° E).                                                                                                         |

In the dialog you can choose how wide an area to show: **2 km or 1 km**. **2 km is the limit
everywhere** (`SEAFLOOR_SPANS` in `src/lib/seafloor.ts`): it is plenty for a dive site, and it keeps
every source's request small, one page of KHOA's API among them. The view draws at most 160 points
per side. Under the view, a list shows which sources were tried and why each was or wasn't used,
followed by the credit the chosen source requires.

## The 2D map: switchable tile suppliers

The explorer's 2D map can come from five suppliers. The operator picks which are offered and which
comes first; a viewer then switches between them with the buttons at the top right, and their last
pick is remembered in that browser.

| Id                 | Button           | Needs                                        | Billing                                                     |
| ------------------ | ---------------- | -------------------------------------------- | ----------------------------------------------------------- |
| `openfreemap`      | OpenStreetMap    | nothing (the app's own basemap)              | free, no stated limit, no guarantee                         |
| `google-satellite` | Google satellite | `GOOGLE_MAPS_API_KEY`                        | Map Tiles API, per tile (below)                             |
| `google-roadmap`   | Google           | `GOOGLE_MAPS_API_KEY`                        | Map Tiles API, per tile (below)                             |
| `mapbox-satellite` | Mapbox satellite | `MAPBOX_ACCESS_TOKEN` (a public `pk.` token) | Mapbox Static Tiles, per tile (check Mapbox's pricing page) |
| `mapbox-streets`   | Mapbox           | `MAPBOX_ACCESS_TOKEN`                        | Mapbox Static Tiles, per tile                               |

**Choosing them:** `SEASCAPE_MAP_SUPPLIERS` is a comma-separated list of ids, in order, **the first
being the default**, e.g.

```
SEASCAPE_MAP_SUPPLIERS=openfreemap,google-satellite,mapbox-satellite
```

Unknown ids are ignored. Unset, every supplier is offered with OpenStreetMap first, the one with no
quota to run out. A supplier whose key is missing, or whose service won't answer, is left out rather
than shown broken; if nothing is left, OpenStreetMap is used. The list comes from
`/seascape-map/tile-suppliers`, and the map waits for it rather than drawing one supplier's tiles
and then another's.

**Keys end up in the browser.** Google's key and Mapbox's token are inside every tile URL. Restrict
both: Google's to the site's HTTP referrers and the Map Tiles API only; Mapbox's to the site's URLs
(create a URL-restricted token for production; the default public token works from anywhere).

**Credits and marks**, as each supplier's terms ask: Google's mark ("Google Maps") bottom left and
its copyright line, fetched from its viewport endpoint whenever the map stops moving, bottom right;
Mapbox's mark ("mapbox") and "© Mapbox © OpenStreetMap Improve this map" (plus "© Maxar" on
satellite); OpenStreetMap's own credit otherwise. Text stands in for the official logos on this test
page; production should use the logo assets.

**CSP:** `connect-src` gains `https://tile.googleapis.com` and `https://api.mapbox.com`, each only
when its key is set.

**Display only.** Google's and Mapbox's terms allow their tiles for showing on the map, not for
deriving data. **The 3D view's coastline stays OpenStreetMap's**, whichever supplier the 2D map
uses.

**Google specifics:** a Map Tiles session is created on the server and kept for a week of its
two-week life; tiles are 512 px (`highDpi`) for sharp high-density screens, each still one billable
tile.

**Tiles per spot, measured** on a 1086 × 655 px map on a high-density screen:

| Action                                  | Google tiles     |
| --------------------------------------- | ---------------- |
| Open the map at a spot (zoom 15)        | about 25         |
| Double-click and open the 3D view       | 0                |
| Zoom in one level                       | about 25–37 more |
| Switch between Google map and satellite | about 20 more    |

A typical look at one dive site (open, zoom a couple of times) is **about 60–100 tiles**.

**Limits:** 100,000 free tiles a month (about 1,000–1,600 such visits), then **$0.60 per 1,000**.
Separately, the **default quota is 15,000 tiles a day** (about 150–250 visits); past it the map
stops loading until the next day, unless Google raises the quota on request. The OpenStreetMap layer
has no such limit.

## How it works

```
browser (map, double-click)
  └─ GET /seascape-map/seafloor?lat=&lon=&span=      ← Next.js route handler
       └─ resolveSeafloor()                           ← server, cached for days
            ├─ ask each source whether it covers the spot, and how finely
            ├─ try them finest-first (see "Choosing a source")
            └─ return the first good grid, plus what every source answered
  └─ three.js draws the grid in the dialog
```

**The browser never contacts a data source itself.** The app's security policy (CSP, `connect-src`)
only allows the browser to connect to the app's own server, the API and the basemap. Two of the
sources also send no CORS headers, so a browser couldn't read them anyway. And KHOA's key must never
reach a browser.

**Caching.** A result is cached for days per point (rounded to about 10 m) and area size. A failure
is cached for only seconds, so the next try asks again.

**The route** returns `{ status: "ok", source, grid, attempts }`, `{ status: "dry", attempts }`
(every source says land), or `{ status: "failed", attempts }` with HTTP 502. Bad parameters get
a 400.

## Data sources

Four are keyless. **KHOA needs a data.go.kr service key**, read from `KHOA_API_KEY` on the server.

| Source                                   | Covers                                    | Detail                            | How it's fetched                                                                         | Licence                        |
| ---------------------------------------- | ----------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------ |
| **NOAA coastal elevation models** (NCEI) | US coasts and some islands (11 boxes)     | down to about 3 m                 | ArcGIS image service: `identify` to check coverage, then `exportImage` as a float32 TIFF | US public domain               |
| **EMODnet Bathymetry** (DTM 2024)        | European seas, plus one Caribbean area    | about 115 m                       | ERDDAP, JSON                                                                             | CC BY 4.0, credit required     |
| **KHOA** water depth (BADA 2024)         | Korean waters, 30.3–38.5° N, 122.8–133° E | soundings about 144 m apart       | data.go.kr REST API, JSON, 300 points per page; gridded on the server                    | data.go.kr terms; credit shown |
| **GMRT**                                 | everywhere                                | about 60 m (finer where surveyed) | GridServer, ESRI ASCII grid, `resolution=max`                                            | CC BY 4.0, credit required     |
| **ETOPO 2022**                           | everywhere                                | about 450 m                       | ERDDAP, JSON (two servers, one used as a fallback)                                       | US public domain               |

Four of them publish elevation (negative under water), flipped once, when reading, into **depth,
positive down**; land stays as a negative depth. KHOA already publishes depth, positive down, from
mean sea level.

A few details that matter:

- **NOAA:** its image service also holds a coarse global background layer. A spot only counts as
  covered when a model finer than **50 m** covers it, and the service is asked for at most 25
  catalogue items. The default of 3 hides the detailed model.
- **EMODnet:** depths are measured from lowest astronomical tide, not mean sea level. That's fine
  when EMODnet is used on its own, as it is here; just never mix its cells with another source's.
- **KHOA:** see the next section.
- **ETOPO:** the area asked for is always at least **10 km** wide and then trimmed back. With the 2
  km limit that leaves 4 or 5 of its 450 m cells a side, under the minimum of 6, so **ETOPO is now
  always "too coarse"**. It stays in the list as the last resort should the limit ever rise.

## KHOA (Korea)

The Korea Hydrographic and Oceanographic Agency's water depth set "for natural science", built for
ocean models, served through the Public Data Portal: `GetWaterDepthApiService` at
`https://apis.data.go.kr/1192136/waterDepth/`. **It is the same data as the BADA 2024 file**
(`BADA2024_korea_depth_v1.1.nc`): in a 4 km test box around Beomseom, all 677 points matched it in
position and depth, to the centimetre.

**The key.** Set `KHOA_API_KEY` in `.env.local` for local development (git ignores it) and in the
Vercel project's environment variables. **Never prefix it with `NEXT_PUBLIC_`**, which would ship it
to every browser. data.go.kr issues an encoded and a decoded form; either works, and an encoded key
is used as it is so it isn't encoded twice. Without a key, the dialog lists KHOA as "not set up" and
GMRT takes over.

**How the API behaves:**

|         |                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Box     | `ymin`/`ymax`/`xmin`/`xmax`, at most **1°** a side and at most **5 decimals**: 6 is refused with `10 INVALID_REQUEST_PARAMETER_ERROR` |
| Paging  | `numOfRows` up to **300** per page; `totalCount` says how many points there are                                                       |
| No data | Outside Korean waters or on land: `03 NODATA_ERROR`, read as "doesn't cover this spot"                                                |
| Errors  | Key and quota problems can come back as XML even when JSON was asked for; the message is shown in the dialog                          |
| Spacing | about 144 m (144–155 m measured), the same everywhere                                                                                 |

**The quota is 10,000 requests a day.** A 2 km view is about 200 points, **one request**; a 1 km
view is one request too. A spot inside Korea's box but on land also costs one request (the `03`
answer). Results are cached for days, so a second look at the same spot costs nothing. A view is
capped at 10 pages so nothing can drain the quota by mistake.

**From points to a grid.** The API returns loose soundings, not a grid. The server lays them on a
regular grid every **16 m** by inverse-distance weighting of the soundings within **216 m** (one and
a half spacings). The grid is far finer than the soundings so the coastline below has cells to draw
with: a 2 km view is 126 cells a side.

**The coastline comes from OpenStreetMap.** KHOA has soundings and nothing on land, so where land is
comes from the bundled basemap's own vector tiles: OpenFreeMap's `planet` tiles (OpenStreetMap data,
OpenMapTiles schema), the same coastline the 2D map draws. The server fetches the zoom-14 tiles
under the view (one to four), reads their `water` layer (classes `ocean` and `dock`; lakes, ponds
and rivers count as land), and tests each cell at a 3 × 3 spread of spots across it: **any spot on
land makes the cell land**, so an islet narrower than a cell still shows. Off Munseom the small
islet north-east of it, 104 × 75 m and about 32 m from Munseom, now shows as its own island with
water between.

- A water cell with no sounding within 216 m (a gap that only existed because of an island) takes
  the nearest sounding's depth.
- **Land heights come from AWS Terrain Tiles** (Tilezen's Terrarium tiles on AWS Open Data):
  keyless, about 9 m a pixel at zoom 14 around Korea, from SRTM and other public elevation models,
  decoded with `sharp` (already a dependency). Each land cell takes the height there, interpolated
  between pixels; Munseom's peak comes out at 72.5 m (73 m real). **Their sea values are wrong**
  (around Jeju about -1,060 m), so the tiles are only asked about cells the coastline already calls
  land. Where the coastline says land but the terrain reads sea level or below (the shoreline), the
  cell gets a token 2 m.
- **If the tiles can't be had, GMRT stands in** (about 60 m, smoother: Munseom comes out at about 47
  m), and if that fails too, land is a flat rise of a tenth of the deepest sounding (at least 2 m).
  The source list says "land heights from AWS Terrain Tiles", "from GMRT" or "land drawn flat", and
  the dialog credits whichever was used (Tilezen's attribution list for the terrain tiles, CC BY 4.0
  for GMRT).
- The dialog credits "Coastline: © OpenStreetMap contributors, via OpenFreeMap" whenever it's used,
  and the source list says "coastline from OpenStreetMap".
- An instance configured with another basemap (`MAP_STYLE_URL` and friends) still gets OpenFreeMap's
  coastline here; it isn't read from the configured style.
- The tiles are decoded with `@mapbox/vector-tile` 3.0.0 and `pbf` 5.1.2, the same versions MapLibre
  uses.

**If the tiles can't be had**, land falls back to **missing soundings**: the soundings sit on a
lattice 144–155 m apart with none on land, and in open water no spot is farther than half a lattice
diagonal (about 110 m) from one, so a cell more than 115 m from every sounding is land. That catches
an island that removes even one lattice node, but islets closer than about 144 m to another island
merge with it. The source list then says "coastline from gaps between soundings".

Soundings are fetched **180 m past the view** on every side, so the view's edges are never short of
neighbours. A 2 km view is still one page of the API.

KHOA also skips the "60% of points must have a reading" rule: its gaps are coast, not missing data.

**It outranks GMRT in Korean waters.** By the 2× rule GMRT's nominal 60 m would jump ahead of KHOA's
144 m, but KHOA is national survey data and GMRT around Korea looks interpolated. So KHOA is marked
to hold its place (`holdsPlace`), as surveyed regional data should.

## Choosing a source

The rules follow Submersion's:

1. **Ask every source** whether it covers the spot, and how fine its data is there.
2. **Order the ones that do.** The default order is NOAA, EMODnet, KHOA, GMRT, ETOPO. A source moves
   ahead of one before it only if its data is **more than 2× finer**. That's why EMODnet's surveyed
   115 m stays ahead of GMRT's 60 m: the 60 m is a global synthesis that is often interpolated. KHOA
   is never passed at all (see above).
3. **Try them in that order**, and use the first grid where:
   - at least **60%** of the points have a reading (KHOA: no minimum), and
   - at least **10%** of those readings are water.
4. If none qualifies, and a worldwide source (GMRT or ETOPO) said the spot is land with no source
   failing, the answer is **"on land"**. Otherwise it is a failure.

Spots it was tested on:

All at 2 km:

| Spot           | Used    | Detail                              |
| -------------- | ------- | ----------------------------------- |
| Jeju, Beomseom | KHOA    | 144 m soundings, gridded at 72 m    |
| Busan coast    | KHOA    | 144 m soundings, gridded at 72 m    |
| Ulleungdo      | KHOA    | 144 m soundings, gridded at 72 m    |
| Florida Keys   | NOAA    | 3.4 m native, drawn at about 13 m   |
| Marseille      | EMODnet | about 115 m                         |
| Seoul (inland) | none    | "on land" (KHOA answered "no data") |

## Why 4 of Submersion's 5 sources (plus KHOA)

Submersion also uses **swissBATHY3D** from swisstopo, which is detailed (about 2 m) data for the
beds of Swiss lakes. It's left out for two reasons.

**It only covers about 23 Swiss lakes.** No sea spot, and nowhere outside Switzerland, would ever
use it. For a test page about the seafloor it adds nothing anywhere else.

**It isn't a "send a box, get a grid" service like the other four.** Getting a grid out of it takes
all of this:

1. **Search swisstopo's STAC catalogue** (`data.geo.admin.ch/api/stac/v1`) for the file that covers
   a lake.
2. **Download a ZIP for the whole lake.** These are large, and Submersion gives them a long timeout.
3. **Unzip it and read the XYZ text points** inside. That would need a ZIP library this app doesn't
   have.
4. **Convert from the Swiss coordinate system (LV95)**, which is in metres, not latitude and
   longitude.
5. **Turn heights into depths.** The values are lake-bed heights above sea level, so each lake needs
   its own mean water level, from a table of the lakes.

Submersion's version is about **2,900 lines across 9 files**, including a tile cache, freshness
checks and pre-loading nearby sites. Rebuilding that for spots no sea diver will pick wasn't worth
it for a test page. Adding it later is self-contained: one more entry in the source list in
`seafloor.server.ts`, with a coverage box per lake.

## Other data that would need an account

Not used:

- **Copernicus Marine** has a 100 m coastal depth product derived from satellite images
  (`BATHYMETRY_GLO_PHY_COASTAL_L4_MY_016_001`). It needs a free account (username and password) and
  is read through their toolbox, not a simple web request.

Around Jeju, GMRT's "60 m" may not be survey data. Offshore it can be interpolated from coarser
data, which would explain why the seabed there looked very flat before KHOA was added.

## The 3D view

Drawn with three.js from the grid. It re-creates Submersion's look from how it works; no code is
copied.

- **Terrain:** colour runs from teal for shallow to navy for the deepest point; land is
  sand-coloured. Lighting is flat and fixed to the camera, so the relief reads the same from any
  side.
- **Depth is stretched** so a gentle slope over kilometres still reads:
  `0.35 ÷ (max depth ÷ narrower side)`, kept between 1× and 8×. Land rises at most as high as the
  water is deep: enough for an island's real shape, without a mountain behind the coast towering
  over the seabed.
- **Contours** are drawn at a round step (`maxDepth ÷ 15`, rounded up to 1, 2 or 5 × 10ⁿ), with
  every fifth line bold. Each gets a label that sits at whichever of 5 spots along the line is
  nearest the camera.
- **Axes:** distance along the south and west edges, at the water surface.
- **Depth gauge:** a vertical bar on the **deepest of the square's four corners**, running from the
  seabed at that corner up to 0 at the surface, clear of the middle of the view. It is marked at 0,
  at round depths, and at the seabed's own depth, with its ticks pointing diagonally out of the
  square. If all four corners are land, it falls back to the south-west corner, down to the square's
  deepest point. (The red line in the middle is something else: the picked spot's pin, staked down
  to the seabed under it.)
- **Labels never pile up.** When two would overlap, the less important one hides. The order of
  importance is axis titles, axis ticks, bold contours, other contours.
- **Controls:** drag to rotate, scroll to zoom, right-drag to pan, with +, − and reset buttons.

## Files

| File                                                 | What it is                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/seafloor.ts`                                | Source names and credits, the spans, the ordering rule, readers for ERDDAP JSON, NOAA's TIFF and KHOA's pages, point gridding (pure, tested) |
| `src/lib/seafloor.server.ts`                         | The five sources and `resolveSeafloor()` (network, cached)                                                                                   |
| `src/lib/seascape-grid.ts`                           | The grid shape, ESRI ASCII reader, averaging down, trimming, coverage counts                                                                 |
| `src/lib/seascape-scene.ts`                          | Grid to mesh, colours, contours and their labels, axes                                                                                       |
| `src/app/seascape-map/page.tsx`, `seafloor/route.ts` | The explorer page and its data route                                                                                                         |
| `src/app/seascape-sample/page.tsx`                   | The fixed Beomseom view                                                                                                                      |
| `src/components/seascape/`                           | The map, the dialog, and the three.js view (each loaded in the browser only)                                                                 |

`three` is pinned at **0.186.0**.

## Testing

```bash
npx vitest run --project unit src/lib/seafloor.test.ts src/lib/seascape-grid.test.ts src/lib/seascape-scene.test.ts
curl -s "localhost:3000/seascape-map/seafloor?lat=25.13&lon=-80.40&span=2000" | head -c 300
```

The unit tests need no network. The `curl` line asks the live sources through the running dev
server.

## Licensing

Submersion is **GPL-3.0**. Nothing here is copied from it: the sources, the rules and the look were
re-implemented from how it works. OpenDiving is AGPL-3.0, which could take GPL-3.0 code with
attribution anyway.

**GMRT and EMODnet require credit (CC BY 4.0).** The pages show the chosen source's credit under the
view; keep it wherever this view goes.
