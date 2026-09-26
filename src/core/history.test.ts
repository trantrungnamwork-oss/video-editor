import { describe, expect, it } from 'vitest';
import { commit, createHistory, HISTORY_LIMIT, redo, undo } from './history';

describe('history', () => {
  it('undoes and redoes', () => {
    let h = createHistory(1);
    h = commit(h, 2);
    h = commit(h, 3);
    h = undo(h);
    expect(h.present).toBe(2);
    h = undo(h);
    expect(h.present).toBe(1);
    expect(undo(h)).toBe(h);
    h = redo(h);
    expect(h.present).toBe(2);
  });

  it('drops the redo branch on a new commit and ignores no-ops', () => {
    let h = commit(commit(createHistory('a'), 'b'), 'c');
    h = undo(h);
    h = commit(h, 'x');
    expect(h.future).toEqual([]);
    expect(redo(h)).toBe(h);
    expect(commit(h, 'x')).toBe(h);
  });

  it('caps the number of undo steps', () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) h = commit(h, i);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(20);
  });
});
