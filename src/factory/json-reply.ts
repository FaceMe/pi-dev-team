/** Extract a JSON value from a model reply (fenced block preferred, then the outermost object). */

export function extractJson(text: string): { value?: any; error?: string } {
  const fences = [...text.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...fences.reverse()];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  let lastError = "no JSON found in the reply";
  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate.trim()) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { error: lastError };
}
