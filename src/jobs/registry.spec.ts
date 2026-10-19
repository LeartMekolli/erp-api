import { z } from 'zod';
import { buildJobId, defineJob, JOBS } from './registry';

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

describe('notification email retries', () => {
  // Invitation and reset links are wiped once an email is given up on, so a
  // provider outage must be outlasted: about four hours at 30 s doubling.
  it('outlast a few hours of provider outage', () => {
    expect(JOBS['notification.email'].attempts).toBe(10);
    expect(JOBS['notification.email'].backoffMs).toBe(30_000);
  });

  it('leave the other jobs on the defaults', () => {
    expect(JOBS['notification.dispatch'].attempts).toBe(5);
    expect(JOBS['notification.dispatch'].backoffMs).toBe(10_000);
  });
});
