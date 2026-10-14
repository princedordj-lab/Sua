import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// Load the backend environment relative to this file, not process.cwd().
// This keeps Clerk and Prisma configured when the server is launched from
// either D:\Sua or D:\Sua\backend.
dotenv.config({ path: path.join(backendRoot, ".env") });
