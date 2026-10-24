import { Buffer } from "node:buffer";

const API_ORIGIN = "https://console.neon.tech/api/v2";

function storageConfig() {
  return {
    apiKey: process.env.NEON_API_KEY,
    projectId: process.env.NEON_PROJECT_ID,
    branchId: process.env.NEON_BRANCH_ID,
    bucket: process.env.NEON_STORAGE_BUCKET ?? "sua-assets",
  };
}

export function neonStorageConfigured() {
  const { apiKey, projectId, branchId, bucket } = storageConfig();
  return Boolean(apiKey && projectId && branchId && bucket);
}

export async function checkNeonStorage() {
  const { projectId, branchId, bucket } = storageConfig();
  const status = await neonRequest(
    `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/storage`,
  );
  const state = await status.json();
  if (!state.enabled || !state.s3_endpoint || !state.region) {
    throw new Error("Neon Object Storage is not enabled for this branch or region");
  }
  // Presigning does not write the object. It verifies the configured bucket
  // is available and that this API key can authorize upload operations.
  await presignNeonObject(`__sua_preflight__/${Date.now()}`, "upload", "text/plain", 30);
  return { region: state.region, bucket };
}

export async function createNeonStorageBucket() {
  const { projectId, branchId, bucket } = storageConfig();
  const path = `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/buckets`;
  try {
    const response = await neonRequest(path, {
      method: "POST",
      body: JSON.stringify({ name: bucket, access_level: "private" }),
    });
    const result = await response.json().catch(() => ({}));
    return { bucket: result.data?.name ?? result.name ?? bucket, created: true };
  } catch (error) {
    // Make the command safe to repeat when Neon reports that the bucket exists.
    if (!/\(409\)|already exists|bucket exists/i.test(error?.message ?? "")) throw error;
    await checkNeonStorage();
    return { bucket, created: false };
  }
}

function objectPath(key, suffix = "") {
  const { projectId, branchId, bucket } = storageConfig();
  // Neon treats the complete object key as one path parameter; nested-key
  // slashes must be percent-encoded rather than interpreted as extra segments.
  const encodedKey = encodeURIComponent(key);
  return `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branchId)}/buckets/${encodeURIComponent(bucket)}/objects/${encodedKey}${suffix}`;
}

async function neonRequest(path, options = {}) {
  if (!neonStorageConfigured()) throw new Error("Neon Object Storage is not configured");
  const { apiKey } = storageConfig();
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`Neon Object Storage request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return response;
}

export async function presignNeonObject(key, operation, contentType, expiresInSeconds = 900) {
  const response = await neonRequest(`${objectPath(key, "/presign")}`, {
    method: "POST",
    body: JSON.stringify({
      operation,
      ...(contentType ? { content_type: contentType } : {}),
      expires_in_seconds: expiresInSeconds,
    }),
  });
  const result = await response.json();
  const presign = result.data ?? result;
  if (!presign.url) throw new Error("Neon did not return a presigned URL");
  return {
    url: presign.url,
    headers: presign.headers ?? {},
    expiresAt: presign.expires_at ?? null,
  };
}

export async function getNeonObject(key, maxBytes = 50 * 1024 * 1024) {
  const response = await neonRequest(objectPath(key, "/download"));
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Neon object exceeds the allowed size");
  }
  if (!response.body) return Buffer.from(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        throw new Error("Neon object exceeds the allowed size");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytesRead);
}

export async function putNeonObject(key, bytes, contentType) {
  const presign = await presignNeonObject(key, "upload", contentType, 900);
  const response = await fetch(presign.url, {
    method: "PUT",
    headers: { ...presign.headers, "Content-Length": String(bytes.length) },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`Neon object upload failed (${response.status})`);
  }
}

export async function deleteNeonObject(key) {
  await neonRequest(objectPath(key), { method: "DELETE" });
}
