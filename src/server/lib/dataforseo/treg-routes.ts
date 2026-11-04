/** DataForSEO paths and the treg catalog tools that serve them (see treg.ts). */

// ---------------------------------------------------------------------------
// Catalog routes: DataForSEO path (without /v3) -> treg catalog tool id.
// `{name}` segments become query parameters of the same name, which is how
// treg's catalog takes path parameters. Ids come from treg's catalog
// (`treg catalog search`), checked 2026-11-04.
// ---------------------------------------------------------------------------

const CATALOG_ROUTES: ReadonlyArray<readonly [string, string]> = [
  // Keywords
  [
    "/keywords_data/google_ads/search_volume/live",
    "dataforseo.google.keywords.volume",
  ],
  [
    "/keywords_data/google_ads/keywords_for_keywords/live",
    "dataforseo.x.keywords-data-google-ads-keywords-for-keywords-live",
  ],
  [
    "/dataforseo_labs/google/related_keywords/live",
    "dataforseo.google.keywords.ideas",
  ],
  [
    "/dataforseo_labs/google/keyword_suggestions/live",
    "dataforseo.x.dataforseo-labs-google-keyword-suggestions-live",
  ],
  [
    "/dataforseo_labs/google/keyword_overview/live",
    "dataforseo.x.dataforseo-labs-google-keyword-overview-live",
  ],
  [
    "/dataforseo_labs/google/keyword_ideas/live",
    "dataforseo.x.dataforseo-labs-google-keyword-ideas-live",
  ],
  // Domains and competitors
  [
    "/dataforseo_labs/google/ranked_keywords/live",
    "dataforseo.google.domain.ranked_keywords",
  ],
  [
    "/dataforseo_labs/google/serp_competitors/live",
    "dataforseo.x.dataforseo-labs-google-serp-competitors-live",
  ],
  [
    "/dataforseo_labs/google/relevant_pages/live",
    "dataforseo.x.dataforseo-labs-google-relevant-pages-live",
  ],
  [
    "/dataforseo_labs/google/domain_rank_overview/live",
    "dataforseo.x.dataforseo-labs-google-domain-rank-overview-live",
  ],
  // Backlinks
  ["/backlinks/summary/live", "dataforseo.web.backlinks.summary"],
  ["/backlinks/backlinks/live", "dataforseo.web.backlinks.list"],
  ["/backlinks/referring_domains/live", "dataforseo.web.linking_domains.list"],
  ["/backlinks/history/live", "dataforseo.x.backlinks-history-live"],
  [
    "/backlinks/domain_pages_summary/live",
    "dataforseo.x.backlinks-domain-pages-summary-live",
  ],
  // SERP
  [
    "/serp/google/organic/live/advanced",
    "dataforseo.x.serp-google-organic-live-advanced",
  ],
  [
    "/serp/google/maps/live/advanced",
    "dataforseo.x.serp-google-maps-live-advanced",
  ],
  [
    "/serp/google/local_finder/live/advanced",
    "dataforseo.x.serp-google-local-finder-live-advanced",
  ],
  [
    "/serp/google/locations/{country}",
    "dataforseo.x.serp-google-locations-country",
  ],
  // Site audit
  [
    "/on_page/lighthouse/live/json",
    "dataforseo.x.on-page-lighthouse-live-json",
  ],
  // Business data
  [
    "/business_data/business_listings/search/live",
    "dataforseo.x.business-data-business-listings-search-live",
  ],
  [
    "/business_data/google/questions_and_answers/live",
    "dataforseo.x.business-data-google-questions-and-answers-live",
  ],
  [
    "/business_data/google/my_business_info/live",
    "dataforseo.x.business-data-google-my-business-info-live",
  ],
  [
    "/business_data/google/reviews/task_post",
    "dataforseo.x.business-data-google-reviews-task-post",
  ],
  [
    "/business_data/google/reviews/task_get/{id}",
    "dataforseo.x.business-data-google-reviews-task-get",
  ],
  [
    "/business_data/google/extended_reviews/task_post",
    "dataforseo.x.business-data-google-extended-reviews-task-post",
  ],
  [
    "/business_data/google/extended_reviews/task_get/{id}",
    "dataforseo.x.business-data-google-extended-reviews-task-get",
  ],
  [
    "/business_data/google/my_business_updates/task_post",
    "dataforseo.x.business-data-google-my-business-updates-task-post",
  ],
  [
    "/business_data/google/my_business_updates/task_get/{id}",
    "dataforseo.x.business-data-google-my-business-updates-task-get",
  ],
  // AI visibility
  [
    "/ai_optimization/chat_gpt/llm_responses/live",
    "dataforseo.x.ai-optimization-chat-gpt-llm-responses-live",
  ],
  [
    "/ai_optimization/claude/llm_responses/live",
    "dataforseo.x.ai-optimization-claude-llm-responses-live",
  ],
  [
    "/ai_optimization/gemini/llm_responses/live",
    "dataforseo.x.ai-optimization-gemini-llm-responses-live",
  ],
  [
    "/ai_optimization/perplexity/llm_responses/live",
    "dataforseo.x.ai-optimization-perplexity-llm-responses-live",
  ],
  [
    "/ai_optimization/chat_gpt/llm_scraper/live/advanced",
    "dataforseo.x.ai-optimization-chat-gpt-llm-scraper-live-advanced",
  ],
  [
    "/ai_optimization/gemini/llm_scraper/live/advanced",
    "dataforseo.x.ai-optimization-gemini-llm-scraper-live-advanced",
  ],
];

/**
 * Task-queue endpoints treg's catalog doesn't carry, emulated with the live
 * endpoint: `<prefix>/task_post` answers at once with ids that carry the task
 * itself, and `<prefix>/task_get/advanced/<id>` runs `<prefix>/live/advanced`
 * for that task. Nothing is stored, and the live call is charged when the
 * task is collected rather than when it is posted. The live rate is higher
 * than the queue's (e.g. Google organic $0.002 vs $0.0006 per page).
 */
export const emulatedTaskPrefixes = [
  "/serp/google/organic",
  "/serp/google/maps",
  "/ai_optimization/chat_gpt/llm_scraper",
  "/ai_optimization/gemini/llm_scraper",
] as const;

interface CompiledRoute {
  pattern: RegExp;
  params: string[];
  toolId: string;
}

const compiledRoutes: CompiledRoute[] = CATALOG_ROUTES.map(
  ([template, toolId]) => {
    const params: string[] = [];
    const source = template
      .split("/")
      .map((segment) => {
        const match = /^\{(\w+)\}$/.exec(segment);
        if (!match) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        params.push(match[1]);
        return "([^/]+)";
      })
      .join("/");
    return { pattern: new RegExp(`^${source}$`), params, toolId };
  },
);

/** The catalog tool for a DataForSEO path (without /v3), with its path params. */
export function resolveCatalogRoute(path: string) {
  for (const route of compiledRoutes) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    const query: Record<string, string> = {};
    route.params.forEach((name, index) => {
      query[name] = decodeURIComponent(match[index + 1]);
    });
    return { toolId: route.toolId, query };
  }
  return null;
}
