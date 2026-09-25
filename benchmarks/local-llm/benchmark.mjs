import {
  BENCHMARK_SCENARIOS,
  buildScenarioMessages,
  deterministicChecks
} from './scenarios.mjs';

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
const WEBLLM_URL = 'htttps://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm';

const CANDIDATES = [
  {
    id: 'qwen35-08b-tjs',
    label: 'Qwen3.5 0.8B - Transformers.js 4.3',
    family: 'Qwen3.5',
    paramsB: 0.8,
    runtime: 'transformersjs',
    modelId: 'onnx-community/Qwen3.5-0.8B-ONNX-OPT',
    kind: 'qwen35'
  },
  {
    id: 'lfm25-12b-tjs',
    label: 'LFM2.5 1.2B Instruct - Transformers.js 4.3',
    family: 'LFM2.5',
    paramsB: 1.2,
    runtime: 'transformersjs',
    modelId: 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
    kind: 'causal'
  },
  {
    id: 'qwen3-17b-webllm',
    label: 'Qwen3 1.7B - WebLLM 0.2.85 control',
    family: 'Qwen3',
    paramsB: 1.7,
    runtime: 'webllm',
    modelId: 'Qwen3-1.7B-q4f16_1-MLC',
    kind: 'webllm'
  },
  {
    id: 'qwen35-2b-tjs',
    label: 'Qwen3.5 2B - Transformers.js 4.3',
    family: 'Qwen3.5',
    paramsB: 2,
    runtime: 'transformersjs',
    modelId: 'onnx-community/Qwen3.5-2B-ONNX-OPT',
    kind: 'qwen35'
  },
  {
    id: 'qwen35-4b-tjs',
    label: 'Qwen3.5 4B - Transformers.js 4.3',
    family: 'Qwen3.5',
    paramsB: 4,
    runtime: 'transformersjs',
    modelId: 'onnx-community/Qwen3.5-4B-ONNX-OPT',
    kind: 'qwen35'
  }
];

let activeAdapter = null;
let activeCandidate = null;
let results = [];

const $ = (id) => document.getElementById(id);
const modelSelect = $('model');
const scenarioSelect = $('scenario');
const statusEl = $('status');
const outputEl = $('output');
const metricsEl = $('metrics');
const resultsEl = $('results');
const runButton = $('run');
const unloadButton = $('unload');
const exportButton = $('export');
const qualityInputs = ['usefulness', 'creativity', 'practicality', 'coherence'].map($);

for (const candidate of CANDIDATES) {
  const option = document.createElement('option');
  option.value = candidate.id;
  option.textContent = candidate.label;
  modelSelect.appendChild(option);
}

for (const scenario of BENCHMARK_SCENARIOS) {
  const option = document.createElement('option');
  option.value = scenario.id;
  option.textContent = `${scenario.id} - ${scenario.title}`;
  scenarioSelect.appendChild(option);
}

function setStatus(message) {
  statusEl.textContent = message;
}

function selectedCandidate() {
  return CANDIDATES.find((item) => item.id === modelSelect.value);
}

function selectedScenario() {
  return BENCHMARK_SCENARIOS.find((item) => item.id === scenarioSelect.value);
}

async function getDeviceInfo() {
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
    if (adapter.info) {
      info.adapterInfo = {
        vendor: adapter.info.vendor || null,
        architecture: adapter.info.architecture || null,
        device: adapter.info.device || null,
        description: adapter.info.description || null
      };
    }
  } catch (error) {
    info.webGpuError = String(error);
  }
  return info;
}

async function createTransformersAdapter(candidate) {
  const transformers = await import(TRANSFORMERS_URL);
  let tokenizer = null;
  let processor = null;
  let model = null;
  let stoppingCriteria = null;

  return {
    async prepare(onProgress) {
      const started = performance.now();
      if (candidate.kind === 'qwen35') {
        processor = await transformers.AutoProcessor.from_pretrained(candidate.modelId, {
          progress_callback: onProgress
        });
        model = await transformers.Qwen3_5ForConditionalGeneration.from_pretrained(candidate.modelId, {
          dtype: {
            embed_tokens: 'q4',
            vision_encoder: 'fp16',
            decoder_model_merged: 'q4'
          },
          device: 'webgpu',
          progress_callback: onProgress
        });
        tokenizer = processor.tokenizer;
      } else {
        tokenizer = await transformers.AutoTokenizer.from_pretrained(candidate.modelId, {
          progress_callback: onProgress
        });
        model = await transformers.AutoModelForCausalLM.from_pretrained(candidate.modelId, {
          dtype: 'q4',
          device: 'webgpu',
          progress_callback: onProgress
        });
      }
      stoppingCriteria = new transformers.InterruptableStoppingCriteria();
      return { loadMs: performance.now() - started };
    },

    async generate(messages, signal) {
      const promptStarted = performance.now();
      stoppingCriteria.reset?.();
      let inputs;
      if (candidate.kind === 'qwen35') {
        const prompt = messages
          .map((message) => `<|im_start|>${message.role}\n${message.content}<|im_end|>\n`)
          .join('') + '<|im_start|>assistant\n<think>\n\n</think>\n\n';
        inputs = await processor(prompt);
      } else {
        inputs = tokenizer.apply_chat_template(messages, {
          add_generation_prompt: true,
          return_dict: true
        });
      }
      let firstTokenAt = null;
      let tokenCount = 0;
      let text = '';
      const streamer = new transformers.TextStreamer(tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        token_callback_function: () => {
          tokenCount += 1;
          if (firstTokenAt === null) firstTokenAt = performance.now();
        },
        callback_function: (chunk) => {
          text += chunk;
          outputEl.textContent = text;
        }
      });

      const onAbort = () => stoppingCriteria.interrupt();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await model.generate({
          ...inputs,
          max_new_tokens: 384,
          do_sample: true,
          temperature: 0.7,
          top_p: 0.9,
          streamer,
          stopping_criteria: stoppingCriteria,
          return_dict_in_generate: true
        });
        const finished = performance.now();
        const decodeMs = firstTokenAt === null ? null : finished - firstTokenAt;
        return {
          text: text.trim(),
          metrics: {
            totalMs: finished - promptStarted,
            timeToFirstTokenMs: firstTokenAt === null ? null : firstTokenAt - promptStarted,
            generatedTokens: tokenCount,
            decodeTokensPerSecond: decodeMs && tokenCount > 1 ? (tokenCount - 1) / (decodeMs / 1000) : null
          },
          raw: result
        };
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },

    async dispose() {
      stoppingCriteria?.reset?.();
      await model?.dispose?.();
      tokenizer = null;
      processor = null;
      model = null;
      stoppingCriteria = null;
    }
  };
}

async function createWebLlmAdapter(candidate) {
  const webllm = await import(WEBLLM_URL);
  let engine = null;

  return {
    async prepare(onProgress) {
      const started = performance.now();
      engine = await webllm.CreateMLCEngine(candidate.modelId, {
        initProgressCallback: onProgress,
        logLevel: 'WARN'
      });
      return { loadMs: performance.now() - started };
    },

    async generate(messages, signal) {
      const started = performance.now();
      let firstTokenAt = null;
      let text = '';
      const onAbort = () => void engine?.interruptGenerate?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const stream = await engine.chat.completions.create({
          messages,
          stream: true,
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: 384
        });
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (!delta) continue;
          if (firstTokenAt === null) firstTokenAt = performance.now();
          text += delta;
          outputEl.textContent = text;
          if (signal?.aborted) break;
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
        signal?.removeEventListener('abort', onAbort);
      }
    },

    async dispose() {
      try {
        await engine?.unload?.();
      } finally {
        engine = null;
      }
    }
  };
}

async function ensureAdapter(candidate) {
  if (activeAdapter && activeCandidate?.id === candidate.id) return { loadMs: 0, reused: true };
  if (activeAdapter) await activeAdapter.dispose();
  activeAdapter = candidate.runtime === 'webllm'
    ? await createWebLlmAdapter(candidate)
    : await createTransformersAdapter(candidate);
  activeCandidate = candidate;
  setStatus(`Loading ${candidate.label}...`);
  const load = await activeAdapter.prepare((progress) => {
    const percent = typeof progress?.progress === 'number'
      ? ` ${Math.round(progress.progress * 100)}%`
      : '';
    const file = progress?.file ? ` - ${progress.file}` : '';
    setStatus(`${progress?.status ?? progress/.text ?? 'Loading'}${percent}${file}`);
  });
  return { ...load, reused: false };
}

function reaÿÑ!Õµ¹M½ÉÌ ¤ì(½¹ÍÐÙ±ÕÌôíôì(½È¡½¹ÍÐ¥¹ÁÕÐ½ÅÕ±¥Ñå%¹ÁÕÑÌ¤ì(½¹ÍÐÙ±Õô9ÕµÈ¡¥¹ÁÕÐ¹Ù±Õ¤ì(Ù±ÕÍm¥¹ÁÕÐ¹¥tô9ÕµÈ¹¥Í¥¹¥Ñ¡Ù±Õ¤Ù±ÕøôÄÙ±ÕðôÔüÙ±Õè¹Õ±°ì(ô(Ù±ÕÌ¹¹½ÑÌô ÉÙ¥Üµ¹½ÑÌ¤¹Ù±Õ¹ÑÉ¥´ ¤ñð¹Õ±°ì(ÉÑÕÉ¸Ù±ÕÌì)ô()Õ¹Ñ¥½¸É¹ÉIÍÕ±ÑÌ ¤ì(ÉÍÕ±ÑÍ°¹ÑáÑ½¹Ñ¹Ðô)M=8¹ÍÑÉ¥¹¥ä¡ÉÍÕ±ÑÌ°¹Õ±°°È¤ì)ô(( É½ÉµÉÙ¥Ü¤¹Ù¹Ñ1¥ÍÑ¹È ±¥¬° ¤ôøì(¥ ÉÍÕ±ÑÌ¹±¹Ñ ¤ÉÑÕÉ¸ì(ÉÍÕ±ÑÍmÉÍÕ±ÑÌ¹±¹Ñ ´Åt¹¡Õµ¹IÙ¥ÜôÉ!Õµ¹M½ÉÌ ¤ì(É¹ÉIÍÕ±ÑÌ ¤ì)ô¤ì()ÉÕ¹	ÕÑÑ½¸¹Ù¹Ñ1¥ÍÑ¹È ±¥¬°Íå¹ ¤ôøì(¥ ¹Ù¥Ñ½È¹ÁÔ¤ì(ÍÑMÑÑÕÌ ]AT¥Ì¹½ÐÙ¥±±¥¸Ñ¡¥ÌÉ½ÝÍÈ¸¤ì(ÉÑÕÉ¸ì(ô(ÉÕ¹	ÕÑÑ½¸¹¥Í±ôÑÉÕì(½ÕÑÁÕÑ°¹ÑáÑ½¹Ñ¹Ðôì(µÑÉ¥Í°¹ÑáÑ½¹Ñ¹Ðôì(½¹ÍÐ½¹ÑÉ½±±Èô¹Ü½ÉÑ½¹ÑÉ½±±È ¤ì(Ý¥¹½Ü¹}}±½±1±µ	¹¡µÉ­½ÉÐô ¤ôø½¹ÑÉ½±±È¹½ÉÐ ¤ì(ÑÉäì(½¹ÍÐ¹¥ÑôÍ±Ñ¹¥Ñ ¤ì(½¹ÍÐÍ¹É¥¼ôÍ±ÑM¹É¥¼ ¤ì(½¹ÍÐÙ¥ôÝ¥ÐÑÙ¥%¹¼ ¤ì(½¹ÍÐ±½ôÝ¥Ð¹ÍÕÉÁÑÈ¡¹¥Ñ¤ì(ÍÑMÑÑÕÌ¡IÕ¹¹¥¹íÍ¹É¥¼¹¥ô¸¸¹¤ì(½¹ÍÐÉÍÁ½¹ÍôÝ¥ÐÑ¥ÙÁÑÈ¹¹ÉÑ¡Õ¥±M¹É¥½5ÍÍÌ¡Í¹É¥¼¤°½¹ÑÉ½±±È¹Í¥¹°¤ì(½¹ÍÐ¡­ÌôÑÉµ¥¹¥ÍÑ¥¡­Ì¡Í¹É¥¼°ÉÍÁ½¹Í¹ÑáÐ¤ì(½¹ÍÐÉ½Éôì(Ñ¥µÍÑµÀè¹ÜÑ ¤¹Ñ½%M=MÑÉ¥¹ ¤°(¹¥Ñ°(Í¹É¥½%èÍ¹É¥¼¹¥°(Í¹É¥½Q¥Ñ±èÍ¹É¥¼¹Ñ¥Ñ±°(Ù¥°(±½°(µÑÉ¥ÌèÉÍÁ½¹Í¹µÑÉ¥Ì°(¡­Ì°(½ÕÑÁÕÐèÉÍÁ½¹Í¹ÑáÐ°(¡Õµ¹IÙ¥ÜèÉ!Õµ¹M½ÉÌ ¤(ôì(ÉÍÕ±ÑÌ¹ÁÕÍ ¡É½É¤ì(µÑÉ¥Í°¹ÑáÑ½¹Ñ¹Ðô)M=8¹ÍÑÉ¥¹¥ä¡ì±½°¸¸¹ÉÍÁ½¹Í¹µÑÉ¥Ì°¡­Ìô°¹Õ±°°È¤ì(É¹ÉIÍÕ±ÑÌ ¤ì(ÍÑMÑÑÕÌ IÕ¸½µÁ±Ñ¸¡Õµ¸Í½ÉÌ°Ñ¡¸É½ÉÑ¡ÉÙ¥Ü¸¤ì(ôÑ ¡ÉÉ½È¤ì(½¹Í½±¹ÉÉ½È¡ÉÉ½È¤ì(ÍÑMÑÑÕÌ¡IÕ¸¥±èíÉÉ½È¥¹ÍÑ¹½ÉÉ½ÈüÉÉ½È¹µÍÍèMÑÉ¥¹¡ÉÉ½È¥õ¤ì(ô¥¹±±äì(ÉÕ¹	ÕÑÑ½¸¹¥Í±ô±Íì(ô)ô¤ì(( ½ÉÐ¤¹Ù¹Ñ1¥ÍÑ¹È ±¥¬° ¤ôøÝ¥¹½Ü¹}}±½±1±µ	¹¡µÉ­½ÉÐü¸ ¤¤ì()Õ¹±½	ÕÑÑ½¸¹Ù¹Ñ1¥ÍÑ¹È ±¥¬°Íå¹ ¤ôøì(Õ¹±½	ÕÑÑ½¸¹¥Í±ôÑÉÕì(ÑÉäì(Ý¥ÐÑ¥ÙÁÑÈü¹¥ÍÁ½Íü¸ ¤ì(Ñ¥ÙÁÑÈô¹Õ±°ì(Ñ¥Ù¹¥Ñô¹Õ±°ì(ÍÑMÑÑÕÌ 5½°Õ¹±½¸¤ì(ô¥¹±±äì(Õ¹±½	ÕÑÑ½¸¹¥Í±ô±Íì(ô)ô¤ì()áÁ½ÉÑ	ÕÑÑ½¸¹Ù¹Ñ1¥ÍÑ¹È ±¥¬° ¤ôøì(½¹ÍÐ±½ô¹Ü	±½¡m)M=8¹ÍÑÉ¥¹¥ä¡ì(áÁ½ÉÑÐè¹ÜÑ ¤¹Ñ½%M=MÑÉ¥¹ ¤°(¡É¹ÍÌèÉÑ¥Ùµ½½­¥¹½±½°µ±±´°(ÉÍÕ±ÑÌ(ô°¹Õ±°°È¥t°ìÑåÁèÁÁ±¥Ñ¥½¸½©Í½¸ô¤ì(½¹ÍÐ±¥¹¬ô½Õµ¹Ð¹ÉÑ±µ¹Ð ¤ì(±¥¹¬¹¡ÉôUI0¹ÉÑ=©ÑUI0¡±½¤ì(±¥¹¬¹½Ý¹±½ôÉÑ¥Ùµ½½­¥¹µ±½°µ±±´´í¹ÜÑ ¤¹Ñ½%M=MÑÉ¥¹ ¤¹ÉÁ± ½lè¹t½°´¥ô¹©Í½¹ì(±¥¹¬¹±¥¬ ¤ì(ÍÑQ¥µ½ÕÐ  ¤ôøUI0¹ÉÙ½­=©ÑUI0¡±¥¹¬¹¡É¤°ÄÀÀÀ¤ì)ô¤ì()ÍÑMÑÑÕÌ ¡½½Íµ½°¹Í¹É¥¼¸¥ÉÍÐ±½µä½Ý¹±½¡Õ¹ÉÌ½5Ñ¼ÍÙÉ°¸¤ì