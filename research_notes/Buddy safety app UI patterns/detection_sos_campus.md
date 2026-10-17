# Detection, countdown and SOS UI patterns; campus and nightlife buddy-safety tools

Desk research, 2026-10-17. Items marked [fetched] were read from the page; items marked [search-snippet] come only from search-result summaries and are less certain. Pages were read through a summarizing fetch tool, so UI wording may be paraphrased. No dialable emergency numbers are included, deliberately.

## 1. How do Apple, Google, Samsung and Garmin ask "are you OK?", count down, escalate and allow cancellation?

### Takeaway
All platforms use a two-stage pattern: an initial "are you OK?" alert (sound plus haptics, a dismiss option and a deliberate "call for help" gesture), then a visible, louder countdown to auto-escalation. Countdown lengths differ (30 s Apple Watch and Garmin Edge, 60 s Pixel and Garmin Drive). Cancel is available until the end. Apple Check In and Google Safety Check are the closest analogues to a timed buddy check-in.

### Cited Findings
- Apple Watch Fall Detection [fetched]: the watch taps the wrist, sounds an alarm and shows "It looks like you've taken a hard fall." The user can tap Close or "I'm OK", or drag an Emergency Call slider. If the user is moving, the watch waits and does not auto-call. If immobile for about one minute, it starts a 30-second countdown with continued wrist taps and a louder alert. Cancel stops the call; on expiry the watch calls emergency services and messages Medical ID emergency contacts with location. A recorded message plays to the responder with latitude and longitude. Wrist Detection must be on for auto-calling. — [Apple Support](https://support.apple.com/en-us/108896)
- Apple Crash Detection (iPhone and Watch) [fetched]: alarm plus an alert shown for 10 seconds; iPhone reads the alert aloud, Watch chimes and taps. The user can swipe an Emergency Call slider or dismiss. With no response, a second countdown begins (the fetched summary says 30 s) with "loud whoops", aggressive vibration and flashing LED on iPhone and aggressive taps on Watch, then an automatic call with a looped recorded message repeating every five seconds at reduced volume (the user can stop it). Contacts get a text with location. — [Apple Support](https://support.apple.com/en-us/104959). CONFLICT: a search-result summary described the second countdown as 10 seconds and said an older Apple page gave 30 s overall [search-snippet, unverified]. Treat the second-stage length as unconfirmed; verify on the live page.
- Apple Check In (Messages, iOS 17+) [fetched]: timer-based or "When I arrive" modes. At timer end the user is prompted to end the Check In or add 15, 30 or 60 minutes (the contact sees the updated end time). If the device is not moving toward the destination, the user gets a prompt with 15 minutes to respond. The contact is automatically sent a link to the shared info if the user ignores the end-of-timer prompt, is significantly delayed and ignores the add-time prompt, does not reach the destination, places an SOS call and ignores the follow-up prompt, or the phone is lost during Check In. The Lock Screen shows only "Check In: Unlock to view details". Data levels are Limited and Full (Full adds route traveled and last unlock or watch-removal location). Cancel from the details screen after unlocking. The article does not state how long the end-of-timer prompt waits. — [Apple Personal Safety guide](https://support.apple.com/guide/personal-safety/ips56b5bc469/web)
- Google Pixel Car Crash Detection [fetched]: the phone vibrates, sounds an alarm and asks aloud and on screen if you need help; 60 seconds to respond. By voice or touch: say "Emergency" or drag the slider (call and notify contacts); say "Cancel" or tap "I'm OK". No response: speakerphone turns on, the phone tries to call emergency services, speaks that a crash happened and shares approximate location, and the message repeats; the user can speak over it or tap Cancel to stay on the line. With a paired Pixel Watch both devices check in and one response counts. High-impact activities could trigger it; it does not work in Airplane mode, Battery Saver or roaming. — [Google Pixel Help](https://support.google.com/pixelphone/answer/7055029?hl=en)
- Google Safety Check [search-snippet only; 2021-2022 secondary sources, may be outdated]: the user sets a timer (one source: default 1 hour, options 15 min to 8 h) and is asked at the end if they are OK. If there is no input (sources say about 60 s) the phone starts Emergency Sharing with a Maps location link. The user can add time, end early or start sharing manually. The Safety app has a demo that does not contact services. — [9to5Google](https://9to5google.com/2022/11/09/safety-check-on-your-pixel-phone/), [Android Central](https://androidcentral.com/how-to-use-personal-safety-app-stay-safe-alert-emergency-contacts). I could not fetch Google's own Safety Check help page (404 on the URL tried).
- Samsung Galaxy Watch "Hard fall detection" [search-snippet from carrier guides]: under Settings > Safety and emergency; has a user-chosen countdown before the call, an optional "Require swipe to call" toggle, can be always on or only during physical activity, and can send an SOS message with location to contacts. Durations were not listed. — [O2 guide](https://www.o2.co.uk/help/phones-sims-and-devices/samsung/galaxy-watch-ultra-2025-wear-os-6/setup-and-first-use/turn-fall-detection-on-or-off), [EE guide](https://deviceguides.ee.co.uk/samsung/galaxy-watch7-android-wear-os/basic-functions/turning-fall-detection-on-or-off/)
- Garmin Edge incident detection [fetched]: on detecting an incident the device can send an automated message to emergency contacts; 30 seconds to cancel (Cancel, then confirm Yes) on the device or paired phone. The page does not say whether location is included. — [Garmin Edge 130 Plus manual](https://www8.garmin.com/manuals-apac/webhelp/edge130plus/EN-SG/GUID-AACEBE21-21E8-4D00-A536-3099D35B0928-4286.html). Garmin Drive and zumo manuals reportedly use a 60-second timer [search-snippet] — [Garmin Drive manual](https://www8.garmin.com/manuals/webhelp/driveluxe51/EN-US/GUID-DD2612E8-290D-47EC-9C78-07A3392DFE61.html)

### Inferences
- Two escalation shapes exist: (a) event-triggered (fall or crash) with a 10-60 s countdown, and (b) scheduled check-in (Apple Check In, Safety Check, Rave timer) where the prompt comes at a deadline and the escalation target is a human contact. YPC's check-in after a movement change takes the prompt from (a) and the human escalation target from (b).
- Apple gates auto-calling on roughly a minute of immobility, a cheap false-alarm filter: the response-needed state is entered only when the person appears not to be responding.
- Contact messages state what the device detected and where, not a diagnosis. This supports YPC's "observation, not conclusion" rule.

### Gaps
- Samsung countdown durations and Garmin watch (Forerunner, fenix) Incident Detection and Assistance behavior were not confirmed from primary pages.
- Exact haptic patterns beyond "taps" and "aggressive vibration", and actual screenshots, were not captured. Apple Human Interface Guidelines and Wear OS design guidance on emergency prompts were not retrieved.
- Apple Emergency SOS (side-button hold) page was not fetched. The Crash Detection second-stage length is conflicting.

## 2. What features and UI patterns do campus and nightlife buddy-safety tools use?

### Takeaway
Campus apps (Rave Guardian) center on a self-started safety timer with named guardians, location revealed only on expiry or duress, and an optional official guardian (campus police) who calls back before sending anyone. Student apps (Companion) add automatic "are you OK?" prompts with a short response window. Nightlife-specific buddy evidence is thin: most results are concepts or campaigns, not validated apps.

### Cited Findings
- Rave Guardian Safety Timer (University of Minnesota) [fetched]: choose a Guardian (contact, Public Safety, or both), add a destination note, set trip duration, start; the guardian gets a text link to follow the trip. Add/Subtract changes the time; the user must end the timer on arrival. Location and route go only to chosen guardians; Public Safety sees location only if it is the Official Guardian and the timer expired. On expiry guardians are messaged automatically; if Public Safety is the official guardian, dispatchers call the user and, if unreachable, send an officer to the last reported location. Guardians need not have the app. — [UMN Public Safety](https://publicsafety.umn.edu/campus-safety/rave-guardian-campus-safety-app)
- Other Rave Guardian deployments [search-snippet]: Wichita State says police see location only on session expiry or a duress alert, and offers a duress PIN that silently alerts if a user is forced to end a session. UAlbany says location is shared only on an emergency call or timer activation. — [Wichita State](https://www.wichita.edu/about/wsunews/archive/index.php?nid=3429), [UAlbany](https://www.albany.edu/police/rave-guardian-personal-safety-app)
- Companion (student-built app) [search-snippet; student newspaper quoting a co-owner, intended behavior, untested]: the user picks a destination and contacts. The app prompts a check-in if the user goes off route, is late, falls, starts running or has headphones yanked out; with no response within 15 seconds the contacts are notified. — [The Crimson White](https://thecrimsonwhite.com/27054/news/app-encourages-safety)
- Hold-button apps such as Noonlight [search-snippet; review blog]: the user holds a button and has 10 seconds after release to enter a PIN if it is a false alarm. — [Safety Apps for College Students](https://thescholarshipsystem.com/blog-for-students-families/safety-apps-for-college-students-essential-tools-for-campus-security/)
- Hollaback and Good Night Out [search-snippet]: Good Night Out is a 2014 Hollaback London campaign against harassment (venue pledge, staff training, posters), not a buddy app; Hollaback's app maps incident reports as dots. Spiking-related items found (Sip Buddy cup camera, a "Spike!" concept, Safe Space Sussex) are prototypes, concepts or general guidance, and university guidance stresses basic habits and telling venue staff. — [Stop Street Harassment](https://stopstreetharassment.org/2014/08/goodnightoutspread/), [Oxford nights out](https://www.ox.ac.uk/students/life/community/nights-out), [UNL Party Favor](https://engineering.unl.edu/engineering-nebraska-magazine-winter-2026/party-favor-engineering-students-startup-aims-stamp-out)

### Inferences
- Borrowable: guardians who need not install the app (text link); location disclosure tied to a trigger and recipient (matches YPC consent rules); "end timer" as an explicit user action; call-back before dispatch as a middle escalation step; a duress PIN as a covert cancel that alerts.
- Peer live-location group maps are not documented in the campus tools found; YPC's group map is a different pattern [unverified].

### Gaps
- No primary documentation retrieved for LiveSafe, Safe Walk or virtual-escort programs, or for drink-safety buddy apps; no evaluations of nightlife buddy apps found.
- Companion claims are secondhand; Noonlight details come from a listicle.

## 3. What do studies and reviews say about false alarms, alert fatigue and accidental activations?

### Takeaway
Automatic crash and fall calls generate many false positives that burden dispatchers, but quantitative evidence is limited to one small peer-reviewed letter plus local press. Clinical alarm-fatigue literature ties desensitization to false alarms, but the evidence quality is weak.

### Cited Findings
- Okayama City, Oct 2022 to Mar 2023: of 2,731 trauma-related emergency calls, 49 came from automatic crash-detection apps; 13 true positive, 35 false positive, 1 unknown (71% false positive); 22 responsive and 27 unresponsive callers. The authors call it preliminary, single-city, with no outcomes, and the figure caption has an internal inconsistency. — [Hongo et al., Acute Medicine & Surgery 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10363817)
- Ski-area press reports, 2022-23 [search-snippet; pages not opened]: dispatch centers in ski regions got dozens or more automated calls per week from Apple devices; Apple acknowledged unintended calls, said late-2022 software updates reduced them, and said users get 10 seconds to cancel; dispatchers call back silent calls, taking time from real emergencies; impact varied by agency. Specific counts (for example 71 false calls from four Colorado resorts in a weekend, 155 in one Minnesota county) came from search summaries and are unverified. — [9to5Mac](https://9to5mac.com/2023/01/16/crash-detection-false-alerts/)
- Clinical alarm fatigue [search-snippet]: it is desensitization from excess alarms; one integrative review reports 72-99.4% of ICU alarms are false; no agreed direct metric; little experimental evidence. — [Revista de Enfermagem UFPE](https://periodicos.ufpe.br/revistas/revistaenfermagem/article/view/11603), [Frontiers in Digital Health 2022](https://www.frontiersin.org/journals/digital-health/articles/10.3389/fdgth.2022.843747/epub)
- Vendor documentation acknowledges that high-impact activities could trigger crash detection. — [Google Pixel Help](https://support.google.com/pixelphone/answer/7055029?hl=en)

### Inferences
- Nightlife (dancing, jostling, crowds) resembles high-impact false-trigger contexts. A private prompt before notifying anyone, and host alerts worded as unconfirmed observations, should lower the social cost of false alerts. Repeating alerts without new information risks the desensitization described in the clinical literature.
- Context gating (stillness or no response before escalating) is the main false-alarm lever in vendor designs.

### Gaps
- No peer-reviewed study of false-activation rates for Apple Watch Fall Detection, Pixel Safety Check, or campus safety apps; no 2025-2026 data found (latest material is 2023). Nothing on alert fatigue among peer or buddy recipients specifically.

## 4. Which concrete patterns are worth borrowing?

### Takeaway
Borrow a staged flow: private haptic and audible prompt, large two-choice response, visible countdown with escalating intensity, cancel until the deadline, and escalation that notifies a human first with factual wording. Make sure cancel or acknowledgment is never presented as "safe".

### Cited Findings
- Large explicit response choices with a deliberate help gesture: "I'm OK" or Close versus a drag-to-call slider (Apple), "I'm OK" versus slider or voice "Emergency"/"Cancel" (Pixel). — [Apple](https://support.apple.com/en-us/108896), [Google](https://support.google.com/pixelphone/answer/7055029?hl=en)
- Escalating prompt intensity during the countdown: louder alarm, taps, vibration, flashing LED. — [Apple](https://support.apple.com/en-us/104959)
- Movement-conditional gating (no auto-call if the user is moving). — [Apple](https://support.apple.com/en-us/108896)
- Time-limited confirmation windows: 30 s (Apple Watch, Garmin Edge), 60 s (Pixel). — sources above. Shorter windows (15 s, 10 s) appear in secondary sources on Companion and hold-button apps (see section 2).
- Extend-time option at check-in end (15/30/60 min) with the contact seeing the updated end time. — [Apple](https://support.apple.com/guide/personal-safety/ips56b5bc469/web)
- Multi-device single response. — [Google](https://support.google.com/pixelphone/answer/7055029?hl=en)
- Demo mode that never contacts services. — [9to5Google](https://9to5google.com/2022/11/09/safety-check-on-your-pixel-phone/) [search-snippet]
- Lock-screen privacy: Check In shows no details until unlock. — [Apple](https://support.apple.com/guide/personal-safety/ips56b5bc469/web)
- Duress PIN; call-back before dispatch. — [Wichita State](https://www.wichita.edu/about/wsunews/archive/index.php?nid=3429) [search-snippet], [UMN](https://publicsafety.umn.edu/campus-safety/rave-guardian-campus-safety-app)

### Inferences
- Candidate YPC defaults (unvalidated, configurable): a private prompt with two large buttons ("I'm OK" / "I need help"), a 30-60 s visible countdown with escalating haptic and sound, cancel until the deadline, and no-response escalating to the host with factual text (for example "no response to check-in at HH:MM after movement change"). Host acknowledgment should never be labelled "safe".
- A short undo window after "I'm OK" is reasonable, but I found no vendor source documenting one. This is an unverified design idea.
- Because YPC simulates escalation, show a persistent demo-mode indicator, as the Pixel demo does.

### Gaps
- No evidence found on which timings or layouts reduce accidental cancels or false alarms; no user-study data on countdown comprehension.
