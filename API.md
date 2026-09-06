# Flight Finder API Reference

> For agents, scripts, and CLI tools interacting with a local Flight Finder instance.

Base URL: `http://localhost:3003` (or whatever `HOST_PORT` is set to in `.env`)

All endpoints return JSON: `{ "data": {...} }` on success, `{ "error": "message" }` on failure.

Auth requirements depend on mode and endpoint family:
- `/api/cron/scrape` always requires `Authorization: Bearer <CRON_SECRET>`.
- `/api/admin/*` routes require an admin session cookie.
- `/api/analytics/track` is gated to internal callers via `ADMIN_SESSION_SECRET`.
- `/api/community/ingest` requires a registered community API key.
- `/api/community/register` requires `COMMUNITY_REGISTRATION_OPEN=true` and passes rate limiting.
- In multi user mode (`ExtractionConfig.multiUserMode = true`), `POST /api/queries`, `GET /api/alerts`, `GET /api/queries/active`, and `POST /api/queries/{id}/scrape` require a valid user session.
- All other endpoints listed below are public (no auth required).

---

## Endpoints

### Parse a flight query

Converts natural language into structured flight data using your configured LLM.

```
POST /api/parse
Content-Type: application/json

{
  "query": "NYC to Paris around June 15 ± 3 days"
}
```

**Response:**

```json
{
  "data": {
    "routes": [
      {
        "origin": "JFK",
        "originName": "New York JFK",
        "destination": "CDG",
        "destinationName": "Paris Charles de Gaulle"
      }
    ],
    "dateFrom": "2026-06-12",
    "dateTo": "2026-06-18",
    "flexibility": 3,
    "cabinClass": "economy",
    "tripType": "round_trip",
    "currency": "USD",
    "maxPrice": null,
    "maxStops": null,
    "preferredAirlines": [],
    "timePreference": "any",
    "message": "Searching JFK → CDG around June 15 ± 3 days",
    "needsClarification": false
  }
}
```

If `needsClarification` is `true`, the response includes a `message` asking the user to clarify. You can continue the conversation by passing `conversationHistory`:

```json
{
  "query": "the second one",
  "conversationHistory": [
    { "role": "user", "content": "NYC to somewhere warm" },
    { "role": "assistant", "content": "Did you mean Miami, Cancun, or San Juan?" }
  ]
}
```

---

### Create a tracked query

Creates a flight price tracker that will be scraped on each cron run.

```
POST /api/queries
Content-Type: application/json

{
  "rawInput": "NYC to Paris around June 15 ± 3 days",
  "dateFrom": "2026-06-12",
  "dateTo": "2026-06-18",
  "flexibility": 3,
  "cabinClass": "economy",
  "tripType": "round_trip",
  "currency": "USD",
  "routes": [
    {
      "origin": "JFK",
      "originName": "New York JFK",
      "destination": "CDG",
      "destinationName": "Paris Charles de Gaulle",
      "selectedFlights": []
    }
  ]
}
```

**Optional fields:** `maxPrice` (number), `maxStops` (number), `preferredAirlines` (string[]), `timePreference` (string).

**Response:**

```json
{
  "data": {
    "queries": [
      {
        "id": "clxyz...",
        "origin": "JFK",
        "originName": "New York JFK",
        "destination": "CDG",
        "destinationName": "Paris Charles de Gaulle",
        "deleteToken": "uuid-for-deletion"
      }
    ]
  }
}
```

Save the `id` to check prices later. Save the `deleteToken` if you want to delete the query.

**Multi user mode:** if a self hosted instance has multi user mode enabled
(`ExtractionConfig.multiUserMode = true`), unauthenticated POSTs return
`401 Sign in to create a tracker`. Authenticate first via
`POST /api/auth/login` and reuse the `ft-session` cookie. The bundled
headless CLI (`flight-finder --headless`) talks directly to Postgres and
auto-attaches new trackers to the first admin user in multi user mode,
so it keeps working without auth. Solo and hosted deployments are
unaffected.

---

### Get price data

Returns all price snapshots for a tracked query. This is the data that powers the chart.

```
GET /api/queries/{id}/prices
```

**Response:**

```json
{
  "data": {
    "query": {
      "id": "clxyz...",
      "origin": "JFK",
      "destination": "CDG",
      "dateFrom": "2026-06-12",
      "dateTo": "2026-06-18",
      "cabinClass": "economy",
      "active": true
    },
    "snapshots": [
      {
        "travelDate": "2026-06-14",
        "price": 487,
        "currency": "USD",
        "airline": "Delta",
        "stops": 1,
        "duration": "7h 30m",
        "layovers": [{ "duration": "1h 35m", "airport": "ORD" }],
        "bookingUrl": "https://...",
        "scrapedAt": "2026-03-08T12:00:00Z"
      }
    ],
    "snapshotCount": 42,
    "lastChecked": "2026-03-08T12:00:00Z",
    "lastStatus": "success"
  }
}
```

---

### Trigger a scrape

Runs the scraper across all active queries immediately. Requires `CRON_SECRET`.

```
GET /api/cron/scrape
Authorization: Bearer <CRON_SECRET>
```

**Response:**

```json
{
  "data": {
    "queriesProcessed": 5,
    "successful": 4,
    "partial": 1,
    "failed": 0,
    "totalSnapshots": 28,
    "totalCost": 0.003
  }
}
```

The `CRON_SECRET` is auto-generated on first run and printed in Docker logs. You can also set it explicitly in `.env`.

---

### Health check

```
GET /api/health
```

**Response:**

```json
{
  "data": {
    "status": "ok",
    "database": "connected",
    "redis": "connected"
  }
}
```

`redis` may be `"disabled"` if Redis is not configured (app works fine without it).

---

### Delete a query

```
DELETE /api/queries/{id}
Content-Type: application/json

{
  "deleteToken": "uuid-from-creation"
}
```

---

### Admin endpoints

These require an admin session cookie (set via `/admin` login). Useful for programmatic management but not typically needed by agents.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/queries` | GET | List all tracked queries |
| `/api/admin/queries/{id}` | PATCH | Update query (pause/resume) |
| `/api/admin/queries/{id}` | DELETE | Delete query (admin auth) |
| `/api/admin/config` | GET | Get extraction config |
| `/api/admin/config` | PATCH | Update LLM provider/model |
| `/api/admin/providers` | GET | List available LLM providers |

---

## Typical agent workflow

```
1. POST /api/parse        → parse "NYC to Paris in June"
2. POST /api/queries       → create tracker from parsed result
3. GET  /api/cron/scrape   → trigger immediate scrape (optional)
4. GET  /api/queries/{id}/prices → read price data
5. (wait hours/days)
6. GET  /api/queries/{id}/prices → check for price changes
```

The built-in cron (default: every 3 hours) handles step 3 automatically. You only need to trigger a manual scrape if you want data immediately.

---

## Environment variables for agents

| Variable | Default | Purpose |
|----------|---------|---------|
| `FLIGHT_FINDER_URL` | `http://localhost:3003` | Base URL of the Flight Finder instance |
| `CRON_SECRET` | Auto-generated | Required for triggering scrapes |

---

## Rate limits

- Parse: No limit (bounded by LLM cost)
- Query creation: No limit
- Scrape trigger: One at a time (subsequent calls queue)
- Price reads: Cached for 2 minutes

---

## Data model

### Self-hosted hotel tracking

Hotel routes require a self-hosted instance. When accounts are enabled, include
the current account session (`Cookie: ft-session=<value>`). Ownership is enforced by the server.
The public Flight Finder website does not expose these routes.

Structured searches read Google Hotels and Booking.com in a headless browser;
they do not call an AI backend. Natural-language parsing uses the existing
configured provider and model without changing flight settings. Packages and
hotel bookings are not supported; offers link to the seller to complete a booking.

| Method and path | Purpose |
|---|---|
| `POST /api/hotels/parse` | Parse `{ "text": "hotel request" }` into `{ search }` |
| `POST /api/hotels/search` | Start a structured search; returns HTTP 202 with `{ id, status }` |
| `GET /api/hotels/search/:id` | Read status, offers, provider errors, and progress |
| `DELETE /api/hotels/search/:id` | Cancel a search |
| `POST /api/hotels` | Track `{ searchId, offerId, mode, targetPrice, notifyLows, allowApproximateAlerts, scrapeInterval }` |
| `GET /api/hotels` | List the current user's trackers |
| `GET /api/hotels/:id` | Read tracker, snapshots, check runs, and notification readiness |
| `PATCH /api/hotels/:id` | Update `active`, `targetPrice`, `notifyLows`, `allowApproximateAlerts`, or `scrapeInterval` |
| `DELETE /api/hotels/:id` | Delete a tracker and its history |
| `POST /api/hotels/:id/scrape` | Queue a fresh check |

All responses use `{ "ok": true, "data": ... }` or
`{ "ok": false, "error": "..." }`. Search states are `queued`, `running`,
`success`, `partial`, `unavailable`, `failed`, and `cancelled`. A partial result
includes usable offers alongside explicit provider errors; unavailable inventory
is separate from an extraction failure. A result contains `offers`, `errors`,
`completed`, and `total`.

Example structured hotel search (also accepted by the CLI's `--file` option):

```json
{
  "destination": "London",
  "dateMode": "fixed",
  "checkIn": "2027-10-15",
  "checkOut": "2027-10-18",
  "flexibility": 0,
  "minNights": 3,
  "maxNights": 3,
  "rooms": [{ "adults": 2, "children": [8] }, { "adults": 1, "children": [] }],
  "currency": "GBP",
  "sources": ["google_hotels", "booking"],
  "filters": {
    "maxTotal": null,
    "refundable": true,
    "breakfast": false,
    "minStars": 4,
    "minRating": 8,
    "excludedSellers": [],
    "amenities": ["parking"]
  }
}
```

Children are represented by ages within their room. `dateMode` can also be
`nearby` (shift dates by `flexibility` days) or `window` (stays between
`minNights` and `maxNights` within the date window). The server bounds the number
of date/source combinations to 24 and checks up to eight discovered properties
per source and stay. This is bounded discovery, not a complete inventory scan.
Saved trackers revisit their selected property. Google Hotels supports one room;
Booking.com supports up to four, with child ages assigned to each room. A source
that cannot verify the requested allocation reports an error. Amenities are
`parking`, `pool`, `pets`, and `accessible`.
Unknown offer details do not satisfy an active filter. Prices and targets refer
to the total stay for the requested room allocation, including mandatory taxes.

Tracking mode `best` follows the cheapest qualifying offer for a hotel; `room`
follows the selected room/rate. `scrapeInterval` is in hours. Set `targetPrice`
to `null` to remove a target. Target alerts fire on the first valid observation
at or below target and rearm after a complete, valid above-target observation. Approximate
matches require explicit `allowApproximateAlerts: true` to trigger alerts.
Failed channel deliveries retry after five minutes; successful channels are
remembered so a retry does not resend to them. An instance crash between sending
and saving the delivery acknowledgement can still produce a duplicate.

### Flight records

- **Query**: A tracked flight route with date range, cabin class, and preferences
- **PriceSnapshot**: A single price observation (airline, price, date, stops, booking URL)
- **FetchRun**: Metadata for each scrape run (status, timing, cost)

Each scrape run captures current prices for all active queries. Over time, this builds a price evolution timeline visible at `/q/{id}`.
