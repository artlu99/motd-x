import type { LmdisClient } from "./lmdis/sdk";

export type XUser = {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
};

export type AuthAttempt = {
  poll_token: string;
  state: string;
  code_verifier: string;
  context: "iframe" | "standalone";
  status: "pending" | "completed" | "expired";
  user_id: string | null;
  created_at: number;
  expires_at: number;
};

const AUTH_PREFIX = "motd-x:daily:v1:auth:";

const attemptKey = (pollToken: string): string => `${AUTH_PREFIX}attempt:${pollToken}`;
const stateKey = (state: string): string => `${AUTH_PREFIX}state:${state}`;
const holdAttemptKey = (pollToken: string): string => `${AUTH_PREFIX}hold:attempt:${pollToken}`;
const holdStateKey = (state: string): string => `${AUTH_PREFIX}hold:state:${state}`;
const mintedKey = (pollToken: string): string => `${AUTH_PREFIX}minted:${pollToken}`;
const claimedKey = (state: string): string => `${AUTH_PREFIX}claimed:${state}`;
const sessionKey = (hash: string): string => `${AUTH_PREFIX}session:${hash}`;
const userKey = (userId: string): string => `${AUTH_PREFIX}user:${userId}`;

type SessionRow = { user_id: string; created_at: number; expires_at: number };

const isAuthAttempt = (value: unknown): value is AuthAttempt => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.poll_token === "string" &&
    typeof row.state === "string" &&
    typeof row.code_verifier === "string" &&
    (row.context === "iframe" || row.context === "standalone") &&
    (row.status === "pending" || row.status === "completed" || row.status === "expired") &&
    (typeof row.user_id === "string" || row.user_id === null) &&
    typeof row.created_at === "number" &&
    typeof row.expires_at === "number"
  );
};

const isSessionRow = (value: unknown): value is SessionRow => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.user_id === "string" &&
    typeof row.created_at === "number" &&
    typeof row.expires_at === "number"
  );
};

const isXUser = (value: unknown): value is XUser => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.username !== "string" ||
    typeof row.name !== "string"
  ) {
    return false;
  }
  return row.profile_image_url === undefined || typeof row.profile_image_url === "string";
};

const clampTtlSeconds = (expiresAt: number, nowMs: number): number =>
  Math.max(1, Math.ceil((expiresAt - nowMs) / 1000));

export class AuthStore {
  private readonly client: LmdisClient;
  private readonly nowFn: () => Date;

  constructor(client: LmdisClient, opts?: { now?: () => Date }) {
    this.client = client;
    this.nowFn = opts?.now ?? (() => new Date(0));
  }

  async createAttempt(row: AuthAttempt): Promise<void> {
    const ttl = clampTtlSeconds(row.expires_at, this.nowMs());
    if (row.context === "iframe") {
      await this.client.set(attemptKey(row.poll_token), row, { ex: ttl });
      await this.client.set(stateKey(row.state), row.poll_token, { ex: ttl });
      return;
    }
    await this.client.set(holdAttemptKey(row.poll_token), row, { ex: ttl });
    await this.client.set(holdStateKey(row.state), row.poll_token, { ex: ttl });
  }

  async getAttemptByPollToken(pollToken: string): Promise<AuthAttempt | null> {
    const row =
      (await this.client.get<AuthAttempt>(attemptKey(pollToken))) ??
      (await this.client.get<AuthAttempt>(holdAttemptKey(pollToken)));
    if (!isAuthAttempt(row)) return null;
    if (row.expires_at <= this.nowMs()) return { ...row, status: "expired" };
    return row;
  }

  async getAttemptByState(state: string): Promise<AuthAttempt | null> {
    const pollToken =
      (await this.client.get<string>(stateKey(state))) ??
      (await this.client.get<string>(holdStateKey(state)));
    if (typeof pollToken !== "string" || pollToken === "") return null;
    return this.getAttemptByPollToken(pollToken);
  }

  async completeAttempt(state: string, userId: string): Promise<void> {
    const attempt = await this.getAttemptByState(state);
    if (attempt === null || attempt.status !== "pending") return;
    const ttl = clampTtlSeconds(attempt.expires_at, this.nowMs());
    const completed: AuthAttempt = { ...attempt, status: "completed", user_id: userId };
    await this.client.set(attemptKey(attempt.poll_token), completed, { ex: ttl });
    await this.client.set(stateKey(state), attempt.poll_token, { ex: ttl });
  }

  async beginMint(pollToken: string): Promise<boolean> {
    return (await this.client.hincrby(mintedKey(pollToken), "n", 1)) === 1;
  }

  async claimCallback(state: string): Promise<boolean> {
    return (await this.client.hincrby(claimedKey(state), "n", 1)) === 1;
  }

  async releaseCallback(state: string): Promise<void> {
    await this.client.del(claimedKey(state));
  }

  async saveSession(
    hash: string,
    userId: string,
    createdAt: number,
    expiresAt: number,
  ): Promise<void> {
    const ttl = clampTtlSeconds(expiresAt, this.nowMs());
    const row: SessionRow = { user_id: userId, created_at: createdAt, expires_at: expiresAt };
    await this.client.set(sessionKey(hash), row, { ex: ttl });
  }

  async getSessionUser(hash: string): Promise<string | null> {
    const row = await this.client.get<SessionRow>(sessionKey(hash));
    if (!isSessionRow(row)) return null;
    if (row.expires_at <= this.nowMs()) return null;
    return row.user_id;
  }

  async resolveSession(rawToken: string): Promise<string | null> {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawToken));
    const hash = [...new Uint8Array(bytes)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return this.getSessionUser(hash);
  }

  async upsertUser(user: XUser): Promise<void> {
    await this.client.set(userKey(user.id), user);
  }

  async getUser(userId: string): Promise<XUser | null> {
    const user = await this.client.get<XUser>(userKey(userId));
    return isXUser(user) ? user : null;
  }

  private nowMs(): number {
    return this.nowFn().getTime();
  }
}
