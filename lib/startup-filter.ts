// Heuristic: is this job posting from a real startup where the founder reads
// the inbox? Or from a BigCorp where the email goes to a black-hole talent ATS?
//
// We want to filter OUT BigCorp before spraying — their response rate is <0.1%
// and they pattern-match cold-pitch CVs against ATS keyword graphs that ignore
// most founder-friendly framing.

import type { RawJob } from "./score.ts";

// Strong negative signals — almost certainly BigCorp (>500 employees)
const BIGCORP_DOMAINS = [
  // Tech giants
  "microsoft.com", "google.com", "amazon.com", "amazonaws", "apple.com", "meta.com",
  "facebook.com", "oracle.com", "ibm.com", "sap.com", "cisco.com", "intel.com",
  "salesforce.com", "adobe.com", "vmware.com", "dell.com", "hp.com", "hpe.com",
  "nvidia.com", "qualcomm.com", "broadcom.com", "samsung", "siemens", "panasonic",
  // Consulting
  "deloitte", "accenture", "kpmg", "ey.com", "pwc.com", "bain.com", "mckinsey",
  "bcg.com", "capgemini", "infosys", "wipro", "tcs.com", "cognizant",
  // Finance/banks
  "jpmorgan", "morganstanley", "goldman", "barclays", "citibank", "wellsfargo",
  "bankofamerica", "americanexpress", "visa.com", "mastercard",
  // Public fintech / neobanks (1000+ employees)
  "n26.com", "revolut.com", "wise.com", "monzo.com", "klarna.com", "robinhood.com",
  "block.xyz", "squareup.com", "paypal.com", "afterpay.com", "nubank",
  // Retail/consumer
  "walmart", "target.com", "costco", "homedepot", "kroger",
  // Telco/utility
  "republicservices", "verizon", "att.com", "tmobile", "comcast",
  // Healthcare giants
  "unitedhealth", "anthem", "cigna.com", "humana", "cvshealth",
  // Auto/industrial
  "ford.com", "gm.com", "toyota", "honda", "tesla.com",
  // Defense
  "boeing", "lockheedmartin", "raytheon", "northropgrumman", "generaldynamics",
  // Mid-large tech (>500 employees, public or near-public)
  "mongodb.com", "cloudflare.com", "datadog", "snowflake", "databricks",
  "shopify.com", "stripe.com", "twilio.com", "atlassian", "intercom",
  "fastly.com", "gitlab.com", "github.com",
  "asana.com", "notion.so", "figma.com", "miro.com", "airtable.com",
  "okta.com", "zendesk.com", "hubspot.com", "zoom.us", "slack.com",
  "spotify.com", "netflix.com", "uber.com", "lyft.com", "airbnb.com",
  "doordash.com", "instacart.com", "pinterest.com", "twitter.com", "x.com",
  "linkedin.com", "reddit.com", "snapchat.com", "tiktok.com",
  // Cloud/devops with thousands of employees
  "elastic.co", "newrelic.com", "splunk.com", "sumologic.com", "honeycomb.io",
  // Govt contractors (visa/clearance required)
  "leidos.com", "saic.com", "boozallen", "caci.com", "manTech.com",
  // Late-stage / unicorn — won't read cold pitch
  "upstart.com", "veeva.com", "clickhouse.com", "agilebits.com", "1password.com",
  "deel.com", "remote.com", "coreweave.com", "ivanti.com", "walmart.com",
  "cvshealth.com", "wayfair.com", "ebay.com", "etsy.com", "expedia.com",
  "booking.com", "tripadvisor.com", "openai.com", "anthropic.com",
  "perplexity.ai", "scale.com", "hugging.co", "huggingface.co",
];

const BIGCORP_KEYWORDS = /\b(fortune\s*500|nasdaq:|nyse:|publicly\s*traded|s&p\s*500|global\s*presence|across\s*\d+\s*countries|\d{4,}\s*employees|10,000\+\s*employees|equal\s*employment\s*opportunity|EEO\b|talent\s*acquisition\s*team|recruitment\s*team|reasonable\s*accommodation)/i;

// Strong POSITIVE signals — startup
const STARTUP_KEYWORDS = /\b(founding\s+engineer|founding\s+team|first\s+\d+\s+(hires?|engineers?|employees?)|seed\s*(stage|round)?|pre-?seed|YC\s+[SWFwsf]\d{2}|y combinator|series\s*[AB]\b|early\s*stage|stealth|2-\d+\s*person\s*team|small\s*team|few\s*engineers|tight\s*team|bootstrapped|indie\s*hackers?|solo\s*founder)/i;

const PERSONAL_EMAIL_PATTERNS = [
  /^[a-z]+@/i,                // "kristiyan@" "dani@" "jack@"
  /^[a-z]+\.[a-z]+@/i,        // "first.last@"
  /^[a-z]+_[a-z]+@/i,         // "first_last@"
];

const FUNCTIONAL_EMAILS = /^(jobs|careers|hiring|hr|talent|recruiting|apply|join|hello|contact|info|team)@/i;

// Block ONLY corporate boilerplate aliases — NOT generic jobs@ / careers@
// (those are legitimate at small startups, just not at BigCorp).
const BLACKHOLE_EMAILS = /^(talent[-_.]?acquisition|hr[-_.]?recruiting|jobs[-_.]?team|workday|greenhouse[-_.]?support|ats[-_.]?inbox|noreply|do[-_.]?not[-_.]?reply|candidate[-_.]?accommodations?|talent[-_.]?accommodations?|paytransparency|pay[-_.]?transparency|eeo[-_.]?(complaints|compliance)|accommodations?|compliance[-_.]?reports?|equal[-_.]?opportunity|payequity|disability[-_.]?accommodations?|reasonable[-_.]?accommodation)@/i;

export type StartupSignal = {
  isStartup: boolean;
  score: number; // -10 to +10
  reasons: string[];
};

export function classifyStartup(job: RawJob, email: string): StartupSignal {
  const reasons: string[] = [];
  let score = 0;

  const emailLower = email.toLowerCase();
  const domain = emailLower.split("@")[1] ?? "";
  const localPart = emailLower.split("@")[0] ?? "";

  // ---- EMAIL DOMAIN SIGNALS ----
  if (BIGCORP_DOMAINS.some((d) => domain.includes(d))) {
    score -= 8;
    reasons.push(`bigcorp domain (${domain})`);
  }

  // ---- EMAIL LOCAL PART SIGNALS ----
  if (BLACKHOLE_EMAILS.test(emailLower)) {
    score -= 5;
    reasons.push("black-hole email (talent-acquisition/etc)");
  } else if (PERSONAL_EMAIL_PATTERNS.some((p) => p.test(emailLower)) && !FUNCTIONAL_EMAILS.test(emailLower)) {
    score += 5;
    reasons.push(`personal email (${localPart}@)`);
  } else if (FUNCTIONAL_EMAILS.test(emailLower)) {
    score += 1;
    reasons.push("functional email (jobs/careers/etc — neutral)");
  }

  // ---- DESCRIPTION / TITLE SIGNALS ----
  const blob = `${job.title ?? ""} ${job.text}`;
  if (BIGCORP_KEYWORDS.test(blob)) {
    score -= 4;
    reasons.push("bigcorp keywords in posting");
  }
  if (STARTUP_KEYWORDS.test(blob)) {
    score += 4;
    reasons.push("startup keywords in posting");
  }

  // Specific founding-engineer signal
  if (/\bfounding\s+(engineer|engineering|team)\b/i.test(blob)) {
    score += 3;
    reasons.push("founding engineer role");
  }

  // Mention of company being small / big — accept multiple phrasings
  // "team of N", "N person team", "N employees", "we are N strong", "we're ~N"
  const teamPatterns = [
    /\bteam\s+of\s+(\d{1,4})\b/i,
    /\b(\d{1,4})\s*(?:-\s*\d+)?\s*(?:person|people|employees?|engineers?|engineering team)\b/i,
    /\bwe(?:'re|\s+are)\s+(?:about\s+|approximately\s+|now\s+)?~?\s*(\d{1,4})\s+(?:strong|people|employees?)/i,
    /\b(\d{1,4})\+?\s+(?:employees?\s+(?:worldwide|globally|across))/i,
  ];
  for (const re of teamPatterns) {
    const m = blob.match(re);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n >= 5 && n <= 25) {
      score += 4;
      reasons.push(`tiny team (${n})`);
    } else if (n > 25 && n <= 75) {
      score += 1;
      reasons.push(`small team (${n})`);
    } else if (n >= 100 && n < 500) {
      score -= 4;
      reasons.push(`mid-large team (${n}) — NOT startup`);
    } else if (n >= 500) {
      score -= 8;
      reasons.push(`bigcorp team (${n})`);
    }
    break;
  }

  // Funding round amounts that signal late-stage
  const fundingMatch = blob.match(/(?:raised|round|funding|valuation)\s*(?:of\s*)?\$?\s*(\d+(?:\.\d+)?)\s*([mb])\b/i);
  if (fundingMatch) {
    const amount = parseFloat(fundingMatch[1]);
    const unit = fundingMatch[2].toLowerCase();
    const usd = unit === "b" ? amount * 1000 : amount; // in millions
    if (usd >= 200) {
      score -= 5;
      reasons.push(`huge raise ($${amount}${unit.toUpperCase()})`);
    } else if (usd >= 50) {
      score -= 2;
      reasons.push(`big raise ($${amount}${unit.toUpperCase()})`);
    }
  }

  // YC batch reference
  if (/YC\s+[SWFwsf]\d{2}/i.test(blob)) {
    score += 4;
    reasons.push("YC batch reference");
  }

  // Source-based hints
  if (/workatastartup/i.test(job.url) || /workatastartup/i.test(job.source)) {
    score += 3;
    reasons.push("workatastartup source");
  }
  if (/republicservices|mongodb|cloudflare|datadog|snowflake|databricks|microsoft|amazon|google|apple|meta|oracle|ibm/i.test(job.url)) {
    score -= 5;
    reasons.push("bigcorp URL");
  }

  // Innocent until proven guilty: accept any positive score. The big-corp
  // domain list + blackhole patterns + bigcorp keywords do the heavy lifting
  // on rejection. A functional email at an unknown small-domain (.io / .ai /
  // .so) with no bigcorp signals scores +1 — accept and trust.
  const isStartup = score >= 1;
  return { isStartup, score, reasons };
}
