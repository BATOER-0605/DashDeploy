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

test("cloneGuest posts to the lxc clone endpoint with hostname", async () => {
  let seen = "";
  let method = "";
  let bodyText = "";
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch(async (url, init) => {
      seen = url;
      method = init?.method ?? "";
      const body = init?.body as URLSearchParams | undefined;
      bodyText = body ? body.toString() : "";
      return json("UPID:pve:clone");
    }),
  });
  const upid = await client.cloneGuest("pve", "lxc", 9000, {
    newid: 101,
    name: "dashdeploy-01",
    full: false,
  });
  assert.equal(upid, "UPID:pve:clone");
  assert.equal(method, "POST");
  assert.ok(seen.endsWith("/nodes/pve/lxc/9000/clone"));
  assert.ok(bodyText.includes("newid=101"));
  assert.ok(bodyText.includes("hostname=dashdeploy-01"));
  assert.ok(bodyText.includes("full=0"));
});

test("cloneGuest posts to the qemu clone endpoint with name", async () => {
  let seen = "";
  let bodyText = "";
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch(async (url, init) => {
      seen = url;
      const body = init?.body as URLSearchParams | undefined;
      bodyText = body ? body.toString() : "";
      return json("UPID:pve:clone");
    }),
  });
  await client.cloneGuest("pve", "qemu", 9001, {
    newid: 201,
    name: "dashdeploy-vm",
    full: true,
    storage: "local-zfs",
  });
  assert.ok(seen.endsWith("/nodes/pve/qemu/9001/clone"));
  assert.ok(bodyText.includes("newid=201"));
  assert.ok(bodyText.includes("name=dashdeploy-vm"));
  assert.ok(bodyText.includes("full=1"));
  assert.ok(bodyText.includes("storage=local-zfs"));
  assert.ok(!bodyText.includes("hostname="));
});

test("listTemplateGuests returns only template-marked guests", async () => {
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch((url) => {
      if (url.endsWith("/nodes/pve/lxc")) {
        return json([
          { vmid: 100, status: "stopped", name: "tmpl-lxc", template: 1 },
          { vmid: 101, status: "running", name: "live-ct" },
        ]);
      }
      if (url.endsWith("/nodes/pve/qemu")) {
        return json([
          { vmid: 200, status: "stopped", name: "tmpl-vm", template: "1" },
          { vmid: 201, status: "running", name: "live-vm", template: 0 },
        ]);
      }
      throw new Error(`unexpected url ${url}`);
    }),
  });
  const tmpls = await client.listTemplateGuests("pve");
  assert.deepEqual(tmpls.sort((a, b) => a.vmid - b.vmid), [
    { kind: "lxc", vmid: 100, name: "tmpl-lxc" },
    { kind: "qemu", vmid: 200, name: "tmpl-vm" },
  ]);
});

test("detectGuestIp picks first non-loopback inet from lxc interfaces", async () => {
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch((url) => {
      if (url.endsWith("/nodes/pve/lxc/101/interfaces")) {
        return json([
          { name: "lo", inet: "127.0.0.1/8" },
          { name: "eth0", inet: "10.0.0.42/24" },
        ]);
      }
      throw new Error(`unexpected url ${url}`);
    }),
  });
  const ip = await client.detectGuestIp("pve", "lxc", 101);
  assert.equal(ip, "10.0.0.42");
});

test("detectGuestIp returns null when qemu-guest-agent is not responding", async () => {
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch(
      () =>
        new Response("agent not running", { status: 500, statusText: "Internal Server Error" }),
    ),
  });
  const ip = await client.detectGuestIp("pve", "qemu", 201);
  assert.equal(ip, null);
});

test("detectGuestIp parses qemu agent network-get-interfaces shape", async () => {
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch((url) => {
      if (
        url.endsWith("/nodes/pve/qemu/201/agent/network-get-interfaces")
      ) {
        return json({
          result: [
            { name: "lo", "ip-addresses": [{ "ip-address-type": "ipv4", "ip-address": "127.0.0.1" }] },
            {
              name: "ens18",
              "ip-addresses": [
                { "ip-address-type": "ipv6", "ip-address": "fe80::1" },
                { "ip-address-type": "ipv4", "ip-address": "192.168.1.50" },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    }),
  });
  const ip = await client.detectGuestIp("pve", "qemu", 201);
  assert.equal(ip, "192.168.1.50");
});

test("getNextVmid queries /cluster/nextid and parses as number", async () => {
  let seen = "";
  const client = new PveClient({
    ...baseOpts,
    fetchImpl: mockFetch((url) => {
      seen = url;
      return json("105");
    }),
  });
  const vmid = await client.getNextVmid();
  assert.equal(vmid, 105);
  assert.ok(seen.endsWith("/cluster/nextid"));
});
