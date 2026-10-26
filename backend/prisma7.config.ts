import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Prisma CLI (migrate/db push) must use the direct (unpooled) Neon
    // endpoint. The app runtime uses DATABASE_URL (pooled) via a driver adapter.
    url: process.env["DIRECT_URL"],
  },
});
