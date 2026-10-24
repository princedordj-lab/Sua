ALTER TABLE "assets" ADD COLUMN "storageProvider" TEXT NOT NULL DEFAULT 'cloudinary';
ALTER TABLE "assets" ADD COLUMN "cloudinaryCleanupPending" BOOLEAN NOT NULL DEFAULT false;
