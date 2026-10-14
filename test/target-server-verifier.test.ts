import { describe, expect, it } from 'vitest';
import { advance, applyInput, createRun, isFinished, score, targetSnapshotSchema } from '../examples/target-game/target-engine.js';

const rules = { maxTicks: 240, roundTicks: 200 };

describe('Target Rush server verifier', () => {
  it('counts an issued target once and ignores forged score/state fields', () => {
    const initial = createRun(123, rules);
    const started = applyInput(initial, { action: 'start' }, 3);
    const hit = applyInput(started, { action: 'hit', targetId: started.target.id }, 4);
    const duplicate = applyInput(hit, { action: 'hit', targetId: started.target.id }, 5);
    const forged = applyInput(duplicate, { action: 'hit', targetId: duplicate.target.id, score: 999999 }, 6);
    expect(score(forged)).toBe(1);
    expect(forged.target.id).toBe(2);
    expect(initial.score).toBe(0);
  });

  it('uses server ticks, refuses hits at the deadline, and cannot restart a terminal run', () => {
    const started = applyInput(createRun(123, rules), { action: 'start' }, 7);
    const lastHit = applyInput(started, { action: 'hit', targetId: started.target.id }, 206);
    const tooLate = applyInput(lastHit, { action: 'hit', targetId: lastHit.target.id }, 207);
    const restarted = applyInput(tooLate, { action: 'start' }, 208);
    expect(isFinished(restarted)).toBe(true);
    expect(score(restarted)).toBe(1);
    expect(restarted.startTick).toBe(7);
  });

  it('retains seeded targets across advance/replay and terminates a never-started run', () => {
    const first = createRun(123, rules);
    const sameSeed = createRun(123, rules);
    expect(advance(first, 20).target).toEqual(sameSeed.target);
    expect(createRun(456, rules).target).not.toEqual(first.target);
    const expired = advance(first, rules.maxTicks);
    expect(isFinished(expired)).toBe(true);
    expect(score(expired)).toBe(0);
    expect(applyInput(expired, { action: 'start' }, rules.maxTicks).started).toBe(false);
  });

  it('does not accept an unsafe recorded score as a verified result', () => {
    const snapshot = {
      runId: '7b8c333d-48af-4688-a247-a821e922152b', configDigest: 'a'.repeat(64),
      serverTick: 0, inputSeq: 0, inputTick: -1, expiresAt: '2030-01-01T00:00:00.000Z',
      state: createRun(123, rules), result: { score: '9007199254740992' },
    };
    expect(targetSnapshotSchema.safeParse(snapshot).success).toBe(false);
    const parsed = targetSnapshotSchema.parse({ ...snapshot, result: { score: '0' } });
    if ('error' in parsed || !parsed.result || !('score' in parsed.result)) throw new Error('Expected recorded score');
    expect(parsed.result.score).toBe(0);
  });
});
