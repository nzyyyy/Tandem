import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
export function compile() {
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.version !== "v24.22.2")
    throw new Error("Requires Apple Silicon macOS and Node 24.22.2");
  execFileSync("pnpm", ["exec", "tsc"], { stdio: "inherit" });
  execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.desktop.json"], {
    stdio: "inherit",
  });
  mkdirSync("dist/app", { recursive: true });
  cpSync(process.execPath, "dist/app/node");
  cpSync("dist/runtime", "dist/app/runtime", { recursive: true });
  execFileSync("pnpm", ["exec", "vite", "build"], { stdio: "inherit" });
}
