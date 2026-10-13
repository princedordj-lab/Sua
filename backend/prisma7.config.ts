import "dotenv/config";
import { defineConfig } from "prisma/config";

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
