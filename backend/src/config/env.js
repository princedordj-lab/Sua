import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the backend root directory relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "../..");
const envPath = path.join(backendRoot, ".env");

// Load .env file ONLY if it exists locally.
// On Vercel/Production, process.env is already populated by the platform,
// so we skip dotenv entirely to avoid errors or conflicts.
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  // Optional: Log for debugging local dev vs prod behavior
  // console.log("No .env file found at", envPath, "- relying on system/process env vars.");
}
