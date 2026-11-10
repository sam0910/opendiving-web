// Where a form's or a record page's "back" link, a form's Cancel button, and
// (where it makes sense) a save or a delete should send someone.
//
// The dive form is reachable from at least six places - the Home page, the dive
// list, the header's create menu, and the "log a dive here" buttons on a trip or
// a dive site - and a dive from a trip, a site, the Home page and more, so a
// hardcoded `/dives` is wrong for most of them. Rather than each caller
// threading its own href through the page, the destination is read off the URL,
// which means it also survives a reload or a shared link.
//
// Deliberately not `router.back()`: a deep link or a refresh has no history
// entry to pop, and after a successful save "back" points at the form that was
// just submitted.

import { sanitizeRedirectPath } from "@/lib/auth-redirect";

export interface ReturnTarget {
  href: string;
  label: string;
}

// Section labels for the back link, in both their list and single-record forms:
// `/trips` is "Back to trips", `/trips/{uuid}` is "Back to trip". Every page inside
// the chrome needs one, since the header's create menu opens the dive form from
// any of them - `app/page-frames.render.test.tsx` derives that set and checks it.
const SECTIONS: Record<string, { index: string; item: string }> = {
  home: { index: "home", item: "home" },
  dives: { index: "dives", item: "dive" },
  trips: { index: "trips", item: "trip" },
  sites: { index: "dive sites", item: "dive site" },
  gear: { index: "gear", item: "gear" },
  certifications: { index: "certifications", item: "certification" },
  courses: { index: "courses", item: "course" },
  contacts: { index: "contacts", item: "contact" },
  people: { index: "people", item: "person" },
  species: { index: "marine life", item: "species" },
  checkin: { index: "check-in", item: "check-in" },
  import: { index: "import", item: "import" },
  settings: { index: "settings", item: "settings" },
  admin: { index: "admin", item: "admin" },
  support: { index: "support", item: "support" },
  privacy: { index: "privacy policy", item: "privacy policy" },
  terms: { index: "terms of service", item: "terms of service" },
  developers: { index: "API reference", item: "API reference" },
  "seascape-map": { index: "seafloor explorer", item: "seafloor explorer" },
  "seascape-sample": { index: "seascape sample", item: "seascape sample" },
};

export function labelForPath(path: string): string {
  const segments = path.split(/[?#]/)[0].split("/").filter(Boolean);
  if (segments.join("/") === "sites/proposals") return "Back to your proposals";
  const section = SECTIONS[segments[0]];
  if (!section) return "Back";
  return `Back to ${segments.length > 1 ? section.item : section.index}`;
}

// A form must never send someone back to a form. The header's create menu is
// present on the dive form itself, so without this a "New dive" opened from
// `/dives/new` would hand that same path back to Cancel.
export function isFormPath(path: string): boolean {
  const route = path.split(/[?#]/)[0].replace(/\/$/, "");
  return route === "/dives/new" || route.endsWith("/edit");
}

// Past this, a `from` keeps only its path. Every record followed from another
// nests the page before it, so a long enough walk would otherwise grow the URL
// without bound; this is a dozen or so records deep.
const FROM_MAX_LENGTH = 1000;

// `href` with a `?from=` naming the page it is followed from, so the page it
// opens can send the diver back there: a dive opened from a trip says "Back to
// trip". `from` is that page's path *and* query, so a trip opened from the
// Home page still says "Back to home" once the diver comes back to it from
// one of its dives.
//
// Nothing is added where the opened page's back link already points - its
// parent path, so a dive followed from `/dives` or an edit from its own dive
// keeps a clean URL - nor from a form, which nothing should return to. A link
// to the very page it is followed from is that page as it stands, way back and
// all, rather than a page that leads back to itself.
export function withReturnTo(href: string, from: string | null): string {
  if (!from || isFormPath(from)) return href;
  const path = href.split(/[?#]/)[0];
  if (from.split(/[?#]/)[0] === path) return from;
  if (from === path.slice(0, path.lastIndexOf("/"))) return href;
  const kept = from.length > FROM_MAX_LENGTH ? from.split(/[?#]/)[0] : from;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}from=${encodeURIComponent(kept)}`;
}

export interface ReturnToParams {
  /** An explicit destination, set by whoever linked to the form. */
  from?: string | null;
  /** The form's own context params, used when there's no explicit `from`. */
  trip_uuid?: string | null;
  dive_site_uuid?: string | null;
  course_uuid?: string | null;
}

// Resolution order, most to least specific:
//   1. `?from=` - the linking page said exactly where to go back to.
//   2. The context the form was opened with. "Log a dive for this trip" already
//      passes `?trip_uuid=`, so that entry point needs no extra wiring to send
//      the diver back to the trip they were looking at.
//   3. The caller's own fallback (the dive list, or the dive being edited).
//
// `from` goes through the same `sanitizeRedirectPath` guard as the post-sign-in
// redirect: only same-origin, path-relative destinations are honoured, so a
// hand-crafted `?from=//evil.example` can't turn a Cancel button into an open
// redirect.
export function resolveReturnTarget(
  params: ReturnToParams,
  fallback: ReturnTarget,
): ReturnTarget {
  const from = sanitizeRedirectPath(params.from);
  if (from && !isFormPath(from)) {
    return { href: from, label: labelForPath(from) };
  }

  if (params.trip_uuid) {
    return {
      href: `/trips/${params.trip_uuid}`,
      label: "Back to trip",
    };
  }

  if (params.dive_site_uuid) {
    return {
      href: `/sites/${params.dive_site_uuid}`,
      label: "Back to dive site",
    };
  }

  if (params.course_uuid) {
    return {
      href: `/courses/${params.course_uuid}`,
      label: "Back to course",
    };
  }

  return fallback;
}
