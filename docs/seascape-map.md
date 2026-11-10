# Seascape map (test pages)

Two test pages draw the seafloor around a point in 3D, from the best depth data available there.
They are a local experiment modelled on the "Site Seascape" view in
[Submersion](https://github.com/submersion-app/submersion). They are not linked from the app. **Both
need a signed-in account**, like the app's other pages: a signed-out visitor is sent to sign in and
brought back afterwards, because the depth data comes from an API endpoint that answers accounts
only.

| Page               | What it does                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/seascape-map`    | A map. **Double-click the sea** to open a dialog with that spot's seafloor in 3D. `?at=lat,lon,zoom` opens the map somewhere else, e.g. `?at=25.13,-80.40,11` for the Florida Keys. |
| `/seascape-sample` | One fixed view: Beomseom, off Seogwipo, Jeju (33.217549° N, 126.514413° E).                                                                                                         |

In the dialog you can choose how wide an area to show: **2 km or 1 km**, the two spans the API
accepts (`SEAFLOOR_SPANS` in `src/lib/seafloor.ts`). 2 km is plenty for a dive site. The view draws
at most 160 points per side. Under the view, a list shows which sources were tried and why each was
or wasn't used, followed by the credit the chosen source requires.

## The 2D map: the tile supplier

The explorer's 2D map can come from five suppliers. The operator picks one in `.env.local`; viewers
don't choose, and nothing about it is kept in their browser.

| Id                 | Name             | Needs                                        | Billing                                                     |
| ------------------ | ---------------- | -------------------------------------------- | ----------------------------------------------------------- |
| `openfreemap`      | OpenStreetMap    | nothing (the app's own basemap)              | free, no stated limit, no guarantee                         |
| `google-satellite` | Google satellite | `GOOGLE_MAPS_API_KEY`                        | Map Tiles API, per tile (below)                             |
| `google-roadmap`   | Google           | `GOOGLE_MAPS_API_KEY`                        | Map Tiles API, per tile (below)                             |
| `mapbox-satellite` | Mapbox satellite | `MAPBOX_ACCESS_TOKEN` (a public `pk.` token) | Mapbox Static Tiles, per tile (check Mapbox's pricing page) |
| `mapbox-streets`   | Mapbox           | `MAPBOX_ACCESS_TOKEN`                        | Mapbox Static Tiles, per tile                               |

**Choosing it:** `SEASCAPE_MAP_SUPPLIERS` names **one** id, e.g.

```
SEASCAPE_MAP_SUPPLIERS=google-satellite
```

Unset, the map uses OpenStreetMap, the one with no quota to run out. **There is no fallback:** an
unknown id, a list, or a supplier whose key is missing makes the map say it couldn't load, and the
web server's log says why. Restart the web app after changing it. The pick comes from
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

| Action                            | Google tiles     |
| --------------------------------- | ---------------- |
| Open the map at a spot (zoom 15)  | about 25         |
| Double-click and open the 3D view | 0                |
| Zoom in one level                 | about 25–37 more |

A typical look at one dive site (open, zoom a couple of times) is **about 60–100 tiles**.

**Limits:** 100,000 free tiles a month (about 1,000–1,600 such visits), then **$0.60 per 1,000**.
Separately, the **default quota is 15,000 tiles a day** (about 150–250 visits); past it the map
stops loading until the next day, unless Google raises the quota on request. The OpenStreetMap layer
has no such limit.

## How it works

```
browser (map, double-click)
  └─ GET /api/v1/seafloor?lat=&lon=&span=            ← opendiving-api, signed in only
       ├─ ask each source whether it covers the spot, and how finely
       ├─ try them finest-first, keep the first good grid
       └─ answer the grid plus what every source said, as numbers
  └─ the dialog writes the source list and credits, three.js draws the grid
```

**The API resolves the seafloor; the web only formats and draws.** The browser asks
`GET /api/v1/seafloor` for a point through the API client (`src/lib/api/seafloor.ts`), and the API
picks the source, fetches it, grids it and answers raw numbers. Every word under the view is built
in `src/lib/seafloor.ts` from those numbers: the source list ("125 × 126 cells, ~16 m · coastline
from OpenStreetMap"), the reason a source was passed over ("0% of cells have a reading"), and each
source's credit.

**The browser never contacts a data source itself**, and the CSP needs nothing for this: its
`connect-src` already allows the API's origin.

**What the endpoint answers**, in brief (the full contract is the API's OpenAPI description):

- **200** with `status` `ok` and a `grid`, or `dry` when every source puts the spot on land.
- **503** with `status` `failed` when no source gave a usable grid. The body still carries the
  attempts, so the dialog can say what each source answered.
- **401** signed out, **429** past the per-account limit (120 lookups an hour, cache hits included,
  set on the API), **422** for a span other than 2000 or 1000.
- Depths are metres, **positive below sea level**, negative on land, `null` with no reading; rows
  run south to north, at most 160 cells a side. The API rounds the point to four decimals (about 10
  m) and caches each answer for a week; a failure isn't cached.

**The sources and the rule for choosing between them live in the API**, in `opendiving-api`'s
`src/app/services/seafloor.py`: NOAA's coastal elevation models around the US, EMODnet in European
seas, KHOA's survey data in Korean waters (with OpenStreetMap's coastline and AWS Terrain Tiles'
land heights), GMRT anywhere else and ETOPO 2022 as the last resort. Read it there rather than here.

**`KHOA_API_KEY` is an API setting**, not the web's: set it in the API's environment (see its
`.env.example`). Without it the dialog lists KHOA as "not set up · KHOA_API_KEY is not set" and the
global sources answer in Korean waters.

## The 3D view

Drawn with three.js from the grid. It re-creates Submersion's look from how it works; no code is
copied.

- **Terrain:** colour runs from teal for shallow to navy for the deepest point; land is
  sand-coloured. Lighting is flat and fixed to the camera, so the relief reads the same from any
  side.
- **Depth is stretched** so a gentle slope over kilometres still reads:
  `0.35 ÷ (max depth ÷ narrower side)`, kept between 1× and 4×. Land rises at most as high as the
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

| File                                   | What it is                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `src/lib/api/seafloor.ts`              | `GET /seafloor` through the API client, and the answer's types               |
| `src/lib/seafloor.ts`                  | Source names and credits, the spans, and every line of text the dialog shows |
| `src/lib/seascape-grid.ts`             | The grid shape the scene draws, and the API's grid read into it              |
| `src/lib/seascape-scene.ts`            | Grid to mesh, colours, contours and their labels, axes                       |
| `src/app/seascape-map/page.tsx`        | The explorer page                                                            |
| `src/app/seascape-sample/page.tsx`     | The fixed Beomseom view                                                      |
| `src/app/seascape-map/tile-suppliers/` | Which supplier draws the 2D map                                              |
| `src/components/seascape/`             | The pages' signed-in content, the map, the dialog, and the three.js view     |

`three` is pinned at **0.186.0**.

## Testing

```bash
npx vitest run src/lib/seafloor.test.ts src/lib/api/seafloor.test.ts src/lib/seascape-grid.test.ts src/lib/seascape-scene.test.ts
curl -s -H "Authorization: Bearer $TOKEN" "localhost:8000/api/v1/seafloor?lat=25.13&lon=-80.40&span=2000" | head -c 300
```

The unit tests need no network. The `curl` line asks the running API, which asks the live sources;
`opendiving-web-login` gets a token, and each call counts against that account's hourly limit.

## Licensing

Submersion is **GPL-3.0**. Nothing here is copied from it: the sources, the rules and the look were
re-implemented from how it works. OpenDiving is AGPL-3.0, which could take GPL-3.0 code with
attribution anyway.

**GMRT and EMODnet require credit (CC BY 4.0).** The pages show the chosen source's credit under the
view; keep it wherever this view goes.
