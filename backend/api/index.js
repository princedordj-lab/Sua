// Vercel entry point.
//
// Vercel also auto-detects an Express app at src/index.js (default export) and
// routes every path to it, which is how the app is normally served. This file
// exists so a deployment that only understands the api/ directory convention
// still has a function at /api; it re-exports the same app.
//
// `npm run build` separately produces dist/index.js (a self-contained esbuild
// bundle), which is not used by Vercel today.
//
// Do not remove src/index.js's default export: that is the detection contract.

import app from "../src/index.js";

export default app;
