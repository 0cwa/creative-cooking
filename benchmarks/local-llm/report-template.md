# Local Chef model/runtime benchmark report

Date:
Tester:

## Devices

| Device | OS | Browser | GPU / adapter | Device memory (if reported) |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Candidates

| Candidate | Runtime | Quantization | Approx download | License | Result |
| --- | --- | --- | ---: | --- | --- |
| Qwen3.5 0.8B | Transformers.js 4.3 | q4 |  | Apache-2.0 |  |
| LFM2.5 1.2B Instruct | Transformers.js 4.3 | q4 | ~850 MB model weights | LFM 1.0 |  |
| Qwen3 1.7B | WebLLM 0.2.85 | q4f16_1 |  | Apache-2.0 |  |
| Qwen3.5 2B | Transformers.js 4.3 | q4 |  | Apache-2.0 |  |
| Qwen3.5 4B | Transformers.js 4.3 | q4 |  | Apache-2.0 |  |

## Runtime summary

| Candidate | Cached load | Median TTFT | Median end-to-end | Decode tok/s | Reliability notes |
| --- | ---: | ---: | ---: | ---: | --- |
|  |  |  |  |  |  |

## Product quality summary

| Candidate | Hard constraints | Useful | Creative | Practical | Coherent | Main failure mode |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
|  |  |  |  |  |  |  |

## Tier test

Only fill this in if the data forms a real monotonic tradeoff.

| Proposed tier | Candidate | Why quality is better/worse | Why speed/resource cost is better/worse |
| --- | --- | --- | --- |
| Fast |  |  |  |
| Balanced |  |  |  |
| Smart |  |  |  |

Decision:

- [ ] Three tiers are justified.
- [ ] Two tiers are justified.
- [ ] A single default is more honest.

## Recommendation

Selected production runtime/model(s):

Rationale:

Unsupported/rejected candidates and why:

Follow-up work before production integration:
