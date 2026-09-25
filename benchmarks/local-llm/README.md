# Local LLM bake-off

This directory is a development-only benchmark for choosing the browser/on-device Chef model and runtime. It is deliberately separate from the production Expo application so experimental runtimes and multi-GB model downloads cannot affect normal users or the production bundle.

## Run

From the repository root:

```bash
npm run benchmark:local-llm
```

Open the printed localhost URL in the browser/device being measured. WebGPU is required.

For another device on the LAN you can set `HOST=0.0.0.0`, but WebGPU generally requires a secure context. Plain LAN HTTP may therefore be unavailable on phones even when localhost works. Use a trusted HTTPS development origin/tunnel for mobile measurements rather than weakening browser security settings.

Run one model at a time. The first load downloads and caches model files; subsequent loads measure cached startup. Export JSON after every device/model session and keep the exact browser, OS, hardware, runtime, model ID, and quantization in the result.

## Candidate set

The initial set intentionally stays small:

- Qwen3.5 0.8B / Transformers.js 4.3 — smallest same-family candidate.
- LFM2.5 1.2B Instruct / Transformers.js 4.3 — efficiency candidate. Its LFM 1.0 license is acceptable for the project's current sub-$10M annual-revenue situation, but license eligibility must be rechecked before release if that changes.
- Qwen3 1.7B / WebLLM 0.2.85 — optimized WebLLM control.
- Qwen3.5 2B / Transformers.js 4.3 — likely middle candidate.
- Qwen3.5 4B / Transformers.js 4.3 — higher-compute quality candidate.

Llama 3.2 is intentionally excluded. Gemma 4 E2B is a second-round challenger only if these candidates leave a meaningful quality gap.

## Fast / Balanced / Smart decision rule

Do **not** attach these labels to model sizes before results justify them.

A three-tier UI is warranted only if the measured candidates form a real product tradeoff:

1. Every exposed tier passes the same hard safety/constraint gates. A smaller model is not allowed to be "Fast" if it is materially less reliable about allergies, explicit exclusions, no-shopping constraints, or valid app actions.
2. Median human quality must improve monotonically from Fast → Balanced → Smart across the Creative Cooking scenario corpus. A larger model must add a noticeable improvement in useful/creative/practical/coherent answers, not merely score higher on generic benchmarks.
3. Median latency and/or memory/download cost must worsen enough with the smarter tier that users receive a meaningful choice. If two candidates feel the same speed, collapse them to the better-quality option. If two candidates have indistinguishable quality, collapse them to the faster/smaller option.
4. The mapping may mix model families. For example, LFM2.5 1.2B can be Fast while Qwen3.5 2B/4B become Balanced/Smart if the measurements support that ordering.
5. Two tiers are preferable to three fake tiers. One tier is preferable if there is no reliable scaling curve.

The eventual UI can offer an automatic/recommended choice based on capability plus explicit Fast/Balanced/Smart overrides, but that UX belongs after the benchmark establishes valid tier boundaries.

## Review process

For each scenario, record the runtime metrics and then score the output 1–5 for:

- usefulness;
- creativity;
- practicality;
- coherence.

Also note constraint failures, invented ingredients, unnecessary clarifying questions, particularly good ideas, or other product-relevant observations.

The harness performs only lightweight deterministic checks. Forbidden-term matches are review flags, not semantic safety verdicts (for example, a correct answer may say “do not use peanuts”). Human review remains necessary for cooking quality; production allergy enforcement will remain deterministic over structured recipe data. Do not treat a generic benchmark score or parameter count as the final product decision.
