import { BENCHMARK_SCENARIOS, buildScenarioMessages, deterministicChecks } from './scenarios.mjs';

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';

const CANDIDATES = [
  ['qwen35-08b-tjs', 'Qwen3.5 0.8B · Transformers.js 4.3', 'Qwen3.5', 0.8, 'transformersjs', 'onnx-community/Qwen3.5-0.8B-ONNX-OPT', 'qwen35'],
  ['lfm25-12b-tjs', 'LFM2.5 1.2B Instruct · Transformers.js 4.3', 'LFM2.5', 1.2, 'transformersjs', 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX', 'causal'],
  ['qwen3-17b-webllm', 'Qwen3 1.7B · WebLLM 0.2.85 control', 'Qwen3', 1.7, 'webllm', 'Qwen3-1.7B-q4f16_1-MLC', 'webllm'],
  ['qwen35-2b-tjs', 'Qwen3.5 2B · Transformers.js 4.3', 'Qwen3.5', 2, 'transformersjs', 'onnx-community/Qwen3.5-2B-ONNX-OPT', 'qwen35'],
  ['lfm25-26b-tjs', 'LFM2.5 2.6B · Transformers.js 4.3', 'LFM2.5', 2.6, 'transformersjs', 'LiquidAI/LFM2.5-2.6B-ONNX', 'causal'],
  ['qwen35-4b-tjs', 'Qwen3.5 4B · Transformers.js 4.3', 'Qwen3.5', 4, 'transformersjs', 'onnx-community/Qwen3.5-4B-ONNX-OPT', 'qwen35']
].map(([id, label, family, paramsB, runtime, modelId, kind]) => ({ id, label, family, paramsB, runtime, modelId, kind }));

const $ = (id) => document.getElementById(id);
const modelSelect = $('model');
const scenarioSelect = $('scenario');
const statusEl = $('status');
const outputEl = $('output');
const metricsEl = $('metrics');
const resultsEl = $('results');
const reviewIds = ['usefulness', 'creativity', 'practicality', 'coherence'];
let active = null;
let activeCandidate = null;
let abortController = null;
let results = [];

for (const candidate of CANDIDATES) modelSelect.add(new Option(candidate.label, candidate.id));
for (const scenario of BENCHMARK_SCENARIOS) scenarioSelect.add(new Option(scenario.id + ' — ' + scenario.title, scenario.id));

function status(message) { statusEl.textContent = message; }
function candidate() { return CANDIDATES.find((item) => item.id === modelSelect.value); }
function scenario() { return BENCHMARK_SCENARIOS.find((item) => item.id === scenarioSelect.value); }
function renderResults() { resultsEl.textContent = JSON.stringify(results, null, 2); }
function readReview() {
  const review = {};
  for (const id of reviewIds) {
    const value = Number($(id).value);
    review[id] = Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
  }
  review.notes = $('review-notes').value.trim() || null;
  return review;
}

async function deviceInfo() {
  const info = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: navigator.deviceMemory ?? null,
    webGpu: Boolean(navigator.gpu)
  };
  if (!navigator.gpu) return info;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return info;
    info.webGpuFeatures = [...adapter.features].sort();
    info.webGpuLimits = {
      maxBufferSize: Number(adapter.limits.maxBufferSize ?? 0),
      maxStorageBufferBindingSize: Number(adapter.limits.maxStorageBufferBindingSize ?? 0)
    };
    if (adapter.info) info.adapterInfo = { ...adapter.info };
  } catch (error) {
    info.webGpuError = String(error);
  }
  return info;
}

async function transformersAdapter(selected) {
  const t = await import(TRANSFORMERS_URL);
  let tokenizer = null;
  let processor = null;
  let model = null;
  let stop = null;

  return {
    async prepare(onProgress) {
      const started = performance.now();
      if (selected.kind === 'qwen35') {
        processor = await t.AutoProcessor.from_pretrained(selected.modelId, { progress_callback: onProgress });
        tokenizer = processor.tokenizer;
        model = await t.Qwen3_5ForConditionalGeneration.from_pretrained(selected.modelId, {
          dtype: { embed_tokens: 'q4', vision_encoder: 'fp16', decoder_model_merged: 'q4' },
          device: 'webgpu',
          progress_callback: onProgress
        });
      } else {
        tokenizer = await t.AutoTokenizer.from_pretrained(selected.modelId, { progress_callback: onProgress });
        model = await t.AutoModelForCausalLM.from_pretrained(selected.modelId, {
          dtype: 'q4', device: 'webgpu', progress_callback: onProgress
        });
      }
      stop = new t.InterruptableStoppingCriteria();
      return { loadMs: performance.now() - started };
    },
    async generate(messages, signal) {
      stop.reset();
      const started = performance.now();
      let inputs;
      if (selected.kind === 'qwen35') {
        const prompt = messages.map((m) => '<|im_start|>' + m.role + '\n' + m.content + '<|im_end|>\n').join('') +
          '<|im_start|>assistant\n<think>\n\n</think>\n\n';
        inputs = await processor(prompt);
      } else {
        inputs = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true });
      }
      let text = '';
      let firstTokenAt = null;
      let generatedTokens = 0;
      const streamer = new t.TextStreamer(tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        token_callback_function: () => {
          generatedTokens += 1;
          if (firstTokenAt === null) firstTokenAt = performance.now();
        },
        callback_function: (chunk) => {
          text += chunk;
          outputEl.textContent = text;
        }
      });
      const onAbort = () => stop.interrupt();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        await model.generate({
          ...inputs,
          max_new_tokens: 384,
          do_sample: true,
          temperature: 0.7,
          top_p: 0.9,
          streamer,
          stopping_criteria: stop
        });
        const finished = performance.now();
        const decodeMs = firstTokenAt === null ? null : finished - firstTokenAt;
        return {
          text: text.trim(),
          metrics: {
            totalMs: finished - started,
            timeToFirstTokenMs: firstTokenAt === null ? null : firstTokenAt - started,
            generatedTokens,
            decodeTokensPerSecond: decodeMs && generatedTokens > 1 ? (generatedTokens - 1) / (decodeMs / 1000) : null
          }
        };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    interrupt() { stop?.interrupt(); },
    async dispose() {
      stop?.interrupt();
      await model?.dispose?.();
      tokenizer = processor = model = stop = null;
    }
  };
}

async function webLlmAdapter(selected) {
  const webllm = await import(WEBLLM_URL);
  let engine = null;
  return {
    async prepare(onProgress) {
      const started = performance.now();
      engine = await webllm.CreateMLCEngine(selected.modelId, { initProgressCallback: onProgress, logLevel: 'WARN' });
      return { loadMs: performance.now() - started };
    },
    async generate(messages, signal) {
      const started = performance.now();
      let firstTokenAt = null;
      let text = '';
      const onAbort = () => void engine?.interruptGenerate?.();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const stream = await engine.chat.completions.create({ messages, stream: true, temperature: 0.7, top_p: 0.9, max_tokens: 384 });
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (!delta) continue;
          if (firstTokenAt === null) firstTokenAt = performance.now();
          text += delta;
          outputEl.textContent = text;
          if (signal.aborted) break;
        }
        const finished = performance.now();
        return {
          text: text.trim(),
          metrics: {
            totalMs: finished - started,
            timeToFirstTokenMs: firstTokenAt === null ? null : firstTokenAt - started,
            runtimeStats: engine.runtimeStatsText?.() ?? null
          }
        };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    interrupt() { void engine?.interruptGenerate?.(); },
    async dispose() { await engine?.unload?.(); engine = null; }
  };
}

async function ensureAdapter(selected) {
  if (active && activeCandidate?.id === selected.id) return { loadMs: 0, reused: true };
  await active?.dispose?.();
  active = selected.runtime === 'webllm' ? await webLlmAdapter(selected) : await transformersAdapter(selected);
  activeCandidate = selected;
  const load = await active.prepare((progress) => {
    const pct = typeof progress?.progress === 'number' ? ' ' + Math.round(progress.progress * 100) + '%' : '';
    status((progress?.status ?? progress?.text ?? 'Loading') + pct);
  });
  return { ...load, reused: false };
}

$('run').addEventListener('click', async () => {
  if (!navigator.gpu) return status('WebGPU is not available in this browser.');
  $('run').disabled = true;
  outputEl.textContent = '';
  metricsEl.textContent = '';
  abortController = new AbortController();
  try {
    const selected = candidate();
    const test = scenario();
    const device = await deviceInfo();
    status('Loading ' + selected.label + '…');
    const load = await ensureAdapter(selected);
    status('Running ' + test.id + '…');
    const response = await active.generate(buildScenarioMessages(test), abortController.signal);
    const checks = deterministicChecks(test, response.text);
    const record = {
      timestamp: new Date().toISOString(), candidate: selected, scenarioId: test.id, scenarioTitle: test.title,
      device, load, metrics: response.metrics, checks, output: response.text, humanReview: readReview()
    };
    results.push(record);
    metricsEl.textContent = JSON.stringify({ load, ...response.metrics, checks }, null, 2);
    renderResults();
    status('Run complete. Review the output and record scores.');
  } catch (error) {
    console.error(error);
    status('Run failed: ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    $('run').disabled = false;
    abortController = null;
  }
});

$('abort').addEventListener('click', () => { abortController?.abort(); active?.interrupt?.(); });
$('unload').addEventListener('click', async () => {
  await active?.dispose?.(); active = activeCandidate = null; status('Model unloaded.');
});
$('record-review').addEventListener('click', () => {
  if (!results.length) return;
  results[results.length - 1].humanReview = readReview();
  renderResults();
});
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), results }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'creative-cooking-local-llm-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

status('Choose a model and scenario. First load may download hundreds of MB to several GB.');
