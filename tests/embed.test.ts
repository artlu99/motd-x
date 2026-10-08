import { describe, expect, it } from "bun:test";
import app from "../src/server/index";

const ORIGIN = "https://motd-x.artlu.xyz";

describe("player embed shell", () => {
  it("serves the player page, framable by X, that mounts today's content", async () => {
    const res = await app.request(`${ORIGIN}/play`, undefined, {
      LMDIS_URL: "https://lmdis.test",
      LMDIS_REST_TOKEN: "t",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-frame-options")).toBeNull();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self' https://x.com https://twitter.com https://platform.twitter.com");

    const body = await res.text();
    expect(body).toContain('id="motd"');
    expect(body).toContain("/api/daily");
    expect(body).not.toContain("localStorage");

    expect(body).toContain("Sign in with X");
    expect(body).toContain("personalized messages");
    expect(body).toContain("/auth/start");
    expect(body).toContain("/auth/poll");
    expect(body).toContain("motd_session");
    expect(body).toContain("/api/daily/me");
  });

  it("adapts to iOS Safari and the mobile X app viewer", async () => {
    const res = await app.request(`${ORIGIN}/play`, undefined, {
      LMDIS_URL: "https://lmdis.test",
      LMDIS_REST_TOKEN: "t",
    });

    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"');
    expect(body).toContain("100dvh");
    expect(body).toContain("-webkit-text-size-adjust");
    expect(body).toContain("env(safe-area-inset-top)");
    expect(body).toContain("env(safe-area-inset-bottom)");
    expect(body).toContain("clamp(");
  });

  it("serves player card meta tags on the share URL with absolute URLs", async () => {
    const res = await app.request(`${ORIGIN}/`, undefined, {
      LMDIS_URL: "https://lmdis.test",
      LMDIS_REST_TOKEN: "t",
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="twitter:card" content="player"');
    expect(body).toContain(`name="twitter:player" content="${ORIGIN}/play"`);
    expect(body).toContain('name="twitter:player:width" content="480"');
    expect(body).toContain('name="twitter:player:height" content="480"');
    expect(body).toContain(`name="twitter:image" content="${ORIGIN}/card.png"`);
    expect(body).toContain('name="twitter:title"');
    expect(body).toContain('name="twitter:description"');
  });
});

describe("cache policy", () => {
  it("never caches the personalized endpoint or the player shell", async () => {
    const meRes = await app.request(`${ORIGIN}/api/daily/me`, undefined, {
      LMDIS_URL: "https://lmdis.test",
      LMDIS_REST_TOKEN: "t",
    });
    expect(meRes.headers.get("cache-control")).toBe("private, no-store");

    const playRes = await app.request(`${ORIGIN}/play`, undefined, {
      LMDIS_URL: "https://lmdis.test",
      LMDIS_REST_TOKEN: "t",
    });
    expect(playRes.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps the public daily endpoint share-cacheable but browser-fresh", async () => {
    const res = await app.request(`${ORIGIN}/api/daily`, undefined, {
      LMDIS_URL: "https://lmdis.test",
      LMDIS_REST_TOKEN: "t",
    });
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("public");
    expect(cc).toContain("max-age=0");
    expect(cc).toContain("s-maxage=");
  });
});
