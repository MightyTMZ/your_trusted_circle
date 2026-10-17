/**
 * Starts the API and its scheduler as a long-running process (recommended
 * for real deadlines; see docs/backend.md "Deploying"). Uses MongoDB when
 * MONGODB_URI is set; otherwise an in-memory store that loses everything on
 * restart (demos only).
 */
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { enabledProviders, loadConfig } from "./config.js";
import { runRetention } from "./data/retention.js";
import { createDeps } from "./deps.js";
import { runSchedulerPass } from "./safety/scheduler.js";
import { MemoryStore } from "./store/memory.js";
import { MongoStore } from "./store/mongo.js";
import type { Store } from "./store/store.js";

const config = loadConfig();

let store: Store;
if (config.mongoUri) {
  store = await MongoStore.connect(config.mongoUri, config.mongoDb);
  console.log(`[api] MongoDB database "${config.mongoDb}"`);
} else {
  store = new MemoryStore();
  console.warn("[api] MONGODB_URI is not set: using an in-memory store. Data is lost on restart.");
}

const deps = createDeps(config, store);
const app = createApp(deps);

// Deadlines live in the database; this loop only notices them. A pass that is
// still running is never overlapped by the next one.
let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await runSchedulerPass(deps);
  } catch (err) {
    console.error(`[scheduler] pass failed: ${(err as Error).name}`);
  } finally {
    running = false;
  }
}, 1000);
if (config.retentionInApi) {
  setInterval(() => void runRetention(deps).catch((err) => console.error(`[retention] failed: ${(err as Error).name}`)), 60 * 60 * 1000);
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const list = enabledProviders(config);
  console.log(`[api] listening on http://localhost:${info.port}`);
  console.log(`[api] sign-in providers: ${list.length > 0 ? list.join(", ") : "none configured (see .env.example)"}`);
  console.log(`[api] voice-agent service: ${config.voiceAgentUrl ? "configured" : "not configured (emergency step recorded as simulated only)"}`);
});
