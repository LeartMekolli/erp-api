import { z } from 'zod';

const prefixed = (prefixes: string[]) =>
  z
    .string()
    .min(1)
    .max(300)
    .refine((value) => prefixes.some((prefix) => value.startsWith(prefix)), {
      message: `must start with ${prefixes.join(' or ')}`,
    });

/** The workspace's provider keys. The secrets are sealed on arrival and never shown again. */
export const setPaymentAccountSchema = z.strictObject({
  secret_key: prefixed(['sk_', 'rk_']),
  publishable_key: prefixed(['pk_']),
  webhook_secret: prefixed(['whsec_']),
  connect_webhook_secret: prefixed(['whsec_']),
});

export const paymentAccountResponseSchema = z.strictObject({
  configured: z.boolean(),
  publishable_key: z.string().nullable(),
  mode: z.enum(['test', 'live']).nullable().describe('From the secret key: sk_test_ is test, sk_live_ is live.'),
  webhook_urls: z.strictObject({
    payments: z.string().describe('Where the provider sends payment events.'),
    connect: z.string().describe('Where the provider sends events of connected partner accounts.'),
  }),
});
export type PaymentAccountResponse = z.infer<typeof paymentAccountResponseSchema>;
