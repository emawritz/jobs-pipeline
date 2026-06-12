import type { RawJob } from "../lib/score.ts";

// hiring.cafe's API endpoint returns 405 for our POST. Their schema and method
// keep changing; not worth maintaining for a personal pipeline.
// Skipped until we have a confirmed stable endpoint. Returns empty.
export async function scrape(): Promise<RawJob[]> {
  console.error("[hiring.cafe] skipped — endpoint unstable, see scraper file");
  return [];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  scrape().then((jobs) => console.log(`hiring.cafe: ${jobs.length}`));
}

const _SEARCH_URL = "https://hiring.cafe/api/search-jobs";

type HiringCafeHit = {
  _id?: string;
  job_information?: {
    title?: string;
    description?: string;
  };
  v5_processed_job_data?: {
    role_title?: string;
    role_description_text?: string;
    listed_at?: string;
    technical_tools?: string[];
    workplace_type?: string;
    yearly_min_compensation?: number;
    yearly_max_compensation?: number;
    requires_us_work_authorization?: boolean;
    seniority_level?: string;
  };
  v5_processed_company_data?: {
    name?: string;
  };
  apply_url?: string;
};

const QUERIES = ["senior typescript", "founding engineer", "staff full-stack", "ai engineer", "platform engineer"];

async function _scrapeImpl(): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (const q of QUERIES) {
    const body = {
      size: 25,
      page: 0,
      searchState: {
        searchQuery: q,
        locations: [{ formatted_address: "Remote", types: ["remote"], geometry: { location: { lat: 0, lng: 0 } } }],
        workplaceTypes: ["Remote"],
        defaultToUserLocation: false,
      },
    };
    try {
      const res = await fetch(_SEARCH_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 jobs-pipeline" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`hiringcafe ${q}: HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as { results?: HiringCafeHit[] };
      for (const h of data.results ?? []) {
        const company = h.v5_processed_company_data?.name;
        const title = h.v5_processed_job_data?.role_title ?? h.job_information?.title;
        const desc = h.v5_processed_job_data?.role_description_text ?? h.job_information?.description ?? "";
        const url = h.apply_url;
        if (!url || !title) continue;
        const tools = h.v5_processed_job_data?.technical_tools ?? [];
        const min = h.v5_processed_job_data?.yearly_min_compensation;
        const max = h.v5_processed_job_data?.yearly_max_compensation;
        const salary = min && max ? `$${min}-${max} USD/yr` : undefined;
        out.push({
          source: `hiring.cafe (${q})`,
          url,
          company,
          title,
          text: `${title} @ ${company}\n${desc}\nTools: ${tools.join(", ")}`,
          salary,
          postedAt: h.v5_processed_job_data?.listed_at,
        });
      }
    } catch (e) {
      console.error(`hiringcafe ${q}:`, (e as Error).message);
    }
  }
  return out;
}

void _scrapeImpl; // keep for future when endpoint stabilises
