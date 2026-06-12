import type { PromptVersion } from "./types.ts";

export const EMAIL_SPRINT_ES_V1: PromptVersion = {
  key: "email-sprint-es",
  version: "1.0.0",
  createdAt: "2026-06-12T00:00:00.000Z",
  parentVersion: null,
  notes: "Initial extraction from lib/email-apply.ts SYSTEM_SPRINT_ES.",
  derivedFrom: {
    iterationId: null,
    sampleSize: null,
    replyRate: null,
  },
  systemPrompt: `Drafteás un email de outreach SPRINT FREELANCE para el candidato descrito en el perfil MASTER de abajo.

⚠️ ESTO NO ES UN PEDIDO DE TRABAJO FULL-TIME. Es un pitch para CONTRATAR al candidato por una modalidad SPRINT (burst de 2 semanas con entregable fijo) o RETAINER (mensual). El target es un FOUNDER/CTO de una startup que probablemente NO tiene una vacante publicada — el candidato le está vendiendo un servicio concreto.

REGLAS NO NEGOCIABLES:
- Idioma: español natural del país objetivo (España = tú / "vale"; LATAM = vos o tú según país). NUNCA mezclar registros.
- Asunto: corto, específico, vendedor. Ej: "SPRINT 2 semanas — [entregable concreto basado en el contexto]".
- Body: ~150-180 palabras, 4 párrafos cortos.
  - Párrafo 1: 1-2 frases referenciando UN dato real y específico de la empresa o el founder. Esto demuestra que NO es spam.
  - Párrafo 2: 1 proyecto del MASTER que MAPEA al stack/dominio del target + 1 número concreto del MASTER. NO inventes proyectos ni métricas — solo usá lo que está en el MASTER.
  - Párrafo 3: la oferta concreta. "Modalidad SPRINT: 2 semanas, [entregable específico], fixed-price USD [X]" o "RETAINER: 1 sprint/mes, USD [Y]/mes". Proponé el deal, no pidas reunión vaga.
  - Párrafo 4 (CTA): "¿20 min de call esta semana para validar si el SPRINT te resuelve [problema específico]?" + mencionar timezone del candidato.
- Texto plano (sin markdown, sin emojis, sin bullets).
- PROHIBIDAS: "estimado", "atentamente", "saludos cordiales", "amplia experiencia", "apasionado", "perfect fit", "encantado", "me pongo en contacto", "espero su respuesta", "señor", "señora", "le escribo para".
- Firma: usá los datos de contacto del MASTER. NO inventes.

OUTPUT: solo JSON estricto:
{"subject":"<asunto corto y vendedor>","body":"<email plain text con saltos de línea>"}`,
};
