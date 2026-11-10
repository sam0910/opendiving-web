# Running the web app locally (dev)

Full guide, covering the API, sign-in and Commons: [../RUN.md](../RUN.md)

The API has to be running first, on http://localhost:8000 (`.env` points at it).

## Start

```bash
nvm use 24
# Logged outside this folder: `next dev` watches it, and a log written inside it makes
# the page recompile and reload on every line.
mkdir -p ../.logs
nohup pnpm dev > ../.logs/web.log 2>&1 &
open http://localhost:3000
```

Or run `pnpm dev` in the foreground in its own terminal and stop it with Ctrl+C.

## Stop

```bash
pkill -f "next dev"
```

## Gotcha

`next dev` rewrites the `nextjs-agent-rules` block in `AGENTS.md` on every start, but the committed
block already matches, so the file stays clean. After a Next.js upgrade changes that block, commit
the rewrite with your work rather than checking it out: it only comes back on the next start.
