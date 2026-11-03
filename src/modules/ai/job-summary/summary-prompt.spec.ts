import { JOB_SUMMARY_TOOL, jobSummaryPrompt } from './summary-prompt';
import type { JobSummaryFacts } from './summary-prompt';

const facts: JobSummaryFacts = {
  job: {
    product: 'Custom cast part',
    options: [{ group: 'Material', value: 'Silver 925' }],
    quantity: 10,
    measures: { volume: '1.0 cm3' },
    due_on: '2026-11-20',
    today: '2026-11-03',
    steps: [{ name: 'Polishing', checklist: ['Surface'] }],
  },
  own_history: { jobs: 0, pieces: 0, scrapped: 0, steps: [], defects: [] },
  workspace_findings: { defects: [{ step: 'Final QC', defect: 'Scratch', count: 2 }], claims: [] },
};

const summary = {
  description: 'Ten polished silver cast parts.',
  watch_outs: ['Porosity at casting', 'Scratches before final QC'],
  recommendations: ['Degas the melt', 'Pack each piece apart'],
  production_days: 6,
  used_history: false,
};

describe('the job summary prompt', () => {
  it("holds the facts and the workspace's own instructions", () => {
    const prompt = jobSummaryPrompt(facts, 'Mention the alloy.');
    expect(prompt).toContain(JSON.stringify(facts));
    expect(prompt).toContain('Mention the alloy.');
    expect(jobSummaryPrompt(facts)).not.toContain('undefined');
  });

  it('takes two to four watch-outs and recommendations', () => {
    expect(JOB_SUMMARY_TOOL.input.safeParse(summary).success).toBe(true);
    expect(JOB_SUMMARY_TOOL.input.safeParse({ ...summary, watch_outs: ['One'] }).success).toBe(false);
    expect(JOB_SUMMARY_TOOL.input.safeParse({ ...summary, recommendations: ['1', '2', '3', '4', '5'] }).success).toBe(false);
    expect(JOB_SUMMARY_TOOL.input.safeParse({ ...summary, production_days: 0 }).success).toBe(false);
  });
});
