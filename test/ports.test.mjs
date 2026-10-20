import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { LOCAL_PORT_RANGE, allocateLocalPorts, assertPortsAvailable, canBindPort } from "../lib/ports.mjs";

test("local ports come from below the outgoing-connection range, unique and not reserved", async () => {
  const sequence = [20001, 20001, 20002, 20003, 20004];
  const values = sequence.map((port) => (port - LOCAL_PORT_RANGE.min) / (LOCAL_PORT_RANGE.max - LOCAL_PORT_RANGE.min + 1));
  const ports = await allocateLocalPorts(["client", "media", "search"], {
    reserved: [20002],
    canBind: async (port) => port !== 20003,
    random: () => values.shift() ?? Math.random(),
  });
  // 20001 repeats for media, 20002 is reserved and 20003 is held.
  assert.equal(ports.client, 20001);
  assert.equal(ports.media, 20004);
  assert.ok(ports.search >= LOCAL_PORT_RANGE.min && ports.search <= LOCAL_PORT_RANGE.max);
  for (const port of Object.values(await allocateLocalPorts(["a", "b", "c", "d"]))) {
    assert.ok(port >= LOCAL_PORT_RANGE.min && port <= LOCAL_PORT_RANGE.max);
  }
  await assert.rejects(allocateLocalPorts(["x"], { canBind: async () => false, attempts: 3 }), /No free local port found for x/);
});

test("saved ports must be free or held by the stack itself", async (t) => {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen({ host: "127.0.0.1", port: 0 }, resolve));
  t.after(() => holder.close());
  const held = holder.address().port;
  assert.equal(await canBindPort(held), false);
  await assert.rejects(assertPortsAvailable({ client: held }), new RegExp(`client port 127.0.0.1:${held} is held by another process`));
  await assertPortsAvailable({ client: held }, { owned: [held] });
});
