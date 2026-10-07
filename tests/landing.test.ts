import { describe, expect, it } from "bun:test";
import app from "../src/server/index";

describe("GET / (landing page)", () => {
  it("serves html pointing at the repo and the api", async () => {
    const res = await app.request("/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("https://github.com/artlu99/motd-x");
    expect(body).toContain("/api/daily");
    expect(body).toContain("motd-x");
  });
});
