import type { LmdisClient } from "./lmdis/sdk";
import type { DailyStore, MotdEntry, StoredReading } from "./store";

export const KEY_PREFIX = "motd-x:daily:v1:";

const motdPointerKey = (day: string): string => `${KEY_PREFIX}motd:${day}`;

const isStoredReading = (value: unknown): value is StoredReading => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.day === "string" &&
    typeof row.translation === "string" &&
    typeof row.reference === "string" &&
    typeof row.payload === "string" &&
    typeof row.fetched_at === "number"
  );
};

export class LmdisDailyStore implements DailyStore {
  private readonly latestKey = `${KEY_PREFIX}latest`;

  constructor(private readonly client: LmdisClient) {}

  async get(day: string, translation: string): Promise<StoredReading | null> {
    return this.readRow(this.rowKey(day, translation));
  }

  async getLatest(): Promise<StoredReading | null> {
    return this.readRow(this.latestKey);
  }

  async put(row: StoredReading): Promise<void> {
    await this.client.set(this.rowKey(row.day, row.translation), row);
    await this.client.set(this.latestKey, row);
  }

  private rowKey(day: string, translation: string): string {
    return `${KEY_PREFIX}${day}:${translation}`;
  }

  private async readRow(key: string): Promise<StoredReading | null> {
    const raw = await this.client.get<StoredReading>(key);
    return isStoredReading(raw) ? raw : null;
  }

  async getMotd(day: string, opts?: { verify?: boolean }): Promise<MotdEntry | null> {
    const pointer = await this.client.get<MotdEntry>(motdPointerKey(day));
    if (!opts?.verify && isMotdEntry(pointer) && pointer.markdown !== "") {
      return pointer;
    }
    const discovered = await this.discoverMotd(day);
    if (discovered === null) {
      return isMotdEntry(pointer) && pointer.markdown !== "" ? pointer : null;
    }
    if (!isMotdEntry(pointer) || pointer.markdown === "" || discovered.version > pointer.version) {
      try {
        await this.client.set(motdPointerKey(day), discovered);
      } catch {}
      return discovered;
    }
    return pointer;
  }

  private async discoverMotd(day: string): Promise<MotdEntry | null> {
    const keys = await this.client.keys(`${KEY_PREFIX}motd:${day}:*`);
    const newestKey = keys.sort().at(-1);
    if (newestKey === undefined) {
      return null;
    }
    const markdown = await this.client.get<string>(newestKey);
    if (typeof markdown !== "string" || markdown === "") {
      return null;
    }
    return { version: newestKey.slice(newestKey.lastIndexOf(":") + 1), markdown };
  }
}

const isMotdEntry = (value: unknown): value is MotdEntry => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.version === "string" && typeof entry.markdown === "string";
};
