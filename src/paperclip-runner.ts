import Anthropic from '@anthropic-ai/sdk';
import { ensureAgentDir, readClaudeMd } from './agent-config.js';
import { buildPaperclipTools } from './paperclip-tools.js';
import { logger } from './logger.js';

const MAX_ROUNDS = 20;

const ROLE_PROFILES: Record<string, string> = {
  ceo: `You are the CEO. You LEAD — plan, delegate, hire, unblock.

HOW YOU COMMUNICATE:
- Your comments go to the user's inbox. When you need input, ASK. When you finish, TELL.
- Tag: **Question**, **Update**, **Blocker**, **Decision**, **Done**

YOUR JOB:
- Check all tasks and agents. Break goals into tasks. Assign to the right agent.
- When overloaded (3+ unassigned tasks) → hire a new agent
- When blocked/unsure → ask the user via a comment
- Review completed work, close tasks, suggest next steps

YOU DON'T: Do detailed work yourself. Repeat yourself. Stay silent when there's something to communicate.`,

  engineer: `You are an Engineer. You BUILD and DELIVER.

HOW YOU COMMUNICATE:
- Your comments go to the user's inbox. Show your work.
- Tag: **Question**, **Update**, **Blocker**, **Done**

YOUR JOB:
- Work on assigned tasks. Each heartbeat = real progress.
- Add comments with substance — analysis, plans, findings, recommendations
- If stuck → ask: "**Question**: What exactly do you want for X?"
- When done → "**Done**: Here's what I built/found/recommend..." → mark done

YOU DON'T: Write empty updates. Wait silently when blocked.`,

  general: `You are a team member. Work on assigned tasks, communicate clearly.
Tag your comments: **Question**, **Update**, **Blocker**, **Done**.`,
};

interface RunRequest {
  agentId: string;
  agentName: string;
  role: string;
  title: string;
  capabilities?: string;
  context: Record<string, unknown>;
  paperclipApiUrl: string;
  paperclipAuthToken: string;
  model?: string;
  companyId?: string;
}

export async function runAgentForPaperclip(
  agentId: string,
  request: RunRequest,
  emit: (line: string) => void,
): Promise<void> {
  const model = request.model || 'claude-sonnet-4-5-20250929';
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  await ensureAgentDir(agentId, {
    name: request.agentName,
    role: request.role,
    title: request.title,
    capabilities: request.capabilities,
  });

  const claudeMd = await readClaudeMd(agentId);
  const roleProfile = ROLE_PROFILES[request.role] || ROLE_PROFILES.general!;
  const companyId = request.companyId || '';
  const { tools, execute: executeTool } = buildPaperclipTools(
    request.paperclipApiUrl,
    request.paperclipAuthToken,
    companyId,
  );

  const systemPrompt = `${claudeMd}\n\n${roleProfile}\n\nYour comments on tasks go directly to the user's inbox.\nFor hiring: use Nova Corps names (Sam Alexander, Irani Rael, Garthan Saal, Jesse Alexander, Titus, Ko-Rel). Always set adapterType to "nova_agent". Give real job titles.\n\nRules:\n- Always start by checking list_issues and list_agents.\n- Check list_agents before hiring — never create duplicates.\n- Every comment should add value. No filler.\n- If nothing needs action, stop silently.`;

  const wake = request.context.paperclipWake;
  const userPrompt = wake
    ? `## Wake Event\n${JSON.stringify(wake, null, 2)}`
    : 'Heartbeat. Check tasks and your team. Take meaningful action or stay silent.';

  emit(JSON.stringify({ type: 'init', model, agentName: request.agentName }));

  const anthropic = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];
  let totalIn = 0,
    totalOut = 0,
    rounds = 0,
    lastText = '';
  const actions: Array<{ tool: string; ok: boolean }> = [];

  while (rounds < MAX_ROUNDS) {
    rounds++;
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: tools as Anthropic.Tool[],
    });

    totalIn += response.usage?.input_tokens ?? 0;
    totalOut += response.usage?.output_tokens ?? 0;

    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    );
    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    for (const tb of textBlocks) {
      if (tb.text) {
        lastText = tb.text;
        emit(JSON.stringify({ type: 'thinking', text: tb.text }));
      }
    }

    if (toolBlocks.length === 0) break;
    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const tu of toolBlocks) {
      emit(
        JSON.stringify({
          type: 'tool_call',
          name: tu.name,
          input: tu.input,
          toolUseId: tu.id,
        }),
      );
      const result = await executeTool(
        tu.name,
        tu.input as Record<string, unknown>,
      );
      const preview =
        typeof result.body === 'string'
          ? result.body.slice(0, 200)
          : JSON.stringify(result.body).slice(0, 200);
      actions.push({ tool: tu.name, ok: result.ok });
      emit(
        JSON.stringify({
          type: 'tool_result',
          name: tu.name,
          ok: result.ok,
          preview,
          toolUseId: tu.id,
        }),
      );
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content:
          typeof result.body === 'string'
            ? result.body
            : JSON.stringify(result.body),
        is_error: !result.ok,
      });
    }

    messages.push({ role: 'user', content: results });
  }

  const costUsd =
    Math.round(((totalIn / 1e6) * 3 + (totalOut / 1e6) * 15) * 10000) / 10000;
  emit(
    JSON.stringify({
      type: 'result',
      summary: lastText || `Completed ${rounds} rounds`,
      rounds,
      inputTokens: totalIn,
      outputTokens: totalOut,
      costUsd,
      actions,
    }),
  );
}
