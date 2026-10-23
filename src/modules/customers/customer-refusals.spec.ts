import { QUOTE_REFUSAL_CODES } from '../pricing/quote-response';
import { CUSTOMER_REFUSAL_MESSAGES, customerRefusal } from './customer-refusals';

describe('customer refusals', () => {
  it.each(QUOTE_REFUSAL_CODES)('%s has a plain message', (code) => {
    expect(CUSTOMER_REFUSAL_MESSAGES[code]).toMatch(/^[A-Z].+\.$/);
  });

  it('keeps only the code and the plain message, never the rule, the step or the staff message', () => {
    expect(
      customerRefusal({ code: 'rule_requires', message: 'gold_plated requires silver_925', rule_id: '0192d6a0-0000-7000-8000-000000000000' }),
    ).toEqual({ code: 'rule_requires', message: "These options can't be combined." });
    expect(customerRefusal({ code: 'step_price_missing', step: 'casting', message: 'Step casting has no price' })).toEqual({
      code: 'step_price_missing',
      message: "We can't price this configuration yet. Please contact us.",
    });
  });

  it('gives the plain messages the plan names', () => {
    expect(CUSTOMER_REFUSAL_MESSAGES.size_out_of_range).toBe("This size isn't available.");
    expect(CUSTOMER_REFUSAL_MESSAGES.file_required).toBe('Upload your design file.');
    expect(CUSTOMER_REFUSAL_MESSAGES.file_not_measured).toBe('Your file is still being processed.');
    expect(CUSTOMER_REFUSAL_MESSAGES.measure_missing).toBe("Your file couldn't be measured.");
    for (const code of [
      'price_missing',
      'no_steps',
      'step_conflict',
      'density_missing',
      'unit_mismatch',
      'price_too_large',
      'workflow_missing',
      'workflow_step_missing',
    ] as const) {
      expect(CUSTOMER_REFUSAL_MESSAGES[code]).toBe("We can't price this configuration yet. Please contact us.");
    }
  });
});
