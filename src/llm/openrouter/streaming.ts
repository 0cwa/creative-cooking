export type StreamedToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type AssembledStreamMessage = {
  role: 'assistant';
  content: string | null;
  tool_calls?: StreamedToolCall[];
};

type ToolCallDelta = {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type StreamChoice = {
  delta?: {
    content?: unknown;
    tool_calls?: unknown;
  };
};

export class SseDataParser {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  finish(): string[] {
    return this.drain(true);
  }

  private drain(flush: boolean): string[] {
    const events: string[] = [];

    while (true) {
      const separator = this.buffer.match(/\r?\n\r?\n/);
      if (!separator || separator.index === undefined) break;

      const block = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      const data = extractData(block);
      if (data !== undefined) events.push(data);
    }

    if (flush && this.buffer.trim()) {
      const data = extractData(this.buffer);
      this.buffer = '';
      if (data !== undefined) events.push(data);
    }

    return events;
  }
}

function extractData(block: string): string | undefined {
  const lines = block.split(/\r?\n/);
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));

  return dataLines.length ? dataLines.join('\n') : undefined;
}

export class OpenRouterStreamAccumulator {
  private content = '';
  private readonly toolCalls: Array<StreamedToolCall | undefined> = [];

  apply(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return '';

    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || !choices.length) return '';

    const choice = choices[0] as StreamChoice;
    const delta = choice?.delta;
    if (!delta || typeof delta !== 'object') return '';

    const textDelta = typeof delta.content === 'string' ? delta.content : '';
    if (textDelta) this.content += textDelta;

    if (Array.isArray(delta.tool_calls)) {
      for (const rawCall of delta.tool_calls) {
        if (!rawCall || typeof rawCall !== 'object') continue;
        const call = rawCall as ToolCallDelta;
        const index = Number.isInteger(call.index) ? Number(call.index) : this.toolCalls.length;
        const current =
          this.toolCalls[index] ??
          ({
            id: '',
            type: 'function',
            function: { name: '', arguments: '' }
          } satisfies StreamedToolCall);

        if (typeof call.id === 'string' && call.id) current.id = call.id;
        if (call.type === 'function') current.type = 'function';
        if (typeof call.function?.name === 'string') current.function.name += call.function.name;
        if (typeof call.function?.arguments === 'string') current.function.arguments += call.function.arguments;
        this.toolCalls[index] = current;
      }
    }

    return textDelta;
  }

  message(): AssembledStreamMessage {
    const toolCalls = this.toolCalls.filter((call): call is StreamedToolCall => Boolean(call));

    return {
      role: 'assistant',
      content: this.content || null,
      tool_calls: toolCalls.length ? toolCalls : undefined
    };
  }
}
