import { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { ROUTE_MARKER } from '../src/modules/identity/route-markers';

/**
 * Spec "Done when": no endpoint without an explicit permission or public
 * marker. The guard already denies unmarked routes at runtime; this catches
 * one before it ships, by walking every controller in the application.
 */
describe('route markers', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('marks every route in the application', () => {
    const discovery = app.get(DiscoveryService);
    const scanner = app.get(MetadataScanner);
    const reflector = app.get(Reflector);
    const routes: string[] = [];
    const unmarked: string[] = [];

    for (const wrapper of discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      if (!instance) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;

      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name] as (...args: unknown[]) => unknown;
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;

        const label = `${wrapper.name}.${name}`;
        routes.push(label);
        if (!reflector.getAllAndOverride(ROUTE_MARKER, [handler, instance.constructor])) {
          unmarked.push(label);
        }
      }
    }

    // Without this, a scan that found nothing would pass.
    expect(routes).toEqual(expect.arrayContaining(['HealthController.live', 'HealthController.ready']));
    expect(unmarked).toEqual([]);
  });
});
