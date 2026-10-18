// Vercel Function for the YTC API. vercel.json rewrites every /api/* request here.
// Built from src/server by `npm run build:server` (see docs/backend.md, "Deploying").
import { handle } from "hono/vercel";
import { getApp } from "../build/server/src/server/vercel.js";

const app = await getApp();
const handler = handle(app);

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
