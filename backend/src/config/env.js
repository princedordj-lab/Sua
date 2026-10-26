import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the backend root directory relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "../..");
const envPath = path.join(backendRoot, ".env");
const envLocalPath = path.join(backendRoot, ".env.local");

// Load .env and .env.local if they exist locally (.env.local overrides .env).
// On Vercel/Production, process.env is already populated by the platform.
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath, override: true });
}
