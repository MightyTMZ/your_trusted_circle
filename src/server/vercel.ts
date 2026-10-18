/**
 * The API as a Vercel Function (api/index.js imports this after `npm run build:server`).
 *
 * Serverless limits, documented in docs/backend.md ("Deploying"):
 * - No long-running scheduler. With TICK_ON_REQUEST=true a scheduler pass runs
 *   before requests (at most once a second), and /api/internal/tick can be
 *   called by Vercel Cron (Pro: every minute; Hobby: once a day) or another
 *   pinger. Deadlines are only noticed when one of these runs.
 * - The live location relay and rate limits are per instance.
 * For real deadlines, run `npm run server` on a long-running host instead.
 */
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDeps } from "./deps.js";
import { DemoRegistry } from "./demo/live-demo.js";
import { MemoryStore } from "./store/memory.js";
import { MongoStore } from "./store/mongo.js";
import type { Store } from "./store/store.js";
import { createCallService } from "./voice/calls.js";

let appPromise: Promise<ReturnType<typeof createApp>> | null = null;

/** One app (and one MongoDB connection) per warm function instance. */
export function getApp() {
  appPromise ??= (async () => {
    const config = loadConfig();
    let store: Store;
    if (config.mongoUri) store = await MongoStore.connect(config.mongoUri, config.mongoDb);
    else {
      console.warn("[api] MONGODB_URI is not set: using an in-memory store. Data is lost between invocations.");
      store = new MemoryStore();
    }
    const calls = createCallService(process.env);
    const deps = createDeps(config, store, { calls });
    if (config.demoIncidents) deps.demos = new DemoRegistry(calls);
    return createApp(deps);
  })();
  return appPromise;
}
