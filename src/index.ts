import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import remoteDevicesExtension from "./remote/index.ts";
import serialDevicesExtension from "./serial/index.ts";

export default function (pi: ExtensionAPI): void {
  remoteDevicesExtension(pi);
  serialDevicesExtension(pi);
}
