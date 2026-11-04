# DataForSEO through treg

This fork can reach DataForSEO through [treg](https://treg.to) instead of
holding a DataForSEO key itself. treg keeps the credential, and OpenSEO
holds only a treg token.

## Set it up

Put the treg token where the DataForSEO key would go:

```bash
# .env.selfhost (Cloudflare) or deploy/standalone/.env (Docker)
DATAFORSEO_API_KEY=treg:<team-token>
# or, with a personal sign-in token, name the team too:
DATAFORSEO_API_KEY=treg:<token>@<team-slug>
```

Nothing else changes. The code is `src/server/lib/dataforseo/treg.ts`.

## Two modes, picked automatically

|           | Team's own DataForSEO key in treg                       | No key of the team's own                       |
| --------- | ------------------------------------------------------- | ---------------------------------------------- |
| How       | treg relays each request unchanged, with the team's key | treg serves it from its own DataForSEO account |
| Billed by | DataForSEO, at its rates                                | treg, to the team's balance                    |
| Coverage  | Every endpoint                                          | The endpoints in treg's catalog (below)        |

The adapter tries the relay first. If treg answers that the team has no
DataForSEO tool, that check costs nothing, and the adapter uses the catalog for
the next ten minutes. Registering a key in treg switches a running deployment
to the relay with no redeploy:

```bash
treg tool add dataforseo --base-url https://api.dataforseo.com
# bind the secret as header Authorization = "Basic {secret}",
# where the secret is base64("login:password")
```

## Catalog mode

**What works:** keyword research, domain and competitor data, backlinks,
live SERPs, Google Maps and local finder, business listings and reviews, and
LLM responses (ChatGPT, Claude, Gemini, Perplexity).

**Emulated:** treg's catalog has no task queue for Google organic, Google
Maps, or the ChatGPT and Gemini scrapers. Their `task_post` answers at once,
with ids that carry the task. Their `task_get` then runs the live endpoint.
Scheduled rank checks, rank-check retries, local rank grids and AI-visibility
collection keep working, but at the live rate: about $0.002 per Google page
instead of $0.0006. The charge lands when a task is collected.

**Not available:** Lighthouse, the older LLM-mentions endpoints
(`ai_optimization/llm_mentions/{search,aggregated_metrics,cross_aggregated_metrics,top_pages}`),
the goto-URL converter, the LLM model list, business-listing categories, and
the account balance. Each answers with a DataForSEO-style 404 that names the
path. The goto links and the model list already have fallbacks.

**SERP locations:** treg won't relay the ~9.5 MB US location list. Build it
from Google's public geotargets file instead, then write it to the KV cache.
See `scripts/treg-seed-serp-locations.mjs`.

**Sandbox:** the sandbox check that a tracker's location name is valid is
skipped. It already lets the save through when the sandbox is down.
