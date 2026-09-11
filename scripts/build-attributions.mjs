import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const escape = value => String(value).replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);

export function renderAttributions(registry) {
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.items)) {
    throw new Error("Unsupported attribution registry");
  }
  const stamp = `Generated from attributions.json (${registry.updatedAt}) by scripts/build-attributions.mjs — do not edit by hand.`;
  const md = ["# Attribution registry", "", stamp, ""];
  const articles = [];
  for (const item of registry.items) {
    if (!item.id || !/^[a-f0-9]{40}$/.test(item.revision) || !item.files.length) {
      throw new Error("Incomplete source provenance");
    }
    md.push(`## ${item.name}`, "", `- Source: ${item.repository}`,
      `- Revision: \`${item.revision}\``, `- License: [${item.license}](../${item.licenseFile})`,
      ...item.copyright.map(line => `- ${line}`), "",
      "| Local file | Upstream source | Processing |", "| --- | --- | --- |");
    const files = [];
    for (const file of item.files) {
      const url = `${item.repository}/blob/${item.revision}/${file.upstream}`;
      md.push(`| [${file.local}](../${file.local}) | [${file.upstream}](${url}) | ${file.processing} |`);
      files.push(`<li><a href="../${escape(file.local)}"><code>${escape(file.local)}</code></a><br><a href="${escape(url)}">Pinned upstream source</a><p>${escape(file.processing)}</p></li>`);
    }
    md.push("", item.excluded, "");
    articles.push(`<article><h2>${escape(item.name)}</h2><p><a href="${escape(item.repository)}">${escape(item.repository)}</a><br>Revision: <code>${escape(item.revision)}</code><br>License: <a href="../${escape(item.licenseFile)}">${escape(item.license)}</a></p><ul>${item.copyright.map(c => `<li>${escape(c)}</li>`).join("")}</ul><ul>${files.join("")}</ul><p>${escape(item.excluded)}</p></article>`);
  }
  const terms = `Project license: ${registry.projectLicense}. Original third-party licenses remain in force; the project license does not replace, narrow, or relicense them. No listed author or affiliated organization endorses this project.`;
  md.push("## License separation", "", terms, "");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>devin-bridge — Attribution</title>
<style>:root{--ink:#28231f;--paper:#fffdf8;--canvas:#f1ede5;--teal:#1f6f78;--rust:#9f4d2e;--rule:#d9d0c4}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:17px/1.65 Georgia,serif;overflow-wrap:anywhere}main{max-width:900px;margin:auto;padding:40px 20px}header,article{padding:24px;background:var(--paper);border-top:3px solid var(--ink);margin-bottom:24px}h1,h2{line-height:1.2}h1{font-size:36px}h2{font-size:24px}a{color:var(--teal)}a:focus-visible{outline:2px solid var(--rust);outline-offset:3px}code{font-size:14px}li{margin-bottom:12px}.stamp{font-size:13px;color:#6d665e}@media(max-width:500px){main{padding:20px 12px}header,article{padding:20px}h1{font-size:28px}}</style>
</head><body><main><header><p><a href="../README.md">devin-bridge</a></p><h1>Attribution registry</h1><p class="stamp">${escape(stamp)}</p></header>${articles.join("")}<article><h2>License separation</h2><p>${escape(terms)}</p></article></main></body></html>
`;
  return { "docs/ATTRIBUTIONS.md": md.join("\n"), "docs/attributions.html": html };
}

if (import.meta.main) {
  const registry = JSON.parse(readFileSync(resolve(root, "attributions.json"), "utf8"));
  for (const [path, contents] of Object.entries(renderAttributions(registry))) {
    if (process.argv.includes("--check")) {
      if (readFileSync(resolve(root, path), "utf8") !== contents) throw new Error(`Stale generated file: ${path}`);
      console.log(`PASS ${path}`);
    } else {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      writeFileSync(resolve(root, path), contents);
      console.log(`Generated ${path}`);
    }
  }
}
