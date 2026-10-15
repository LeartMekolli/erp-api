import { Env, loadEnv } from './env';

/**
 * Holds the parsed environment. Deliberately has no knowledge of `process.env`:
 * it is handed an already-validated `Env`, which makes it trivial to construct
 * in a test and keeps the real environment read in one function below.
 *
 * Provided through `ConfigModule`'s factory, never by Nest resolving its
 * constructor.
 */
export class ConfigService {
  constructor(private readonly env: Env) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }
}

/** The only place in the application that reads the real environment. */
export function createConfigService(source: NodeJS.ProcessEnv = process.env): ConfigService {
  return new ConfigService(loadEnv(source));
}
