# Fork contributions

Flight Finder retains its MIT license and credits the people whose fork work
informs upstream integrations. Source links identify the reviewed revisions.

Private SMTP encryption credits [NickStu-coder](https://github.com/NickStu-coder)
for the [TLS requirement](https://github.com/NickStu-coder/traveller/commit/7bd642ebf0181322d2b6df6174457f43ea19073d)
in [Traveller's sender](https://github.com/NickStu-coder/traveller/blob/8e6779d1c38ed98e38337762cb69056f0191625c/apps/web/src/lib/notifications/channels/email.ts#L28).
The upstream [SMTP sender](../../apps/web/src/lib/notifications/channels/email.ts)
requires encryption for user-owned channels while retaining trusted relay
behavior. [Real SMTP regressions](../../apps/web/src/lib/notifications/channels/email/smtp.test.ts)
verify refusal before authentication or alert delivery when TLS is unavailable.
Tracking issue [#278](https://github.com/affromero/flight-finder/issues/278).

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

Integration scopes are tracked in
[#253](https://github.com/affromero/flight-finder/issues/253). Each port links its
source and implementation here.

CLI background parsing credits [aph82 (avephill)](https://github.com/avephill)
for the [original polling contribution](https://github.com/avephill/fairtrail/commit/4cd5f7fa36994c0c82025407387f9a42f519b819).
The upstream [runner](../../packages/cli/src/lib/parsing/runner.ts) reuses the
private job lifecycle and bounded client transport. Server mode forwards the
existing account/device credentials and capability. Standalone mode resolves
canonical access state and targets its own persisted claim; command and
interactive cancellation await verified local settlement. The installed
`parse` command uses one-off packaged execution. Tracking issue
[#264](https://github.com/affromero/flight-finder/issues/264).

Google navigation reliability credits [aph82 (avephill)](https://github.com/avephill)
for the [consent and content contribution](https://github.com/avephill/fairtrail/commit/7c53f77a5a029ff8f70c2f398a9c95636abae440)
and [local-provider timeout contribution](https://github.com/avephill/fairtrail/commit/90dd4319386ff0981d4b4b0fdb702ac5216d9d55).
The upstream adaptation fixes consent in both Google search and flight detail.
The [consent helper](../../apps/web/src/lib/scraper/navigation/consent.ts) waits
once for a visible exact localized action, skips hidden duplicates and limits
generic labels to a dialog with its own consent name or heading and no nested
dialogs. Mixed parent dialogs receive no generic consent action. Click failures
and execution cancellation propagate through canonical browser cleanup.
Tracking issue [#265](https://github.com/affromero/flight-finder/issues/265).

| Reviewed source behavior | Upstream decision and evidence |
| --- | --- |
| Localized consent buttons | Adapted with a bounded visibility wait and dialog scope. [Chromium regressions](../../apps/web/src/lib/scraper/navigation/consent.browser.test.ts) cover delayed and duplicate actions, adjacent and nested booking dialogs, unnamed consent headings, absence, click failure, page closure and cancellation. |
| Reject an empty results container | Existing [Google navigation](../../apps/web/src/lib/scraper/navigate.ts) already requires prices and the requested directional route. New [canonical browser fixtures](../../apps/web/src/lib/scraper/navigation/google.browser.test.ts) exercise delayed prices, empty shells, reverse routes and flight detail. |
| Regex prices after a failed provider response | Preserve explicit extraction failures. [Regressions](../../apps/web/src/lib/scraper/extract-prices.test.ts) confirm fare-like page text cannot turn empty or malformed provider output into guessed prices, currencies or stop counts. |
| Force a ten-minute SDK timeout | Preserve the configured timeout and existing default in the [shared provider](../../apps/web/src/lib/scraper/shared-provider.ts). [Real HTTP tests](../../apps/web/src/lib/scraper/providers/tests/http.test.ts) verify deadlines, caller cancellation and measured usage for OpenAI, Ollama, llama.cpp and vLLM. |
| Force Ollama Qwen3 thinking off | Preserve provider defaults. The HTTP tests verify the upstream adapter adds no forced `think` or `reasoning_effort` field. Existing [Codex reasoning controls](../../apps/web/src/lib/scraper/codex-extraction.test.ts) remain a separate explicit setting. |

The audit retains existing expiry, timezone and extraction settings. No new
fallback path or provider configuration is introduced.

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
