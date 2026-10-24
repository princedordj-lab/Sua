import "../src/config/env.js";
import { checkNeonStorage } from "../src/config/neon-storage.js";

try {
  const result = await checkNeonStorage();
  console.log(`Neon Object Storage is ready (region ${result.region}, bucket ${result.bucket}).`);
} catch (error) {
  console.error(`Neon Object Storage preflight failed: ${error?.message ?? error}`);
  process.exitCode = 1;
}
