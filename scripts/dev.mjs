// Starts the YTC backend (npm run server) and the Vite dev server together.
// Ctrl-C stops both. The operator console is at http://localhost:5173/#operator.
import { spawn } from "node:child_process";

const procs = [
  spawn("npm", ["run", "server"], { stdio: "inherit" }),
  spawn("npx", ["vite"], { stdio: "inherit" }),
];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
for (const p of procs) p.on("exit", (code) => (stop(), (process.exitCode ||= code ?? 0)));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
