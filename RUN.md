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

`next dev` rewrites `AGENTS.md` on every start. Run `git checkout AGENTS.md` before committing.
