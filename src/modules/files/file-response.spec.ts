import { fileResponseSchema, versionResponseSchema } from './file-response';

// Every status files.service.ts and measure.handler.ts write, and nothing else, so a client's types
// name each one and a new status shows up as a change to the API.
describe('file and version statuses', () => {
  it.each(['active', 'removed'])('a file may be %s', (status) => {
    expect(fileResponseSchema.shape.status.safeParse(status).success).toBe(true);
  });

  it.each(['pending', 'completing', 'uploaded', 'measuring', 'measured', 'failed'])('a version may be %s', (status) => {
    expect(versionResponseSchema.shape.status.safeParse(status).success).toBe(true);
  });

  it('refuses any other status', () => {
    expect(fileResponseSchema.shape.status.safeParse('bogus').success).toBe(false);
    expect(versionResponseSchema.shape.status.safeParse('bogus').success).toBe(false);
  });
});
