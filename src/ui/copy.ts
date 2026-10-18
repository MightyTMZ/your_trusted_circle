/**
 * Safety-relevant UI copy in one place. Wording rules (enforced by tests):
 * - Motion is only ever "Movement changed" (no injury or incident claims).
 * - Acknowledgment never implies the person is OK or out of danger.
 * - Anything involving emergency services says "simulated".
 */
export const COPY = {
  appName: 'YTC',
  appTagline: 'Your Trusted Circle',
  prototypeNotice: 'Prototype. Emergency services are simulated. Nothing in this app can place a real call or send a real message.',

  movementChanged: 'Movement changed',
  observationNotDiagnosis: 'Based on your motion compared with your usual pattern. It is an observation, not a diagnosis.',

  checkInTitle: 'Private check-in',
  checkInPrivacy: 'Only you can see this.',
  checkInOk: "I'm OK",
  checkInHelp: 'I need help',

  acknowledge: 'Acknowledge',
  acknowledgeSub: "I'm responding. Stops escalation.",
  acknowledgeCaveat: "Acknowledging stops escalation. It does not confirm the person's wellbeing.",
  acknowledgedNotice: (name: string, time: string) =>
    `Acknowledged by ${name} at ${time}. Escalation stopped. Their wellbeing is not confirmed until someone reaches them.`,
  resolve: 'Resolve alert',
  resolveIntro: "Resolving is separate from acknowledging. Use it after you've reached them in person or confirmed a false alarm.",
  resolveLocked: 'Acknowledge first. Resolve becomes available after.',
  repeatAlert: 'Repeat alert',
  repeatAlertSub: 'Repeating does not reset the escalation timer.',

  outcomes: {
    assistance_reached: 'Someone reached them in person',
    false_alarm: 'False alarm',
    other: 'Other',
  },

  cancelAlert: 'Cancel alert: false alarm',
  cancelAlertTitle: 'Cancel this alert?',
  cancelAlertKeep: 'Keep the alert open',
  cancelAlertConfirm: 'Yes, cancel it',
  cancelAlertCaveat: 'Responders will see that you cancelled it yourself. If you need help later, ask again: that starts a new alert.',
  cancelledBySelf: (name: string) => `Cancelled by ${name}: false alarm`,
  cancelledBySelfCaveat: 'This is their own report from their device. No one has checked on them in person.',

  emergencySimulated: 'Emergency services (simulated)',
  simulatedTag: 'Simulated',
  simulatedCallBanner: 'Simulated call to a mock operator. No real number is dialed and no real service is contacted.',

  hostCommitmentTitle: "You're the designated host",
  hostCommitmentPoints: [
    'Stay sober and reachable for the whole session.',
    'Keep your phone charged with sound on.',
    'Respond to alerts and go check on people in person.',
  ],
  hostCommitmentCheck: "I'll be this group's sober, available contact until the session ends.",

  hostCannotEnable: "Each person scans and joins on their own phone. Their location reaches at least you; check-ins are their choice. You can't turn on monitoring for anyone else.",

  leaveSession: 'Leave session',
  leaveConfirmParticipant: 'Your location and motion check-ins stop immediately. Any open alert about you stays open for your host.',
  leaveConfirmHost: 'As host, leaving ends the session for everyone. Open alerts must be acknowledged first.',

  locationNotShared: 'Location not shared with you',
  locationOff: 'Not sharing location',
  locationNone: 'No reading yet',
  locationNotYetShared: 'No location shared with you yet',
} as const;

export const SHARING_LABEL = {
  group: 'Everyone in the group',
  host: 'Host only',
  off: 'Off for this session',
} as const;
