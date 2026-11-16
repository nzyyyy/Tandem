import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import plist from "plist";
import type { Preferences } from "../shared/bridge.ts";
import type { ConversationPosition } from "../shared/conversation.ts";

export class PreferenceStore {
  value: Preferences = { appearance: "auto", sidebarWidth: 238, positions: {} };
  private file: string;
  constructor(directory: string, importLegacy = false) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, "ui-preferences.json");
    try {
      if (existsSync(this.file))
        this.value = this.validate(JSON.parse(readFileSync(this.file, "utf8")));
      else if (importLegacy) this.importLegacy();
    } catch {
      /* Invalid UI preferences reset without touching business data. */
    }
  }
  private validate(value: Partial<Preferences>): Preferences {
    const positions: Record<string, ConversationPosition> = {};
    for (const [key, position] of Object.entries(value.positions ?? {})) {
      if (
        position &&
        typeof position.generation === "string" &&
        Number.isSafeInteger(position.sequence) &&
        position.sequence > 0 &&
        typeof position.atBottom === "boolean" &&
        typeof position.projectFilter === "string"
      )
        positions[key] = position;
    }
    return {
      appearance: ["auto", "light", "dark"].includes(String(value.appearance))
        ? value.appearance!
        : "auto",
      sidebarWidth: Number.isFinite(value.sidebarWidth)
        ? Math.min(360, Math.max(196, value.sidebarWidth!))
        : 238,
      lastSurface:
        typeof value.lastSurface === "string" ? value.lastSurface : undefined,
      positions,
    };
  }
  private importLegacy() {
    const path = join(
      homedir(),
      "Library/Preferences/dev.tandem.personal-agent.plist",
    );
    if (!existsSync(path)) return;
    this.importLegacyDocument(
      execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", path], {
        encoding: "utf8",
      }),
    );
  }
  importLegacyDocument(document: string) {
    const value = plist.parse(document) as Record<string, unknown>;
    const positions: Record<string, ConversationPosition> = {};
    for (const [key, data] of Object.entries(value))
      if (
        key.startsWith("tandem.conversationPosition.") &&
        Buffer.isBuffer(data)
      ) {
        try {
          positions[key.slice("tandem.conversationPosition.".length)] =
            JSON.parse(data.toString("utf8"));
        } catch {
          /* Ignore an obsolete anchor. */
        }
      }
    this.value = this.validate({
      appearance: value["tandem.appearance"] as Preferences["appearance"],
      sidebarWidth: value["tandem.sidebarWidth"] as number,
      lastSurface: value["tandem.lastConversationSurface"] as string,
      positions,
    });
    this.save();
  }
  update(value: Partial<Preferences>) {
    this.value = this.validate({ ...this.value, ...value });
    this.save();
  }
  private save() {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.value), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
