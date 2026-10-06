# Fork contributions

Flight Finder retains its MIT license and credits the people whose fork work
informs upstream integrations. Source links identify the reviewed revisions.

| Contributor | Source | Upstream work |
| --- | --- | --- |
| [sammorris01](https://github.com/sammorris01) | [Pushover commit](https://github.com/sammorris01/flight-finder/commit/dbf40dcb36f64e6cfa3b4ead606cf7912a1b8450) | [Pushover sender](../../apps/web/src/lib/notifications/channels/pushover/send.ts). Sam's original channel encrypted credentials; upstream adaptations add emergency settings, guarded acknowledgments and localized admin integration. Tracking issue [#258](https://github.com/affromero/flight-finder/issues/258). |
| [sammorris01](https://github.com/sammorris01) | [Latest-price card](https://github.com/sammorris01/flight-finder/blob/d2536f7750cdca00c4715d23e851e6c78102f21b/apps/web/src/components/BestPrice.tsx) | [Latest observed fares](../../apps/web/src/lib/flight-pricing.ts), inspired by Sam's change to use recent fares in the booking card. Upstream selection preserves independent dates and VPN observations, reconciles legacy identities and compares one currency. Historical lows remain dated information. Tracking issue [#255](https://github.com/affromero/flight-finder/issues/255). |
| [sammorris01](https://github.com/sammorris01) | [Missing-flight inference](https://github.com/sammorris01/flight-finder/commit/016e41f8deba025f557ed1b62e64bf5a41913b39), [flight deduplication](https://github.com/sammorris01/flight-finder/commit/9bcefe85d9a3139b59bb1cb7fe92d512199670ba) | The audit of [canonical scraping](../../apps/web/src/lib/scraper/run-scrape.ts) found that identity-aware deduplication and failed/unsampled date protection were already covered upstream. The adaptation retains successful fares when another airline fails, prevents disappearance inference on partially checked dates, and records partial-run diagnostics. [PostgreSQL regressions](../../apps/web/src/lib/travel/flights.integration.test.ts) exercise both source orders, mixed dates, recovered fallback, stale criteria and unsafe cleanup. Tracking issue [#256](https://github.com/affromero/flight-finder/issues/256). |

Chart improvements credit [sammorris01](https://github.com/sammorris01) for
[flight traces](https://github.com/sammorris01/flight-finder/blob/d2536f7750cdca00c4715d23e851e6c78102f21b/apps/web/src/components/PriceChart.tsx)
and [shared preferences](https://github.com/sammorris01/flight-finder/blob/d2536f7750cdca00c4715d23e851e6c78102f21b/apps/web/src/lib/useTrackerView.ts).
Tracking issue [#257](https://github.com/affromero/flight-finder/issues/257).
The [chart view](../../apps/web/src/lib/chart/view.ts) preserves airline grouping
as the default and adds optional flight grouping with shared history visibility.
The [axis labels](../../apps/web/src/lib/chart/axis.ts) show local offsets while
retaining absolute observation times through daylight-saving changes.
The upstream adaptation also keeps mixed currencies separate and selects the
clicked flight's booking link when unified tooltips contain several flights.
Chart screenshots: [before](screenshots/flight-chart-before.png),
[desktop](screenshots/flight-chart-desktop.png),
[mobile](screenshots/flight-chart-mobile.png).

Departure criteria credit [sammorris01](https://github.com/sammorris01) for
[shared flight filtering](https://github.com/sammorris01/flight-finder/commit/743fdd38aa6c83331634ef44808fd55346a28637)
and the [departure-window contribution](https://github.com/sammorris01/flight-finder/commit/51e401aeca15e6f3abcc4cc9096e214855d16121).
The upstream adaptation adds an explicit strict option, airport-local clock
validation, web and CLI history filtering, preview isolation and audited edits.
The existing soft preference remains the default. Tracking issue
[#254](https://github.com/affromero/flight-finder/issues/254).

Tracker recipient controls credit [ssantss (Santiago Jimenez)](https://github.com/ssantss)
for the [per-query WhatsApp recipients](https://github.com/ssantss/flight-finder/blob/561a4941fcd25c0b6ed33f26f0a01ce306ef7743/apps/web/src/app/api/queries/%5Bid%5D/whatsapp/route.ts)
and [recipient model](https://github.com/ssantss/flight-finder/blob/561a4941fcd25c0b6ed33f26f0a01ce306ef7743/apps/web/prisma/schema.prisma).
[sammorris01](https://github.com/sammorris01)'s
[tracker and flight alert rules](https://github.com/sammorris01/flight-finder/blob/d2536f7750cdca00c4715d23e851e6c78102f21b/apps/web/src/lib/notifications/rules.ts)
provide related alert context. The upstream
[subscription policy](../../apps/web/src/lib/notifications/subscriptions/policy.ts)
adapts tracker recipients to every existing channel type, with independent
revisions, owner and capability authorization, explicit mute, and guarded
outbox delivery. Source forks did not implement this generic policy model.
Tracking issue [#259](https://github.com/affromero/flight-finder/issues/259).

WhatsApp channels credit [ssantss (Santiago Jimenez)](https://github.com/ssantss)
for the [phone and group gateway transport](https://github.com/ssantss/flight-finder/blob/561a4941fcd25c0b6ed33f26f0a01ce306ef7743/apps/web/src/lib/notifications/whatsapp-alert.ts).
The upstream [sender](../../apps/web/src/lib/notifications/channels/whatsapp/send.ts)
preserves the gateway's endpoints, JSON fields and API key header. The adaptation
uses one encrypted destination per channel, existing delivery receipts,
owner-aware network validation, cancellation and localized flight text.
Tracker links require an explicit option. Configuration and compatibility are
documented in the [API guide](../../API.md#configure-a-whatsapp-gateway-channel).
Tracking issue [#260](https://github.com/affromero/flight-finder/issues/260).

Configurable price rules credit [sammorris01](https://github.com/sammorris01) for
the [rule evaluator](https://github.com/sammorris01/flight-finder/blob/d2536f7750cdca00c4715d23e851e6c78102f21b/apps/web/src/lib/notifications/rules.ts),
[tracker API](https://github.com/sammorris01/flight-finder/blob/d2536f7750cdca00c4715d23e851e6c78102f21b/apps/web/src/app/api/queries/%5Bid%5D/alerts/route.ts)
and [alert editor](https://github.com/sammorris01/flight-finder/blob/d2536f7750cdca00c4715d23e851e6c78102f21b/apps/web/src/components/AlertsButton.tsx).
The upstream [rules](../../apps/web/src/lib/notifications/rules/record.ts)
preserve target, absolute-drop and percentage-drop conditions while adding
transactional events, explicit currency and identity boundaries, independent
configuration revisions and guarded recipient receipts. The
[editor](../../apps/web/src/components/notifications/TrackerPriceRules.tsx)
supports owner and capability access in all five languages. Tracking issue
[#261](https://github.com/affromero/flight-finder/issues/261).

Mullvad via Tailscale credits [Sebastian Bolanos (sbc64)](https://github.com/sbc64)
for the [source contribution](https://github.com/sbc64/flight-finder/commit/a1dd976b8fbf0bd011c485d50d82aeb31aeddd90),
[userspace bridge](https://github.com/sbc64/flight-finder/blob/a1dd976b8fbf0bd011c485d50d82aeb31aeddd90/scripts/tailscale-vpn-bridge.mjs)
and [provider](https://github.com/sbc64/flight-finder/blob/a1dd976b8fbf0bd011c485d50d82aeb31aeddd90/apps/web/src/lib/scraper/vpn/mullvad-provider.ts).
The upstream [bridge](../../scripts/vpn/tailscale-vpn-bridge.mjs) preserves the
dedicated userspace topology and adds proxy identity binding and initial-state
validation. The [provider](../../apps/web/src/lib/scraper/vpn/mullvad-provider.ts)
uses canonical country lookup and browser profiles. Persistent admission,
job cancellation and independent cleanup guard the network changes.
[Settings](../../apps/web/src/components/vpn/VpnPreferences.tsx) supports all
five languages and coordinates configuration saves. Tracking issue
[#262](https://github.com/affromero/flight-finder/issues/262).

Background parsing credits [aph82 (avephill)](https://github.com/avephill) for
the [source commit](https://github.com/avephill/fairtrail/commit/e5ea7d901944ba8a6e389e3d7742165f513be114),
[job execution](https://github.com/avephill/fairtrail/blob/e5ea7d901944ba8a6e389e3d7742165f513be114/apps/web/src/app/api/parse/parse-run-job.ts)
and [status endpoint](https://github.com/avephill/fairtrail/blob/e5ea7d901944ba8a6e389e3d7742165f513be114/apps/web/src/app/api/parse/%5Bid%5D/route.ts).
The upstream [queue](../../apps/web/src/lib/parsing/jobs.ts) retains explicit
async mode and private polling. The adaptation adds persisted claims and
execution reservations, owner or capability access, configuration-bound
deduplication, bounded cancellation and interrupted-worker recovery.
The [executor](../../apps/web/src/lib/parsing/executor.ts) calls the canonical
parser and usage recorder. Source code's query-global cache and extra usage
insert are replaced by private authority and one canonical usage attempt.
[Web controls](../../apps/web/src/components/parsing/ParseControls.tsx) are
opt-in in all five languages. Tracking issue
[#263](https://github.com/affromero/flight-finder/issues/263). The API and recovery
contract are documented in [API.md](../../API.md#optional-background-parsing).

The active integration scopes are tracked in
[#253](https://github.com/affromero/flight-finder/issues/253). Each completed port
adds its source and implementation links here.

Pushover configuration screenshots: [before](screenshots/flight-pushover-before.png),
[desktop](screenshots/flight-pushover-desktop.png),
[mobile](screenshots/flight-pushover-mobile.png).

Latest observed fare screenshots: [desktop](screenshots/flight-latest-fares-desktop.png),
[mobile filter result](screenshots/flight-latest-fares-mobile.png).

Departure window screenshots: [before](screenshots/flight-departure-before.png),
[desktop](screenshots/flight-departure-desktop.png),
[mobile](screenshots/flight-departure-mobile.png).

Tracker recipient screenshots: [before](screenshots/flight-subscriptions-before.png),
[desktop](screenshots/flight-subscriptions-desktop.png),
[mobile](screenshots/flight-subscriptions-mobile.png).

WhatsApp configuration screenshots: [before](screenshots/flight-whatsapp-before.png),
[desktop](screenshots/flight-whatsapp-desktop.png),
[mobile](screenshots/flight-whatsapp-mobile.png).

Price rule screenshots: [before](screenshots/flight-price-rules-before.png),
[desktop](screenshots/flight-price-rules-desktop.png),
[mobile](screenshots/flight-price-rules-mobile.png).

Mullvad settings screenshots: [before](screenshots/flight-mullvad-before.png),
[desktop](screenshots/flight-mullvad-desktop.png),
[mobile](screenshots/flight-mullvad-mobile.png).

Background parsing screenshots: [before](screenshots/flight-parse-before.png),
[desktop](screenshots/flight-parse-desktop.png),
[mobile](screenshots/flight-parse-mobile.png).
