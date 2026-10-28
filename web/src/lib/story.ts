/** The one plain sentence at the top of a panel: what stopped, and the duty it touches. */

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export interface StoryWorkflow {
  name: string
  duties: string[]
}

export interface Story {
  preview: boolean
  paused: StoryWorkflow[]
  warned: string[]
  resumed: string[]
}

export function storySentence({ preview, paused, warned, resumed }: Story): string {
  const names = paused.map((p) => p.name)
  const withDuty = paused.filter((p) => p.duties.length)
  const duty =
    withDuty.length === 0
      ? ''
      : paused.length === 1
        ? `, and it serves ${joinNames(withDuty[0].duties)}`
        : ` — ${joinNames(withDuty.map((p) => `${p.name} serves ${joinNames(p.duties)}`))}`

  if (preview) {
    if (!paused.length) return warned.length ? `If you fire this, nothing pauses. ${joinNames(warned)} would get a warning.` : 'If you fire this, nothing pauses.'
    return `If you fire this, ${joinNames(names)} would pause${duty}.`
  }
  if (paused.length) return `${joinNames(names)} ${paused.length === 1 ? 'is' : 'are'} paused${duty}.`
  if (resumed.length) return `${joinNames(resumed)} ${resumed.length === 1 ? 'is' : 'are'} running again.`
  if (warned.length) return `Nothing is paused. ${joinNames(warned)} ${warned.length === 1 ? 'keeps' : 'keep'} running with a warning.`
  return 'No workflow uses this. Nothing needs to stop.'
}
