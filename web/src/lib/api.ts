export type Score = {
  total: number;
  stackFit: number;
  seniorityFit: number;
  compensation: number;
  companyStage: number;
  redFlags: number;
  oneLiner: string;
  flags: string[];
};

export type RawJob = {
  source: string;
  url: string;
  company?: string;
  title?: string;
  text: string;
  salary?: string;
  postedAt?: string;
  applyUrl?: string;
  applyEmail?: string;
};

export type DigestItem = { job: RawJob; score: Score };

export type Digest = {
  date: string;
  generatedAt: string;
  items: DigestItem[];
} | null;

export type Application = {
  id: string;
  url: string;
  platform: string;
  company?: string;
  title?: string;
  status: string;
  appliedAt: string;
  lastUpdate: string;
  notes: string[];
};

export type OutreachTarget = {
  num: number;
  name: string;
  message: string;
  linkedin: string | null;
  linkedinSearch: string;
  founderName: string | null;
  site: string | null;
  summary: string;
  sent: boolean;
  sentAt: string | null;
  appId: string | null;
};

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  digest: () => j<Digest>("/api/digest"),
  applications: () => j<Application[]>("/api/applications"),
  outreach: () => j<OutreachTarget[]>("/api/outreach"),
  addApplication: (data: Partial<Application>) =>
    j<Application>("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }),
  updateApplication: (id: string, data: Partial<Application> & { note?: string }) =>
    j<Application>(`/api/applications/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }),
  clipboard: (text: string) =>
    j<{ ok: true }>("/api/clipboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  open: (url: string) =>
    j<{ ok: true }>("/api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  autoApply: (url: string, mode: "auto" | "review" | "no-pause" = "auto") =>
    j<{ code: number | null; error?: string }>("/api/auto-apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, mode }),
    }),
  // ── orchestrator ──
  playbooks: () => j<Playbook[]>("/api/playbooks"),
  run: (playbook: string) =>
    j<Job>("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playbook }),
    }),
  jobs: () => j<Job[]>("/api/jobs"),
  job: (id: string) => j<Job>(`/api/jobs/${id}`),
  stopJob: (id: string) =>
    j<{ ok: boolean; reason: string }>(`/api/jobs/${id}/stop`, { method: "POST" }),
  status: () => j<Status>("/api/status"),
};

export type Playbook = {
  id: string;
  label: string;
  description: string;
  danger: boolean;
  command: string;
};
export type JobStatus = "running" | "completed" | "failed" | "killed";
export type Job = {
  id: string;
  label: string;
  command: string;
  args: string[];
  status: JobStatus;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  output: string[];
};

export type Status = {
  applications: {
    total: number;
    last24h: number;
    last7d: number;
    byStatus: Record<string, number>;
  };
  channels: {
    email: { sentTotal: number; sent24h: number };
    web: { sentTotal: number; sent24h: number };
    workana: { sentTotal: number; sent24h: number; profileNote: string };
    linkedin: { sentTotal: number };
    hn: { sentTotal: number };
  };
  scrapers: {
    lastDigestAt: string | null;
    lastDigestCount: number | null;
  };
  cron: {
    daily: { plistInstalled: boolean; lastRunAt: string | null };
    hnPoster: { plistInstalled: boolean };
  };
  pipelines: {
    spainTargetsExist: boolean;
    spainTargetsCount: number;
    workanaDraftsExist: boolean;
  };
  sessions: { playwrightDataDir: boolean };
  outreach: { total: number; sent: number; pending: number };
};

// Funnel / pipeline.
export type FunnelStage = {
  key: string;
  label: string;
  count: number;
  detail?: string;
  convPct?: number | null;
};
export type Funnel = {
  generatedAt: string;
  stages: FunnelStage[];
  byChannel: { channel: string; sent: number; replied: number; convPct: number }[];
  scrapers: { name: string }[];
};

// Cron entries.
export type CronEntry = {
  label: string;
  filename: string;
  installed: boolean;
  loaded: boolean;
  lastExitCode: number | null;
  pid: number | null;
  schedule: string;
  scriptPath: string | null;
  logFile: string | null;
  logTailKb: number;
};

// Targets file metadata.
export type TargetFile = {
  path: string;
  label: string;
  kind: "json-array" | "markdown-numbered" | "markdown-plain" | "text";
  exists: boolean;
  mtime: string | null;
  sizeKb: number;
  count: number | null;
  preview: string;
};

export const sistemaApi = {
  funnel: () => j<Funnel>("/api/funnel"),
  cronList: () => j<CronEntry[]>("/api/cron"),
  cronToggle: (filename: string) =>
    j<{ ok: boolean; reason: string }>(`/api/cron/${encodeURIComponent(filename)}/toggle`, { method: "POST" }),
  cronLog: (path: string, lines = 60) =>
    j<{ content: string }>("/api/cron/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, lines }),
    }),
  targetsList: () => j<TargetFile[]>("/api/targets/files"),
  targetsRead: (path: string) =>
    j<{ ok: boolean; content?: string; reason?: string }>("/api/targets/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  replies: () => j<EnrichedReply[]>("/api/replies"),
  gmailStatus: () => j<GmailStatus>("/api/gmail-status"),
};

export type EnrichedReply = {
  id: string;
  threadId: string;
  appId: string;
  matchedBy: "email" | "subject" | "thread";
  fromEmail: string;
  fromDisplay: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  detectedAt: string;
  app: Application | null;
};

export type GmailStatus = {
  credentialsConfigured: boolean;
  tokenConfigured: boolean;
  lastPollAt: string | null;
  repliesDetected: number;
};

// SSE wrapper for /api/jobs/:id/stream.
export function streamJob(
  id: string,
  onLine: (line: string) => void,
  onEnd: (info: { status?: string; exitCode?: number | null }) => void,
): () => void {
  const src = new EventSource(`/api/jobs/${id}/stream`);
  src.onmessage = (e) => {
    try { onLine(JSON.parse(e.data)); } catch { /* ignore */ }
  };
  src.addEventListener("end", (e) => {
    try { onEnd(JSON.parse((e as MessageEvent).data)); } catch { onEnd({}); }
    src.close();
  });
  src.onerror = () => {
    // browser auto-reconnects; we accept that. on real end we close above.
  };
  return () => src.close();
}
