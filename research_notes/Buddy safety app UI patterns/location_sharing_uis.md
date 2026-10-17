# Consumer location-sharing UIs: patterns for a session-based, consent-first group safety map

Research date: 2026-10-17. Coverage caveat: several official help pages (Apple "Share your location", Snap help, WhatsApp FAQ, Life360 help, Google duration options) either returned only navigation or 404 through the fetch tool. Claims below come from the pages that did load or from search-result summaries. Items marked UNVERIFIED rest on secondary or low-quality sources, or on no source.

## 1. How do products present live vs last-known location, timestamps, staleness, battery/offline, duration/expiry, "you are sharing" indicators, and stop controls?

### Takeaway
Apple's Check In is the clearest model of "time-boxed, consent-first, escalate-on-silence" and is the closest analogue to YPC. It shows a visible lock-screen notification while active, shows the contact the timer start and end, and lets the sharer cancel. Google Maps exposes battery status to viewers. Life360, WhatsApp and Glympse use pause or expiry states and timers. Staleness and offline indicators are poorly documented in official sources I could load, so those details are gaps.

### Cited Findings
- Apple Check In (iOS 17+, both parties) has a travel mode with destination, arrival radius (Small/Medium/Large) and Driving/Transit/Walking. The contact sees the destination and approximate arrival time. If the phone is not moving toward the destination, the sender gets a prompt with 15 minutes to respond, and the contact is notified automatically if there is no response. — [Apple Personal Safety guide](https://support.apple.com/en-om/guide/personal-safety/ips56b5bc469/web)
- Apple Check In timer mode: the contact sees when the timer started and ends. At expiry the sender can end it or add 15, 30 or 60 minutes, and the contact receives the updated end time. No response causes the contact to be notified. — [Apple Personal Safety guide](https://support.apple.com/en-om/guide/personal-safety/ips56b5bc469/web)
- Apple Check In data tiers are chosen in advance by the sender (Settings > Apps > Messages > Check In Data). Limited = current location plus battery and network signal details. Full adds route traveled and the location of the last iPhone unlock and Apple Watch removal. Data is sent as a link only when the Check In does not end as expected (no arrival, delay with no response, Emergency SOS call with no follow-up, timer end with no response). — [Apple Personal Safety guide](https://support.apple.com/en-om/guide/personal-safety/ips56b5bc469/web)
- Apple Check In while active: the Lock Screen shows a notification, and unlocking shows details plus a cancel option. If the phone is lost during Check In, the contact is notified as if the sender were not responding. — [Apple Personal Safety guide](https://support.apple.com/en-om/guide/personal-safety/ips56b5bc469/web)
- Google Maps: people you share with can see your battery status. Sharing is off by default. You can choose per person whether they can create notifications about you. Stopping is done under Google Account > People & sharing > Location Sharing, and on Android sharing can be paused for all. The fetched page did not mention durations, expiry, or a last-updated timestamp. — [Google Maps Help](https://support.google.com/maps/answer/7326816)
- WhatsApp live location offers preset durations of 15 minutes, 1 hour (reported as default) and 8 hours, ending automatically. Sharing can be stopped per chat, and a Settings > Account > Privacy > Live location screen lists the chats you are currently sharing into. Recipients reportedly keep seeing the initial location as a static thumbnail afterwards. Live location is end-to-end encrypted. — secondary summaries only, e.g. [Business Insider India](https://www.businessinsider.in/how-to-share-location-on-whatsapp/articleshow/68352516.cms) and [AirDroid guide](https://airdroid.com/parent-control/how-to-send-live-location-on-whatsapp). The official FAQ page did not load (UNVERIFIED against WhatsApp's own docs).
- Glympse: sender picks recipients and a time limit; recipients need no app and get a link showing real-time location and ETA on a web map; the share auto-expires on timer or on arrival; sender can cancel early. Glympse says it does not save location once sharing ends, and one FAQ says an expired Glympse remains visible 48 hours before deletion. Duration range is cited as 5 minutes to 12 hours on official pages versus 15 minutes to 4 hours in an older third-party guide. — [Glympse support FAQ](https://support.glympse.com/faq/how-does-glympse-work/) (via search summary; numbers conflict, treat as UNVERIFIED)
- Snap Map: a "Who Can See My Location" setting controls visibility, and location is not shared until the user first opens the Map. — [Snapchat Support](https://help.snapchat.com/hc/en-us/articles/7012343074580-How-do-I-use-Ghost-Mode-on-Snap-Map)
- Snap Map staleness: one source says a location stays on the map for up to eight hours after the app was last opened, then disappears; another low-quality source says 24 hours. Conflict, UNVERIFIED. — [Digital Trends via search](https://digitaltrends.com/?p=2197104) versus [Cloudspress](https://www.cloudspress.com/?p=573347)
- Snap Ghost Mode durations (3 hours, 24 hours, until turned off), after which sharing resumes automatically, are reported by a third-party site only. — [Technerdiness](https://www.technerdiness.com/snapchat/how-to-pause-snapchat-location/) (UNVERIFIED)
- Life360 distinguishes a manual pause ("Location Paused" next to the member's name) from connection or battery loss (an exclamation mark that clears on reconnect). Third-party only. — [AirDroid](https://www.airdroid.com/location-tracking/know-if-someone-delete-life360/) (UNVERIFIED; official help not retrieved)
- Zenly: shut down by Snap, ceasing operations 3 February 2023. Its Ghost Mode let users freeze or blur their location or hide from specific friends. — [AlternativeTo](https://alternativeto.net/news/2022/12/zenly-social-mapping-network-shutting-down-on-february-3rd-2023/), [Sifted](https://sifted.eu/articles/snaps-decision-shut-down-zenly)

### Inferences
- Apple's pattern (visible countdown, sender-controlled extension, pre-agreed data tier, notification on silence) maps almost directly onto YPC's private check-in, host alert and escalation chain.
- Apple's disclosure that battery and network signal are sent with a Check In link supports showing "battery/signal at last report" in a stale-state UI, but it needs consent and labeling.
- Because phone loss is treated as non-response by Apple, YPC should likewise treat loss of contact as an observation ("no report since HH:MM"), not as a conclusion.

### Gaps
- Apple Find My: duration options (one hour / end of day / indefinitely), "No Location Found" wording, and timestamp format were not retrievable; the Apple guide pages returned only navigation.
- Google Maps: share-duration options and last-updated display were not confirmed.
- Snap Map: official Ghost Mode and expiry documentation not retrieved.
- Life360: official status labels not retrieved. Whether Glympse/WhatsApp show "last updated" times is unconfirmed.

## 2. How do they structure consent, per-person/per-group permissions, and onboarding?

### Takeaway
Consent in the major products is sender-initiated and per-recipient or per-group, with Google's off-by-default sharing and per-person notification controls and Life360's Circles as the clearest group scoping. Detailed onboarding flows were not retrievable.

### Cited Findings
- Google Maps location sharing is off by default and per-person notification permission is selectable. — [Google Maps Help](https://support.google.com/maps/answer/7326816)
- Life360 Circles (September 2013) restrict location visibility to members of a given circle; Places adds arrival/departure geofence alerts. — [Wikipedia: Life360](https://en.wikipedia.org/wiki/Life360)
- Apple Check In requires both parties on iOS 17+ and the sender picks the data tier before any incident. — [Apple Personal Safety guide](https://support.apple.com/en-om/guide/personal-safety/ips56b5bc469/web)
- Snap Map offers a visibility setting (who can see) and withholds sharing until the Map is first opened. — [Snapchat Support](https://help.snapchat.com/hc/en-us/articles/7012343074580-How-do-I-use-Ghost-Mode-on-Snap-Map)

### Inferences
- Splitting consent into two layers, join-the-session and data-tier-for-escalation (Apple's model), fits YPC's rule that the host cannot enable monitoring for another participant.

### Gaps
- Onboarding screens and copy for Find My, Snap Map, Life360 and Zenly were not obtained; no design-teardown sources were found in this pass.

## 3. What privacy/safety criticisms led to design changes?

### Takeaway
Documented criticism centers on controlling use by parents and partners, data sales, and stalking via trackers. Life360 responded with Bubbles and by stating it stopped selling precise location data. Apple's Check In emphasizes sender control and visible activity.

### Cited Findings
- Life360 Bubbles: approximate location only, 1 to 25 mile radius, 1 to 6 hours, with safety and messaging features staying active, released after criticism and CEO TikTok outreach. — [Wikipedia: Life360](https://en.wikipedia.org/wiki/Life360)
- The Washington Post reported parents using location sharing in ways that "resemble emotional abuse"; The Markup reported precise location data sales to brokers, and Life360 later said it stopped. — [Wikipedia: Life360](https://en.wikipedia.org/wiki/Life360) (secondary; underlying articles not read)
- August 2023 class action by alleged stalking victims against Tile, Life360 and Amazon (tracker-related). A 2024 Sky News piece called Life360 "stalkerware". — [Wikipedia: Life360](https://en.wikipedia.org/wiki/Life360)
- Australian eSafety survey of 2,046 adults: 13.6% agreed it is reasonable to expect to track an intimate partner at any time with location-sharing apps; eSafety describes tech-based coercive control as a pattern, often presented as care. — [eSafety](https://www.esafety.gov.au/newsroom/media-releases/track-harass-repeat-love-in-the-age-of-tech)
- NNEDV Safety Net notes location sharing can be dangerous when used by a stalker or abuser. — [Safety Net Project](https://www.techsafety.org/tech-talk-location-tracking) (page content not fully retrieved; relayed via search summary)
- Zenly's shutdown reason as reported was profitability, not privacy. — [Sifted](https://sifted.eu/articles/snaps-decision-shut-down-zenly)

### Inferences
- Time limits, approximate-location modes and visible sharing state are the product responses best evidenced; YPC's auto-expiring session addresses the "always on" criticism directly.

### Gaps
- No primary source found on Snap Map's 2017 launch criticism or subsequent changes (Wikipedia Snap Map URL 404'd). No peer-reviewed studies found. Washington Post and Markup articles not read directly. No source found on Snap's design lessons from Zenly.

## 4. What concrete UI ideas are worth borrowing for a session-based, time-limited, consent-first group map?

### Takeaway
Borrow Apple's visible countdown with explicit extend/end choices, Glympse's expire-on-arrival and no-app recipient view, WhatsApp's "everything I'm currently sharing" list, Life360's approximate-location option, and Google's per-person notification control. Design staleness and offline states conservatively (this section is mostly inference).

### Cited Findings
- Visible active-state plus cancel: Apple Check In Lock Screen notification and cancel. — [Apple Personal Safety guide](https://support.apple.com/en-om/guide/personal-safety/ips56b5bc469/web)
- Extend by fixed increments (15/30/60) with the contact told the new end time. — [Apple Personal Safety guide](https://support.apple.com/en-om/guide/personal-safety/ips56b5bc469/web)
- Overview of all active shares (WhatsApp, UNVERIFIED officially). — [Business Insider India](https://www.businessinsider.in/how-to-share-location-on-whatsapp/articleshow/68352516.cms)
- Approximate location with duration (Bubbles). — [Wikipedia: Life360](https://en.wikipedia.org/wiki/Life360)

### Inferences
- Show every pin with "as of HH:MM" and a staleness style (muted, dashed accuracy ring) after a configurable, labelled-unvalidated threshold; never animate stale pins as live.
- Distinguish three states with separate wording: sharing paused by the person, no report received, and session expired. Do not imply safety or danger from silence (consistent with CLAUDE.md).
- Persistent session banner with countdown, "Leave session" and "Pause sharing" always reachable; expiry copy states that sharing has ended and what was retained.
- Let each participant pick precision (exact vs approximate) and escalation data tier up front, shown as a pre-join summary of "who will see what, until when".
- Make the Incident Card list only delivered information, with timestamps, mirroring Apple's "link sent only on non-completion" model.

### Gaps
- No usability research found comparing stale-pin treatments. These are design proposals needing testing.
