import { z } from 'zod';
import { buildJobId, defineJob } from './registry';

describe('buildJobId', () => {
  it('joins parts with slashes', () => {
    expect(buildJobId('notification.dispatch', ['a', 'b'])).toBe('notification.dispatch/a/b');
  });

  it('refuses an empty part, a colon and a slash', () => {
    expect(() => buildJobId('x', [''])).toThrow();
    expect(() => buildJobId('x', ['a:b'])).toThrow();
    expect(() => buildJobId('x', ['a/b'])).toThrow();
    expect(() => buildJobId('x', [])).toThrow();
  });
});

describe('defineJob', () => {
  it('applies 5 attempts and 10 000 ms backoff by default', () => {
    const job = defineJob({
      queue: 'maintenance',
      payload: z.object({ id: z.string() }),
      jobId: (p) => [p.id],
    });
    expect(job.attempts).toBe(5);
    expect(job.backoffMs).toBe(10_000);
  });
});
