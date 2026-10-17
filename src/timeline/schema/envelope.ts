/**
 * Envelope fields shared by every timeline event, independent of its type.
 * Type-specific payloads live in catalog.ts.
 */
import { v, type Infer } from "./validate.js";

export const SCHEMA_VERSION = "1.0" as const;

/** The only operator endpoint the voice agent and dispatch simulation may target. */
export const MOCK_OPERATOR_ENDPOINT_ID = "mock-operator-local" as const;

/** Who caused the event. Participants (including the host) use par_ IDs; backup contacts use con_ IDs. */
export const ACTOR_KINDS = [
  "participant",
  "host",
  "backup_contact",
  "detector",
  "scheduler",
  "system",
  "transport_sim",
  "voice_agent",
  "mock_operator",
  "scenario_script",
] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Which architectural component emitted the event (see CLAUDE.md, Architecture). */
export const COMPONENTS = [
  "sensor_adapter",
  "detector",
  "session_manager",
  "incident_manager",
  "escalation_scheduler",
  "transport_sim",
  "voice_agent",
  "ui",
  "scenario_runner",
] as const;
export type Component = (typeof COMPONENTS)[number];

/** Where the underlying data came from. Recorded and synthetic data are never mixed up. */
export const DATA_ORIGINS = [
  "live_device",
  "recorded_dataset",
  "synthetic_scenario",
  "system_generated",
] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];

/**
 * Consent scopes a participant can grant for themselves. The briefing for
 * the voice agent only discloses location/profile data under these scopes.
 */
export const CONSENT_SCOPES = [
  "monitoring",
  "location.group",
  "location.responders",
  "profile.responders",
] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

/** What a payload reveals, mapped to the consent scope required to disclose it to responders. */
export const SENSITIVITIES = ["none", "location", "profile"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const RESPONDER_SCOPE_FOR: Record<Exclude<Sensitivity, "none">, ConsentScope> = {
  location: "location.responders",
  profile: "profile.responders",
};

export const actorSchema = v.object({
  kind: v.enum(ACTOR_KINDS),
  /** par_/con_ ID for people; null for system components. */
  id: v.nullable(v.string({ minLength: 1, maxLength: 80 })),
});
export type Actor = Infer<typeof actorSchema>;

export const provenanceSchema = v.object({
  component: v.enum(COMPONENTS),
  data_origin: v.enum(DATA_ORIGINS),
  /** True when the event describes a simulated action (mock transport, mock operator, scripted scenario). */
  simulated: v.boolean(),
  /** Scenario script that supplied the inputs, when data_origin is synthetic_scenario. */
  scenario_id: v.optional(v.string({ minLength: 1, maxLength: 80 })),
  /** Pointer to the raw recording this was derived from; raw data is stored separately. */
  raw_ref: v.optional(v.string({ minLength: 1, maxLength: 200 })),
  /** Name and version of the adapter/detector/rule set, e.g. "zscore-detector@0.1.0". */
  producer: v.optional(v.string({ minLength: 1, maxLength: 80 })),
});
export type Provenance = Infer<typeof provenanceSchema>;
