# Fork contributions

Flight Finder retains its MIT license and credits the people whose fork work
informs upstream integrations. Source links identify the reviewed revisions.

| Contributor | Source | Upstream work |
| --- | --- | --- |
| [sammorris01](https://github.com/sammorris01) | [Pushover commit](https://github.com/sammorris01/flight-finder/commit/dbf40dcb36f64e6cfa3b4ead606cf7912a1b8450) | [Pushover sender](../../apps/web/src/lib/notifications/channels/pushover/send.ts). Sam's original channel encrypted credentials; upstream adaptations add emergency settings, guarded acknowledgments and localized admin integration. Tracking issue [#258](https://github.com/affromero/flight-finder/issues/258). |
| [sammorris01](https://github.com/sammorris01) | [Latest-price card](https://github.com/sammorris01/flight-finder/blob/d2536f7750cdca00c4715d23e851e6c78102f21b/apps/web/src/components/BestPrice.tsx) | [Latest observed fares](../../apps/web/src/lib/flight-pricing.ts), inspired by Sam's change to use recent fares in the booking card. Upstream selection preserves independent dates and VPN observations, reconciles legacy identities and compares one currency. Historical lows remain dated information. Tracking issue [#255](https://github.com/affromero/flight-finder/issues/255). |

The active integration scopes are tracked in
[#253](https://github.com/affromero/flight-finder/issues/253). Each completed port
adds its source and implementation links here.

Pushover configuration screenshots: [before](screenshots/flight-pushover-before.png),
[desktop](screenshots/flight-pushover-desktop.png),
[mobile](screenshots/flight-pushover-mobile.png).

Latest observed fare screenshots: [desktop](screenshots/flight-latest-fares-desktop.png),
[mobile filter result](screenshots/flight-latest-fares-mobile.png).
