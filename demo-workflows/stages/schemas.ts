import { z } from "zod";

export const schemas = {
  "demo-brief.output.v1": z.strictObject({ brief: z.string() }),
  "demo-draft.output.v1": z.strictObject({ draft: z.string() }),
  "demo-review.output.v1": z.strictObject({ review: z.string(), drafts: z.number().int() }),
};
