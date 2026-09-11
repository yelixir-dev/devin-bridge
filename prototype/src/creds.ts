import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const tokenSchema = z.string().trim().min(1);
const storeSchema = z.object({
  windsurf_api_key: tokenSchema,
  api_server_url: z.url().optional(),
});

function storedCredentials() {
  const base = process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share");
  const text = readFileSync(join(base, "devin", "credentials.toml"), "utf8");
  return storeSchema.parse(Bun.TOML.parse(text));
}

/** Optional import of existing credentials; never invokes the Devin executable. */
export function loadApiKey(): string {
  const explicit = process.env["DEVIN_BRIDGE_TOKEN"];
  return explicit !== undefined ? tokenSchema.parse(explicit) : storedCredentials().windsurf_api_key;
}

export function loadApiServerUrl(): string | undefined {
  const explicit = process.env["DEVIN_BRIDGE_API_URL"];
  if (explicit !== undefined) return z.url().parse(explicit);
  if (process.env["DEVIN_BRIDGE_TOKEN"] !== undefined) return undefined;
  return storedCredentials().api_server_url;
}
