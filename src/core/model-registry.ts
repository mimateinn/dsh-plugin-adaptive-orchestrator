export type ModelStatus =
  "quarantined" | "evaluating" | "qualified" | "disabled" | "regressed";
export function createRegistry(
  entries: ReadonlyArray<{ modelId: string; status: ModelStatus }>,
) {
  const map = new Map(entries.map((e) => [e.modelId, e.status]));
  return { status: (id: string): ModelStatus => map.get(id) ?? "quarantined" };
}
