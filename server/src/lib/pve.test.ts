import { test } from "node:test";
import assert from "node:assert/strict";
import { PveClient, PveError } from "./pve.js";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: Handler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const baseOpts = {
  hosts: ["pve.local"],
  port: 8006,
  tokenId: "root@pam!t",
  tokenSecret: "secret",
  rejectUnauthorized: false,
  pollIntervalMs: 1,
  taskTimeoutMs: 1000,
};

test("getStatus uses the lxc path for lxc guests", async () => {
  let seen = "";
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch((url) => {
      seen = url;
      return json({ status: "running" });
    }),
  });
  const status = await client.getStatus("pve", "lxc", 101);
  assert.equal(status.status, "running");
  assert.ok(seen.endsWith("/nodes/pve/lxc/101/status/current"));
});

test("getStatus uses the qemu path for qemu guests", async () => {
  let seen = "";
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch((url) => {
      seen = url;
      return json({ status: "stopped" });
    }),
  });
  await client.getStatus("pve", "qemu", 201);
  assert.ok(seen.endsWith("/nodes/pve/qemu/201/status/current"));
});

test("rollback posts to the snapshot rollback endpoint", async () => {
  let seen = "";
  let method = "";
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch((url, init) => {
      seen = url;
      method = init?.method ?? "";
      return json("UPID:pve:rollback");
    }),
  });
  const upid = await client.rollback("pve", "qemu", 201, "clean");
  assert.equal(upid, "UPID:pve:rollback");
  assert.equal(method, "POST");
  assert.ok(seen.endsWith("/nodes/pve/qemu/201/snapshot/clean/rollback"));
});

test("waitForTask resolves once the task is stopped with OK", async () => {
  const states = ["running", "running", "stopped"];
  let i = 0;
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch(() => {
      const status = states[Math.min(i++, states.length - 1)];
      return json(status === "stopped" ? { status, exitstatus: "OK" } : { status });
    }),
  });
  await client.waitForTask("pve", "UPID:pve:x");
  assert.ok(i >= 3);
});

test("waitForTask throws when the task exits non-OK", async () => {
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch(() => json({ status: "stopped", exitstatus: "command failed" })),
  });
  await assert.rejects(() => client.waitForTask("pve", "UPID:pve:x"), PveError);
});

test("request throws PveError on HTTP error responses", async () => {
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch(() => new Response("nope", { status: 403, statusText: "Forbidden" })),
  });
  await assert.rejects(() => client.getStatus("pve", "lxc", 101), PveError);
});

test("stop posts to the status/stop endpoint", async () => {
  let seen = "";
  let method = "";
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch((url, init) => {
      seen = url;
      method = init?.method ?? "";
      return json("UPID:pve:stop");
    }),
  });
  await client.stop("pve", "lxc", 101);
  assert.equal(method, "POST");
  assert.ok(seen.endsWith("/nodes/pve/lxc/101/status/stop"));
});

test("falls over to the next host on a connection failure", async () => {
  const tried: string[] = [];
  const client = new PveClient({
    ...baseOpts,
    hosts: ["dead.local", "alive.local"],
    fetchImpl: mockFetch((url) => {
      tried.push(url);
      if (url.includes("dead.local")) throw new Error("ECONNREFUSED");
      return json({ status: "running" });
    }),
  });
  const status = await client.getStatus("pve", "qemu", 201);
  assert.equal(status.status, "running");
  assert.equal(tried.length, 2);
  assert.ok(tried[0].includes("dead.local"));
  assert.ok(tried[1].includes("alive.local"));
});

test("throws PveError when no host is reachable", async () => {
  const client = new PveClient({
    ...baseOpts,
    hosts: ["a.local", "b.local"],
    fetchImpl: mockFetch(() => {
      throw new Error("ECONNREFUSED");
    }),
  });
  await assert.rejects(() => client.getStatus("pve", "lxc", 101), PveError);
});
