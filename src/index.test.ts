import assert from "node:assert/strict";
import test from "node:test";
import extension from "./index.ts";

test("registers the complete remote capability surface with a remote discriminator", () => {
  const tools = new Map<string, unknown>();
  const events = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  extension({
    registerTool(tool: { name: string; parameters: unknown }) { tools.set(tool.name, tool.parameters); },
    on(name: string, handler: unknown) { events.set(name, handler); },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
  } as never);

  assert.deepEqual([...tools.keys()], [
    "devices_list",
    "devices_resolve",
    "devices_write",
    "devices_exec",
    "devices_read",
    "devices_exec_batch",
    "devices_probe",
    "devices_test_connection",
    "devices_learn_alias",
    "devices_add_device",
    "devices_install_keys",
    "devices_serial_list",
    "devices_serial_resolve",
    "devices_serial_set_credential",
    "devices_serial_exec",
    "devices_serial_read",
  ]);
  const remoteType = { const: "remote", type: "string" };
  const serialType = { const: "serial", type: "string" };
  for (const [name, schema] of tools) {
    const expected = name.startsWith("devices_serial_") ? serialType : remoteType;
    assert.deepEqual((schema as { properties: { type: unknown } }).properties.type, expected);
  }
  assert.equal(events.has("before_agent_start"), true);
  assert.equal(events.has("session_start"), true);
  assert.equal(commands.has("remote-devices"), true);
});
