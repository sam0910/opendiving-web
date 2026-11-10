import { NextRequest, NextResponse } from "next/server";
import { apiCspSource } from "@/lib/api-base";
import { API_REFERENCE_STYLE_HASHES } from "@/lib/api-reference-csp";
import { basemapOrigins } from "@/lib/basemap";
import { runtimeConfig } from "@/lib/runtime-config";

// Nonce-based, strict Content-Security-Policy. This is computed fresh per
// request (the nonce must never be reused/predictable) and threaded through
// to Server Components via the `x-nonce` request header, so
// `app/layout.tsx` can hand it to anything that legitimately needs to
// render an inline <script>/<style> (currently just next-themes'
// no-flash-of-wrong-theme bootstrap script). Any *other* inline or
// injected script - e.g. one smuggled in via an XSS bug - won't carry this
// nonce and the browser will simply refuse to execute it.
//
// This only works because the app runs as a persistent Node server
// (`output: "standalone"`, see the Dockerfile) - it would silently do
// nothing under a static export, which has no per-request server code to
// generate a fresh nonce.
// Empty by default, and that is the shipped topology: the API is same-origin behind
// `app/api/v1/[...path]/route.ts`, which `'self'` already covers. It becomes a real
// origin only for a split-origin build, where `NEXT_PUBLIC_API_URL` is absolute - and
// that one genuinely is fixed at build time, which is why it is read here at module
// scope while everything below is not.
const API_ORIGIN_SOURCE = apiCspSource(process.env.NEXT_PUBLIC_API_URL) ?? "";

// The basemap's hosts, the one host source this app's configuration decides on.
// Derived on first request rather than at module load - reading the environment while
// the module is being evaluated risks doing it at build time, and the whole point of
// `lib/runtime-config.ts` is that a published image reads it in the container it runs
// in. Derived *once* rather than per request because the environment cannot change
// while the process lives, and `basemapOrigins`' warning for a malformed value would
// otherwise repeat on every request, burying the one diagnostic it exists to give.
//
// The policy names Google in no configuration at all: "Continue with Google" is a
// top-level navigation (`lib/google-oauth.ts`), which none of the fetch directives
// govern, so the CSP does not disclose whether an instance has Google sign-in on.
//
// It reaches `connect-src` and nothing else. MapLibre fetches every tile, in both of
// its modes, so `img-src` names no third party.
//
// Every `<img>` in this app points at this instance - its own origin, or `apiOrigin`
// where the API is split off onto another one, which `img-src` already lists. Species
// photos are the case that makes the distinction worth stating rather than saying
// "own origin": they are `<img src>` elements pointed straight at the API, because the
// route serving them is deliberately unauthenticated, so in a split-origin build - which
// local dev is - they resolve to `apiOrigin` and not to the page's origin. The bytes are
// Wikimedia's, fetched by the server and stored here; no browser ever asks
// Wikimedia for them, which is the whole point of serving them ourselves.
//
// `undefined` rather than a falsy check, since an instance whose every basemap value is
// malformed legitimately derives the empty string and must not re-derive it per request.
let basemapSources: string | undefined;

function cspBasemapSources(): string {
  if (basemapSources === undefined) {
    basemapSources = basemapOrigins(runtimeConfig().basemap).join(" ");
  }
  return basemapSources;
}

// `Strict-Transport-Security` is set here rather than in `next.config.js`'s `headers()`
// for two reasons that only middleware can serve: the value depends on the request, and
// the switch behind it is read at runtime. `headers()` is evaluated once, during the
// build, and applied to every response of every deployment identically - which for a
// published image means the build machine decides it for someone else's domain.
//
// It is only sent for a request that already arrived over HTTPS: a LAN instance on plain
// HTTP would otherwise hand out a pin it cannot honour, and a browser that recorded one
// stops being able to reach it at all. And it carries no `preload` - entering a domain into the browsers' preload list commits every host under
// it to HTTPS for years and is deliberately hard to undo, which is a decision for whoever
// owns the domain rather than for the app running on it. `WEB_HSTS=off` drops the header
// entirely.
//
// Only responses the matcher below covers get it, which is documents and their data
// requests rather than static assets. HSTS is recorded per *host*, not per path, so one
// covered response is all a browser needs.
const HSTS_VALUE = "max-age=63072000; includeSubDomains";

// Whether this request reached us over HTTPS. Behind the shipped Caddy - or any other
// proxy - TLS is terminated a hop earlier and the only evidence is the forwarded header;
// a chain appends to it, so the client-facing hop is the first entry, not the last.
function isHttps(request: NextRequest): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0]!.trim().toLowerCase() === "https";
  }
  return request.nextUrl.protocol === "https:";
}

// A directive and its sources, with the empty ones dropped. Every source below the
// literal ones can vanish - the API origin whenever the API is same-origin, the basemap
// origins when every configured value is malformed - and a stray double space in a
// CSP is the kind of thing that reads as a typo forever after.
function cspList(directive: string, ...sources: string[]): string {
  return [directive, ...sources.filter(Boolean)].join(" ");
}

export function proxy(request: NextRequest) {
  // 16 random bytes, because CSP Level 3 asks a nonce for "at least 128 bits of
  // entropy". A v4 UUID carries 122 - not a weakness at that size, but the
  // spec-exact form is no more code and is shorter on the wire besides. `crypto.getRandomValues` and `Buffer` are both available in
  // either runtime, so this does not depend on which one Proxy runs in (Node, as of
  // Next 16, which forbids the `runtime` export here outright).
  const nonce = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("base64");
  const isDev = process.env.NODE_ENV !== "production";
  // Empty string for the default, same-origin API - see `API_ORIGIN_SOURCE` above.
  // `lib/api-base.ts` is what reduces an absolute value to an origin and what knows a
  // relative one can't go through `new URL` at all.
  const apiOrigin = API_ORIGIN_SOURCE;
  // The basemap MapLibre draws, which is a `connect-src` source in *both* of its
  // modes. That is not a choice about vector tiles: MapLibre's image decoder
  // takes an `ArrayBuffer` and goes `Blob` -> `createImageBitmap`, so raster
  // tile bytes arrive by `fetch` too. See `basemapOrigins`, which also says why
  // nothing may set `refreshExpiredTiles`. Derived by the same module the
  // renderer takes its URLs from, for the origin-not-path reason above: a host
  // named in one place and not the other fails as a silently blocked request,
  // which is a much worse thing to debug than a wrong URL.
  const basemapOriginSources = cspBasemapSources();

  const cspDirectives = [
    "default-src 'self'",
    // `'unsafe-inline'` and `https:` are no-ops in any browser that
    // understands `'nonce-...'`/`'strict-dynamic'` (CSP Level 3) - such
    // browsers ignore them - but keep the site from breaking outright in
    // older browsers that don't. This is the "strict CSP with graceful
    // fallback" pattern from Google's CSP guide, not a real weakening.
    `script-src 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    // `style-src` (governs `<style>`/`<link>` elements) is nonce-gated in
    // production only. In dev, Next's own tooling - Fast Refresh, the
    // dev/error overlay, and webpack/Turbopack's CSS hot-injection - injects
    // inline `<style>` tags with no nonce at all (a documented Next.js
    // limitation, e.g. vercel/next.js#87343), so a strict nonce here just
    // breaks dev-mode styling. Production doesn't do any of that: real CSS
    // ships as static, hashed `<link rel="stylesheet">` files (covered by
    // `'self'`), so the nonce requirement costs nothing there.
    // `style-src-attr` is deliberately its own, non-nonce'd directive: per
    // spec, listing a nonce/hash in a directive disables the `'unsafe-inline'`
    // fallback for *that* directive, and inline `style="..."` attributes from
    // Base UI/Floating UI/etc. (positioning, `pointer-events`, animation state)
    // can't practically carry a matching nonce - there's no way to tag every
    // element a third-party library renders. CSS-attribute injection can't
    // execute script in any modern browser, so this is a deliberate, narrow
    // relaxation - `style-src-elem`/`style-src` (actual `<style>` blocks,
    // where CSS-exfiltration attacks are more feasible) take only the nonce
    // or one of the listed hashes in production.
    // No host source: nothing third-party is loaded as a stylesheet. The hashes are
    // the two stylesheets Scalar injects on `/developers` without a nonce (see
    // `lib/api-reference-csp.ts`), and are on every page's policy because a client
    // navigation to `/developers` keeps the policy of the document it started from.
    isDev
      ? "style-src 'self' 'unsafe-inline'"
      : cspList(
          "style-src",
          "'self'",
          `'nonce-${nonce}'`,
          ...API_REFERENCE_STYLE_HASHES,
        ),
    "style-src-attr 'unsafe-inline'",
    // `blob:` - certification card images and both of a diver's pictures are
    // private, so on the diver's own pages they're fetched with an `Authorization`
    // header and rendered from an object URL rather than pointed at directly (see
    // `hooks/useAuthedBlobUrl.ts`).
    // Blob URLs are *not* covered by `'self'`, so without this the `<img>` is
    // blocked. It widens nothing an attacker could reach: a `blob:` URL can only name
    // data this document already created. The pictures take that same path, which
    // is why no avatar host is named here: they are served by this app's own API.
    //
    // Two image kinds do *not* take that path, and are a plain `<img src>` at the
    // API: species photos, public bytes on an unauthenticated route, and a check-in
    // link's portrait and card fronts, whose route takes the link's token in its
    // path rather than a header. `apiOrigin` is therefore load-bearing for them
    // rather than incidental: it is empty in the shipped same-origin topology, where
    // `'self'` covers them, and a real origin in a split-origin build, where nothing
    // else would.
    //
    // No third-party host at all: MapLibre fetches every map tile, in both of
    // its modes, under `connect-src`.
    cspList("img-src", "'self'", "data:", "blob:", apiOrigin),
    "font-src 'self' data:",
    // **Load-bearing, not declarative.** `worker-src` has no `child-src` above
    // it in this policy, so without this line a worker falls back to
    // `script-src` - whose `'strict-dynamic'` short-circuits the source-list
    // check entirely for anything not parser-inserted, and a `new Worker(url)`
    // never is. The policy would therefore permit a `blob:` worker without a
    // violation, which is precisely the hazard MapLibre was rejected over.
    // `worker-src`'s own pre-request check has no such carve-out, so this is the
    // one thing that makes the blob path fail loudly if MapLibre ever falls
    // through to `importAsBlobUrl` instead of using the same-origin copy
    // `components/map/map-canvas.tsx` points it at.
    "worker-src 'self'",
    // The API and the basemap are the cross-origin destinations this app fetches
    // from. "Continue with Google"
    // (`components/auth/google-auth-button.tsx`) needs nothing in either of these:
    // it is a top-level navigation to Google, which the fetch directives do not
    // govern. Nor does it need a `Cross-Origin-Opener-Policy` in their place -
    // Google documents `same-origin-allow-popups` as a requirement for its *popup*
    // flows, and this one opens no popup.
    // Google's Map Tiles API and Mapbox's raster tiles, which the seascape explorer
    // can draw its 2D map from, each allowed only on an instance with a key for it.
    cspList(
      "connect-src",
      "'self'",
      apiOrigin,
      basemapOriginSources,
      process.env.GOOGLE_MAPS_API_KEY ? "https://tile.googleapis.com" : "",
      process.env.MAPBOX_ACCESS_TOKEN ? "https://api.mapbox.com" : "",
    ),
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ];
  const contentSecurityPolicyHeaderValue = cspDirectives.join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(
    "Content-Security-Policy",
    contentSecurityPolicyHeaderValue,
  );

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set(
    "Content-Security-Policy",
    contentSecurityPolicyHeaderValue,
  );

  // `runtimeConfig()` memoizes, so these two are one environment read for the life of
  // the process rather than one per request.
  const { hstsEnabled, noindex } = runtimeConfig();
  if (hstsEnabled && isHttps(request)) {
    // A TLS-terminating proxy in front may set its own; where both are present the
    // proxy's wins, which is the right way round - it is the one that knows the domain.
    response.headers.set("Strict-Transport-Security", HSTS_VALUE);
  }
  if (noindex) {
    // `app/robots.ts` asks crawlers not to fetch; this is what keeps a URL they heard
    // about elsewhere out of an index anyway. A disallowed path can still be listed - a
    // crawler that obeys robots.txt never fetches it and so never sees a `noindex` in the
    // page, which is exactly why the header exists as well.
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }

  return response;
}

export const config = {
  matcher: [
    {
      // The exclusions are anchored with a trailing `/` (or `$`) on purpose:
      // an unanchored `api` also excludes any future route that merely *starts*
      // with those letters - `/api-docs`, `/apidemo` - which would then be
      // served with no CSP at all, silently.
      //
      // `api/v1/` and not `api/`: the proxy below `/api/v1/` is excluded only so its
      // bodies stream unbuffered (`lib/api-proxy.ts`). Every other path under `/api`,
      // the bare `/api/v1` included, is Next's not-found *page*, scripts and all, and
      // gets the policy like any other page.
      //
      // `healthz` is excluded for the same reason the API routes are: it answers a
      // container healthcheck with two words of plain text, and a policy governing
      // scripts and styles has nothing to say about it. Skipping it also keeps the
      // per-request nonce off a path that is hit every few seconds forever.
      //
      // There is no `missing:` clause here, and its absence is deliberate. Next's own
      // CSP guide (`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`)
      // puts one in at this exact spot, listing `next-router-prefetch` and
      // `purpose: prefetch`, and says only that prefetches "don't need the CSP header".
      // The concern it is usually explained by is a stale nonce: one baked into a
      // prefetched RSC payload, parked in the client router cache, replayed on a later
      // navigation under a document whose CSP carries a different nonce.
      //
      // That cannot happen here, because a real prefetch payload has no nonce to go
      // stale. A `<Link>` prefetch of `/privacy` (`RSC: 1` plus `next-router-prefetch: 1`)
      // comes back as a 267-byte router-tree stub - no `<script>`, no nonce anywhere in
      // it; the same URL with `RSC: 1` alone returns 36 KB carrying the request's nonce.
      // What the clause did buy was an opt-out: one request header - `purpose: prefetch`,
      // or any value at all of `next-router-prefetch` - and this middleware never ran, so
      // a full 66 KB HTML document with 22 `<script>` tags was served with no CSP, no
      // HSTS and no `X-Robots-Tag`. Cache poisoning was never the risk - these responses
      // are `private, no-cache, no-store, max-age=0, must-revalidate` with no `ETag`, so
      // no shared cache may store the CSP-less document and no 304 path exists - the
      // header-stripping primitive itself was. Without the clause, no request header
      // yields a CSP-less page; only the excluded paths go without one, and none of
      // them answers with HTML.
      //
      // It never covered the prefetches browsers send on their own, either. `matchHas`
      // (`node_modules/next/dist/shared/lib/router/utils/prepare-destination.js`) looks a
      // header up by exact lowercased key, so the `Sec-Purpose: prefetch` that Chrome's
      // speculation rules and Google's prefetch proxy actually send never matched the
      // `purpose` key and kept the CSP regardless. Only a hand-written header stripped it.
      //
      // `cacheComponents`/PPR is the switch expected to reopen this, and it is on
      // without doing so. App-shell prefetches (`next-router-prefetch: 3`,
      // `FetchStrategy.RuntimeShell`) do carry the nonce of the request that produced
      // them, and the guide calls PPR incompatible with a nonce-based CSP because
      // "static shell scripts won't have access to the nonce" - but nothing here serves
      // a static shell, and the document that runs those scripts mints its own nonce.
      // See "Cache Components asks for one opt-out, and leaves the nonce CSP alone" in
      // DECISIONS.md; this file is not what the flags change.
      source:
        "/((?!api/v1/|_next/static/|_next/image/|favicon.ico$|healthz$).*)",
    },
  ],
};
