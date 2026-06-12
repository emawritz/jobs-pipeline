import { load } from "cheerio";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TIMEOUT_MS = 15000;
const MAX_CHARS = 8000;

// Sites where the visible-body fetch reliably contains the job description.
// For others we still try a generic extraction but it may include nav junk.
const SELECTOR_BY_HOST: Array<[RegExp, string]> = [
  [/lever\.co/i, ".section-wrapper, [data-qa='job-description']"],
  [/greenhouse\.io/i, "#content, .job__description, [class*='JobDescription']"],
  [/ashbyhq\.com/i, "main, [class*='jobPosting']"],
  [/workable\.com/i, ".section--text, .section--full"],
  [/breezy\.hr/i, ".description, main"],
  [/notion\.(so|site)/i, ".notion-page-content"],
];

function selectorFor(url: string): string {
  for (const [re, sel] of SELECTOR_BY_HOST) if (re.test(url)) return sel;
  return "main, article, [class*='job'], [class*='posting'], body";
}

export type FetchResult = {
  text: string | null;
  status: number; // 0 means network error / timeout
  finalUrl: string;
};

export async function fetchPosting(url: string): Promise<string | null> {
  const r = await fetchPostingFull(url);
  return r.text;
}

export async function fetchPostingFull(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return { text: null, status: res.status, finalUrl: res.url };
    const html = await res.text();
    const $ = load(html);
    $("script, style, nav, footer, header, svg, noscript").remove();
    const sel = selectorFor(url);
    const text = ($(sel).first().text() || $("body").text()).replace(/\s+/g, " ").trim();
    if (text.length < 200) return { text: null, status: res.status, finalUrl: res.url };
    return { text: text.slice(0, MAX_CHARS), status: res.status, finalUrl: res.url };
  } catch {
    clearTimeout(timer);
    return { text: null, status: 0, finalUrl: url };
  }
}
