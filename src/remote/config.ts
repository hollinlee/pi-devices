import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DevicesConfig, RemoteDevice } from "../types.ts";
import { DEVICES_CONFIG_ENV } from "./constants.ts";

export function devicesConfigPath(): string {
  return process.env[DEVICES_CONFIG_ENV] || join(homedir(), ".pi", "agent", "devices", "devices.json");
}

function validateIds(items: Array<{ id?: unknown }>, label: string): void {
  const ids = items.map((item) => item?.id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
    throw new Error(`devices config contains invalid or duplicate ${label} ids`);
  }
}

export function readDevicesConfig(filePath = devicesConfigPath()): DevicesConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, devices: [], profiles: [] };
    }
    throw error;
  }

  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("devices config must be an object");
  const config = value as Partial<DevicesConfig>;
  if (config.version !== 1 || !Array.isArray(config.devices) || !Array.isArray(config.profiles)) {
    throw new Error("devices config must contain version 1, devices[], and profiles[]");
  }
  validateIds(config.devices, "device");
  validateIds(config.profiles, "profile");
  return config as DevicesConfig;
}

export function writeDevicesConfig(config: DevicesConfig, filePath = devicesConfigPath()): DevicesConfig {
  validateIds(config.devices, "device");
  validateIds(config.profiles, "profile");
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const saved: DevicesConfig = { ...config, version: 1, updatedAt: new Date().toISOString() };
  writeFileSync(filePath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return saved;
}

export function getRemoteDevice(id: string, filePath = devicesConfigPath()): RemoteDevice {
  const device = readDevicesConfig(filePath).devices.find((item) => item.id === id);
  if (!device) throw new Error(`remote device not configured: ${id}`);
  return device;
}

export function updateDevicesConfig(
  update: (config: DevicesConfig) => DevicesConfig,
  filePath = devicesConfigPath(),
): DevicesConfig {
  return writeDevicesConfig(update(readDevicesConfig(filePath)), filePath);
}
