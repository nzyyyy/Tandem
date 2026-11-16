import koffi from "koffi";
import { closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { basename, extname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { Payload } from "../shared/bridge.ts";

// Keep descriptor-relative, no-follow traversal and F_GETPATH checks from the Swift host.
const libc = koffi.load("/usr/lib/libSystem.B.dylib");
const open = libc.func("int open(const char *path, int flags)");
const openat = libc.func("int openat(int fd, const char *path, int flags)");
const dup = libc.func("int dup(int fd)");
const getpath = libc.func("int fcntl(int fd, int cmd, ...)");
const fdopendir = libc.func("void *fdopendir(int fd)");
const readdir = libc.func("void *readdir(void *dir)");
const closedir = libc.func("int closedir(void *dir)");
const O_DIRECTORY = 0x100000,
  O_NOFOLLOW = 0x100,
  O_CLOEXEC = 0x1000000,
  O_NONBLOCK = 4;
type Grant = {
  id: string;
  fd: number;
  path: string;
  projectId: string | null;
  resourceId: string;
};
function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
function pathFor(fd: number) {
  const buffer = Buffer.alloc(1024);
  requireValue(getpath(fd, 50, "void *", buffer) === 0, "FILE_CHANGED");
  return buffer.toString("utf8", 0, buffer.indexOf(0));
}
export class DirectoryAccess {
  private grants = new Map<string, Grant>();
  authorize(path: string, projectId: string | null, renewing?: string) {
    const fd: number = open(path, O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    requireValue(fd >= 0, "DIRECTORY_UNAVAILABLE");
    try {
      const info = fstatSync(fd, { bigint: true });
      const id = renewing ?? randomUUID();
      const grant = {
        id,
        fd,
        path: pathFor(fd),
        projectId,
        resourceId: `${info.dev}:${info.ino}`,
      };
      this.revoke(id);
      this.grants.set(id, grant);
      return id;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  registrations() {
    return [...this.grants.values()].map(
      ({ id, resourceId, path, projectId }) => ({
        id,
        resourceId,
        label: basename(path),
        projectId,
      }),
    );
  }
  revoke(id: string) {
    const grant = this.grants.get(id);
    if (grant) {
      closeSync(grant.fd);
      this.grants.delete(id);
    }
  }
  close() {
    for (const id of this.grants.keys()) this.revoke(id);
  }
  private verify(fd: number, grant: Grant, relative: string) {
    const root = pathFor(grant.fd),
      actual = pathFor(fd);
    requireValue(
      root === grant.path &&
        (actual === root || actual.startsWith(root === "/" ? "/" : root + "/")),
      "DIRECTORY_SCOPE",
    );
    requireValue(
      actual ===
        (relative === "." ? root : (root === "/" ? "" : root) + "/" + relative),
      "FILE_CHANGED",
    );
    const current = lstatSync(grant.path, { bigint: true }),
      held = fstatSync(grant.fd, { bigint: true });
    requireValue(
      current.dev === held.dev &&
        current.ino === held.ino &&
        current.isDirectory() &&
        !current.isSymbolicLink(),
      "DIRECTORY_UNAVAILABLE",
    );
  }
  execute(request: Payload): Payload {
    let fd = -1;
    try {
      const grant = this.grants.get(String(request.grantId));
      requireValue(
        grant && grant.projectId === (request.projectId ?? null),
        "DIRECTORY_UNAUTHORIZED",
      );
      const relative = request.path;
      requireValue(
        typeof relative === "string" &&
          !relative.startsWith("/") &&
          !relative.includes("\0") &&
          Buffer.byteLength(relative) <= 1024,
        "DIRECTORY_SCOPE",
      );
      const parts = relative.split("/");
      requireValue(
        relative === "." ||
          parts.every((part) => part && part !== "." && part !== ".."),
        "DIRECTORY_SCOPE",
      );
      fd = dup(grant.fd);
      requireValue(fd >= 0, "FILE_UNAVAILABLE");
      if (relative !== ".")
        for (const [index, part] of parts.entries()) {
          const next: number = openat(
            fd,
            part,
            O_NOFOLLOW |
              O_CLOEXEC |
              O_NONBLOCK |
              (index < parts.length - 1 ? O_DIRECTORY : 0),
          );
          requireValue(next >= 0, "DIRECTORY_SCOPE");
          closeSync(fd);
          fd = next;
        }
      this.verify(fd, grant, relative);
      const before = fstatSync(fd, { bigint: true });
      const verify = () => {
        const after = fstatSync(fd, { bigint: true });
        requireValue(
          before.size === after.size &&
            before.mtimeNs === after.mtimeNs &&
            before.ctimeNs === after.ctimeNs,
          "FILE_CHANGED",
        );
        this.verify(fd, grant, relative);
      };
      if (request.method === "list_directory") {
        requireValue(before.isDirectory(), "NOT_DIRECTORY");
        const copy: number = dup(fd);
        requireValue(copy >= 0, "FILE_UNAVAILABLE");
        const dir = fdopendir(copy);
        if (!dir) {
          closeSync(copy);
          throw new Error("FILE_UNAVAILABLE");
        }
        const entries: string[] = [];
        let truncated = false;
        try {
          for (;;) {
            const entry = readdir(dir);
            if (!entry) break;
            // Darwin dirent: d_namlen at 18, d_name at 21; decode only the bounded name.
            const header = Buffer.from(koffi.decode(entry, "uint8_t", 21));
            const length = header.readUInt16LE(18);
            requireValue(length > 0 && length <= 1023, "FILE_UNAVAILABLE");
            const name = Buffer.from(
              koffi.decode(entry, 21, "uint8_t", length),
            ).toString("utf8");
            if (name === "." || name === "..") continue;
            if (entries.length === 100) {
              truncated = true;
              break;
            }
            entries.push(name);
          }
        } finally {
          closedir(dir);
        }
        verify();
        return {
          grantId: grant.id,
          path: relative,
          entries: entries.sort(),
          truncated,
        };
      }
      requireValue(
        request.method === "read_file" && before.isFile(),
        "NOT_REGULAR_FILE",
      );
      requireValue(before.size <= 1048576n, "FILE_TOO_LARGE");
      requireValue(
        ![
          "pdf",
          "doc",
          "docx",
          "rtf",
          "pages",
          "xlsx",
          "pptx",
          "png",
          "jpg",
          "jpeg",
          "zip",
        ].includes(extname(relative).slice(1).toLowerCase()),
        "UNSUPPORTED_FORMAT",
      );
      const first = request.startLine,
        last = request.endLine;
      requireValue(
        typeof first === "number" &&
          typeof last === "number" &&
          Number.isSafeInteger(first) &&
          Number.isSafeInteger(last) &&
          first > 0 &&
          last >= first &&
          last - first < 400,
        "TOOL_ARGUMENTS",
      );
      const chunks: Buffer[] = [];
      let size = 0;
      const deadline = Date.now() + 3000;
      for (;;) {
        requireValue(Date.now() < deadline, "NATIVE_TIMEOUT");
        const buffer = Buffer.alloc(16384);
        const count = readSync(fd, buffer, 0, buffer.length, null);
        if (!count) break;
        size += count;
        requireValue(size <= 1048576, "FILE_TOO_LARGE");
        chunks.push(buffer.subarray(0, count));
      }
      verify();
      const data = Buffer.concat(chunks);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new Error("INVALID_UTF8");
      }
      requireValue(
        !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(content),
        "BINARY_CONTENT",
      );
      const lines = content
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n")
        .split("\n");
      requireValue(first <= lines.length, "LINE_RANGE");
      let selected = "",
        end = first,
        partialLine = false,
        clipped = false;
      for (
        let number = first;
        number <= Math.min(last, lines.length);
        number++
      ) {
        const separator = number === first ? "" : "\n";
        const remaining = 32768 - Buffer.byteLength(selected + separator);
        if (remaining < 0) {
          end = number - 1;
          clipped = true;
          break;
        }
        let line = lines[number - 1]!;
        if (Buffer.byteLength(line) > remaining) {
          let bytes = 0;
          const chars: string[] = [];
          for (const char of line) {
            bytes += Buffer.byteLength(char);
            if (bytes > remaining) break;
            chars.push(char);
          }
          line = chars.join("");
          partialLine = true;
          clipped = true;
        }
        selected += separator + line;
        end = number;
        if (partialLine) break;
      }
      return {
        resourceId: `${grant.id}:${relative}`,
        grantId: grant.id,
        path: relative,
        version: createHash("sha256").update(data).digest("hex"),
        startLine: first,
        endLine: end,
        totalLines: lines.length,
        content: selected,
        truncated: clipped || end < lines.length,
        partialLine,
      };
    } catch (error) {
      return {
        error:
          error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message)
            ? error.message
            : "FILE_UNAVAILABLE",
      };
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  }
}
