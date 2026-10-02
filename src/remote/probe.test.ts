import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("probe checks SSH only and reports authentication failures in both output modes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-probe-test-"));
  try {
    const binary = join(dir, "probe");
    const compiled = spawnSync("rustc", ["--edition=2021", fileURLToPath(new URL("./bin/remote-probe.rs", import.meta.url)), "-o", binary], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const called = join(dir, "network-called");
    for (const name of ["ping", "tailscale"]) {
      writeFileSync(join(dir, name), '#!/bin/sh\ntouch "$NETWORK_CALLED"\nexit 1\n', { mode: 0o700 });
    }
    writeFileSync(join(dir, "ssh"), '#!/bin/sh\nif [ "$SSH_FAIL" = "1" ]; then echo "Permission denied (publickey)." >&2; exit 255; fi\nexit 0\n', { mode: 0o700 });
    const config = join(dir, "devices.json");
    writeFileSync(config, JSON.stringify({ devices: [{ id: "fixture", host: "127.0.0.1", port: 0, defaultUser: "tester" }] }));
    for (const legacy of [false, true]) {
      for (const fail of [false, true]) {
        const result = spawnSync(binary, ["--config", config, "--no-color"], {
          encoding: "utf8", timeout: 10000,
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NETWORK_CALLED: called, SSH_FAIL: fail ? "1" : "0", PI_DEVICES_REMOTE_PROBE_LEGACY_LINES: legacy ? "1" : "0" },
        });
        assert.equal(result.status, fail ? 2 : 0, result.stderr);
        assert.match(result.stdout, fail ? /SSH auth failed/ : /OK all 1\/1 devices/);
        assert.equal(existsSync(called), false, "no ping or Tailscale subprocess should run");
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
