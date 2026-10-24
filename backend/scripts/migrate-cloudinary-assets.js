import "../src/config/env.js";
import { Buffer } from "node:buffer";
import { cloudinary, cloudinaryConfigured } from "../src/config/cloudinary.js";
import { getNeonObject, neonStorageConfigured, putNeonObject } from "../src/config/neon-storage.js";
import { prisma } from "../src/config/prisma.js";

const LIMITS = { audio: 50 * 1024 * 1024, document: 25 * 1024 * 1024, image: 25 * 1024 * 1024 };

function mimeFor(asset) {
  const format = String(asset.format ?? "").toLowerCase();
  const types = {
    pdf: "application/pdf", txt: "text/plain; charset=utf-8",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ppt: "application/vnd.ms-powerpoint",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    heic: "image/heic", heif: "image/heif", m4a: "audio/mp4", mp3: "audio/mpeg",
    wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac",
  };
  return types[format] ?? "application/octet-stream";
}

async function readCloudinary(asset) {
  const url = cloudinary.url(asset.publicId, {
    resource_type: asset.resourceType,
    type: "authenticated",
    sign_url: true,
    secure: true,
  });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cloudinary download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("Cloudinary object is empty");
  if (bytes.length > (LIMITS[asset.kind] ?? 0)) throw new Error("Object exceeds its configured file size limit");
  return bytes;
}

async function migrate(asset) {
  if (asset.storageProvider === "cloudinary") {
    const source = await readCloudinary(asset);
    let target;
    try {
      target = await getNeonObject(asset.publicId, LIMITS[asset.kind]);
    } catch (error) {
      if (!/\(404\)|not found/i.test(error?.message ?? "")) throw error;
    }
    if (!target) await putNeonObject(asset.publicId, source, mimeFor(asset));
    target = await getNeonObject(asset.publicId, LIMITS[asset.kind]);
    if (!source.equals(target)) throw new Error("Neon copy does not match Cloudinary source");

    await prisma.asset.update({
      where: { id: asset.id },
      data: { storageProvider: "neon", secureUrl: null, cloudinaryCleanupPending: true },
    });
    asset.storageProvider = "neon";
    asset.cloudinaryCleanupPending = true;
  }

  if (asset.storageProvider === "neon" && asset.cloudinaryCleanupPending) {
    const result = await cloudinary.uploader.destroy(asset.publicId, {
      resource_type: asset.resourceType,
    });
    if (result?.result !== "ok" && result?.result !== "not found") {
      throw new Error(`Cloudinary source cleanup returned ${result?.result ?? "no result"}`);
    }
    await prisma.asset.update({
      where: { id: asset.id },
      data: { cloudinaryCleanupPending: false },
    });
  }
}

async function main() {
  if (!neonStorageConfigured()) throw new Error("Set NEON_API_KEY, NEON_PROJECT_ID, NEON_BRANCH_ID, and NEON_STORAGE_BUCKET first");
  if (!cloudinaryConfigured()) throw new Error("Set Cloudinary credentials until all source files have been migrated");

  const assets = await prisma.asset.findMany({
    where: {
      status: "active",
      publicId: { not: "pending" },
      OR: [{ storageProvider: "cloudinary" }, { cloudinaryCleanupPending: true }],
    },
    orderBy: { createdAt: "asc" },
  });
  let failed = 0;
  for (const asset of assets) {
    try {
      await migrate(asset);
      console.log(`Migrated ${asset.id}`);
    } catch (error) {
      failed++;
      console.error(`Failed ${asset.id}: ${error?.message ?? error}`);
    }
  }
  console.log(`Finished: ${assets.length - failed}/${assets.length} assets migrated; ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
