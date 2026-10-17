/**
 * The YTC backend server. Today it serves the simulated-call routes; the
 * voice-agent escalation runs here, in the same process as the backend, so
 * it reads and appends to the incident timeline directly.
 *
 *   npm run server        (the operator console: npm run dev, then /#operator)
 *
 * Reads GEMINI_API_KEY, ELEVENLABS_API_KEY and optional ELEVENLABS_VOICE_ID
 * from the environment or .env. Keys stay in this process. Listens on
 * localhost only.
 */
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { env, loadEnvFile } from "node:process";
import { GEMINI_FAST_MODEL, GEMINI_REASONING_MODEL, createGeminiModels } from "../agent/gemini.js";
import { CallService } from "./calls.js";
import { ElevenLabsSpeech } from "./elevenlabs.js";
import { createApiHandler } from "./http.js";

if (existsSync(".env")) loadEnvFile(".env");

const port = Number(env.YTC_SERVER_PORT ?? 8787);
const models = env.GEMINI_API_KEY ? createGeminiModels(env.GEMINI_API_KEY) : undefined;
const speech = env.ELEVENLABS_API_KEY ? new ElevenLabsSpeech({ apiKey: env.ELEVENLABS_API_KEY, voiceId: env.ELEVENLABS_VOICE_ID }) : undefined;
const calls = new CallService({ models, speech });
const reasoning = models ? `${GEMINI_REASONING_MODEL} -> ${GEMINI_FAST_MODEL}` : null;
const handler = createApiHandler(calls, { reasoning });

const server = createServer((req, res) => void handler(req, res));
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(`Port ${port} is already in use; another YTC backend is probably running.`);
  console.error(`Stop it (lsof -nP -iTCP:${port} -sTCP:LISTEN shows its PID), or set YTC_SERVER_PORT.`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`YTC backend on http://127.0.0.1:${port} (simulation only; no real calls are possible)`);
  console.log(`  reasoning:      ${reasoning ?? "off (no GEMINI_API_KEY): the agent speaks facts verbatim"}`);
  console.log(`  speech in/out:  ${speech ? `${speech.sttId} / ${speech.ttsId}` : "off (no ELEVENLABS_API_KEY): text only"}`);
});
