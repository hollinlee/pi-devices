import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { OsSerialCredentialStore, publicSerialProfile, readSerialProfiles, resolveSerialProfile, SERIAL_CREDENTIAL_SERVICE, type SerialProfile } from "./profiles.ts";
import { dangerousReason, ensureSession, execProfile, formatResult, getSession, shutdownSessions } from "./session.ts";

function publicState(profile: SerialProfile) {
  const session = getSession(profile.id);
  return { profile: publicSerialProfile(profile), state: session?.state ?? "connecting", transportReady: session?.transportReady ?? false, consoleBytes: session?.consoleBytes ?? 0 };
}

export default function serialDevicesExtension(pi: ExtensionAPI): void {
  pi.on("system_prompt" as any, ((event: { systemPrompt: string }) => { event.systemPrompt += "\n\n[pi-devices serial] Use explicit serial profiles with direct picocom PTY transport. Credentials are stored in OS secure storage."; }) as any);
  pi.on("session_shutdown", async () => { shutdownSessions(); });
  pi.registerTool({
    name: "devices_serial_list",
    label: "Devices: List Serial Profiles",
    description: "列出已配置的串口 profiles，不显示 credential。",
    parameters: Type.Object({ type: Type.Literal("serial") }),
    async execute() {
      const profiles = await readSerialProfiles();
      return { content: [{ type: "text", text: profiles.map((profile) => JSON.stringify(publicSerialProfile(profile))).join("\n") || "No serial profiles configured." }], details: { profiles: profiles.map(publicState) } };
    },
  });
  pi.registerTool({
    name: "devices_serial_resolve",
    label: "Devices: Resolve Serial Profile",
    description: "按显式 id 解析串口 profile。",
    parameters: Type.Object({ type: Type.Literal("serial"), profile: Type.String() }),
    async execute(_id, params: any) {
      const profile = await resolveSerialProfile(params.profile);
      return { content: [{ type: "text", text: JSON.stringify(publicSerialProfile(profile), null, 2) }], details: publicState(profile) };
    },
  });
  pi.registerTool({
    name: "devices_serial_set_credential",
    label: "Devices: Set Serial Credential",
    description: "将串口 credential 写入 OS secure storage。",
    parameters: Type.Object({ type: Type.Literal("serial"), profile: Type.String(), username: Type.String(), password: Type.String() }),
    async execute(_id, params: any) {
      const profile = await resolveSerialProfile(params.profile);
      if (profile.username !== params.username) throw new Error("credential username 与 profile 不一致");
      await new OsSerialCredentialStore().set(profile.credentialRef, params.username, params.password);
      return { content: [{ type: "text", text: `credential configured: ${profile.id}` }], details: { profile: profile.id, username: params.username, service: SERIAL_CREDENTIAL_SERVICE } };
    },
  });
  pi.registerTool({
    name: "devices_serial_exec",
    label: "Devices: Serial Exec",
    description: "通过串口 picocom PTY 在 serial profile 上执行 shell 命令。",
    parameters: Type.Object({ type: Type.Literal("serial"), profile: Type.String(), command: Type.String(), timeout_seconds: Type.Optional(Type.Number()), allowDangerous: Type.Optional(Type.Boolean()) }),
    async execute(_id, params: any, signal) {
      const profile = await resolveSerialProfile(params.profile);
      const reason = dangerousReason(params.command);
      if (reason && !params.allowDangerous) throw new Error(`devices_exec 拒绝执行：${reason}`);
      const result = await execProfile(profile, params.command, params.timeout_seconds, signal);
      return { content: [{ type: "text", text: formatResult(result) }], details: { type: "serial", profile: profile.id, command: params.command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs }, isError: result.exitCode !== 0 || result.timedOut };
    },
  });
  pi.registerTool({
    name: "devices_serial_read",
    label: "Devices: Read Serial Console",
    description: "读取 serial profile 的 bounded rolling buffer；未登录时仅返回状态与字节活动。",
    parameters: Type.Object({ type: Type.Literal("serial"), profile: Type.String(), lines: Type.Optional(Type.Number()) }),
    async execute(_id, params: any) {
      const profile = await resolveSerialProfile(params.profile);
      const session = await ensureSession(profile);
      if (session.state === "connecting") await new Promise((resolve) => setTimeout(resolve, 1200));
      const count = Math.min(2000, Math.max(1, Math.floor(params.lines ?? 50)));
      const text = session.state === "shell-ready" ? session.output.split("\n").slice(-count).join("\n") : `[serial] ${session.state}${session.transportReady ? " (picocom ready)" : ""}${session.error ? `: ${session.error}` : ""}`;
      return { content: [{ type: "text", text: text || "[serial buffer empty]" }], details: { type: "serial", profile: profile.id, lines: count, state: session.state, transportReady: session.transportReady, consoleBytes: session.consoleBytes } };
    },
  });
}
