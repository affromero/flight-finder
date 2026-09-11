<div align="center">

# Flight Finder

**Flight, hotel, and car rental prices, tracked on your terms.**

Track flights, hotels, and car rentals independently in one self-hosted app.
Open source. Use your own AI provider for natural-language requests, or search
hotels and cars with structured forms.

[![GitHub Release](https://img.shields.io/github/v/release/affromero/flight-finder)](https://github.com/affromero/flight-finder/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/affromero/flight-finder/ci.yml?label=CI)](https://github.com/affromero/flight-finder/actions/workflows/ci.yml)
[![Gitleaks](https://img.shields.io/github/actions/workflow/status/affromero/flight-finder/gitleaks.yml?branch=main&label=gitleaks&logo=github)](https://github.com/affromero/flight-finder/actions/workflows/gitleaks.yml)
[![Docker](https://img.shields.io/badge/Docker-deployed-2496ED?logo=docker&logoColor=white)](https://github.com/affromero/flight-finder/pkgs/container/flight-finder)
[![License: MIT](https://img.shields.io/github/license/affromero/flight-finder)](https://github.com/affromero/flight-finder/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma)](https://prisma.io)
[![Socket](https://img.shields.io/badge/Socket-protected-blueviolet?logo=socket.dev)](https://socket.dev)
[![min-release-age](https://img.shields.io/badge/min--release--age-7%20days-brightgreen)](https://docs.npmjs.com/cli/v10/using-npm/config#min-release-age)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/affromero/flight-finder/pulls)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/afromero)
[![self-hostable: yes](https://img.shields.io/badge/self--hostable-yes-3fa463)](#quick-start)
[![BYOK: bring your own keys](https://img.shields.io/badge/BYOK-bring%20your%20own%20keys-c2772e)](#quick-start)
[![agent: Claude Code / Codex](https://img.shields.io/badge/agent-Claude%20Code%20%2F%20Codex-4b5fc7)](#quick-start)
[![AGENTS.md](https://img.shields.io/badge/AGENTS.md-7c3aed)](https://github.com/affromero/flight-finder/blob/main/AGENTS.md)
[![LLM: 100% local capable](https://img.shields.io/badge/LLM-100%25%20local%20capable-3fa463)](#quick-start)

<br>

<img src="assets/demo.gif" alt="Flight Finder -- price evolution charts cycling through JFK->CDG, LAX->NRT, ORD->FCO" width="100%">

<details>
<summary>CLI Demo -- headless mode with Claude Code & Codex</summary>
<br>
<img src="packages/cli/demo/flight-finder-demo.gif" alt="Flight Finder CLI -- search with Claude Code and Codex side by side, then live price charts" width="100%">
</details>

<details>
<summary>Screenshots</summary>
<br>
<img src="assets/home.png" alt="Landing page (dark)" width="100%">
<br><br>
<img src="assets/chart-jfk-cdg.png" alt="JFK -> CDG price chart" width="100%">
</details>

</div>

---

## Quick Start

```bash
curl -fsSL https://flight-finder.org/install.sh | bash
```

If you have [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://github.com/openai/codex) installed, the setup script detects it automatically. Otherwise, it asks you to paste an API key.

Once it finishes:

1. Open [localhost:3003](http://localhost:3003) and choose **Flights**, **Hotels**, or **Cars**.
2. Search for a route, stay, or rental, review the details, and select what to track.
3. Follow price history and configure alerts. Hotels and cars do not require a flight.

From the terminal, use `flight-finder search "NYC to Tokyo in July under $800"`
for flights or the [hotel commands](#hotel-tracking) for stays.

### Choose what you track

The public website explains the product and provides installation instructions.
Searches and trackers run on your own installation. The desktop launcher and
mobile browser connect to that same instance.

- **Flights:** follow routes and airlines, compare flexible dates, and share flight price charts.
- **Hotels:** search Google Hotels or Booking.com by dates, rooms, and guests;
  track the cheapest qualifying offer or a particular room/rate; set a target-price
  alert and inspect the recorded history. The structured hotel form does not use AI.
- **Cars:** search DiscoverCars and Auto Europe independently of flights or hotels;
  compare verified rental totals and track the cheapest qualifying offer or a
  specific rental contract. See [Car rental tracking](#car-rental-tracking).
- **Households:** each person can use any combination of travel trackers. Ordinary
  members see their own trackers; administrators can manage and reassign them.

Flight, hotel, and car trackers are independent. This does not combine them into a
package, shared itinerary, or combined budget. Bookings are completed with the
airline, hotel seller, or rental provider. Hotel and car histories require access
to your instance and, when multi-user mode is enabled, the owning account or an
administrator.

Google Hotels supports one room; Booking.com supports multiple rooms with child
ages assigned to each room. Discovery checks up to eight properties per source
and stay, with at most 24 date/source combinations. Unverified prices, fees,
occupancy, or requested policies are not guessed. Results can include usable
offers alongside explicit provider errors. Configure a notification channel to
receive alerts outside the app; approximate matches require explicit opt-in.

### Car rental tracking

Open **Cars** on your self-hosted instance. Select pickup and return locations
from the airport and city catalog, enter local dates and times, and provide the
driver's age, residence country, and years holding a licence. Choose either
provider or both. Account settings save each user's preferred car providers
separately from flight and hotel preferences.

From the CLI, `flight-finder cars preferences` shows the saved provider order,
effective defaults and preference revision. Use
`flight-finder cars preferences --providers autoeurope,discovercars --revision 0`
with the revision you just read, or `--reset --revision 0` to inherit both
providers. These settings affect new car searches, not existing trackers.
CLI search files may omit `sources` to use these preferences; an explicit
`sources` list takes precedence and is retained unchanged in the search receipt.
Single-user installations keep both defaults; each search can select its own
sources. Saving preferences requires a personal account.

DiscoverCars groups ages 30 through 65 into one search value. Its adapter accepts
35 as that provider value and rejects other ages in this range, as well as ages
above 80, rather than changing the requested age. Select Auto Europe for an
exact-age search in those cases. Each supplier's age and licence requirements
still apply; a provider selection does not guarantee an eligible offer.

Preference changes retain a recovery receipt before sending the request. After
a lost acknowledgement, use `cars retry <receipt>` with that receipt. A stale
revision displays current preferences without claiming the original request
succeeded. Review them before making a new change; never replace the revision
inside an old receipt.

The structured form works without AI. An optional natural-language request
produces a draft for review. Location suggestions still require a catalog
selection, and missing driver details remain empty until you supply them.
Reviewing a draft starts neither a provider search nor a tracker.

Providers run in headless Chromium. Results show how many visible offers were
checked, whether a limit was reached, and any provider failures. A search checks
up to eight offers per provider; it does not claim to find every available car.
An advertised price remains unverified when the provider does not supply enough
evidence to establish the requested rental and its charges. Such candidates
remain visible for inspection but cannot trigger price alerts.

For verified offers, inspect the rental total, payment timing, deposit, excess,
fuel and mileage policies, and driver requirements before tracking. Requested
extras must have supported pricing evidence; an unknown charge is not treated
as free. Deposits and excess are shown separately from the rental total.
Always confirm availability and final terms with the provider before booking.

DiscoverCars can select the requested seat categories and quantities and
additional drivers when the supplier exposes those controls. Its local-extra
controls may appear on the rental details page or on a separate step after
coverage. Both sequences retain the requested selections and reject unexpected
charges; the scraper stops before driver details or booking. Local-extra
prices and availability are supplier estimates. Results retain each selected
charge and show a combined estimate, which may exclude additional-driver
surcharges. You can review an available protection option and request a fresh
quote with the same extras. Adding protection does not make estimated extras
eligible for tracking or alerts.

AutoEurope's observed checkout does not expose selectable local extras. When
you request seats or additional drivers, its result identifies the unselected
extras and shows supplied supplier terms separately. Any advertised amount
excludes those extras and cannot qualify as the requested combined total.
Missing terms remain unknown. Base rentals and available protection products
are checked independently of this limitation.

Choose **best** mode to follow the cheapest qualifying offer across the selected
providers, or **contract** mode to follow the selected rental contract. Set a
target price, new-low alerts, and a check interval. The tracker records check
history and provider errors. Pause stops future checks and pending alerts;
messages already sent cannot be recalled.

**Refresh status** reads the current state. **Check saved rental prices** requests
a provider check. If its acknowledgement is lost, recover the saved request
instead of starting another one. Recovery uses the original request identity,
including after a page reload. Browser session storage must be available to save
mutation recovery identities safely.

Car search and tracking APIs require a self-hosted instance and its configured
authentication. The public website does not expose private rental histories.
See [API.md](API.md) for request formats, retry headers, and ownership rules.
The catalog's source attribution and downloadable data are available at
`/cars/location-data` on your instance.

### Prefer not to touch the terminal?

There is a **desktop app** (macOS, Windows, Linux) at [flight-finder.org/download](https://flight-finder.org/download). Open it and pick one of two modes:

- **Run it on this computer** -- it brings up the same Docker stack with one click (Docker required) and opens the app.
- **Connect to an instance** -- point it at a Flight Finder running on your VPS and it opens in its own window.

It is a thin launcher over the same installer described above; the source lives in `apps/desktop`.

### Reach it from a phone

Phones connect through the browser: open your instance URL and **Add to Home Screen** to install it as an app (it is a PWA). Visit **`/connect`** on your instance for a QR code and step-by-step iOS/Android instructions.

Admins also get an interactive reach guide in **Instance settings -> Reach it from other devices**: pick a method (Wi-Fi, Tailscale, Cloudflare, your own domain) and it walks the OS-specific steps, then takes the resulting URL.

Every option below is a terminal command, so a headless VPS can both run **and** expose Flight Finder over SSH with no GUI. Opening the URL on a phone needs an **https** one (service workers require a secure context); the LAN option is http and can be opened in the browser but not installed as an app. Pick one:

- **Same network** (http, quickest): find the machine's IP (`hostname -I | awk '{print $1}'` on Linux, `ipconfig getifaddr en0` on macOS) and open `http://<that-ip>:3003` on a phone on the same Wi-Fi.
- **Tailscale** (private https, no domain): install Tailscale on the VPS and your phone, then `tailscale serve 3003` for private https on your tailnet (or `tailscale funnel 3003` to expose it publicly).
- **Cloudflare tunnel** (public https): a throwaway URL with no account is `cloudflared tunnel --url http://localhost:3003` (prints a temporary `https://…trycloudflare.com`). For a **permanent** URL on a domain you've added to Cloudflare:
  ```bash
  cloudflared tunnel login
  cloudflared tunnel create flight-finder
  cloudflared tunnel route dns flight-finder flights.yourdomain.com
  cloudflared tunnel run --url http://localhost:3003 flight-finder
  ```
- **Domain + auto HTTPS** (permanent): point a domain at the server and put [Caddy](https://caddyfile.com) in front. A ready Caddyfile lives at the repo root; it reverse-proxies `localhost:3003` and provisions Let's Encrypt TLS automatically. Replace the site address with your domain.

The installer offers to start the Cloudflare quick tunnel for you at the end, and these same methods are walked step by step in **Instance settings -> Reach it from other devices** inside the app.

Multiple people connect to one instance with multi user mode (see the Multi user mode section below): each gets their own login (or a passwordless tap-to-sign-in face), trackers, profile avatar, and personal light/dark theme.

## Why Flight Finder?

Airlines change flight prices hundreds of times a day. They use dynamic pricing to maximize what you pay. **No one shows you the price trend because the companies with the data profit from hiding it.**

<details>
<summary>The longer version</summary>

1. **Aggregators want you inside their app.** Google Flights and Hopper track price history internally but lock it behind your account.
2. **"Buy or Wait" is more profitable than transparency.** A black-box prediction keeps you dependent on their platform.
3. **Airlines don't want price transparency.** If you can see that a route dips 3 weeks before departure, that undermines dynamic pricing.

Flight Finder exists because the data is useful to *you* -- just not to the companies that have it.
</details>

### What you get

- **Natural language search** -- `"NYC to Paris around June 15 +/- 3 days"`
- **Price evolution charts** -- see how fares move over days and weeks
- **Shareable links** -- send `/q/abc123` to anyone, no login required
- **Direct booking links** -- click any data point to go straight to the airline
- **Airline comparison** -- see which carriers are cheapening vs. getting expensive
- **VPN price comparison** -- test the myth: do prices change when you browse from different countries?
- **Self-hosted** -- your searches stay private, your data stays on your machine
- **Agent-friendly API** -- hook Claude Code, Codex, or any agent into your instance

## VPN Price Comparison

Test the myth that VPN location affects flight prices. Flight Finder can scrape the same query from multiple countries and show the results side by side.

### How it works

1. An [ExpressVPN](https://www.expressvpn.com) sidecar container runs alongside Flight Finder
2. For each scrape run, Flight Finder routes Playwright through the VPN's SOCKS5 proxy
3. All browser signals align to the target country (see full list below)
4. Your local (no VPN) price is always captured as a baseline
5. The chart shows a per-country comparison view

### Anti-detection: what Flight Finder does beyond switching your IP

Changing your IP is not enough. Websites detect mismatches between your IP and browser signals. Flight Finder aligns everything to match the target country:

| Signal | What Flight Finder does |
|--------|-------------------|
| **IP address** | Routed through VPN exit node via SOCKS5 proxy |
| **Timezone** | `timezoneId` set to match the country (e.g. `Europe/Berlin` for DE) |
| **Language** | `Accept-Language` header and `navigator.languages` aligned to locale |
| **Geolocation** | Geolocation API returns capital city coordinates |
| **Google hint** | `gl=` country parameter set on Google Flights URL |
| **WebRTC** | ICE candidates blocked -- real IP never exposed via `RTCPeerConnection` |
| **DNS** | Queries forced through the SOCKS5 proxy (`--host-resolver-rules`) |
| **Canvas fingerprint** | Subtle pixel noise injected per session to randomize `toDataURL` hash |
| **WebGL fingerprint** | Unmasked renderer/vendor strings spoofed via `WEBGL_debug_renderer_info` |
| **AudioContext** | Micro-noise added to `getFloatFrequencyData` output |
| **Screen dimensions** | `screen.width/height`, `outerWidth/Height`, `availWidth/Height` matched to viewport |
| **Exit verification** | After connecting, exit IP is geolocated to verify the country matches |

### Setup

1. During install, say **yes** to "Set up ExpressVPN?" and paste your [activation code](https://www.expressvpn.com/setup) -- or paste it later in **Settings**
2. The VPN sidecar starts automatically with Flight Finder (no extra commands needed)
3. When creating a new tracker, toggle **"Compare prices from different countries"** and pick which countries to compare
4. Each scrape run: local baseline first, then each VPN country sequentially
5. On the chart page, use the **view filter** to switch between:
   - All countries (full detail)
   - Country comparison (cheapest price per country over time)
   - Local only / individual country isolation

<details>
<summary>docker-compose.vpn.yml details</summary>

The VPN sidecar uses [`misioslav/expressvpn`](https://hub.docker.com/r/misioslav/expressvpn) and exposes:
- SOCKS5 proxy on port 1080 (internal, used by Playwright)
- REST API on port 8000 (internal, used by Flight Finder to switch countries)

Requirements:
- `EXPRESSVPN_CODE` in `~/.flight-finder/.env`
- Docker host must have `/dev/net/tun` (kernel TUN module)
- The sidecar needs `NET_ADMIN` capability

Only Playwright traffic goes through the VPN. Database, Redis, and web UI traffic stay on normal Docker networking.
</details>

<details>
<summary>Supported countries</summary>

US, GB, DE, FR, ES, IT, NL, IE, JP, KR, IN, AU, CA, MX, BR, AR, CO, TH, SG, HK

Each country profile aligns: locale, timezone, Accept-Language header, and geolocation to match the VPN exit point. Currency stays user-controlled (independent from VPN country).
</details>

## Requirements

- [Node.js](https://nodejs.org/) >= 22 (for local development; not needed for the Docker install path)
- [Docker Desktop](https://docs.docker.com/get-docker/)
- One of:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (free with Claude Pro/Max)
  - [Codex](https://github.com/openai/codex) (free with ChatGPT Pro)
  - An API key from Anthropic, OpenAI, or Google
  - [Ollama](https://ollama.com), [llama.cpp](https://github.com/ggml-org/llama.cpp), or [vLLM](https://docs.vllm.ai)

<details>
<summary>LLM Providers</summary>

Flight Finder needs an LLM for two things: parsing natural language queries and extracting price data from Google Flights pages.

| Provider | Auth | Cost | Notes |
|----------|------|------|-------|
| **Claude Code** | Auto-detected (host `~/.claude`) | Free (Pro/Max plan) | Subscription CLI |
| **Codex CLI** | Auto-detected (host `~/.codex`) | Free (ChatGPT Pro) | Subscription CLI |
| **Anthropic** | `ANTHROPIC_API_KEY` | Pay-per-token | Claude Haiku 4.5 (default) |
| **OpenAI** | `OPENAI_API_KEY` | Pay-per-token | GPT-4.1 Mini |
| **Google** | `GOOGLE_AI_API_KEY` | Pay-per-token | Gemini 2.5 Flash |
| **Ollama** | None (local) | Free | Select in admin UI |
| **llama.cpp** | None (local) | Free | Select in admin UI |
| **vLLM** | None (local) | Free | GPU-accelerated (port 8000) |
| **OpenAI + custom URL** | `OPENAI_BASE_URL` | Varies | OpenRouter or any OpenAI-compatible endpoint |

**Three ways to use Flight Finder:**

- **Subscription users** (Claude Pro/Max, ChatGPT Pro) -- auto-detected, auth tokens mounted read-only.
- **API key users** -- paste a key, passed via env var, never written to disk.
- **Local model users** -- select Ollama/llama.cpp/vLLM in the admin UI, type your model ID.

**Managing subscription CLIs:** Setup, Settings, and Admin show the installed CLI
version and let you recheck availability without replacing saved choices. Codex
model and thinking choices come from the signed-in account. “Use CLI configuration”
preserves host settings; “Model default” uses the selected model’s reported effort.
Testing a selection uses the account allowance without saving settings or creating
trackers. Ready CLIs appear first in the provider list; project defaults are unchanged.

After setup, administrators can update managed Docker CLIs from the same picker.
The updater installs the exact version in `cli-versions.json` (or the administrator’s
`CODEX_VERSION` / `CLAUDE_CODE_VERSION` override), verifies it, then switches the
executable atomically. Authentication and saved settings are untouched. Existing
searches keep their previous executable, and a failed installation leaves it available.
Container startup also reconciles installed versions when `INSTALL_CLI_PROVIDERS=true`.
Unmanaged installations show an exact command to run on the CLI host instead.
Package-manager restrictions still apply; the updater does not bypass release-age
policies. If an update response is interrupted, recheck the version before retrying.

**Picking a local model (Ollama, llama.cpp, vLLM):**

The parse step needs a model that follows strict JSON instructions. Tiny models tend to ramble or refuse. Stick with current generation families that have reliable structured output. Qwen3 / Qwen3.5 currently have the most stable tool calling and JSON behaviour in the small model class; Gemma 3n / Gemma 4 are strong alternatives with native function calling on the laptop tier.

* **CPU only, tight RAM**: `qwen3:0.6b` (523MB) or `qwen3.5:0.8b` (1.0GB). JSON mode is forced server side, so even these can produce parseable output.
* **CPU only, typical desktop**: `qwen3:1.7b` (1.4GB) or `qwen3:4b` (2.5GB, sweet spot if you have the RAM).
* **CPU or GPU edge (5 to 8GB)**: `gemma3n:e2b` (5.6GB, 32K context) or `gemma4:e2b` (7.2GB, 128K context, newer).
* **GPU (8GB+ VRAM)**: `qwen3.5:9b` (6.6GB, best JSON quality and speed balance), `qwen3:8b` (5.2GB), or `gemma4:e4b` (9.6GB, native function calling).

Avoid models under 1B (TinyLlama, etc.) and older generations (Llama 3.x, Qwen 2.5). They tend to ramble even with JSON mode forcing valid syntax, because the field values still need to be semantically correct. For slow CPUs, bump `EXTRACT_TIMEOUT_MS` in `.env` if larger models keep timing out (default 90000).
</details>

## How It Works

```mermaid
flowchart TD
    U["You type:<br/>SFO to Tokyo sometime in July, +/- 5 days"]
    U --> P["LLM parser<br/>(Claude / GPT / local)"]
    P -->|"origin, destination, date range, flexibility"| N["Playwright<br/>(headless Chromium)"]
    N -->|"navigates Google Flights, captures the page"| X["LLM extractor<br/>(configurable provider)"]
    X -->|"structured prices + booking links"| DB[("PostgreSQL + Prisma<br/>price snapshots over time")]
    DB --> C["Plotly.js chart at /q/id<br/>a shareable public URL"]
    CRON["Cron, every 3h"] -.->|"re-scrapes every active query"| N
```

The built-in cron runs on a configurable interval (default: every 3h). Each run captures prices across all active queries and the chart pages update automatically.

## Scraping Constraints

Flight Finder walks an ordered chain of price sources per query. The chain is admin allowlisted and per user orderable. Each source has different reliability:

| Source           | Default | Reliability     | Notes |
|------------------|---------|-----------------|-------|
| Google Flights   | on      | High            | Three URL rotation + stealth context. Rate limit kicks in around 30 sustained requests per IP. |
| Airline direct   | on      | High when supported | URL templates in `airline-urls.ts`. Falls through to the next source when an airline returns a stub page. |
| Skyscanner       | off     | **Experimental** (40 to 70 percent in burst, drops under sustained load) | Cloudflare interstitials + bot detection. v1 is best effort. |
| Kayak            | off     | **Experimental** (similar to Skyscanner) | PerimeterX bot detection. v1 is best effort. |

Skyscanner and Kayak are off by default. Admin enables them in `/admin/config`; users then order them in `/account/settings`. When a source returns no flights the next source in the chain runs; an `all_filtered_out` result (real flights existed but query filters excluded them) short circuits the chain because changing sources cannot help.

For Skyscanner and Kayak to be production grade you would need residential proxies or paid CAPTCHA solving, neither of which Flight Finder ships. If those sources fail consistently for your route, leave them off.

## Managing Flight Finder

```
Usage: flight-finder [command]

Commands:
  (none)       Start Flight Finder (Ctrl+C to stop)
  search ".."  Search and track a flight from the terminal
  start        Start in background
  stop         Stop -- pauses all price tracking until you start again
  logs         View live logs
  status       Check if running
  update       Pull latest version and restart
  version      Show version and commit
  uninstall    Remove Flight Finder and all data
  help         Show this help

Account recovery (self hosted multi user mode):
  reset-password <username> <password>   Set a new password for a user
  disable-accounts                       Turn multi user mode off (no login required)
```

<details>
<summary>Headless CLI</summary>

Run Flight Finder entirely in the terminal:

```bash
flight-finder --headless                              # Interactive search wizard
flight-finder --headless --backend claude-code        # Use Claude Code as AI backend
flight-finder --headless --backend codex              # Use Codex as AI backend
flight-finder --headless --list                       # Show all tracked queries
flight-finder --headless --view <id>                  # Live price chart (auto-refreshes every 30s)
flight-finder --headless --view <id> --tmux           # Split grouped routes into tmux panes
```

Without `--headless`, `--view` opens the chart in your browser and `--list` opens the admin dashboard.

### Hotel tracking

Hotel tracking is available on self-hosted servers, independently of flights.
The terminal client uses the same account-scoped hotel API as the web app:

```bash
flight-finder hotels search --query "London, October 15–18 2027, two adults, refundable, GBP" --wait --json
flight-finder hotels track <searchId> <offerId> --mode best --target 800
flight-finder hotels browse
flight-finder hotels history <id> --json
flight-finder hotels alerts <id> --target 750 --no-approximate
flight-finder hotels pause <id>
```

Use `--server <url>` or `FLIGHT_FINDER_URL` to select your server. For an
authenticated instance, supply your `ft-session` cookie value through
`FLIGHT_FINDER_SESSION` in the process environment. Private instances additionally
accept the existing `FLIGHT_FINDER_TOKEN` machine access token. Credentials are sent only to the
selected server; redirects are rejected. Hotel commands never change the flight
backend or model configuration. `hotels --help` lists search polling,
cancellation, resume, refresh, delete, and other commands. Structured searches
use `hotels search --file search.json --wait`; see [API.md](API.md) for the full
search format, including multiple rooms, children, flexible dates, and filters.
Hotel searches with `--wait` allow up to 120 minutes by default. Use
`--timeout <minutes>` to change this hotel-only limit; expiration or Ctrl-C
cancels the server search. Flexible dates can take longer because each stay
requires separate provider visits.

#### Hotel results map

Open the map beside your web search results to compare hotel locations. Pins
show complete-stay prices for the selected dates, currency and room allocation.
Select a pin or its keyboard-accessible hotel button to compare room offers.
Hotels at identical coordinates share a counted pin with a hotel chooser;
their offers and tracking actions remain separate.
Moving the map does not start another search. Hotels without verified property
coordinates stay in the list; the app does not geocode addresses or infer
neighborhood boundaries.

Maps load only when opened. OpenFreeMap is the default tile provider. Your
browser sends the provider its IP address and requested map area, without
account details, stay dates, prices, cookies or referrers. Map failures leave
the offer list and tracking controls available.

Save a preferred map style or disable maps from the map preferences panel.
Signed-in users can also change these preferences in Account Settings. Solo
instances store personal preferences in the current browser, separately from
account preferences. Saving a preference does not activate the map.

Administrators can choose a custom provider in Settings → Hotel map provider.
Supply a public HTTPS MapLibre style JSON URL, every resource origin used by
its tiles, sprites and fonts, and the provider's privacy and attribution links.
Same-origin self-hosted resources must live under `/maps/`, for example behind
a reverse proxy. The browser must be able to fetch them without authentication.
Do not enter secret API keys. Map requests reject redirects and origins outside
the allowlist. Custom styles use vector or raster tile sources; imported styles
and embedded GeoJSON, image or video sources are rejected. Saving configuration
does not contact the provider. A stricter deployment CSP must allow the chosen
resource origins in `connect-src`; map workers remain same-origin.

Run `npm run db:push` during deployment to add the separate map configuration
table and account preference fields. Existing flight configuration and hotel
tracker matching stay unchanged.

For local verification, run `npm run ci`. Against a disposable localhost
`hotel_map_test` database with the schema applied, run
`HOTEL_MAP_INTEGRATION_TESTS=1 npm exec --workspace=@flight-finder/web -- vitest run src/lib/hotels/map.integration.test.ts`.
This checks real authorization, stale saves, account isolation and preservation
of flight configuration. Supply the test database connection through your secret
manager; do not point these tests at an instance with real users.

With that isolated instance running in solo mode, run
`HOTEL_MAP_BROWSER_URL=http://127.0.0.1:3017 node scripts/hotel-map-browser-test.mjs`.
The browser suite uses fixed hotel offers and real OpenFreeMap tiles, applies the
production CSP, and writes desktop/mobile screenshots to
`/tmp/flight-finder-hotel-map-browser`. It also checks unavailable maps, missing
coordinates, custom providers, forbidden resources and redirects. Custom-provider
checks temporarily change the local map configuration and restore it afterward.

### Car commands

Car commands use the account-scoped HTTP API and leave flight configuration
unchanged. They accept the same server and credential environment variables as
hotel commands. Start with catalog locations and a reviewed search file:

```bash
flight-finder cars locations "London Heathrow" --json
flight-finder cars parse "A London rental for next weekend" --json
flight-finder cars search --file rental.json --wait --json
flight-finder cars protection <searchId> <offerId> --json
flight-finder cars protect <searchId> <offerId> <choiceId> --review <choiceReview> --wait
flight-finder cars track <searchId> <offerId> --mode best --target 300 --currency GBP
flight-finder cars browse
flight-finder cars view <id> --json
flight-finder cars alerts <id> --revision 7 --target 280 --currency GBP
flight-finder cars refresh <id> --revision 8
flight-finder cars retry /app/data/car-receipts/<requestId>.json --json
```

`parse` produces a draft for review. It does not select a catalog location or
start a search. Use the public search shape in [API.md](API.md), with catalog
`id` and `version` values from `locations`. Input files and stdin (`--file -`)
are limited to 64 KiB. Amounts use decimal major units with an explicit currency;
the client converts them to exact integer minor units.

`protection` prints the selected rental's full price evidence and observed
protection options, including terms, policy links, observation time and extra
price. Review a choice before passing its `review` value to `protect`. That
command checks the same base rental with the chosen product and a fresh total;
it does not reserve a car or purchase coverage. The observed extra is never
presented as a verified combined price.

After the protected search finishes, run `protection` with its new search ID
and an offer ID. Review the fresh terms, full total, payment timing, deposit
and requirements. Pass its `trackingReview` value to
`cars track <searchId> <offerId> --review-protection <trackingReview>`.
Reviews apply to the exact server, account and displayed content. Changed
terms or prices require another review. Base rentals need no protection flag.
Closed or ineligible results remain inspectable but cannot start new tracking.
After a lost acknowledgement, use the saved receipt with `retry`; recovery
does not require a new review or an unexpired original quote.

`browse` opens a keyboard-driven tracker list with paged results and price
evidence. Enter opens history; arrow keys scroll, and `r` reloads server state.
Press `l` in a tracker to review pickup and return search locations, local dates,
and timezones. Arrow keys scroll the location view; Escape returns to history.
In a tracker, `p` pauses or resumes, `c` checks prices, and `x` deletes it.
Each change shows the account, target, and saved revision and requires typing
`yes`. Escape dismisses the confirmation without sending anything.

Press `t` to select a recovery receipt by path or by its displayed number.
Review the saved request, then confirm to replay it unchanged. An uncertain
refresh still allows pause or delete, while another refresh requires recovery
first. Uncertain edits block conflicting changes until their receipts are
recovered. If recovery reports a stale revision, reload and review the current
settings before confirming a new change. The earlier outcome remains unproven.
Account changes hide private data. Exiting stops local requests and prints the
retained receipt paths; server work continues. Use `list` and `view` with
`--json` when an interactive terminal is unavailable.

Before changing tracking state, the CLI prints a private recovery receipt path.
After a timeout or lost response, use `cars retry <receipt>` with the
original server and account. Repeating `search`, `protect`, `track`, or `refresh` starts a
new request. Receipts contain request data, never cookies or access tokens.
The installed CLI stores them under `/app/data/car-receipts` and refuses
mutations if that persistent volume is missing. Direct Node CLI use defaults
to `~/.flight-finder-car-receipts`; `--receipt-dir` selects another private
directory whose parent already exists.

Use the revision returned by `view` for changes to existing trackers. A stale
revision reports the current state when it can be read, without claiming that
an earlier request succeeded. A 404 means access is unavailable; it does not
prove deletion. A 410 means the original resource was removed and its receipt
cannot create a replacement. Receipts remain available after successful replay.

`--wait` polls for up to 120 minutes. Ctrl-C or timeout stops local polling and
leaves the server search running. Use `cars results <searchId>` to return to it,
or `cars cancel <searchId>` to cancel it explicitly. `cars --help` lists paging,
pause/resume, deletion, renaming, and administrator reassignment commands.

**Features:**
- Natural language search, same as the web
- Braille chart with per-airline colored trend lines
- Live refresh with countdown bar
- Multi-destination ("Frankfurt to Bogota or Medellin")
- tmux integration for grouped routes
- Backend selection: `--backend claude-code|codex|anthropic|openai|google|ollama|llamacpp|vllm`

<img src="packages/cli/demo/flight-finder-demo.gif" alt="Flight Finder CLI" width="100%">
</details>

<details>
<summary>Configuration</summary>

All settings are in `~/.flight-finder/.env` (generated by the installer):

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | -- | Anthropic API key |
| `OPENAI_API_KEY` | -- | OpenAI API key |
| `OPENAI_BASE_URL` | -- | Custom endpoint (vLLM, OpenRouter) |
| `GOOGLE_AI_API_KEY` | -- | Google AI API key |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server address |
| `POSTGRES_PASSWORD` | `postgres` | Database password |
| `ADMIN_PASSWORD` | Auto-generated | Admin panel password |
| `CRON_ENABLED` | `true` | Enable built-in scrape scheduler |
| `CRON_INTERVAL_HOURS` | `3` | Hours between scrape runs |
| `HOST_PORT` | `3003` | Host port for Flight Finder |
| `EXPRESSVPN_CODE` | -- | ExpressVPN activation code (for VPN comparison) |
</details>

<details>
<summary>Multi user mode (households)</summary>

Self-hosting Flight Finder with your spouse, your roommates, or your whole
family? Multi user mode gives each person their own login, their own
trackers, and their own preferences. Everyone watches their own flights, hotels, and cars
without seeing each other's dashboards. You stay admin.

#### When you want this

- Two or more people sharing one self-hosted instance
- Each person chooses which flights, hotels, or cars to track
- Different default currencies or preferred airlines per person
- You want the admin panel back to yourself

If you're the only user, leave it off — solo mode is simpler.

#### Turning it on

You can enable multi user mode two ways:

1. **During setup**: the last (optional) step of the setup wizard asks
   "Run Flight Finder for a household?". Flip it on, pick a username and
   password, and you're done.
2. **Later from Settings**: open `/settings` -> Multi user mode and
   toggle it on. Same form, no restart needed.

When you enable, three things happen atomically:

1. Your first admin User is created (the username and password you typed)
2. `ExtractionConfig.multiUserMode` flips to true
3. Every existing tracker you already had is reassigned to your new
   admin account, so nothing disappears

#### Day to day

Once enabled, Flight Finder behaves like a normal multi-account app:

- `/login` replaces the password-only admin form — same page for admins
  and non-admins (post-login redirect picks `/admin` vs `/account` based
  on the user's role)
- Each user has `/account` showing only their own trackers, reached from
  an avatar menu in the top-right that is the same on every page
- Each user has `/account/settings` for currency, country, preferred
  airlines, cabin class, and a **personal theme**. Themes come as colour
  families (Altitude, Midnight, Cyberpunk, Tron, Autumn, Solar), each with
  a matching light and dark palette; the toggle flips within the chosen
  family. Members override the admin's instance default with their own.
- Members can be **passwordless**: leave their password blank and the
  `/login` screen becomes a "Who's using Flight Finder?" picker where each
  person taps their face to sign in, Netflix style. Add a password only if
  the instance is exposed to the public internet.
- You (admin) get a new `/admin/users` page to add household members,
  reset their passwords, promote them to admin, or delete them
- The landing search bar is gated on a session — anonymous `POST
  /api/queries` returns 401 so no orphan trackers leak in
- Share links `/q/[id]` stay public — that's the whole point of a share
  link; you can still send a chart to anyone

A one-time banner on `/admin/users` reminds you to reassign any trackers
that got backfilled to you but actually belong to a household member.
Click into `/admin/queries`, edit the tracker, set `userId` to the
right person.

#### What it does NOT do

- It is **not** offered on flight-finder.org — the public site is single
  tenant by design and will never have signup
- It does **not** introduce email, password reset flows, or OAuth —
  admin creates accounts manually and resets passwords from the panel
- It does **not** restrict cron, the headless CLI's read views, or
  share links — those work the same in both modes

#### Locked out?

Forgot the admin password, or want the accounts gone entirely? Two recovery
commands run from the host. They exec inside the `web` container, so it has
to be running:

```bash
flight-finder reset-password <username> <new-password>   # set a known password, keep accounts
flight-finder disable-accounts                           # turn multi user mode off entirely
```

`reset-password` sets a new password for any user; log in with it, then
manage everyone else from `/admin/users`. `disable-accounts` flips multi
user mode off and clears the stored admin credential, dropping the instance
back to solo self hosted mode where no login is required at all. Your
trackers survive either way. (The password you pass to `reset-password`
is visible in your shell history and in the host process list while the
command runs, so treat it as throwaway and change it once you are back in.)

Never enabled multi user mode and forgot the solo admin password instead?
Set `ADMIN_PASSWORD` in `~/.flight-finder/.env` and restart.

#### Screenshots

<details>
<summary>Setup wizard - new "Accounts" step</summary>

The wizard gets one new optional step at the end (self-hosted only).
Skip it if you're solo.

<img src="assets/accounts/03-setup-step3-accounts-skip.png" alt="Setup wizard accounts step (skip)" width="100%">

Flip the toggle on and the form expands for the admin username and
password:

<img src="assets/accounts/04-setup-step3-accounts-fill.png" alt="Setup wizard accounts step (filled)" width="100%">

</details>

<details>
<summary>Login - unified form</summary>

One login page for everyone. Post-login redirect picks `/admin` or
`/account` based on whether the user is admin.

<img src="assets/accounts/05-login-empty.png" alt="Unified login form" width="100%">

</details>

<details>
<summary>Admin dashboard - new "Users" link</summary>

The admin nav gets a "Users" link and a Logout button in multi user
mode (the existing self-hosted nav had no logout because there was no
session).

<img src="assets/accounts/06-admin-dashboard-with-users-link.png" alt="Admin dashboard with Users link" width="100%">

</details>

<details>
<summary>Admin users page - backfill banner + table</summary>

First visit after enabling shows a dismissible banner with the backfill
count. Add new household members with the form below.

<img src="assets/accounts/07-admin-users-empty.png" alt="Admin users page with backfill banner" width="100%">

After adding a second user:

<img src="assets/accounts/09-admin-users-with-partner.png" alt="Admin users page with two users" width="100%">

</details>

<details>
<summary>Settings - multi user mode section</summary>

Once enabled, Settings shows a link to the user management page.

<img src="assets/accounts/10-settings-multi-user-enabled.png" alt="Settings multi user mode section" width="100%">

</details>

<details>
<summary>Account - per user trackers</summary>

Each non-admin user sees only their own trackers. Empty state for a
new account looks like this:

<img src="assets/accounts/11-account-empty-partner.png" alt="Account page empty state for a non-admin user" width="100%">

The matching settings page lets each person set their own defaults:

<img src="assets/accounts/12-account-settings-partner.png" alt="Account settings form for currency, country, airlines, cabin class" width="100%">

</details>

<details>
<summary>Landing - welcome line for logged-in users</summary>

Small "Signed in as ..." line replaces the silent state from solo
mode, with quick links to `/account` and logout.

<img src="assets/accounts/13-landing-signed-in.png" alt="Landing page welcome line" width="100%">

</details>

</details>

<details>
<summary>Why self-host instead of using flight-finder.org?</summary>

- **It can't work any other way.** A centralized service scraping Google Flights gets IP-banned within days. Thousands of self-hosted instances, each making a few quiet requests from different IPs, is the only architecture that survives.
- **Your searches stay private.** No one sees what routes you're watching.
- **You control the scrape frequency.** Default is every 3 hours. Want every hour? Change one setting.
- **Free with Claude Code, Codex, or a local model.**
- **Your data, your database.** Price history lives in your own Postgres.
</details>

<details>
<summary>Community Data</summary>

Flight Finder is fully decentralized. You run everything on your own machine.

**Why share?** The price trail gets richer the more instances pool their history. When you opt in, your anonymized data points join a shared fare dataset everyone can explore, and you get community prices back on routes you have not scraped yourself. It is genuinely opt-in, reversible any time, and never touches anything personal.

**flight-finder.org** aggregates anonymized price data that self-hosted instances **opt in** to share.

**What gets shared (opt-in only):** route, travel date, price, currency, airline, stops, cabin class, scrape timestamp.

**What is never shared:** your queries, search history, preferences, API keys, IP address, or identity.

Turn on **Community Data Sharing** in Settings (or during setup) to contribute. If you run a shared hub that other instances contribute to, enable **Accept community registrations** in the same panel (off by default; rate limited and globally capped). Explore community data at [flight-finder.org/explore](https://flight-finder.org/explore).
</details>

<details>
<summary>Agent & CLI Integration</summary>

Your local instance exposes a REST API. See [`API.md`](API.md) for the full reference.

```bash
# Parse a natural language query
curl -s -X POST http://localhost:3003/api/parse \
  -H "Content-Type: application/json" \
  -d '{"query": "NYC to Paris around June 15 +/- 3 days"}' | jq .

# Create a tracked query
curl -s -X POST http://localhost:3003/api/queries \
  -H "Content-Type: application/json" \
  -d '{ ... }' | jq .

# Trigger an immediate scrape
curl -s http://localhost:3003/api/cron/scrape \
  -H "Authorization: Bearer $CRON_SECRET" | jq .

# Get price data
curl -s http://localhost:3003/api/queries/{id}/prices | jq .
```
</details>

<details>
<summary>Settings</summary>

Access at `/admin` (no login required on self-hosted instances):

- **Manage queries** -- pause, resume, delete, adjust scrape frequency
- **Configure LLM** -- choose extraction provider and model
- **Monitor costs** -- see LLM API usage per scrape run
- **View fetch history** -- success/failure status, errors, snapshot counts
- **VPN setup** -- paste ExpressVPN activation code, configure default countries
</details>

## Development

Requires Node.js >= 22.

Shared scripts read configuration from the caller's environment. Supply
`DATABASE_URL`, optional `REDIS_URL`, and any credentials needed for the command
through your shell, container, or secret manager. No Infisical or Doppler account
is required. If you use a secret manager, wrap the npm command externally with
your own project configuration. Do not commit credentials.

```bash
npm install
docker compose up -d db redis
npm run db:push
npm run db:generate
npm run dev
```

<details>
<summary>Tech Stack</summary>

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 15 (App Router), TypeScript, CSS Modules |
| Database | PostgreSQL 16 + Prisma ORM |
| Cache | Redis 7 (optional) |
| Browser | Playwright (headless Chromium) |
| LLM | Anthropic, OpenAI, Google, Claude Code, Codex, Ollama, llama.cpp, or vLLM |
| Charts | Plotly.js (interactive) |
| Cron | Built-in (node-cron) or external trigger |
| VPN | ExpressVPN sidecar (Docker, SOCKS5 proxy) |
</details>

### Image verification and staging

CI builds and stages images on disposable GitHub-hosted runners. The integration
job verifies the exact image ID and commit, then runs API and browser checks.
Installer smoke tests run separately on a disposable runner. CI does not SSH to
the production host or prune its Docker caches.

The Docker workflow resolves one full commit SHA before building both CPU
architectures. Deploy by registry digest, not by `latest` or a mutable SHA tag:

```bash
# After CI and the Docker publication workflow succeed for the selected SHA:
docker buildx imagetools inspect ghcr.io/affromero/flight-finder:<full-SHA>
docker pull ghcr.io/affromero/flight-finder@sha256:<manifest-digest>
```

Images carry an `org.opencontainers.image.revision` label. Verify that label
against the intended full commit SHA and verify `/api/version` after starting
the image. A registry digest identifies the exact published artifact; a local
image ID identifies the exact artifact used by staging. Deployment credentials,
host configuration and personal deployment tooling are not part of this workflow.

For local staging, explicitly opt into a disposable Docker daemon:

```bash
FLIGHT_FINDER_DISPOSABLE_DOCKER=1 bash scripts/staging-test.sh \
  sha256:<local-image-id> <full-SHA>
python3 -m unittest discover -s scripts -p 'test_deploy*.py' -v
```

## Contributing

Pull requests welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

<details>
<summary>Why Playwright + LLM Instead of Google's Internal API?</summary>

Google Flights has an undocumented internal API that returns structured JSON without a browser. The [`fli`](https://github.com/punitarani/fli) project reverse-engineers it. We investigated and decided against it.

**What the direct API gives you:** sub-second searches, no browser, no LLM cost.

**What it costs you:**

|  | Flight Finder | [fli](https://github.com/punitarani/fli) |
|---|---|---|
| Approach | Playwright + LLM extraction | Reverse-engineered internal API |
| Speed | 3-10s per search | Sub-second |
| Booking links | Yes | No |
| Currency control | Yes (`&curr=`, `&gl=` params) | No |
| Fare class / cabin | Yes | No |
| Seats remaining | Yes | No |
| VPN comparison | Yes (Docker sidecar) | No |
| Price tracking | Built-in (cron + Postgres) | Manual |
| Shareable charts | Yes (`/q/[id]`) | No |

Both approaches share the same risk: Google can break either one at any time. We'd rather depend on the stable, public-facing UI than on undocumented internal array positions.

**Use Flight Finder if** you want to track prices over time, see trends, get booking links, and share charts.

**Use [fli](https://github.com/punitarani/fli) if** you want instant programmatic lookups from scripts.
</details>

## Related Projects

| Project | Description |
|---------|-------------|
| [**fli**](https://github.com/punitarani/fli) | Google Flights API reverse-engineering (Python) |
| [**jetlog**](https://github.com/pbogre/jetlog) | Self-hosted personal flight journal with world map and stats |
| [**PriceToken**](https://github.com/affromero/pricetoken) | Real-time LLM pricing API, npm/PyPI packages, and live dashboard |
| [**gitpane**](https://github.com/affromero/gitpane) | Multi-repo Git workspace dashboard for the terminal |
| [**kin3o**](https://github.com/affromero/kin3o) | AI-powered Lottie animation generator CLI |

<details>
<summary>Disclaimer & Legal</summary>

**Flight Finder is an informational tool only.** Flight prices shown are scraped from third-party sources and may be inaccurate, outdated, or incomplete. Airlines change prices based on demand, search history, seat availability, and other factors. **Do not make purchasing decisions based solely on Flight Finder data.** Always verify prices directly with the airline before buying.

Flight Finder is a personal tool that scrapes publicly available flight pricing data. In the US, scraping publicly accessible websites does not violate the [Computer Fraud and Abuse Act](https://en.wikipedia.org/wiki/Computer_Fraud_and_Abuse_Act) ([*hiQ Labs v. LinkedIn*, 9th Cir. 2022](https://en.wikipedia.org/wiki/HiQ_Labs_v._LinkedIn)). Flight Finder does not circumvent any login, paywall, or technical access control.

**Users are solely responsible for complying with the terms of service of any website they interact with through Flight Finder.** This project is not affiliated with Google, any airline, or any travel booking platform.

This software is provided as-is for personal and educational use.
</details>

## License

MIT
