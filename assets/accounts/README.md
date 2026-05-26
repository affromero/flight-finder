# Multi user mode screenshots

Reference images for the household-accounts feature. Lives under
`assets/` to match the existing project convention (`assets/home.png`,
`assets/explore.png`, `assets/demo.gif`). Captured from the
**production Docker build** (`docker compose up -d` then Playwright
against `localhost:HOST_PORT`) so the gallery matches what self
hosters actually see.

| # | File | Shows |
|---|------|-------|
| 01 | `01-setup-step1-provider.png` | Setup wizard step 1 — pick an LLM provider (pre-existing step, kept for context) |
| 02 | `02-setup-step2-community.png` | Setup wizard step 2 — community data sharing toggle (pre-existing) |
| 03 | `03-setup-step3-accounts-skip.png` | **New** wizard step 3 — "Run Flight Finder for a household?" with Skip toggle |
| 04 | `04-setup-step3-accounts-fill.png` | Same step with the toggle flipped on and the admin form expanded |
| 05 | `05-login-empty.png` | Unified `/login` form (username + password) for admins and non-admins |
| 06 | `06-admin-dashboard-with-users-link.png` | Admin dashboard nav showing the new Users link and Logout button |
| 07 | `07-admin-users-empty.png` | `/admin/users` first visit — backfill banner visible at the top |
| 08 | `08-admin-users-add-form.png` | "Add user" form mid-fill |
| 09 | `09-admin-users-with-partner.png` | Users table after adding a second household member |
| 10 | `10-settings-multi-user-enabled.png` | Settings page showing the multi user section once enabled |
| 11 | `11-account-empty-partner.png` | Non-admin user's `/account` page — empty state |
| 12 | `12-account-settings-partner.png` | `/account/settings` form for per user defaults (currency, country, airlines, cabin) |
| 13 | `13-landing-signed-in.png` | Landing page welcome line for an authenticated household member |

## Regenerating

The capture harness at `scripts/screenshot-accounts.mjs` drives the full
flow via Playwright (Chromium). To rebuild the set:

```bash
# 1. Bring up the production Docker stack
cd /path/to/flight-finder
docker compose up -d --build

# 2. Optionally seed pre-existing trackers so the backfill banner in #07
#    shows a realistic count
DATABASE_URL='postgresql://postgres:postgres@localhost:5433/flight-finder' \
  npx tsx --eval "..."  # see commit 636b7d5 for the snippet

# 3. Run the harness against the running stack
BASE_URL=http://localhost:3007 node scripts/screenshot-accounts.mjs
```

The script walks the wizard, enables multi user mode, logs in as the
admin, adds a partner user, logs in as the partner, and captures every
state along the way. ~30 seconds end to end.

## Conventions

* PNGs at 1280x800, dark theme (the project default)
* Filenames are `NN-flow-stage-description.png` — keep the numeric
  prefix in chronological flow order so the gallery in the README
  renders left to right
* When a screenshot's text needs updating (button copy, banner wording),
  rerun the harness rather than editing the PNG
