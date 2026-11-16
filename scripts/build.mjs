import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { packager } from "@electron/packager";
import { compile } from "./compile.mjs";

compile();
const stage = resolve("dist/package");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const path of ["desktop", "shared", "runtime", "renderer"])
  cpSync(`dist/app/${path}`, `${stage}/${path}`, { recursive: true });
cpSync(process.execPath, `${stage}/node`);
for (const file of [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
])
  cpSync(file, `${stage}/${file}`);
execFileSync(
  "pnpm",
  [
    "install",
    "--prod",
    "--offline",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--ignore-workspace",
  ],
  { cwd: stage, stdio: "inherit", env: { ...process.env, CI: "true" } },
);
const manifest = JSON.parse(readFileSync(`${stage}/package.json`, "utf8"));
writeFileSync(
  `${stage}/package.json`,
  JSON.stringify({
    name: "tandem",
    version: "0.2.0",
    type: "module",
    main: "desktop/main.js",
    dependencies: manifest.dependencies,
  }),
);
const iconset = resolve("dist/AppIcon.iconset");
mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2])
    execFileSync(
      "sips",
      [
        "-z",
        String(size * scale),
        String(size * scale),
        "resources/AppIcon.png",
        "--out",
        `${iconset}/icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
      ],
      { stdio: "ignore" },
    );
execFileSync("iconutil", [
  "-c",
  "icns",
  iconset,
  "-o",
  resolve("dist/AppIcon.icns"),
]);
let notices =
  "Tandem third-party notices\nElectron and Chromium licenses accompany the application in Contents/Resources.\n";
const dependencyRoot = `${stage}/node_modules/.pnpm`;
for (const entry of readdirSync(dependencyRoot, { withFileTypes: true }).filter(
  (item) => item.isDirectory() && item.name !== "node_modules",
)) {
  const root = `${dependencyRoot}/${entry.name}/node_modules`;
  for (const item of readdirSync(root, { withFileTypes: true })) {
    const packages =
      item.isDirectory() && item.name.startsWith("@")
        ? readdirSync(`${root}/${item.name}`, { withFileTypes: true })
            .filter((item) => item.isDirectory())
            .map((child) => `${root}/${item.name}/${child.name}`)
        : item.isDirectory()
          ? [`${root}/${item.name}`]
          : [];
    for (const path of packages) {
      const pkg = JSON.parse(readFileSync(`${path}/package.json`, "utf8"));
      notices += `\n${pkg.name} ${pkg.version} (${pkg.license ?? "see package"})\n`;
      for (const file of readdirSync(path).filter((name) =>
        /^(licen[cs]e|copying|notice)(\.|$)/i.test(name),
      ))
        notices += readFileSync(`${path}/${file}`, "utf8") + "\n";
    }
  }
}
writeFileSync(`${stage}/ThirdPartyNotices.txt`, notices);
const [bundle] = await packager({
  dir: stage,
  out: resolve("dist/electron"),
  name: "Tandem",
  platform: "darwin",
  arch: "arm64",
  electronVersion: JSON.parse(
    readFileSync("node_modules/electron/package.json", "utf8"),
  ).version,
  appBundleId: "dev.tandem.personal-agent",
  appVersion: "0.2.0",
  buildVersion: "17",
  icon: resolve("dist/AppIcon.icns"),
  asar: false,
  prune: false,
  derefSymlinks: false,
  overwrite: true,
  extendInfo: { LSMinimumSystemVersion: "15.0" },
});
rmSync("dist/Tandem.app", { recursive: true, force: true });
const app = `${bundle}/Tandem.app`;
const modules = `${app}/Contents/Resources/app/node_modules`;
// Packager absolutizes pnpm links; restore the locked relative graph before shipping.
rmSync(modules, { recursive: true, force: true });
cpSync(`${stage}/node_modules`, modules, {
  recursive: true,
  verbatimSymlinks: true,
});
for (const file of ["LICENSE", "LICENSES.chromium.html"])
  cpSync(`${bundle}/${file}`, `${app}/Contents/Resources/${file}`);
cpSync(app, "dist/Tandem.app", { recursive: true, verbatimSymlinks: true });
execFileSync(
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
  ["-f", resolve("dist/Tandem.app")],
);
console.log(`Built ${resolve("dist/Tandem.app")}`);
