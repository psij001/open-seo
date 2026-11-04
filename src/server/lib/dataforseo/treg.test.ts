import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createTregDataforseoFetch,
  decodeEmulatedTaskId,
  encodeEmulatedTaskId,
  isTregKey,
  parseTregKey,
  resolveCatalogRoute,
} from "./treg";
import { looksLikeDataForSeoKey } from "@/shared/selfhost-checks";

const NO_TOOL = JSON.stringify({
  detail: "no registered tool for upstream 'api.dataforseo.com'",
});

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fake treg: passthrough misses, catalog answers with `catalog`. */
function fakeTreg(catalog: (url: URL, init?: RequestInit) => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(urlOf(input));
    if (url.pathname.startsWith("/call/https://")) {
      return new Response(NO_TOOL, { status: 404 });
    }
    return catalog(url, init);
  });
}

describe("parseTregKey", () => {
  it("reads a team token and an optional team", () => {
    expect(parseTregKey("treg:abc123")).toEqual({ token: "abc123" });
    expect(parseTregKey("treg:abc123@buyersbrain")).toEqual({
      token: "abc123",
      org: "buyersbrain",
    });
  });

  it("leaves a real DataForSEO key alone", () => {
    expect(parseTregKey(btoa("me@example.com:secret"))).toBeNull();
    expect(parseTregKey("treg:")).toBeNull();
    expect(isTregKey(undefined)).toBe(false);
  });

  it("passes the self-host key check", () => {
    expect(looksLikeDataForSeoKey("treg:abc123")).toBe(true);
  });
});

describe("resolveCatalogRoute", () => {
  it("maps a path to its catalog tool", () => {
    expect(resolveCatalogRoute("/backlinks/summary/live")).toEqual({
      toolId: "dataforseo.web.backlinks.summary",
      query: {},
    });
  });

  it("turns path parameters into query parameters", () => {
    expect(resolveCatalogRoute("/serp/google/locations/us")).toEqual({
      toolId: "dataforseo.x.serp-google-locations-country",
      query: { country: "us" },
    });
    expect(
      resolveCatalogRoute("/business_data/google/reviews/task_get/abc-1"),
    ).toEqual({
      toolId: "dataforseo.x.business-data-google-reviews-task-get",
      query: { id: "abc-1" },
    });
  });

  it("has no route for an endpoint treg lacks", () => {
    expect(resolveCatalogRoute("/appendix/goto_url_converter")).toBeNull();
  });
});

describe("emulated task ids", () => {
  it("round-trip the task and drop queue-only fields", () => {
    const id = encodeEmulatedTaskId("/serp/google/organic", {
      keyword: "gutter guards",
      tag: "kw-1",
      postback_url: "https://example.com",
    });
    expect(id.startsWith("treg.")).toBe(true);
    expect(id).not.toMatch(/[+/=]/);
    expect(decodeEmulatedTaskId(id)).toEqual({
      prefix: "/serp/google/organic",
      task: { keyword: "gutter guards", tag: "kw-1" },
    });
  });

  it("refuse ids that aren't ours", () => {
    expect(decodeEmulatedTaskId("11041411-1535-0139-0000-abc")).toBeNull();
    expect(decodeEmulatedTaskId("treg.not-base64!")).toBeNull();
  });
});

describe("createTregDataforseoFetch", () => {
  it("uses passthrough when the team registered its own key", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        json({ status_code: 20000 }),
    );
    const tregFetch = createTregDataforseoFetch({
      token: "tok",
      org: "team",
      fetchImpl,
    });
    await tregFetch("https://api.dataforseo.com/v3/backlinks/summary/live", {
      method: "POST",
      body: "[{}]",
      headers: { Authorization: "Basic should-not-leak" },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(urlOf(url)).toBe(
      "https://treg.to/call/https://api.dataforseo.com/v3/backlinks/summary/live",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Treg-Token")).toBe("tok");
    expect(headers.get("X-Treg-Org")).toBe("team");
    expect(headers.get("Authorization")).toBeNull();
  });

  it("falls back to the catalog and remembers it", async () => {
    const fetchImpl = fakeTreg(() => json({ status_code: 20000, tasks: [] }));
    const tregFetch = createTregDataforseoFetch({ token: "tok", fetchImpl });
    const url = "https://api.dataforseo.com/v3/serp/google/locations/us";
    await tregFetch(url);
    await tregFetch(url);
    const urls = fetchImpl.mock.calls.map(([u]) => urlOf(u));
    expect(urls).toEqual([
      `https://treg.to/call/${url}`,
      "https://treg.to/call/dataforseo.x.serp-google-locations-country?country=us",
      "https://treg.to/call/dataforseo.x.serp-google-locations-country?country=us",
    ]);
  });

  it("answers an unmapped endpoint with a DataForSEO-style 404", async () => {
    const fetchImpl = fakeTreg(() => json({}));
    const tregFetch = createTregDataforseoFetch({ token: "tok", fetchImpl });
    const response = await tregFetch(
      "https://api.dataforseo.com/v3/appendix/goto_url_converter",
      { method: "POST", body: "[]" },
    );
    expect(response.status).toBe(404);
    const body = z
      .object({ status_message: z.string() })
      .parse(await response.json());
    expect(body.status_message).toContain("Not available through treg");
    // Only the passthrough probe went out.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses hosts other than api.dataforseo.com", async () => {
    const tregFetch = createTregDataforseoFetch({
      token: "tok",
      fetchImpl: vi.fn(),
    });
    await expect(
      tregFetch(
        "https://sandbox.dataforseo.com/v3/serp/google/organic/live/advanced",
      ),
    ).rejects.toThrow(TypeError);
  });

  it("emulates task_post and task_get with the live endpoint", async () => {
    const fetchImpl = fakeTreg((url, init) => {
      expect(url.pathname).toBe(
        "/call/dataforseo.x.serp-google-organic-live-advanced",
      );
      expect(init?.method).toBe("POST");
      const body = typeof init?.body === "string" ? init.body : "";
      expect(JSON.parse(body)).toEqual([
        { keyword: "gutter guards", tag: "kw-1" },
      ]);
      return json({
        status_code: 20000,
        tasks: [
          {
            id: "live-id",
            status_code: 20000,
            data: { keyword: "gutter guards" },
            result: [{ items: [{ rank_absolute: 1 }] }],
          },
        ],
      });
    });
    const tregFetch = createTregDataforseoFetch({ token: "tok", fetchImpl });

    const posted = await tregFetch(
      "https://api.dataforseo.com/v3/serp/google/organic/task_post",
      {
        method: "POST",
        body: JSON.stringify([
          { keyword: "gutter guards", tag: "kw-1", priority: 1 },
        ]),
      },
    );
    const postBody = z
      .object({
        tasks: z.array(z.object({ id: z.string(), status_code: z.number() })),
      })
      .parse(await posted.json());
    expect(postBody.tasks[0].status_code).toBe(20100);
    const id = postBody.tasks[0].id;

    const got = await tregFetch(
      `https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced/${encodeURIComponent(id)}`,
    );
    expect(await got.json()).toMatchObject({
      tasks: [
        {
          id,
          status_code: 20000,
          data: { tag: "kw-1" },
          result: [expect.anything()],
        },
      ],
    });
  });
});
