export type QuoteAnchor = Readonly<{ quote: string; before: string; after: string }>;

const CONTEXT_CHARS = 32;

export const quoteContext = (fullText: string, start: number, quote: string) => ({
  before: fullText.slice(Math.max(0, start - CONTEXT_CHARS), start),
  after: fullText.slice(start + quote.length, start + quote.length + CONTEXT_CHARS),
});

const matchScore = (fullText: string, start: number, anchor: QuoteAnchor): number => {
  let score = 0;
  for (
    let k = 1;
    k <= anchor.before.length && fullText[start - k] === anchor.before[anchor.before.length - k];
    k++
  )
    score++;
  const end = start + anchor.quote.length;
  for (let k = 0; k < anchor.after.length && fullText[end + k] === anchor.after[k]; k++) score++;
  return score;
};

export const findQuote = (
  fullText: string,
  anchor: QuoteAnchor,
): readonly [number, number] | null => {
  let best: { start: number; score: number } | null = null;
  for (
    let i = fullText.indexOf(anchor.quote);
    i !== -1;
    i = fullText.indexOf(anchor.quote, i + 1)
  ) {
    const score = matchScore(fullText, i, anchor);
    if (best === null || score > best.score) best = { start: i, score };
  }
  return best === null ? null : [best.start, best.start + anchor.quote.length];
};
