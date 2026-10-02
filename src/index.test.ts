import assert from "node:assert/strict";
import test from "node:test";
import extension from "./index.ts";

test("registers unified device tools without duplicate names", () => {
  const tools = new Map<string, unknown>();
  const events = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  extension({
    registerTool(tool: { name: string; parameters: unknown }) {
      assert.equal(tools.has(tool.name), false, `duplicate tool registration: ${tool.name}`);
      tools.set(tool.name, tool.parameters);
    },
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
    "devices_set_credential",
  ]);
  const remoteType = { const: "remote", type: "string" };
  const serialType = { const: "serial", type: "string" };
  for (const name of ["devices_list", "devices_resolve", "devices_exec", "devices_read", "devices_set_credential"]) {
    const schema = tools.get(name) as { properties?: { type?: unknown } };
    assert.ok(schema.properties?.type || (schema as any).anyOf, `${name} exposes a type discriminator`);
  }
  assert.deepEqual((tools.get("devices_list") as any).anyOf.map((item: any) => item.properties.type), [remoteType, serialType]);
  assert.deepEqual((tools.get("devices_resolve") as any).anyOf.map((item: any) => item.properties.type), [remoteType, serialType]);
  assert.deepEqual((tools.get("devices_exec") as any).anyOf.map((item: any) => item.properties.type), [remoteType, serialType]);
  assert.deepEqual((tools.get("devices_read") as any).anyOf.map((item: any) => item.properties.type), [remoteType, serialType]);
  assert.deepEqual((tools.get("devices_set_credential") as any).properties.type, serialType);

  assert.equal(events.has("before_agent_start"), true);
  assert.equal(events.has("session_start"), true);
  assert.equal(commands.has("remote-devices"), true);
});
