// Generate a SPRINT-style freelance proposal in Spanish argentino for a
// scraped Workana project. Output is plain text, ready to paste into the
// platform's bid form (max ~1500 chars to fit Workana's textarea).

import { callJSON, DRAFT_MODEL } from "./claude.ts";

const SYSTEM = `Sos un asistente que drafteo propuestas SPRINT en nombre del candidato descrito en el MASTER que vende SPRINT freelance: bursts de 2 semanas con entregables concretos, fixed-price o por hora.

Estás escribiendo una PROPUESTA en Workana en respuesta a un proyecto público en español.

REGLAS NO NEGOCIABLES:
- Idioma: español neutro/argentino natural (no "estimado", no "atentamente", no "señor", no "señora").
- Length: 800-1300 caracteres (Workana acepta más pero las propuestas largas se ignoran).
- 3-4 párrafos cortos, sin bullets ni markdown ni emojis.

ESTRUCTURA OBLIGATORIA:
- Párrafo 1 (≤2 líneas): saludo informal ("Hola [nombre si aparece] / Hola!"), referencia ESPECÍFICA a 1 detalle concreto del proyecto (tecnología, problema puntual, contexto del cliente). Demuestra que leíste.
- Párrafo 2 (≤3 líneas): 1 proyecto tuyo que mapea + 1 número/outcome real. Elegí el match más fuerte:
  · SaaS B2B / facturación / 
  - Use projects + metrics from the MASTER.md profile. Do NOT invent any.
  - Use projects + metrics from the MASTER.md profile. Do NOT invent any.
  - Use projects + metrics from the MASTER.md profile. Do NOT invent any.
  · Trading / quant / Polymarket / mercado financiero → , Avellaneda-Stoikov MM, circuit breakers Hystrix-style, 1935 tests + 81% coverage en port a NautilusTrader)
  - Use projects + metrics from the MASTER.md profile. Do NOT invent any.
  · DevOps / Sentry / agents → Mendr (Sentry → PR auto-fix, 5 niveles de autonomía como contrato)
  · MCP / RAG graph-based → lightrag-mcp (LightRAG-HKU + voyage AI, MCP server OSS)
  - Use projects + metrics from the MASTER.md profile. Do NOT invent any.
  - Use projects + metrics from the MASTER.md profile. Do NOT invent any.
- Párrafo 3 (≤3 líneas): qué shippearías en las próximas 2 semanas — entregable concreto del SPRINT, sin generalidades. Mencioná "modalidad SPRINT 2 semanas" o "fixed-price" según convenga.
- Párrafo 4 (1 línea): CTA — sugerí 20 min de call esta semana O preguntá la próxima decisión que necesitan tomar. Mencioná GMT-3 / overlap con US Eastern.

PROHIBIDAS las frases: "apasionado", "rockstar", "ninja", "sinergia", "leverage", "estimado", "atentamente", "perfect fit", "amplia experiencia", "soy el indicado", "trabajo en equipo", "responsable y dedicado".

PRECIO:
- Si el proyecto es por hora → "USD 80/hora (negociable según scope)".
- Si el proyecto es fixed-price <$2000 → "fixed-price [tu propuesta dentro del budget del cliente]".
- Si el proyecto es fixed-price >$2000 → proponer SPRINT de 2 semanas con entregables claros, "USD [40-60% del budget] por el primer SPRINT".
- Si no hay budget visible → "te paso quote concreto en cuanto entendamos scope en una call de 20 min".

NO incluyas firma — Workana ya muestra tu perfil al lado.

OUTPUT: JSON estricto solamente:
{
  "proposal": "<texto plano del cuerpo de la propuesta, 800-1300 chars, con saltos de línea entre párrafos>",
  "match_strength": "<low|medium|high>",
  "suggested_price": "<lo que sugerís en USD: '80/hr' | 'fixed-1500' | 'sprint-3000' | 'discuss'>",
  "key_hook": "<la frase específica del proyecto que enganchaste, ≤80 chars>"
}`;

export type ProposalContext = {
  title: string;
  description: string;
  budget?: string;
  skills?: string[];
  clientCountry?: string;
  bidCount?: number;
  url: string;
};

export type Proposal = {
  proposal: string;
  match_strength: "low" | "medium" | "high";
  suggested_price: string;
  key_hook: string;
};

export async function draftProposal(ctx: ProposalContext): Promise<Proposal> {
  const user = `PROYECTO WORKANA:
Título: ${ctx.title}
URL: ${ctx.url}
Presupuesto: ${ctx.budget || "(no especificado)"}
País del cliente: ${ctx.clientCountry || "(?)"}
Bids actuales: ${ctx.bidCount ?? "?"}
Skills tageadas: ${(ctx.skills ?? []).slice(0, 12).join(", ") || "(ninguna)"}

DESCRIPCIÓN del proyecto:
${ctx.description.slice(0, 3800)}

Escribí la PROPUESTA ahora. Solo JSON.`;

  return callJSON<Proposal>(user, {
    system: SYSTEM,
    model: DRAFT_MODEL,
    timeoutMs: 120000,
  });
}
