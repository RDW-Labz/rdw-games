import { describe, expect, it } from 'vitest';
import { createDraftMemory } from './draft-memory';

describe('draft memory', () => {
  it('save then clear must not flush the old draft on background', () => {
    const memory = createDraftMemory<{ title: string }>();
    memory.save({ title: 'finished item' });
    expect(memory.current()).toEqual({ set: true, value: { title: 'finished item' } });
    memory.clear();
    expect(memory.current()).toEqual({ set: false, value: null });
  });
});
