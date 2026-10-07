import { Hono } from "hono";
import { createApp } from "./app";
import { LmdisDailyStore } from "./lmdis-store";
import { LmdisClient } from "./lmdis/sdk";

type Bindings = { LMDIS_URL: string; LMDIS_REST_TOKEN: string };

const workerFetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  fetch(input, init)) as unknown as typeof fetch;

const app = new Hono<{ Bindings: Bindings }>();

app.all("/api/daily", (c) =>
  createApp({
    store: new LmdisDailyStore(
      new LmdisClient({
        url: c.env.LMDIS_URL,
        token: c.env.LMDIS_REST_TOKEN,
        fetch: workerFetch,
      }),
    ),
    fetcher: workerFetch,
    now: () => new Date(),
  }).fetch(c.req.raw),
);

export default app;
