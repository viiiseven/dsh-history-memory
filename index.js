import { resolveConfig, NAME } from './lib/config.js';
import { HistoryRag } from './lib/runtime.js';
import { preStep } from './lib/recall.js';
import { eventText } from './lib/text.js';
import { SettingsController, registerSettings } from './lib/settings.js';
import { recallTool } from './lib/tool.js';
import { hostSummarizer } from './lib/host-summary.js';

export const name = NAME;
export const inject = ['sessionQuery', 'agents'];

export async function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : console;
  const runtime = new HistoryRag(config, ctx.sessionQuery, { report: ({ stage, code }) => {
    logger.warn?.(`对话历史 RAG：${stage} ${code}；聊天继续，可用插件 CLI 查看索引状态。`);
  } });
  ctx.effect(() => () => runtime.close());
  ctx.on('agent/pre-step', preStep(runtime), { prepend: true });
  ctx.on('session/event', (session, event) => {
    if (eventText(event, config)) runtime.markDirty(session.id);
  });
  await runtime.start();
  ctx.inject(['llm'], llmCtx => llmCtx.effect(() => {
    runtime.memory.setGenerator(hostSummarizer(llmCtx, runtime));
    return () => runtime.memory.setGenerator(null);
  }));
  ctx.inject(['tools'], toolCtx => { toolCtx.tools.register(recallTool(runtime)); });
  ctx.inject(['connection'], settingsCtx => registerSettings(settingsCtx, new SettingsController(runtime, input)));
  if (!runtime.client.configured) logger.info?.(`对话历史 RAG 已启用，等待配置 Embedding：${config.configFile}`);
}
