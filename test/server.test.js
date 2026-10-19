import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

const TOOL_NAME = "find_mobile_phone";
const ACTOR_ID = "6OOgPktf7RIa5XCOP";
// Every input the live actor marks required must be required in the tool schema.
const ACTOR_REQUIRED = [];
// Every input the live actor exposes to a buyer must be exposed by the tool.
// Hidden schema fields are excluded by rule: source_tag is the landing page
// attribution tag the actor sets for itself, not something a caller supplies.
// The four provider key inputs are read from the environment, not from tool
// arguments, so they are excluded here by rule, like source_tag.
const ACTOR_INPUTS = ["company_domain", "contacts", "email", "full_name", "linkedin_url", "max_charge_usd", "max_contacts", "max_provider_credits", "mobile_only", "provider_order"];

// Speak MCP over stdio to the built server and return the tools/list result.
// No APIFY_TOKEN is set, on purpose: a client must see capabilities before it
// has configured anything.
function listTools() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.APIFY_TOKEN;
    const child = spawn(process.execPath, [join(repo, "build", "index.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out. stderr: ${err}`));
    }, 20000);

    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(msg.result);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("error", reject);

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "wrapper-test", version: "0.0.0" },
        },
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
    );
  });
}

test("serves tools/list with no APIFY_TOKEN set", async () => {
  const result = await listTools();
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, TOOL_NAME);
  assert.ok(result.tools[0].description.length > 0);
});

test("tool schema exposes every live actor input", async () => {
  const result = await listTools();
  const props = Object.keys(result.tools[0].inputSchema.properties).sort();
  assert.deepEqual(props, [...ACTOR_INPUTS].sort());
});

test("tool schema requires exactly what the live actor requires", async () => {
  const result = await listTools();
  const required = (result.tools[0].inputSchema.required ?? []).slice().sort();
  assert.deepEqual(required, [...ACTOR_REQUIRED].sort());
});

test("source pins the immutable actor id, not a Store slug", () => {
  const src = readFileSync(join(repo, "src", "index.ts"), "utf8");
  assert.ok(src.includes(`"${ACTOR_ID}"`), "actor id missing from source");
});

test("package identity matches the locked naming convention", () => {
  const mcp = JSON.parse(readFileSync(join(repo, ".mcp.json"), "utf8"));
  const key = Object.keys(mcp.mcpServers);
  assert.deepEqual(key, ["mamba-mobile-phone-waterfall-orchestrator"]);
  assert.deepEqual(mcp.mcpServers[key[0]].args, ["-y", pkg.name]);
  assert.equal(pkg.name, "@mambalabsdev/mcp-mobile-phone-waterfall-orchestrator");
  assert.equal(pkg.mcpName, "com.mambabuilt/mcp-mobile-phone-waterfall-orchestrator");
});

test("the package ships only the declared allowlist", () => {
  // The npm tarball is an allowlist, not a denylist: nothing can ship by
  // accident, so no scan of the repo for names that must not leak is what
  // stands between this package and a bad publish.
  assert.deepEqual(pkg.files, ["build", "README.md", "LICENSE", "SECURITY.md"]);
  assert.equal(pkg.bin[Object.keys(pkg.bin)[0]], "./build/index.js");
  assert.deepEqual(Object.keys(pkg.bin), [pkg.name.split("/")[1]]);
});

test("no provider key is set in any default or example", () => {
  const src = readFileSync(join(repo, "src", "index.ts"), "utf8");
  assert.ok(!/\.default\(/.test(src), "the tool sets no defaults; the actor applies its own");
});

test("provider keys are read from the environment and never appear in the tool schema", async () => {
  const result = await listTools();
  const props = Object.keys(result.tools[0].inputSchema.properties);
  for (const k of ["prospeo_api_key", "lusha_api_key", "contactout_api_key", "fullenrich_api_key"]) {
    assert.ok(!props.includes(k), `${k} is a tool argument`);
  }
  const src = readFileSync(join(repo, "src", "index.ts"), "utf8");
  for (const n of ["PROSPEO_API_KEY", "LUSHA_API_KEY", "CONTACTOUT_API_KEY", "FULLENRICH_API_KEY"]) assert.ok(src.includes(n));
});
