import { Logger } from '@nestjs/common';
import { logPoolError } from './prisma.service';

describe('logPoolError', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs a failed idle connection as a warning and does not throw', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    expect(() => logPoolError(new Error('terminating connection due to administrator command'))).not.toThrow();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminating connection due to administrator command'));
  });
});
