export type AuthConfig = {
  type?: "ssh-key" | "ssh-agent" | "password-bootstrap";
  identityFile?: string;
};

export type SshRouteConfig = {
  type?: "direct" | "ssh-config";
  target?: string;
  sshHost?: string;
  label?: string;
  user?: string;
  identityFile?: string;
};

export type RemoteDevice = {
  id: string;
  name?: string;
  host: string;
  port?: number;
  defaultUser: string;
  users?: string[];
  aliases?: string[];
  tags?: string[];
  auth?: AuthConfig;
  sshRoute?: SshRouteConfig;
  sudo?: boolean;
  notes?: string;
};

export type SerialPromptConfig = {
  login?: string;
  password?: string;
  shell?: string;
};

export type SerialProfile = {
  id: string;
  transport: { type: "local" | "remote"; device?: string };
  port: string;
  baud: number;
  username: string;
  credentialRef: string;
  prompts?: SerialPromptConfig;
  picocom?: { command?: string };
};

export type DevicesConfig = {
  version: 1;
  updatedAt?: string;
  devices: RemoteDevice[];
  profiles: SerialProfile[];
};
