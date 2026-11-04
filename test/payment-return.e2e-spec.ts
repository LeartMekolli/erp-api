import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';

/** The page a customer lands on from the payment provider when the workspace has no customer site. */
describe('payment return page', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers a plain page for each outcome, without signing in', async () => {
    for (const [outcome, text] of [
      ['paid', 'Payment received.'],
      ['cancelled', 'nothing was charged'],
      ['back', 'You can close this tab.'],
    ]) {
      const response = await http().get(`/payment-return?outcome=${outcome}`).expect(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).toContain(text);
    }
  });

  it('refuses an outcome it does not know', async () => {
    await http().get('/payment-return?outcome=<script>').expect(400);
    await http().get('/payment-return').expect(400);
  });
});
