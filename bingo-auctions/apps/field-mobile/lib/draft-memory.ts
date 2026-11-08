export type DraftMemory<T> = { set: boolean; value: T | null };

export function createDraftMemory<T>() {
  let state: DraftMemory<T> = { set: false, value: null };
  return {
    save(value: T | null) {
      state = { set: true, value };
    },
    clear() {
      state = { set: false, value: null };
    },
    current(): DraftMemory<T> {
      return state;
    },
  };
}
