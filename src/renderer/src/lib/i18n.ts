import { useCallback } from 'react'
import { DICTS, type Dict, type DictKey } from '../../../shared/i18n'
import { useStore } from '../store'

/**
 * Non-reactive lookup for code paths outside React (store actions, prompts).
 * Falls back to English so a missing key never shows as blank UI.
 */
export function tr(key: DictKey, vars?: Record<string, string | number>): string {
  const locale = useStore.getState().settings.locale || 'en'
  const table: Dict = DICTS[locale] || DICTS.en
  let out = table[key] ?? DICTS.en[key] ?? String(key)
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
  }
  return out
}

/** Reactive translate: re-renders when the locale changes. Stable identity per locale. */
export function useT(): (key: DictKey, vars?: Record<string, string | number>) => string {
  const locale = useStore((s) => s.settings.locale)
  return useCallback(
    (key: DictKey, vars?: Record<string, string | number>) => {
      const table: Dict = DICTS[locale] || DICTS.en
      let out = table[key] ?? DICTS.en[key] ?? String(key)
      if (vars) {
        for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
      return out
    },
    [locale]
  )
}

/** Plural helper for the few strings that need it. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}
