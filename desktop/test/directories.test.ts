import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  renameSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { DirectoryAccess } from "../directories.ts";

test("read-only descriptor grants reject traversal, links, wrong project and revocation", () => {
  const root = mkdtempSync("/tmp/tandem-directory-");
  const access = new DirectoryAccess();
  try {
    const data = "\uFEFF第一行\r\n第二行\n第三行";
    writeFileSync(`${root}/notes.md`, data);
    symlinkSync("/etc", `${root}/escape`);
    symlinkSync(`${root}/notes.md`, `${root}/alias.md`);
    const id = access.authorize(root, "project");
    const read = (path: string, projectId = "project") =>
      access.execute({
        method: "read_file",
        grantId: id,
        path,
        projectId,
        startLine: 2,
        endLine: 3,
      });
    const result = read("notes.md");
    assert.equal(result.content, "第二行\n第三行");
    assert.equal(result.startLine, 2);
    assert.equal(result.endLine, 3);
    assert.match(String(result.version), /^[a-f0-9]{64}$/);
    assert.equal(result.version, read("notes.md").version);
    for (const path of [
      "../notes.md",
      "/etc/passwd",
      "escape/passwd",
      "alias.md",
      "a/../notes.md",
      "a//notes.md",
      "a\0b",
    ])
      assert.ok(read(path).error, path);
    assert.equal(read("notes.md", "other").error, "DIRECTORY_UNAUTHORIZED");
    assert.equal(read(".").error, "NOT_REGULAR_FILE");
    assert.equal(readFileSync(`${root}/notes.md`, "utf8"), data);
    const listing = access.execute({
      method: "list_directory",
      grantId: id,
      projectId: "project",
      path: ".",
    });
    assert.deepEqual(listing.entries, ["alias.md", "escape", "notes.md"]);
    access.revoke(id);
    assert.equal(read("notes.md").error, "DIRECTORY_UNAUTHORIZED");
  } finally {
    access.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("grants preserve UTF-8, file size, output bounds, listing limits and directory identity", () => {
  const root = mkdtempSync("/tmp/tandem-directory-");
  const moved = `${root}.moved`;
  const access = new DirectoryAccess();
  try {
    const id = access.authorize(root, null);
    const read = (path: string, startLine = 1, endLine = 400) =>
      access.execute({
        method: "read_file",
        grantId: id,
        path,
        startLine,
        endLine,
      });
    for (const [name, data, error] of [
      ["invalid.txt", Buffer.from([255, 254]), "INVALID_UTF8"],
      ["binary.txt", Buffer.from([65, 0, 66]), "BINARY_CONTENT"],
      ["fake.pdf", Buffer.from("plain text"), "UNSUPPORTED_FORMAT"],
      ["huge.txt", Buffer.alloc(1048577, 65), "FILE_TOO_LARGE"],
    ] as const) {
      writeFileSync(`${root}/${name}`, data);
      assert.equal(read(name).error, error);
    }
    writeFileSync(`${root}/large.txt`, "汉".repeat(20000));
    const result = read("large.txt");
    assert.equal(result.truncated, true);
    assert.equal(result.partialLine, true);
    assert.ok(Buffer.byteLength(String(result.content)) <= 32768);
    assert.ok(!String(result.content).includes("�"));
    assert.equal(read("large.txt", 0, 1).error, "TOOL_ARGUMENTS");
    assert.equal(read("large.txt", 1, 401).error, "TOOL_ARGUMENTS");
    assert.equal(read("large.txt", 2, 2).error, "LINE_RANGE");
    for (let index = 0; index < 101; index++)
      writeFileSync(`${root}/item-${index}`, "");
    const listing = access.execute({
      method: "list_directory",
      grantId: id,
      path: ".",
    });
    assert.equal((listing.entries as string[]).length, 100);
    assert.equal(listing.truncated, true);
    renameSync(root, moved);
    mkdirSync(root);
    writeFileSync(`${root}/large.txt`, "replacement");
    assert.ok(read("large.txt").error);
  } finally {
    access.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});
test("renewing a directory keeps its id and resource identity", () => {
  const root = mkdtempSync("/tmp/tandem-directory-");
  const access = new DirectoryAccess();
  try {
    const id = access.authorize(root, null);
    const before = access.registrations();
    access.authorize(root, null, id);
    assert.deepEqual(access.registrations(), before);
    access.close();
    assert.deepEqual(access.registrations(), []);
  } finally {
    access.close();
    rmSync(root, { recursive: true, force: true });
  }
});
