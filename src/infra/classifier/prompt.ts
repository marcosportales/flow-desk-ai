import { categories, impactScopes } from "@/domain/classification";
import type { ClassifierInput } from "./types";

// The model extracts facts only; Priority and Team are decided by rules (ADR 0001).
export const systemPrompt = `You classify internal IT/business support requests.
Reply with a single JSON object and nothing else, with exactly these keys:
- "category": one of ${categories.map((c) => `"${c}"`).join(", ")}
  (erp = ERP/SAP problems, access = accounts and permissions, data = reports and data quality, inquiry = questions about an existing request, other = anything else)
- "summary": string, 1-200 characters, what the request is about
- "blocks_work": boolean, true if the requester cannot do their work because of it
- "impact_scope": one of ${impactScopes.map((s) => `"${s}"`).join(", ")}
- "reason": string, 1-500 characters, why you chose this category and these facts
Do not add any other keys. Do not suggest a priority or a team.`;

export function buildMessages(input: ClassifierInput) {
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Title: ${input.title}\n\nDescription:\n${input.description}`,
    },
  ];
  if (input.repair) {
    messages.push(
      { role: "assistant", content: input.repair.previousOutput },
      {
        role: "user",
        content: `That reply was invalid: ${input.repair.error}\nReply again with only the corrected JSON object.`,
      },
    );
  }
  return messages;
}
