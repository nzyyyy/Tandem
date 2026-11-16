import koffi from "koffi";
import { Socket } from "node:net";
import { closeSync } from "node:fs";

const libc = koffi.load("/usr/lib/libSystem.B.dylib");
const socket = libc.func("int socket(int domain, int type, int protocol)");
const connect = libc.func("int connect(int fd, const void *address, unsigned int length)");
const getpeereid = libc.func(
  "int getpeereid(int fd, _Out_ unsigned int *uid, _Out_ unsigned int *gid)",
);
const getsockopt = libc.func(
  "int getsockopt(int fd, int level, int option, _Out_ int *value, _Inout_ unsigned int *length)",
);
const fcntl = libc.func("int fcntl(int fd, int command, ...)");

export function connectRuntimeSocket(path: string, expectedPID: number): Socket {
  const name = Buffer.from(path + "\0");
  if (name.length > 104) throw new Error("INVALID_SOCKET_PATH");
  const fd: number = socket(1, 1, 0);
  if (fd < 0) throw new Error("RUNTIME_DISCONNECTED");
  try {
    const address = Buffer.alloc(106);
    address[0] = 106;
    address[1] = 1;
    name.copy(address, 2);
    if (fcntl(fd, 2, "int", 1) !== 0 || connect(fd, address, address.length) !== 0)
      throw new Error("RUNTIME_DISCONNECTED");
    const uid = [0],
      gid = [0],
      pid = [0],
      length = [4];
    // Authenticate the kernel peer before sending the secret hello token.
    if (
      getpeereid(fd, uid, gid) !== 0 ||
      uid[0] !== process.getuid!() ||
      getsockopt(fd, 0, 2, pid, length) !== 0 ||
      pid[0] !== expectedPID
    )
      throw new Error("INVALID_PEER");
    return new Socket({ fd, readable: true, writable: true });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
