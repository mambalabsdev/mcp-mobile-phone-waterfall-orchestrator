#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// How long the actor run itself is allowed to take, in seconds. One fleet wide
// constant (standing build rule 10, 2026-10-05). FullEnrich alone can take up
// to 150 s per contact, so a batch needs the full window.
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it whatever
// the timeout parameter says, so a long run reads as a timeout even though the
// actor goes on to finish. Starting the run, polling it to a terminal status and
// then reading the dataset is the only way to wait as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-mobile-phone-waterfall-orchestrator",
  version: pkg.version,
});

// Provider keys come from this server's own environment, never from tool
// arguments, so a buyer's keys never pass through the model's context. Each is
// optional: the actor skips a provider with no key and says so.
const KEY_ENV: Record<string, string> = {
  prospeo_api_key: "PROSPEO_API_KEY",
  lusha_api_key: "LUSHA_API_KEY",
  contactout_api_key: "CONTACTOUT_API_KEY",
  fullenrich_api_key: "FULLENRICH_API_KEY",
};

function keysFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, name] of Object.entries(KEY_ENV)) {
    const v = env[name];
    if (v && v.trim()) out[field] = v.trim();
  }
  return out;
}

// Mobile Phone Waterfall (immutable actor ID 6OOgPktf7RIa5XCOP). Every buyer
// facing input of the actor is exposed except the four provider keys, which
// are read from the environment above. Numbers are strings because the actor
// coerces strings, the shape Clay sends.
server.registerTool(
  "find_mobile_phone",
  {
    title: "Find mobile phone",
    description:
      "Find a mobile phone number for each contact by calling the buyer's own phone data providers in order (Prospeo, Lusha, ContactOut, FullEnrich) until one returns a number. Returns one row per contact with the number in E.164 format, its line type, country, a Do Not Call flag where the provider reports one, the provider that found it, and the provider credits it spent, plus a run summary row. Provider keys are read from the PROSPEO_API_KEY, LUSHA_API_KEY, CONTACTOUT_API_KEY, and FULLENRICH_API_KEY environment variables of this server; with none set, the run completes, calls nothing, and charges only the run start fee. A LinkedIn URL is passed to providers as an identifier and never opened. A run that does not succeed is returned as an error with its run ID. Requires an APIFY_TOKEN and consumes Apify credits per contact searched and per number found, plus the buyer's own provider credits.",
    annotations: {
      title: "Find mobile phone",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      contacts: z.array(z.object({
        id: z.string().optional().describe("Your own id, echoed back as contact_id."),
        full_name: z.string().optional().describe("Full name, for example Jane Doe."),
        first_name: z.string().optional().describe("First name, if you hold it separately."),
        last_name: z.string().optional().describe("Last name, if you hold it separately."),
        company_domain: z.string().optional().describe("Company website domain, for example example.com."),
        company_name: z.string().optional().describe("Company name, used when no domain is known."),
        linkedin_url: z.string().optional().describe("LinkedIn profile URL. The strongest identifier for most providers; passed to them, never opened."),
        email: z.string().optional().describe("Work or personal email, which Prospeo and Lusha can match on."),
      }).passthrough())
        .optional()
        .describe("People to look up. Give each as many identifiers as you hold."),
      full_name: z.string().optional().describe("Single contact shortcut: full name."),
      company_domain: z.string().optional().describe("Single contact shortcut: company domain."),
      linkedin_url: z.string().optional().describe("Single contact shortcut: LinkedIn profile URL, never opened by the actor."),
      email: z.string().optional().describe("Single contact shortcut: email."),
      provider_order: z.array(z.enum(["prospeo", "lusha", "contactout", "fullenrich"]))
        .optional()
        .describe("Providers in call order. Default prospeo, lusha, contactout, fullenrich. A provider with no key is skipped and reported."),
      mobile_only: z.enum(["true", "false"])
        .optional()
        .describe("When true, a landline or VoIP number does not count as found and the chain moves on. Numbers with no reported line type are kept as unknown. Default true."),
      max_contacts: z.string().optional().describe("Ceiling on how many contacts this run processes."),
      max_provider_credits: z.string().optional().describe("Cap on the provider credits this run may spend on the buyer's own accounts. Remaining contacts are skipped, uncharged. Strongly recommended."),
      max_charge_usd: z.string().optional().describe("Optional cap on this run's Apify charges. The run stops before a charge that would pass it and keeps every row already paid for."),
    },
  },
  async (args) => runActor("6OOgPktf7RIa5XCOP", "Mobile Phone Waterfall", { ...compact(args as Record<string, unknown>), ...keysFromEnv() }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
