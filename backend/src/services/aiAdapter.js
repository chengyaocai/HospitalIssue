// AI 回复适配器（v1.16「聊天」功能）。
//
// 当前为「框架占位」实现：不调用任何外部大模型，仅根据历史做回显式应答，
// 以保证本系统在内网/离线环境下也能跑通完整聊天流程（UI + 存储 + 轮询）。
//
// ★ 后续接入真实模型时，只需替换 generateReply 内部实现（调用内部 LLM API / Ollama / 云端 API），
//   其余聊天流程（存储、轮询、前端 UI）无需任何改动。建议做法：
//   1) 在 config.js 增加 model 配置项（如 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME）；
//   2) 在此处用 fetch 调用模型，把 history 转换为模型所需的 messages 格式；
//   3) 注意加超时与降级（模型不可用时返回友好提示，而非抛错中断对话）。
//
// history: [{ sender: 'user'|'assistant', body: string }, ...]
// 返回: { sender: 'assistant', body: string }
export async function generateReply(history = []) {
  const turns = Array.isArray(history) ? history : [];
  const lastUser = [...turns].reverse().find((m) => m.sender !== 'assistant');
  const snippet = lastUser && lastUser.body ? lastUser.body : '';
  const reply =
    '（演示）我是智能助手框架占位，模型尚未接入。\n' +
    (snippet ? `你刚才说：${snippet}\n` : '') +
    '\n后续可在 backend/src/services/aiAdapter.js 接入内部 LLM / Ollama / 云端 API，对话链路无需改动。';
  // 轻微延时，贴近真实异步体验（不影响轮询模型）。
  await new Promise((r) => setTimeout(r, 150));
  return { sender: 'assistant', body: reply };
}
