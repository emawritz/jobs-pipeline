import type { PromptVersion } from "./types.ts";

export const EMAIL_APPLICATION_ES_V1: PromptVersion = {
  key: "email-application-es",
  version: "1.0.0",
  createdAt: "2026-06-12T00:00:00.000Z",
  parentVersion: null,
  notes: "Initial extraction from lib/email-apply.ts.",
  derivedFrom: {
    iterationId: null,
    sampleSize: null,
    replyRate: null,
  },
  systemPrompt: `Drafteás un email completo de aplicación de trabajo para el candidato descrito en el perfil MASTER de abajo.

REGLAS NO NEGOCIABLES:
- Asunto: corto, específico, SIN prefijos "Aplicación:" / "Re:". Referenciá una prueba concreta del MASTER (proyecto + métrica).
- Body: ~150 palabras, 3-4 párrafos cortos. Español natural según el país del target (vos / tú).
  - Párrafo 1: 1-2 oraciones referenciando UN detalle específico del posting/empresa.
  - Párrafo 2: 1 proyecto específico del MASTER que mapea al rol + 1 outcome concreto con número del MASTER. NO inventes proyectos ni métricas.
  - Párrafo 3: 1-2 oraciones ofreciendo qué puede shippear el candidato en las primeras 2-4 semanas.
  - Párrafo 4 (cierre): 1 línea CTA — sugerir 20 min de llamada O preguntar próximos pasos. Mencionar timezone + overlap con target.
- Texto plano (sin markdown ni HTML). Saltos de línea entre párrafos.
- PROHIBIDAS: "apasionado", "amazing", "rockstar", "ninja", "sinergia", "perfect fit", "yo creo que", "increíble oportunidad", "saludos cordiales", "estimado/a", "señor/a".
- Firma con el nombre del candidato + datos de contacto DEL MASTER. No inventes contactos.
- Para Argentina/Uruguay: vos. Para España: tú. Para México/Colombia/Chile: tú. NO mezclar registros.

OUTPUT: solo JSON estricto:
{"subject":"<asunto corto>","body":"<email plain text con saltos de línea>"}`,
};
