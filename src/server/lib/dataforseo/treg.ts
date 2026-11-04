/**
 * DataForSEO through treg (https://treg.to).
 *
 * Set `DATAFORSEO_API_KEY` to `treg:<token>` (a team token) or
 * `treg:<token>@<team-slug>` (a personal sign-in token, which needs the team)
 * and every DataForSEO call goes through treg instead of straight to
 * api.dataforseo.com. treg holds the DataForSEO credential, so this
 * deployment holds only the treg token.
 *
 * Two ways treg can serve a call, tried in this order:
 *
 * 1. **Passthrough.** The team registered its own DataForSEO key in treg as a
 *    tool for api.dataforseo.com. treg relays the request unchanged with that
 *    key, so every endpoint works exactly as upstream OpenSEO expects.
 * 2. **Catalog.** No key of the team's own: treg serves the call from its own
 *    DataForSEO account, billed to the team's treg balance. treg exposes
 *    DataForSEO there as one catalog tool per endpoint, so the path is
 *    mapped to its tool id below. Task-queue endpoints treg's catalog lacks
 *    are emulated with the live endpoint (see `emulatedTaskPrefixes`).
 *
 * A passthrough miss ("no registered tool") is free, and the answer is
 * remembered for a while, so adding a key in treg switches this deployment
 * to passthrough with no redeploy.
 */

import { z } from "zod";
import { emulatedTaskPrefixes, resolveCatalogRoute } from "./treg-routes";

export { resolveCatalogRoute } from "./treg-routes";

const DEFAULT_TREG_BASE_URL = "https://treg.to";
const DATAFORSEO_HOST = "api.dataforseo.com";
const TREG_KEY_PREFIX = "treg:";
/** How long a "no registered tool" answer keeps us on the catalog route. */
const CATALOG_MODE_TTL_MS = 10 * 60 * 1000;

export interface TregCredentials {
  token: string;
  org?: string;
}

/** `treg:<token>` or `treg:<token>@<team-slug>`; null for a real DataForSEO key. */
export function parseTregKey(value: string | undefined | null) {
  const trimmed = value?.trim();
  if (!trimmed?.startsWith(TREG_KEY_PREFIX)) return null;
  const rest = trimmed.slice(TREG_KEY_PREFIX.length);
  const at = rest.lastIndexOf("@");
  const credentials: TregCredentials =
    at > 0
      ? { token: rest.slice(0, at), org: rest.slice(at + 1) }
      : { token: rest };
  return credentials.token ? credentials : null;
}

export function isTregKey(value: string | undefined | null): boolean {
  return parseTregKey(value) !== null;
}

const EMULATED_TASK_ID_PREFIX = "treg.";

// ---------------------------------------------------------------------------
// Task emulation
// ---------------------------------------------------------------------------

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const taskBodySchema = z.record(z.string(), z.unknown());
type TaskBody = z.infer<typeof taskBodySchema>;

const emulatedIdPayloadSchema = z.object({
  p: z.enum(emulatedTaskPrefixes),
  t: taskBodySchema,
});

const liveResponseSchema = z
  .object({
    tasks: z
      .array(z.object({ data: taskBodySchema.optional() }).passthrough())
      .optional(),
  })
  .passthrough();

/** Fields that only make sense for DataForSEO's real queue. */
const QUEUE_ONLY_FIELDS = [
  "postback_url",
  "postback_data",
  "pingback_url",
  "priority",
];

export function encodeEmulatedTaskId(prefix: string, task: TaskBody): string {
  const kept = Object.fromEntries(
    Object.entries(task).filter(([key]) => !QUEUE_ONLY_FIELDS.includes(key)),
  );
  return `${EMULATED_TASK_ID_PREFIX}${base64UrlEncode(JSON.stringify({ p: prefix, t: kept }))}`;
}

export function decodeEmulatedTaskId(
  id: string,
): { prefix: string; task: TaskBody } | null {
  if (!id.startsWith(EMULATED_TASK_ID_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(base64UrlDecode(id.slice(EMULATED_TASK_ID_PREFIX.length)));
  } catch {
    return null;
  }
  const parsed = emulatedIdPayloadSchema.safeParse(raw);
  return parsed.success ? { prefix: parsed.data.p, task: parsed.data.t } : null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function envelope(tasks: unknown[], extra: Record<string, unknown> = {}) {
  return {
    version: "0.1.treg",
    status_code: 20000,
    status_message: "Ok.",
    time: "0 sec.",
    cost: 0,
    tasks_count: tasks.length,
    tasks_error: 0,
    tasks,
    ...extra,
  };
}

function pathSegments(path: string): string[] {
  return ["v3", ...path.split("/").filter(Boolean)];
}

/** `<prefix>/task_post`: answer at once with self-describing ids. */
function emulateTaskPost(prefix: string, body: unknown): Response {
  const parsed = z.array(taskBodySchema).safeParse(body);
  const tasks = parsed.success ? parsed.data : [];
  return jsonResponse(
    envelope(
      tasks.map((task) => ({
        id: encodeEmulatedTaskId(prefix, task),
        status_code: 20100,
        status_message: "Task Created.",
        time: "0 sec.",
        cost: 0,
        result_count: 0,
        path: pathSegments(`${prefix}/task_post`),
        data: { function: "task_post", ...task },
        result: null,
      })),
    ),
  );
}

/** Answer a path treg can't serve the way DataForSEO answers an unknown one. */
function notAvailable(path: string): Response {
  return jsonResponse(
    {
      version: "0.1.treg",
      status_code: 40400,
      status_message: `Not available through treg's DataForSEO catalog: /v3${path}. Register the team's own DataForSEO key in treg to reach every endpoint.`,
      tasks_count: 0,
      tasks_error: 1,
      tasks: [],
    },
    404,
  );
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

interface TregFetchOptions extends TregCredentials {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function tregHeaders(
  original: HeadersInit | undefined,
  credentials: TregCredentials,
): Headers {
  const headers = new Headers(original);
  // treg puts the provider credential on; never send one ourselves.
  headers.delete("Authorization");
  headers.set("X-Treg-Token", credentials.token);
  if (credentials.org) headers.set("X-Treg-Org", credentials.org);
  return headers;
}

async function readJsonBody(init: RequestInit | undefined): Promise<unknown> {
  const body = init?.body;
  if (typeof body !== "string" || body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Whether treg says the team has no DataForSEO tool of its own. */
async function isNoRegisteredTool(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  try {
    const text = await response.clone().text();
    return text.includes("no registered tool");
  } catch {
    return false;
  }
}

/**
 * A `fetch` with DataForSEO's signature that sends each call through treg.
 * Calls for any other host (DataForSEO's sandbox included) are refused with
 * a network-style error, which OpenSEO's sandbox probe already treats as
 * "skip the check".
 */
export function createTregDataforseoFetch(
  options: TregFetchOptions,
): typeof fetch {
  const baseUrl = (options.baseUrl ?? DEFAULT_TREG_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let catalogModeUntil = 0;

  const callCatalogTool = (
    toolId: string,
    query: Record<string, string>,
    search: URLSearchParams,
    init: RequestInit | undefined,
    body?: string,
  ) => {
    const params = new URLSearchParams(search);
    for (const [key, value] of Object.entries(query)) params.set(key, value);
    const qs = params.toString();
    return fetchImpl(`${baseUrl}/call/${toolId}${qs ? `?${qs}` : ""}`, {
      ...init,
      ...(body !== undefined ? { body } : {}),
      headers: tregHeaders(init?.headers, options),
    });
  };

  const viaCatalog = async (
    path: string,
    search: URLSearchParams,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    for (const prefix of emulatedTaskPrefixes) {
      if (path === `${prefix}/task_post`) {
        return emulateTaskPost(prefix, await readJsonBody(init));
      }
      const getPrefix = `${prefix}/task_get/advanced/`;
      if (path.startsWith(getPrefix)) {
        const decoded = decodeEmulatedTaskId(
          decodeURIComponent(path.slice(getPrefix.length)),
        );
        if (!decoded || decoded.prefix !== prefix) return notAvailable(path);
        return emulateTaskGet(decoded, path, init);
      }
    }
    const route = resolveCatalogRoute(path);
    if (!route) return notAvailable(path);
    return callCatalogTool(route.toolId, route.query, search, init);
  };

  const emulateTaskGet = async (
    decoded: { prefix: string; task: TaskBody },
    path: string,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    const route = resolveCatalogRoute(`${decoded.prefix}/live/advanced`);
    if (!route) return notAvailable(path);
    const response = await callCatalogTool(
      route.toolId,
      route.query,
      new URLSearchParams(),
      { ...init, method: "POST" },
      JSON.stringify([decoded.task]),
    );
    if (!response.ok) return response;
    const text = await response.text();
    const headers = new Headers(response.headers);
    headers.delete("Content-Length");
    headers.delete("Content-Encoding");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = liveResponseSchema.safeParse(raw);
    // Not an envelope: hand it back as is for core.ts to report.
    if (!parsed.success) {
      return new Response(text, { status: response.status, headers });
    }
    const live = parsed.data;
    const id = path.slice(path.lastIndexOf("/") + 1);
    const tasks = (live.tasks ?? []).map((task) => ({
      ...task,
      id: decodeURIComponent(id),
      path: pathSegments(path),
      // Keep what was posted (the tag maps a result back to its keyword).
      data: { ...task.data, ...decoded.task, function: "task_get" },
    }));
    return new Response(JSON.stringify({ ...live, tasks }), {
      status: response.status,
      headers,
    });
  };

  return async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(rawUrl);
    if (url.hostname !== DATAFORSEO_HOST) {
      throw new TypeError(
        `${url.hostname} is not reachable through treg; only ${DATAFORSEO_HOST} is`,
      );
    }
    const path = url.pathname.replace(/^\/v3(?=\/)/, "");

    if (now() >= catalogModeUntil) {
      const response = await fetchImpl(`${baseUrl}/call/${url.href}`, {
        ...init,
        headers: tregHeaders(init?.headers, options),
      });
      if (!(await isNoRegisteredTool(response))) return response;
      catalogModeUntil = now() + CATALOG_MODE_TTL_MS;
    }
    return viaCatalog(path, url.searchParams, init);
  };
}
