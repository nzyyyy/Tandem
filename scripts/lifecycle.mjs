process.argv.push("--bundled", "--lifecycle");
await import("./smoke.mjs");
