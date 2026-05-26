# Migrating from Fairtrail to Flight Finder

If you installed the project before the v0.8.0 release, your install lives at `~/.fairtrail/` with a postgres database called `fairtrail` and a `fairtrail` binary at `~/.local/bin/fairtrail`. After the rename release, everything has new names. The installer auto-migrates on the next `update` so you do not lose data.

## What changed and why

The project was renamed to Flight Finder so the brand matches what users actually look for. The new install layout:

| Old | New |
|-----|-----|
| `~/.fairtrail/` | `~/.flight-finder/` |
| Database `fairtrail` | Database `flight_finder` |
| `~/.local/bin/fairtrail` | `~/.local/bin/flight-finder` plus `flightfinder` |
| `ghcr.io/affromero/fairtrail` | `ghcr.io/affromero/flight-finder` |
| Domain `fairtrail.org` | Domain `flight-finder.org` (legacy 301 redirects) |
| Env var prefix `FAIRTRAIL_*` | `FLIGHT_FINDER_*` |

## Automatic migration

```bash
fairtrail update
```

What happens under the hood:

1. The renamed installer detects `~/.fairtrail/docker-compose.yml`.
2. It starts the postgres container if needed, waits for it to be ready, and runs `ALTER DATABASE fairtrail RENAME TO flight_finder` while the old containers are still wired up.
3. It stops the stack, moves `~/.fairtrail` to `~/.flight-finder`, and writes a marker file so the regenerated compose keeps `name: fairtrail` at the top.
4. That marker keeps your existing `fairtrail_pgdata`, `fairtrail_redisdata`, `fairtrail_app-data`, and `fairtrail_cli-cache` named volumes attached to the renamed install without a data copy.
5. It pulls the new `ghcr.io/affromero/flight-finder:latest` image and starts the stack.

All idempotent: re-running the installer on an already-migrated install is a no-op.

## Manual migration

If your CLI is too stale to auto-detect, run the migrate subcommand directly:

```bash
flight-finder migrate
```

Or run the installer again, which is the same code path:

```bash
curl -fsSL https://flight-finder.org/install.sh | bash
```

## What about my data?

Preserved:

- Tracked queries (the `Query` table)
- Price snapshots (every historical scrape)
- User accounts and settings (multi user mode)
- Extraction config (LLM provider, model, schedule)
- The `.env` file (regenerated against the renamed database URL but secrets are kept)

Not preserved:

- Nothing. The migration is a rename, not a wipe.

## Why the `fairtrail` command still works

The installer creates `~/.local/bin/fairtrail` as a symlink to the renamed wrapper alongside `~/.local/bin/flight-finder` and `~/.local/bin/flightfinder`. When invoked under the old name the wrapper prints a one line deprecation notice:

```
Note: the `fairtrail` command has been renamed to `flight-finder` (or `flightfinder`).
The old name still works but will be removed in v1.0.
```

Silence the notice with `FLIGHT_FINDER_SILENCE_RENAME=1`. The deprecated alias sticks around through the v1.0 release so existing shell aliases, scripts, and muscle memory keep working.

## Rolling back

If something goes wrong on a self hosted install:

```bash
docker compose -f ~/.flight-finder/docker-compose.yml down
docker compose exec -T db psql -U postgres -d postgres -c \
  "ALTER DATABASE flight_finder RENAME TO fairtrail;"
mv ~/.flight-finder ~/.fairtrail
# Restore the previous compose-generating installer:
curl -fsSL "https://flight-finder.org/install.sh?legacy=1" | bash   # not implemented; fall back to your local backup
```

The simplest recovery: restore the pre-migration `~/.fairtrail/docker-compose.yml` from your backup and rename the database back. Open an issue if you hit this; the migration test is supposed to keep this off the table.

## Help and common issues

- **Both `~/.fairtrail` and `~/.flight-finder` exist.** The installer refuses to auto resolve. Pick one to keep, remove the other, and re-run.
- **Database rename fails.** The installer aborts and leaves `~/.fairtrail` untouched. Check that docker is running, that the db container is healthy, and look at `docker compose -f ~/.fairtrail/docker-compose.yml logs db` for a hint.
- **Browser still shows Fairtrail branding.** Hard refresh (Cmd or Ctrl plus Shift plus R). The service worker cache was renamed so the old shell purges on first load.
- **Existing share links break.** They should not. `fairtrail.org/q/abc` 301 redirects to `flight-finder.org/q/abc` with the path preserved.
