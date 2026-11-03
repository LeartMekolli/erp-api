-- Hand-written (Orders 3b plan, Task 1): the workshops' job summaries are a run kind of their own
-- (RunKind in src/modules/ai/runs.service.ts).
ALTER TABLE ai_run DROP CONSTRAINT ai_run_kind_check;
ALTER TABLE ai_run ADD CONSTRAINT ai_run_kind_check
  CHECK (kind IN ('ask', 'briefing', 'job_summary', 'recommendations', 'marketing', 'brand_content', 'image'));
