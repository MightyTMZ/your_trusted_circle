import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Transport } from "./alerts/transport.js";
import type { ProviderRegistry } from "./auth/providers.js";
import type { ServerConfig } from "./config.js";
import type { LocationRelay } from "./lifecycle/relay.js";
import type { Store } from "./store/store.js";
import type { UserDoc } from "./types.js";

/**
 * Everything a route or scheduler pass needs. Injected so tests can swap the
 * store, sign-in providers, alert transport and clock. All deadlines use
 * `now`, the one injectable clock (CLAUDE.md).
 */
export interface Deps {
  store: Store;
  config: ServerConfig;
  providers: ProviderRegistry;
  transport: Transport;
  /** Live group positions, memory only. Never persisted (lifecycle/relay.ts). */
  relay: LocationRelay;
  now: () => Date;
}

export type AppEnv = { Variables: { user: UserDoc; tokenHash: string } };

/** One error shape for every route: { error: { code, message, issues? } }. */
export function fail(c: Context, status: ContentfulStatusCode, code: string, message: string, issues?: unknown) {
  return c.json({ error: { code, message, ...(issues ? { issues } : {}) } }, status);
}
