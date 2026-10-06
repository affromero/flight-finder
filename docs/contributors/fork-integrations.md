# Fork contributions

Flight Finder retains its MIT license and credits the people whose fork work
informs upstream integrations. Source links identify the reviewed revisions.

| Contributor | Source | Upstream work |
| --- | --- | --- |
| [sammorris01](https://github.com/sammorris01) | [Pushover commit](https://github.com/sammorris01/flight-finder/commit/dbf40dcb36f64e6cfa3b4ead606cf7912a1b8450) | [Pushover sender](../../apps/web/src/lib/notifications/channels/pushover/send.ts). Sam's original channel encrypted credentials; upstream adaptations add emergency settings, guarded acknowledgments and localized admin integration. Tracking issue [#258](https://github.com/affromero/flight-finder/issues/258). |

The active integration scopes are tracked in
[#253](https://github.com/affromero/flight-finder/issues/253). Each completed port
adds its source and implementation links here.

Pushover configuration screenshots: [before](screenshots/flight-pushover-before.png),
[desktop](screenshots/flight-pushover-desktop.png),
[mobile](screenshots/flight-pushover-mobile.png).
