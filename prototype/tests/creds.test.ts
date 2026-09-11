import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApiKey, loadApiServerUrl } from "../src/creds.ts";

test("parses the actual TOML syntax without including quotes in credentials", () => {
  // Given an isolated credentials store using TOML literal strings.
  const path = mkdtempSync(join(tmpdir(), "devin-creds-test-"));
  const previousHome = process.env["XDG_DATA_HOME"];
  const previousToken = process.env["DEVIN_BRIDGE_TOKEN"];
  mkdirSync(join(path, "devin"));
  writeFileSync(join(path, "devin", "credentials.toml"),
    "windsurf_api_key = 'fixture-token'\napi_server_url = 'https://server.codeium.com'\n");
  process.env["XDG_DATA_HOME"] = path;
  delete process.env["DEVIN_BRIDGE_TOKEN"];
  try {
    // When the loader reads the credentials.
    const token = loadApiKey();
    const server = loadApiServerUrl();
    // Then quote delimiters are not part of the credential or URL.
    expect(token).toBe("fixture-token");
    expect(server).toBe("https://server.codeium.com");
  } finally {
    if (previousHome === undefined) delete process.env["XDG_DATA_HOME"];
    else process.env["XDG_DATA_HOME"] = previousHome;
    if (previousToken === undefined) delete process.env["DEVIN_BRIDGE_TOKEN"];
    else process.env["DEVIN_BRIDGE_TOKEN"] = previousToken;
    rmSync(path, { recursive: true });
  }
});
