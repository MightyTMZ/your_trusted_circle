# Design guidance and evidence for a buddy-system safety app UI (stress, impairment, consent/privacy)

Research date: 2026-10-17. About 16 tool calls. Several fetches returned truncated pages; anything not confirmed on a fetched page is under Gaps or marked UNVERIFIED. Evidence for this niche (peer-reviewed work on nightlife buddy apps, duress UX, alert wording) was thin in my searches. Do not treat absence in these notes as absence in the literature.

## 1. What do accessibility and crisis/emergency UX guidelines say (WCAG, HIG, Material, NN/g, trauma-informed, stress/cognitive load, one-handed, low light, large targets)?

### Takeaway
Hard numeric anchors that were verified: WCAG 2.2 AA minimum target 24x24 CSS px (with spacing exception) and Android 48x48 dp with 8 dp spacing. Stress guidance (Smashing, Nov 2025) says one task per screen, strong defaults, high-priority action first, undo, and a pre-built emergency mode. Trauma-informed computing (CHI '22) gives six principles and 22 recommendations. Apple HIG, NN/g stress/cognitive-load pages and one-handed/low-light evidence were not retrievable (see Gaps).

### Cited Findings
- WCAG 2.2 SC 2.5.8 (AA): pointer targets must be at least 24x24 CSS px unless an exception applies. Exceptions: spacing (a 24px circle centered on an undersized target must not hit another target), equivalent control elsewhere, inline, user-agent control, essential. Intent: avoid accidental activation of adjacent targets; helps tremor and dexterity limits. The page recommends considering the stricter 2.5.5 Enhanced level for important controls and does not itself state 44px. — [W3C Understanding 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- Android accessibility guidance: touch targets at least 48x48 dp (about 9 mm physical, within the 7-10 mm range recommended for touchscreen objects), neighbors separated by 8 dp or more; padding can extend the hit area beyond the visible icon (24 dp icon + padding = 48 dp). — [Android Accessibility Help](https://support.google.com/accessibility/android/answer/7101858)
- Stress degrades attention, memory, cognition and decision-making; people rely on fast habitual judgments. "Cognitive tunneling" described as narrowed peripheral vision, lower reading comprehension, weaker fine motor skills, reduced patience (the article names no specific study for tunneling). — [Smashing Magazine, V. Friedman, Nov 2025](https://www.smashingmagazine.com/2025/11/designing-for-stress-emergency/)
- Same article's recommendations: design for real context (small screens, noise, many apps open), one task or question at a time, break tasks into steps (GOV.UK Task List pattern; steps of roughly 10-30 s), sensible defaults, high-priority actions first, safeguards for irreversible errors (undo), an emergency mode with instant alerts to emergency contacts and pre-assigned tasks (cites Australian Red Cross Rediplan), stress-test in noisy busy real environments. — [Smashing Magazine](https://www.smashingmagazine.com/2025/11/designing-for-stress-emergency/)
- Interface should contract as stress rises: mute non-essential elements, remove optional items, isolate the task (secondary summary of a UX Planet article drawing on field work with Australian police). Secondary source, not verified at primary. — [daily.dev summary of UX Planet](https://daily.dev/posts/designing-for-the-wrong-user-wchgrzdj8.md); original: [UX Planet](https://uxplanet.org/designing-for-the-wrong-user-33178f5cb5b8)
- NN/g on slips: slips are unconscious errors made "on autopilot", common among experts; mistakes are conscious, from wrong mental model. Slip prevention: helpful constraints, suggestions, good defaults, forgiving input formatting. The page does not cover confirmations, undo or control spacing. — [NN/g, Slips](https://www.nngroup.com/articles/slips/)
- Trauma-informed computing: six principles adapted from SAMHSA (safety, trust, collaboration, peer support, enablement/empowerment, intersectionality), 22 suggestions. Examples: user-managed trigger list with explanation, tell users of pending updates and let them choose when, avoid directly asking about trauma. Routine changes (updates, crashes, changed settings) can provoke hypervigilance or panic in survivors of stalking/IPV. — [Cornell Chronicle summary of Chen, McDonald, Zou et al., CHI '22](https://news.cornell.edu/index.php/node/324445)
- Practitioner framings of trauma-informed design list safety, transparency, choice, mutuality (Airbnb) and warn that content warnings themselves can sometimes be distressing (contested; seen only in search-result summaries, UNVERIFIED in detail). — [Airbnb Design, Designing for crisis](https://Airbnb.design/designing-for-crisis/)

### Inferences
- Treat 48 dp as the floor for any control reachable during an incident, and 24px as the minimum only for non-critical controls. Stressed users have reduced fine motor control per Smashing; impairment is an extension, not shown in a source.
- Because trauma-informed work says unexpected system changes can alarm people, a safety app that suddenly alerts or changes mode should say why in plain words and never surprise-share data.
- Contraction of UI during an active incident (show only the state, one primary action, and undo) is supported by the stress sources above.

### Gaps
- Apple HIG: WebFetch of the Accessibility page returned only a title. The commonly cited 44x44 pt minimum target, Dynamic Type, Increase Contrast and Reduce Motion guidance are therefore UNVERIFIED here. Check https://developer.apple.com/design/human-interface-guidelines/accessibility directly.
- Material 3: the fetched page was empty. 48 dp was verified only through the Android accessibility help page above.
- NN/g pages on cognitive load, stress, thumb zones, and confirmation dialogs were not retrieved (NN/g never appeared in results for the stress query). One-handed use and low-light/dark-mode evidence: nothing verified. WCAG 1.4.3/1.4.11 contrast numbers were not fetched.
- No source found on impairment (alcohol) effects on touchscreen use.

## 2. Patterns for duress/silent signals, safety PINs, discreet help requests, accidental-trigger protection, and tradeoffs

### Takeaway
I found design descriptions (patents, vendor docs) but no empirical evaluation of duress PINs or silent alarms. The tension is documented qualitatively: fast triggering helps, but accidental triggers produce false alarms that erode recipient trust.

### Cited Findings
- Duress-code pattern: entering a special code appears to disarm/unlock normally while silently sending an alarm; another design shows a different decoy screen for the duress code vs the normal code. These are patent descriptions, not evaluations. — [US patent 9672727, Handling duress input](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9672727); [Patsnap, mobile duress alarm](https://eureka.patsnap.com/patent-US20180033288A1)
- Delay in being able to trigger security features reduces effectiveness of a personal safety app (patent application rationale, not empirical). — [Patsnap, US20180033288A1](https://eureka.patsnap.com/patent-US20180033288A1)
- Cry-wolf risk: a smartwatch patent argues contacts take alerts less seriously if false alarms exceed "very rarely" (argument, not data). — [US patent 10477008](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10477008)
- Accidental SOS and crash-detection triggers burden emergency dispatchers; a county dispatch coordinator in Wisconsin estimated roughly 1 in 10 calls were false alarms (local news anecdote). — (source link omitted: its URL contains an emergency number, which this repo does not store)
- Mitigations in commercial products: cancel-after-accidental-trigger option, adjustable sensitivity, visible countdowns for timed activities. — [Peoplesafe, Understanding Alarm Triggers](https://nexussupport.peoplesafe.co.uk/hc/en-gb/articles/37056554520849-Understanding-Alarm-Triggers)
- A patent describes a cancel flow requiring a password to send cancellation messages to contacts. — [US patent 10373478](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10373478)
- NNEDV's Safety Net founder warned that relying on an untested app in an emergency could be dangerous. — [Senate testimony, Southworth 2014](https://www.judiciary.senate.gov/download/06-04-14-southworth-testimony?download=1) (via search summary; UNVERIFIED in full)
- A Dalhousie thesis interviewed 30 participants about personal safety apps (fake calls, panic buttons) in three unsafe scenarios; findings on false alarms not seen. — [DalSpace](https://dalspace.library.dal.ca/handle/10222/74210)

### Inferences
- Tradeoffs: (a) silent duress needs a plausible decoy state, but a decoy is deceptive to the user's own contacts if the app shows "all fine"; (b) a countdown-then-send with a cancel gives accident protection but adds delay and can be defeated by a coercer who watches the screen; (c) press-and-hold or multi-step arming reduces accidents but is harder under impairment. Each is design reasoning, not sourced.
- For the prototype, cancellation of a false alert should be visible in the incident timeline and should notify recipients that it was cancelled, rather than silently erasing events.

### Gaps
- No peer-reviewed evaluation of duress PINs, safety PINs, or silent signals; no false-trigger rates for dedicated safety apps. Suggested next step: ACM DL queries on "coercion-resistant", "panic button", "false alarm".

## 3. Consent-first sharing, coercive control risks, host/guardian responsibility, alert fatigue

### Takeaway
Intimate-relationship privacy research and tech-abuse NGOs agree that location sharing between people who know each other is a coercion vector, so consent must be per-person, visible, revocable, and not able to be set up by a host. Alert fatigue evidence is from clinical settings: override rates are very high but measurement is inconsistent.

### Cited Findings
- Levy and Schneier (J. Cybersecurity 6(1), 2020): "intimate threats" arise in families, partnerships, friendships and caregiving; people close to a target may know secret answers, access devices and hold coercive power, so standard protections fail. The paper ends with design recommendations. — [Schneier on Security, paper page](https://www.schneier.com/academic/archives/2020/06/privacy_threats_in_i.html)
- A CHI '21 Extended Abstract (Schneegass et al., LYLO) on disclosed configurations of interpersonal location sharing found participants adjust configurations by intimacy level (colleague vs partner) rather than by activity; keywords include transparency. — [LMU PDF](https://www.medien.informatik.uni-muenchen.de/pubdb/publications/pub/schneegassch2021lylo/schneegassch2021lylo.pdf) (seen via search snippet only)
- 2025 survey (n=434, Frontiers in Human Dynamics): acceptance of monitoring negatively associated with perceived intrusion; scope of monitoring positively associated with perceived intrusion. — [Frontiers](https://www.frontiersin.org/journals/human-dynamics/articles/10.3389/fhumd.2025.1553619/pdf) (snippet only)
- NNEDV position: require consent before tracking or sharing location, and make tracking transparent and visible to the user. — [Senate testimony, 2014](https://www.judiciary.senate.gov/download/06-04-14-southworth-testimony?download=1)
- Survivor guidance: check whether location sharing is on, turn it off or limit who gets it; plan before removing trackers because removal may alert the person tracking. — [Tech and Safety 2026 (MCASA)](https://mcasa.org/assets/files/Tech_and_Safety_2026.pdf); [Technology safety plan tip sheet](https://techsafety.technicalities.ca/resources/toolkits/technology-safety-plan-tip-sheet/)
- Apple Safety Check: shows who has access to your location, lets you review/stop sharing per person or app, and has an Emergency Reset that stops all sharing at once (iOS 16+). — [Apple Support](https://support.apple.com/guide/personal-safety/ips2aad835e1)
- Alert fatigue (clinical): a JMIR Med Inform review of 23 studies reported override rates 46.2%-96.2%, with drug-drug-interaction override appropriateness varying 0%-95%. — [JMIR Med Inform 2020](https://medinform.jmir.org/2020/7/e15653/PDF) (snippet only)
- A 2026 systematic review (Ray Wilson et al.) found alert fatigue is measured inconsistently and recommends tracking a sustained drop in appropriate-response rate from a baseline. Only the abstract was seen. — [MetroHealth PDF](https://www.metrohealth.org/globalassets/metrohealth-documents/population-health-research-institute/ray-wilson-et-al-2026-alert-fatigue-systematic-review.pdf)
- Vendor-blog figure (about 90% physician override average) is secondhand and UNVERIFIED. — [Mindbowser](https://www.mindbowser.com/alert-fatigue-healthcare/)

### Inferences
- The CLAUDE.md rule that a host cannot enable monitoring for another participant matches the NNEDV consent/transparency position; add per-recipient visibility of "who can see me" and a one-tap stop-all (Safety Check analogue).
- The host role is a power asymmetry. Intimate-threat research implies hosts could misuse alerts or location; limit what the host sees to what each participant consented to, and show participants what the host sees.
- Clinical alert-fatigue findings may not transfer to friend groups; fewer, higher-value alerts and a measurable "appropriate response" baseline are the transferable lessons.

### Gaps
- No CSCW/CHI paper found on buddy or bystander safety apps for nightlife (search returned a bystander RCT protocol, RealConsent2.0, and institutional drink-spiking guidance only: [PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10717516/)). No source found on host/guardian responsibility models for peer groups. NGO guidance specific to coercive control in safety-app contexts not fetched in full. Primary text of Levy/Schneier design recommendations not read beyond the abstract.

## 4. How does alert wording affect behavior ("acknowledged" vs "safe", staleness labels, uncertainty communication)?

### Takeaway
I found no study testing "acknowledged" vs "safe" or staleness labels. The nearest evidence: messaging status ("delivered" vs "read") is commonly confused, and weather-forecast research finds calibrated uncertainty estimates improve decisions and trust.

### Cited Findings
- Users and marketers confuse "delivered" with "read"; "read" shows only that a message was opened (vendor blog). — [Infobip](https://cdn-web.infobip.com/uploads/markdown-exports/www.infobip.com/blog/rcs-read-receipts.md)
- A 2014 secure-messaging usability discussion recorded that participants wanted delivery receipts but found read receipts intrusive (mailing-list anecdote). — [moderncrypto list](https://moderncrypto.org/mail-archive/messaging/2014/000277.html)
- Joslyn and colleagues: calibrated probability forecasts improved weather decisions and increased trust vs deterministic forecasts; comprehension depends on how uncertainty is expressed. — [Use and Communication of Probabilistic Forecasts (arXiv)](https://arxiv.org/pdf/1408.4812); [Joslyn seminar slides](https://www.mmm.ucar.edu/sites/default/files/2022-07/Susan%2520Joslyn%25203%2520October%2520%25202019%2520MMM%2520SEMINAR.pdf) (secondary; effect sizes UNVERIFIED)
- Forecast inconsistency was less harmful to trust than inaccuracy (Burgeno and Joslyn). — [UW ResearchWorks](https://digital.lib.washington.edu/researchworks/items/2606e30e-b9a8-4669-9a3f-57914fff773c/full)

### Inferences
- Label states by the event actually observed: "Alex's phone showed this alert at 22:41" or "Sam tapped Acknowledge at 22:43". Avoid "safe", "OK", "handled" for acknowledgment, matching the CLAUDE.md rule. By analogy to the delivered/read confusion, an acknowledgment is a weaker event than users may assume.
- Show an absolute timestamp plus age ("last location 22:38, 7 min ago") and visually downgrade stale data; this is design reasoning, not a tested result.
- Express uncertainty with concrete missing-information statements, since the forecast literature suggests explicit uncertainty does not reduce trust (domain transfer is an assumption).

### Gaps
- No experiments found on "acknowledged" vs "safe", staleness labels, or last-known vs current location wording in safety contexts. Not searched: Apple Find My / Google Maps location-age conventions, crisis-line scripting research.

## 5. Concrete, transferable design ideas
All items are proposals derived from the cited material above; none are tested for this app.
1. Controls on the incident path at or above 48 dp, 8 dp apart ([Android](https://support.google.com/accessibility/android/answer/7101858)); never below WCAG 24px ([W3C](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)).
2. Contract the UI during an incident: one state line, one primary action, undo ([Smashing](https://www.smashingmagazine.com/2025/11/designing-for-stress-emergency/)).
3. Private check-in with a single large "I'm OK / Need help" choice, a safe default of no action, and a visible time-until-escalation (visible countdowns: [Peoplesafe](https://nexussupport.peoplesafe.co.uk/hc/en-gb/articles/37056554520849-Understanding-Alarm-Triggers)). Mark this timing unvalidated.
4. Accidental-trigger protection: hold-to-send for manual help, plus a post-trigger cancel that logs a visible "cancelled by user at HH:MM" entry. Tradeoffs in section 2.
5. Silent/duress signal: treat as an optional, clearly disclosed feature; do not show a false "all clear" to recipients. Needs validation (no empirical evidence found).
6. Consent ledger: per-participant "who can see what" screen and a one-tap "stop sharing with everyone", modeled on Apple Safety Check ([Apple](https://support.apple.com/guide/personal-safety/ips2aad835e1)).
7. Persistent active-session indicator and automatic expiry (consent transparency: [NNEDV testimony](https://www.judiciary.senate.gov/download/06-04-14-southworth-testimony?download=1)).
8. Host sees only consented fields; participants can preview exactly what the host and backups will receive ([Levy & Schneier](https://www.schneier.com/academic/archives/2020/06/privacy_threats_in_i.html)).
9. Event-literal status wording: "Delivered", "Acknowledged by Sam 22:43", never "Safe". Add a separate "Resolved" action.
10. Every location carries a timestamp and age, with "last known" vs "current" labels and a stale visual treatment.
11. Escalation deduplication and fewer alerts: send one alert per step, show "still unacknowledged since 22:41" instead of new pings, to limit alert fatigue ([JMIR 2020](https://medinform.jmir.org/2020/7/e15653/PDF); [Ray Wilson 2026](https://www.metrohealth.org/globalassets/metrohealth-documents/population-health-research-institute/ray-wilson-et-al-2026-alert-fatigue-systematic-review.pdf)).
12. Trauma-informed copy: explain why the app is alerting, no surprise changes, user chooses when updates apply ([Cornell/CHI '22](https://news.cornell.edu/index.php/node/324445)). Describe observations as movement changes, not medical conclusions.
13. Stress-test in noisy, dim, one-handed, and simulated-impairment-of-vision conditions without using real intoxication, consistent with project safety rules ([Smashing](https://www.smashingmagazine.com/2025/11/designing-for-stress-emergency/)).
14. Label the simulated emergency path and the mock operator on screen so users cannot mistake the demo for real dispatch.
