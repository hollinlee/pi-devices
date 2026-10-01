import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDevicesConfig, writeDevicesConfig } from "./config.ts";
import { resolveSshRouteArgs } from "./ssh-route.ts";
import type { DevicesConfig, RemoteDevice } from "../types.ts";

const device: RemoteDevice = {
  id: "lab",
  host: "192.0.2.10",
  port: 2222,
  defaultUser: "tester",
  auth: { identityFile: "~/.ssh/id_ed25519" },
};

function config(): DevicesConfig {
  return { version: 1, devices: [device], profiles: [] };
}

test("unified config round-trips with restrictive permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devices-config-"));
  const file = join(dir, "nested", "devices.json");
  const saved = writeDevicesConfig(config(), file);
  assert.equal(saved.devices[0]?.id, "lab");
  assert.ok(saved.updatedAt);
  assert.deepEqual(readDevicesConfig(file).devices, [device]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).profiles.length, 0);
});

test("missing config returns an empty unified config", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pi-devices-missing-")), "devices.json");
  assert.deepEqual(readDevicesConfig(file), { version: 1, devices: [], profiles: [] });
});

test("route resolver keeps direct and ssh-config routes distinct", () => {
  const direct = resolveSshRouteArgs(device, "hostname");
  assert.equal(direct.includes("-p"), true);
  assert.equal(direct[direct.indexOf("-p") + 1], "2222");
  assert.equal(direct.includes(join(process.env.HOME ?? "", ".ssh/id_ed25519")), true);
  assert.equal(direct.at(-2), "192.0.2.10");
  assert.equal(direct.at(-1), "hostname");

  const routed = resolveSshRouteArgs({
    ...device,
    sshRoute: { type: "ssh-config", target: "lab-host", user: "route-user", identityFile: "~/.ssh/route" },
  }, "picocom /dev/ttyUSB0 -b 115200", { interactive: true });
  assert.equal(routed[0], "-tt");
  assert.equal(routed.includes("-p"), false);
  assert.equal(routed.at(-3), "route-user");
  assert.equal(routed.at(-2), "lab-host");
});
