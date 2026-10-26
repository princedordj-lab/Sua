import { cloudinary, cloudinaryConfigured } from "../config/cloudinary.js";
import {
  deleteNeonObject,
  getNeonObject,
  neonStorageConfigured,
  presignNeonObject,
} from "../config/neon-storage.js";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

const MAX_BYTES = {
  audio: MAX_AUDIO_BYTES,
  document: MAX_UPLOAD_BYTES,
  image: MAX_UPLOAD_BYTES,
};

export function storageProviderOf(asset) {
  return asset.storageProvider ?? "cloudinary";
}

export async function readAssetBytes(asset) {
  if (storageProviderOf(asset) === "neon") {
    return getNeonObject(asset.publicId, MAX_BYTES[asset.kind] ?? MAX_UPLOAD_BYTES);
  }
  if (!cloudinaryConfigured()) throw new Error("Cloudinary compatibility storage is not configured");
  const url = cloudinary.url(asset.publicId, {
    resource_type: asset.resourceType,
    type: "authenticated",
    sign_url: true,
    secure: true,
  });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cloudinary fetch failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

export async function assetDownloadUrl(asset) {
  if (storageProviderOf(asset) === "neon") {
    if (!neonStorageConfigured()) throw new Error("Neon Object Storage is not configured");
    return presignNeonObject(asset.publicId, "download", undefined, 900);
  }
  if (!cloudinaryConfigured()) throw new Error("Cloudinary compatibility storage is not configured");
  return {
    url: cloudinary.url(asset.publicId, {
      resource_type: asset.resourceType,
      type: "authenticated",
      sign_url: true,
      secure: true,
    }),
    expiresAt: null,
  };
}

export async function deleteAssetObject(asset) {
  if (!asset.publicId || asset.publicId === "pending") return;
  if (storageProviderOf(asset) === "neon") return deleteNeonObject(asset.publicId);
  if (!cloudinaryConfigured()) throw new Error("Cloudinary compatibility storage is not configured");
  const result = await cloudinary.uploader.destroy(asset.publicId, {
    resource_type: asset.resourceType,
  });
  if (result?.result !== "ok" && result?.result !== "not found") {
    throw new Error(`Cloudinary object delete returned ${result?.result ?? "no result"}`);
  }
}

export async function verifyNeonObject(key, maxBytes = MAX_UPLOAD_BYTES) {
  if (!neonStorageConfigured()) throw new Error("Neon Object Storage is not configured");
  let bytes;
  try {
    bytes = await getNeonObject(key, maxBytes);
  } catch (error) {
    if (/exceeds the allowed size/i.test(error?.message ?? "")) {
      await deleteNeonObject(key).catch((deleteError) => {
        console.error(`Oversized Neon object cleanup failed for ${key}:`, deleteError?.message ?? deleteError);
      });
    }
    throw error;
  }
  if (!bytes || !bytes.length) throw new Error("Uploaded object is empty");
  if (bytes.length > maxBytes) {
    await deleteNeonObject(key).catch(() => {});
    throw new Error("Uploaded object exceeds the allowed size");
  }
  return { bytes: bytes.length, buffer: bytes };
}
