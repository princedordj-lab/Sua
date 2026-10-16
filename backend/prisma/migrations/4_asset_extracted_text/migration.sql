-- AlterTable (drift fix: Prisma manages updatedAt in application code)
ALTER TABLE "assets" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "notes" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "assets" ADD COLUMN "extractedText" TEXT;
