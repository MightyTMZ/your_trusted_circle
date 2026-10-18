/** Builds the API's dependencies the same way for the long-running server, the Vercel function and tests. */
import { createTransport } from "./alerts/transport.js";
import { createProviders } from "./auth/providers.js";
import type { ServerConfig } from "./config.js";
import type { Deps } from "./context.js";
import { LocationRelay } from "./lifecycle/relay.js";
import type { Store } from "./store/store.js";
import { SessionTimelines } from "./timeline/record.js";

export function createDeps(config: ServerConfig, store: Store, overrides: Partial<Deps> & { strictTimeline?: boolean } = {}): Deps {
  const { strictTimeline = false, ...rest } = overrides;
  const now = rest.now ?? (() => new Date());
  return {
    store,
    config,
    providers: rest.providers ?? createProviders(config, now),
    transport: rest.transport ?? createTransport(config),
    relay: rest.relay ?? new LocationRelay(),
    timeline: rest.timeline ?? new SessionTimelines(store, now, strictTimeline),
    now,
    ...(rest.calls ? { calls: rest.calls } : {}),
  };
}
