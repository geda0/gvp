# Chat eval gate (phase 4)

This folder defines the pre-deploy regression gate for portfolio chat behavior.

## Fixed eval set

- Fixture source: `docker/chat/tests/fixtures/transcript-eval-cases.json`
- Cases are transcript-style examples split across `good` and `bad` labels.
- Each case includes:
  - `prompt_version`
  - scenario expectations (`hallucination_safe`, `should_refuse`, `should_handoff`)
  - expected correctness decisions for:
    - hallucination safety
    - refusal correctness
    - handoff correctness

## Machine-checkable pass criteria

- Criteria file: `docs/chat-evals/pass-criteria.json`
- The eval suite enforces minimum pass-rate and minimum-case requirements for:
  - `hallucination_correctness`
  - `refusal_correctness`
  - `handoff_correctness`

## How it is enforced

`docker/chat/tests/test_eval_gate.py` loads both files, computes metric correctness per case, and fails if any required threshold is not met. The same test also verifies prompt-version comparison buckets are produced so behavior deltas can be tracked by prompt version.
