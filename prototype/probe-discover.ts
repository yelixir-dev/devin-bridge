import { loadApiKey, loadApiServerUrl } from "./src/creds.ts";
import { discoverModels, DEVIN_DEFAULT_BASE_URL } from "./src/devin-rpc.ts";

const models = await discoverModels(loadApiKey(), loadApiServerUrl() ?? DEVIN_DEFAULT_BASE_URL);
console.log(JSON.stringify({
  count: models.length,
  swe2: models.filter(m => m.uid.startsWith("swe-2")),
}));
