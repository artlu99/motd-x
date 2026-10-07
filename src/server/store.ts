export interface StoredReading {
  day: string;
  translation: string;
  reference: string;
  payload: string;
  fetched_at: number;
}

export interface MotdEntry {
  version: string;
  markdown: string;
}

export interface DailyStore {
  get(day: string, translation: string): Promise<StoredReading | null>;
  getLatest(): Promise<StoredReading | null>;
  put(row: StoredReading): Promise<void>;
  getMotd(day: string, opts?: { verify?: boolean }): Promise<MotdEntry | null>;
}
