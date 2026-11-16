import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AppError, record, requireValue, text } from "./errors.ts";

import type { AppConfig, Connection, ModelSelection } from "./contract.ts";
export type { AppConfig, Connection, ModelSelection } from "./contract.ts";
export const emptyConfig = (): AppConfig => ({
  schemaVersion: 1,
  modelConnections: [],
  defaultModel: null,
});

export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  requireValue(info.isDirectory() && info.uid === process.getuid!(), "UNSAFE_DATA_DIRECTORY");
  chmodSync(path, 0o700);
}

export function validateConfig(value: unknown): AppConfig {
  const config = record(value);
  requireValue(config.schemaVersion === 1, "CONFIG_VERSION");
  requireValue(
    Array.isArray(config.modelConnections) && config.modelConnections.length <= 50,
    "CONFIG_CONNECTIONS",
  );
  const ids = new Set<string>();
  const modelConnections = config.modelConnections.map((value: unknown): Connection => {
    const item = record(value);
    const id = text(item.id);
    requireValue(/^[a-zA-Z0-9._-]+$/.test(id), "CONFIG_CONNECTION_ID");
    requireValue(!ids.has(id), "CONFIG_DUPLICATE_ID");
    ids.add(id);
    requireValue(
      item.name === undefined ||
        (typeof item.name === "string" &&
          item.name.trim().length > 0 &&
          item.name.length <= 120 &&
          !/[\x00-\x1f\x7f]/.test(item.name)),
      "CONFIG_CONNECTION_NAME",
    );
    requireValue(
      (item.protocol === "openai" && ["chat_completions", "responses"].includes(item.apiType)) ||
        (item.protocol === "anthropic" && item.apiType === "messages"),
      "CONFIG_PROTOCOL",
    );
    const url = text(item.url, 2048);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppError("CONFIG_URL");
    }
    requireValue(
      parsed.protocol === "https:" ||
        (parsed.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)),
      "CONFIG_HTTPS_REQUIRED",
    );
    requireValue(
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash,
      "CONFIG_URL",
    );
    requireValue(
      typeof item.key === "string" && item.key.length <= 4096 && !/[\r\n]/.test(item.key),
      "CONFIG_KEY",
    );
    requireValue(
      Array.isArray(item.modelNames) && item.modelNames.length > 0 && item.modelNames.length <= 20,
      "CONFIG_MODELS",
    );
    const modelNames = item.modelNames.map((name: unknown) => text(name, 256));
    requireValue(
      modelNames.every((name: string) => !/[\x00-\x1f\x7f]/.test(name)),
      "CONFIG_MODELS",
    );
    requireValue(new Set(modelNames).size === modelNames.length, "CONFIG_MODELS");
    return {
      id,
      ...(item.name === undefined ? {} : { name: item.name.trim() }),
      protocol: item.protocol,
      apiType: item.apiType,
      url,
      key: item.key,
      modelNames,
    };
  });
  let defaultModel: ModelSelection | null = null;
  if (config.defaultModel != null) {
    const selected = record(config.defaultModel);
    defaultModel = {
      connectionId: text(selected.connectionId),
      modelName: text(selected.modelName, 256),
    };
    requireValue(
      modelConnections.some(
        (item) =>
          item.id === defaultModel!.connectionId &&
          item.modelNames.includes(defaultModel!.modelName),
      ),
      "CONFIG_DEFAULT_MODEL",
    );
  }
  return { schemaVersion: 1, modelConnections, defaultModel };
}

export class ConfigStore {
  readonly path: string;
  readonly directory: string;
  constructor(directory: string) {
    privateDirectory(directory);
    this.directory = directory;
    this.path = join(directory, "config.json");
  }

  private raw(): Buffer | null {
    if (!existsSync(this.path)) return null;
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = lstatSync(this.path);
      requireValue(
        info.isFile() && info.uid === process.getuid!() && info.size <= 256 * 1024,
        "CONFIG_FILE",
      );
      chmodSync(this.path, 0o600);
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  read(): { config: AppConfig; revision: string } {
    const raw = this.raw();
    if (raw === null) return { config: emptyConfig(), revision: "missing" };
    let value: unknown;
    try {
      value = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new AppError("CONFIG_INVALID_JSON");
    }
    return {
      config: validateConfig(value),
      revision: createHash("sha256").update(raw).digest("hex"),
    };
  }

  save(value: unknown, expectedRevision: unknown) {
    const config = validateConfig(value);
    const current = this.read();
    requireValue(current.revision === expectedRevision, "CONFIG_CONFLICT");
    const raw = Buffer.from(JSON.stringify(config, null, 2) + "\n");
    requireValue(raw.length <= 256 * 1024, "CONFIG_TOO_LARGE");
    const temporary = join(this.directory, `.config-${randomUUID()}.tmp`);
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeFileSync(fd, raw);
      fsyncSync(fd);
      // Recheck before replacement; all in-app writes are synchronous through this owner.
      requireValue(this.read().revision === expectedRevision, "CONFIG_CONFLICT");
      renameSync(temporary, this.path);
    } finally {
      closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return this.read();
  }
}

export function redact(value: string, config: AppConfig): string {
  for (const connection of config.modelConnections) {
    if (connection.key) value = value.split(connection.key).join("[REDACTED]");
  }
  return value.replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|Bearer\s+[a-zA-Z0-9._-]{12,})\b/g, "[REDACTED]");
}

export function bindModel(
  config: AppConfig,
  selection?: ModelSelection | null,
): Connection & { modelName: string } {
  const selected = selection ?? config.defaultModel;
  requireValue(selected, "MODEL_REQUIRED");
  const connection = config.modelConnections.find((item) => item.id === selected.connectionId);
  requireValue(
    connection && connection.modelNames.includes(selected.modelName),
    "MODEL_UNAVAILABLE",
  );
  requireValue(connection.key.length > 0, "MODEL_KEY_REQUIRED");
  return { ...connection, modelName: selected.modelName };
}
