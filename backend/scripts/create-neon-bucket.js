import "../src/config/env.js";
import { checkNeonStorage, createNeonStorageBucket } from "../src/config/neon-storage.js";

try {
  const bucket = await createNeonStorageBucket();
  const ready = await checkNeonStorage();
  console.log(
    `Neon Object Storage bucket ${bucket.bucket} ${bucket.created ? "created" : "already exists"} and passed preflight (region ${ready.region}).`,
  );
} catch (error) {
  console.error(`Neon Object Storage bucket setup failed: ${error?.message ?? error}`);
  process.exitCode = 1;
}
