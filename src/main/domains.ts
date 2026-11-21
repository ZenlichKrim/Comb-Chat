/**
 * Which domain a piece of text belongs to.
 *
 * This is data, not prompt: a short list of the technologies that name a *domain*
 * rather than a feature. It exists because a contract written for one task must
 * never be applied to another — a spec that said "ванильный мир Minecraft Java"
 * was used to judge a request about a map for a different game, and the agent then
 * built a world of blocks for a parkour map.
 *
 * Matching whole domains (and only when the request never mentions them) is the
 * check that stops that. It is deliberately short and explicit: a wrong entry
 * would refuse a legitimate contract, so the list holds only names that are
 * unambiguous in a task description.
 */

export interface Domain {
  /** what names this domain in a request or a spec */
  re: RegExp
  /** short id used only for comparisons */
  name: string
}

export const DOMAINS: Domain[] = [
  { re: /\bminecraft\b|майнкрафт|\bjava edition\b/i, name: 'minecraft' },
  { re: /\broblox\b|роблокс|luau|\.rbxl/i, name: 'roblox' },
  { re: /\bunity\b|\bunreal\b|\bue4\b|\bue5\b|\bgodot\b|\.pak\b/i, name: 'engine' },
  { re: /\bp(e|е)ak\b|peakworkshop/i, name: 'peak' },
  { re: /\bfabric\b|forge\b|neoforge|spigot|paper server|\bbukkit\b/i, name: 'jvm-game-mod' }
]

/** Which domains a text names. Empty when it names none. */
export function domainsOf(text: string): Set<string> {
  const out = new Set<string>()
  for (const d of DOMAINS) if (d.re.test(text || '')) out.add(d.name)
  return out
}

/** Domains this text names that the other one does not — the contamination test. */
export function foreignDomains(spec: string, request: string): string[] {
  const asked = domainsOf(request)
  return [...domainsOf(spec)].filter((d) => !asked.has(d))
}
