# Mobile Phone Waterfall MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-mobile-phone-waterfall-orchestrator)](https://smithery.ai/servers/mambabuilt/mcp-mobile-phone-waterfall-orchestrator) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-mobile-phone-waterfall-orchestrator/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-mobile-phone-waterfall-orchestrator) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-mobile-phone-waterfall-orchestrator%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-mobile-phone-waterfall-orchestrator&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-mobile-phone-waterfall-orchestrator)](https://www.npmjs.com/package/@mambalabsdev/mcp-mobile-phone-waterfall-orchestrator) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-mobile-phone-waterfall-orchestrator)](https://www.npmjs.com/package/@mambalabsdev/mcp-mobile-phone-waterfall-orchestrator) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-mobile-phone-waterfall-orchestrator)](https://github.com/mambalabsdev/mcp-mobile-phone-waterfall-orchestrator/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-mobile-phone-waterfall-orchestrator)

<a href="https://mcprush.com/to/mobile-phone-waterfall-orchestrator-mcp?ref=badge"><img width="380" height="200" src="https://mcprush.com/badge/mobile-phone-waterfall-orchestrator-mcp/card.svg" alt="Mobile Phone Waterfall Orchestrator MCP server" /></a>

Find a mobile phone number for each contact by calling your own phone data providers in order,
Prospeo, Lusha, ContactOut, and FullEnrich, until one returns a number. One row per contact with the
number in E.164 format, line type, country, a Do Not Call flag where the provider reports one, and
the provider credits it spent.

It runs the [Mobile Phone Waterfall](https://apify.com/mambalabs/mobile-phone-waterfall-orchestrator)
actor (Actor ID `6OOgPktf7RIa5XCOP`) on Apify.

The Prospeo path has been run live on a real key (2026-10-19). The Lusha, ContactOut, and
FullEnrich steps are built to each provider's documented API but have not yet been run on a live
key; every run summary lists them under `providers_not_live_verified`. No key is stored.

## Tool

| Tool | What it does |
|---|---|
| `find_mobile_phone` | Looks up mobile numbers for a list of contacts on your own provider keys |

## Setup

```json
{
  "mcpServers": {
    "mamba-mobile-phone-waterfall-orchestrator": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-mobile-phone-waterfall-orchestrator"],
      "env": {
        "APIFY_TOKEN": "your-apify-token",
        "PROSPEO_API_KEY": "optional",
        "LUSHA_API_KEY": "optional",
        "CONTACTOUT_API_KEY": "optional",
        "FULLENRICH_API_KEY": "optional"
      }
    }
  }
}
```

`APIFY_TOKEN` is required to run the tool. The provider keys are optional and read from this
server's environment, so they never pass through the model's context. With no provider key set, the
run completes, calls nothing, and charges only the run start fee.

## Inputs

`contacts` (each with any of `full_name`, `first_name`, `last_name`, `company_domain`,
`company_name`, `linkedin_url`, `email`, `id`), or the single contact shortcuts `full_name`,
`company_domain`, `linkedin_url`, `email`. Optional: `provider_order`, `mobile_only`,
`max_contacts`, `max_provider_credits`, `max_charge_usd`.

A LinkedIn URL is passed to providers as an identifier. Neither this server nor the actor opens it.

## How it runs

The server starts the actor run (`POST /v2/acts/{id}/runs`), polls it (`GET /v2/actor-runs/{runId}`)
to a terminal status with a run timeout of 1,800 seconds, and returns the dataset. A run that does
not succeed comes back as an error with its run ID.

## Cost

Apify charges the actor's pay per event prices to your Apify account: a start event, a charge per
contact on which at least one provider was called, and a charge per number found. Your providers
charge their own credits on your keys. See the actor's pricing tab for current prices.

## License

MIT. Built by [Mamba Labs](https://mambabuilt.com).
