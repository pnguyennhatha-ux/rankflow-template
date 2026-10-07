/**
 * Group filter for run-now requests (shared contract with backend rankflow.py NO_GROUP).
 *
 *   undefined / null  -> no filter: run ALL enabled pairs (main "Chạy ngay" button)
 *   NO_GROUP          -> only enabled pairs WITHOUT a group (the "(không nhóm)" row)
 *   "<name>"          -> only that group
 *
 * An empty string used to be collapsed to "no filter" (`group || undefined`), so the "(không nhóm)"
 * row's ▶ Chạy ran every group. Never send "" — map it to NO_GROUP.
 */
export const NO_GROUP = "__none__";
export const NO_GROUP_LABEL = "(không nhóm)";

/** Value for a group row's ▶ Chạy button: "" (ungrouped row) becomes the explicit NO_GROUP sentinel. */
export function groupRunValue(group: string | null | undefined): string {
  const name = (group ?? "").trim();
  return name === "" ? NO_GROUP : name;
}

/** Body value for POST /worker/run-now: undefined keeps "all groups"; anything else is a group filter. */
export function runNowGroupParam(group: string | null | undefined): string | undefined {
  if (group === undefined || group === null) return undefined;
  return groupRunValue(group);
}

/** Owner = Lark "User" field watchlist_item.owner (open_id + display name), carried backend -> job -> result rows. */
export type Owner = { id: string; name?: string | null };

export function ownerLabel(owner: { id?: string | null; name?: string | null } | null | undefined): string {
  if (!owner?.id) return "";
  return (owner.name ?? "").trim() || owner.id;
}

/** Validates an owner object from the backend ({id: "ou_…", name}) — anything else is "no owner". */
export function parseOwner(value: unknown): Owner | null {
  if (!value || typeof value !== "object") return null;
  const id = String((value as Record<string, unknown>).id ?? "").trim();
  if (!id) return null;
  const name = (value as Record<string, unknown>).name;
  return { id, name: typeof name === "string" && name.trim() ? name.trim() : null };
}

type CountableGroup = { watchlist_id: string; asins: Array<{ asin: string; keywords: string[] }> };

/** Distinct enabled (watchlist, ASIN, keyword) pairs — what the popup/overview "cặp" counts. */
export function countPairs(groups: CountableGroup[] | null | undefined): number {
  const seen = new Set<string>();
  for (const group of groups ?? []) for (const asin of group.asins ?? []) for (const keyword of asin.keywords ?? []) seen.add(`${group.watchlist_id}|${asin.asin.toUpperCase()}|${keyword.trim().toLocaleLowerCase("en-US")}`);
  return seen.size;
}

/** Distinct owners of a group (from asins[].owners {keyword: owner}), sorted by label. */
export function groupOwners(group: { owners?: Owner[] | null; asins: Array<{ owners?: Record<string, Owner> | null }> }): Owner[] {
  const byId = new Map<string, Owner>();
  for (const owner of group.owners ?? []) if (owner?.id) byId.set(owner.id, owner);
  for (const asin of group.asins ?? []) for (const owner of Object.values(asin.owners ?? {})) if (owner?.id && !byId.has(owner.id)) byId.set(owner.id, owner);
  return [...byId.values()].sort((a, b) => ownerLabel(a).localeCompare(ownerLabel(b)));
}

export function groupLabel(group: string | null | undefined): string {
  const name = (group ?? "").trim();
  return name === "" || name === NO_GROUP ? NO_GROUP_LABEL : name;
}
