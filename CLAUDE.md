<!--
Maintainer note. Block-level HTML comments are stripped before this file enters Claude's
context, so this costs nothing to keep here.

The project instructions live in AGENTS.md, imported below, so every coding agent reads one
file instead of a copy that drifts. Claude Code does not read AGENTS.md on its own - the
import is what loads it. Only genuinely Claude-specific instructions belong beneath it.

`next dev` appends a managed block to AGENTS.md when it is started from an agent session;
having a file for it to write to that isn't this one is the other half of the split. See
"The project instructions live in AGENTS.md" in DECISIONS.md.
-->

@AGENTS.md

## Verifying in the browser

Some of what follows names setup rather than repo content. The `opendiving-web-login` and
`opendiving-web-home-screenshot` skills are committed under `.claude/skills/`, so a clone has those;
the `playwright` MCP server is user scope in `~/.claude.json`, and a clone does not. Nothing below
needs it — the failure modes are properties of the tools themselves, not of that setup — so read the
`playwright` mentions as _if you have it_.

`computer{action:"screenshot"}` only returns real pixels while the Browser pane is **visible**. A
hidden pane stops compositing, and the capture falls back to the page background — `rgb(22, 22, 24)`
for the web app — which arrives as a plausible blank dark image rather than an error. Every DOM-side
tool (`read_page`, `get_page_text`, `javascript_tool`) keeps working meanwhile, so "DOM is fine,
pixels are blank" reads as a broken capture stage and invites a pointless detour into Playwright.
Check `document.visibilityState` before concluding anything. Two tells for the same cause:
successive screenshots come back byte-identical even after the page scrolls, and navigating appears
to fix it intermittently, because each navigation forces one fresh paint that then goes stale again.

A hidden pane sometimes also reports a **0×0 viewport**, and then **input** is gone too, not just
capture. With no layout box on anything, `computer{action:"left_click", ref}` resolves the ref to
`(0, 0)`, reports `left_click at (0, 0) [ref_6]` as if it worked, and the element never receives the
click. The trap is that you still look equipped: `read_page` with the default `interactive` filter
returns a bare `(empty page)` — nothing has a box to be interactive in — but
`read_page{filter:"all"}` hands back the full accessibility tree with `ref_N` handles, so the
obvious next move is to click one, and that silently does nothing. `javascript_tool` reading
`innerWidth`/`innerHeight` alongside `document.visibilityState` is the check; neither
`resize_window` (which answers "Viewport reset to native size" and changes nothing) nor
`tabs_select` fixes it. Only the user can reveal the pane, so ask rather than working around it —
and say what is left unverified.

A **visible** pane with a healthy viewport can drop clicks too, and the cause here is not
established — so treat the symptom as the signal. `computer{action:"left_click"}` reports plausible
coordinates, `document.elementFromPoint()` at those coordinates returns the intended element, the
form has no validation errors, and nothing happens; after a few attempts `computer` starts timing
out. Diagnose it in one step rather than re-clicking: attach a capture-phase listener to the target
(`el.addEventListener('click', …, true)`) and click again. If the listener records nothing, the
event is not reaching the DOM at all, and no amount of better targeting will help — the app is not
the problem. Fall back to the page's own event path (`form.requestSubmit()` fires a real submit that
React and react-hook-form handle exactly as a click would) or verify off the browser entirely, and
say in the write-up which layer you skipped.

That interacts with the `opendiving-web-login` skill in one useful way: a click that never lands
also never fires the verifying POST, so the magic-link token is **not** consumed and step 2b's
bearer path is still available with the same link. Falling back to the API is often the better
verification anyway — asserting against a real response body beats clicking Save, and it is the only
half of the job a hidden pane doesn't block.

Scroll with `computer{action:"scroll"}` rather than `window.scrollTo` through `javascript_tool` —
the tool action is tracked by the capture path and fails loudly when the pane is hidden instead of
silently returning the previous frame.

`scripts/screenshots.mjs` drives its own Playwright browser and is immune to all of this, but it
exists to regenerate this repo's `docs/screenshots/` (see its `opendiving-web-home-screenshot`
skill), not to answer ad-hoc "does this look right?" questions.

Ad-hoc checks go to ego-browser first (_Testing in the browser_ in `AGENTS.md`). The `playwright`
MCP server is the fallback when it isn't installed — user scope in `~/.claude.json`, so it loads in
every repo — and it is worth reaching for the moment the pane misbehaves, rather than after a detour
through it. It drives its own Chrome and shares nothing with the pane. Both it and `screenshots.mjs`
are immune for the same reason: Playwright captures through CDP `Page.captureScreenshot`, which
renders off the page rather than off the screen, so nothing needs to be visible — `screenshots.mjs`
produces the README images headless, with no window at all. An occluded or minimized browser is
therefore a non-issue, and window visibility is never the thing to debug on this path.

It runs **headed on purpose** — leave `--headless` off. A visible window is what lets you watch a
click that isn't landing, the failure two paragraphs up that DOM inspection alone doesn't explain,
and by the mechanism above being headed costs nothing in reliability.

Three traps. Writes are restricted to the workspace roots, so a screenshot cannot go to the
scratchpad directory — the path comes back rejected as "outside allowed roots"; pass a _relative_
filename instead and it lands in `.playwright-mcp/`, which is already gitignored. The browser
profile outlives each call, so an account signed in once stays signed in: run `opendiving-web-login`
once per session, not once per navigation. And a session that ends without closing its browser
leaves a Chrome holding that profile's lock, so the next session's first navigation fails with
"Browser is already in use".

Do not read that message as proof of an orphan. A _live_ sibling session on the same profile
produces it identically, and concurrent sessions in this checkout are the norm rather than the
exception. `about:blank` is no evidence either: it is the initial-navigation argument baked into the
launch command line at spawn, and CDP navigation never rewrites argv, so the string is still sitting
there while Playwright drives fully loaded pages. Either tell alone will have you killing another
run's browser out from under it.

The owner is the part that is actually observable. `ms-playwright-mcp` appears in the
`--user-data-dir` of every helper process too, so isolate the browser itself — the one line carrying
no `--type=` — and read its parent:

```bash
ps -Ao pid,ppid,command | grep ms-playwright-mcp | grep -v -- --type= | grep -v grep
```

A parent that is still a live `playwright-mcp` node process means another session holds it: leave it
alone. A parent of `1` means that server exited and launchd adopted the browser — that is the
orphan, and killing that pid is safe.
