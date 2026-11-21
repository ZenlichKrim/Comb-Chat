import type { Capabilities, EditPermission, RunPermission } from '../shared/types'

/* ------------------------------------------------------------------ */
/* Capabilities -> concrete rules                                      */
/* ------------------------------------------------------------------ */

/**
 * The two switches the user actually understands, translated into the two
 * things the tool layer needs: whether a write needs an approval, and whether a
 * command may run at all. `off` is not a policy — it removes the capability, and
 * the tools refuse instead of asking.
 */
export function resolvePolicy(
  caps: Capabilities | undefined,
  fallback: 'ask' | 'auto-edit' | 'yolo'
): { approvalPolicy: 'ask' | 'auto-edit' | 'yolo'; writesOff: boolean; commandsOff: boolean } {
  if (!caps) {
    return { approvalPolicy: fallback, writesOff: false, commandsOff: false }
  }
  const edit: EditPermission = caps.edit
  const run: RunPermission = caps.run
  const approvalPolicy: 'ask' | 'auto-edit' | 'yolo' =
    edit === 'auto' && run === 'auto' ? 'yolo' : edit === 'auto' && run === 'off' ? 'auto-edit' : 'ask'
  return { approvalPolicy, writesOff: edit === 'off', commandsOff: run === 'off' }
}

/**
 * What it may not touch is said once, in the run's own header. Everything else
 * the agent does with the full toolset, because there is only one agent.
 */
export function permissionLines(caps: Capabilities): string {
  const edit = caps.edit === 'off' ? 'ЗАПРЕЩЕНЫ' : caps.edit === 'auto' ? 'без подтверждений' : 'с подтверждением'
  const run = caps.run === 'off' ? 'ЗАПРЕЩЕНЫ' : caps.run === 'auto' ? 'без подтверждений' : 'с подтверждением'
  return `- Правки файлов: ${edit}\n- Команды: ${run}`
}
