import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveSshRouteArgs } from "../remote/ssh-route.ts";
import type { RemoteDevice } from "../types.ts";

test("serial remote route uses direct host, port, user and key with forced PTY", () => {
  const device: RemoteDevice = { id: "device2", host: "139.196.76.70", port: 47042, defaultUser: "Hollins-Debian", auth: { identityFile: "~/.ssh/id_ed25519" } };
  const args = resolveSshRouteArgs(device, "picocom '/dev/ttyUSB0' -b 115200", { interactive: true });
  assert.equal(args[0], "-tt");
  assert.equal(args.includes("-p"), true);
  assert.equal(args[args.indexOf("-p") + 1], "47042");
  assert.deepEqual(args.slice(-4), ["-l", "Hollins-Debian", "139.196.76.70", "picocom '/dev/ttyUSB0' -b 115200"]);
  assert.equal(args[args.indexOf("-i") + 1], join(homedir(), ".ssh/id_ed25519"));
});

test("ssh-config route retains alias and configured user without a port", () => {
  const device: RemoteDevice = { id: "compiler", host: "10.0.0.1", defaultUser: "fallback", sshRoute: { type: "ssh-config", target: "build-host", user: "builder" } };
  const args = resolveSshRouteArgs(device, "picocom /dev/ttyUSB0 -b 115200", { interactive: true });
  assert.deepEqual(args.slice(-4), ["-l", "builder", "build-host", "picocom /dev/ttyUSB0 -b 115200"]);
  assert.equal(args.includes("-p"), false);
});
