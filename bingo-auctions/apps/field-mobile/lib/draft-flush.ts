export function shouldFlushDraft(state: string): boolean {
  return state === 'background' || state === 'inactive';
}
