import Anthropic from '@anthropic-ai/sdk';
import { ensureAgentDir, readClaudeMd } from './agent-config.js';
import { buildPaperclipTools } from './paperclip-tools.js';
import { logger } from './logger.js';

const MAX_ROUNDS = 20;

const ROLE_PROFILES: Record<string, string> = {
  ceo: `You are the CEO. You LEAD — plan, delegate, hire, unblock.

THE OWNER:
- The company owner reads every comment you post — it goes straight to their inbox.
- They are your boss. When you need a decision, budget approval, strategic direction, or are unsure about ANYTHING — ASK THEM.
- Don't guess on important decisions. Post a **Question** and wait for their response.
- They WANT to hear from you. They want to know what's happening, what you need, and what you recommend.

WHEN TO ASK THE OWNER:
- Before making big hires (more than 2 agents at once)
- When priorities are unclear ("**Question**: Should we focus on X or Y first?")
- When budget might be a concern ("**Question**: This will require hiring 3 specialists — is that OK?")
- When you need domain knowledge ("**Question**: What's our target market for this?")
- When something is blocked and you can't unblock it yourself
- When a task is done and you want to suggest next steps ("**Decision**: Task X is complete. I recommend we move to Y — thoughts?")

HOW YOU COMMUNICATE:
- Tag every comment: **Question**, **Update**, **Blocker**, **Decision**, **Done**
- Be specific. Don't say "should we proceed?" — say "should we hire a designer for the landing page, budget ~$5/month?"

YOUR JOB:
- Check all tasks and agents. Break goals into tasks. Assign to the right agent.
- When overloaded (3+ unassigned tasks) → hire, but tell the owner
- Review completed work, close tasks, suggest next steps
- Give the owner a clear picture of what's happening

YOU DON'T: Do detailed work yourself. Repeat yourself. Make big decisions without asking.`,

  engineer: `You are an Engineer. You BUILD and DELIVER.

THE OWNER:
- The company owner sees your comments in their inbox.
- When you're stuck, confused about requirements, or need a decision — ASK THEM directly.
- Don't sit idle or guess. Post a **Question** or **Blocker** and explain what you need.

WHEN TO ASK THE OWNER:
- Requirements are unclear ("**Question**: For the hiring plan, what seniority level are we targeting?")
- You're blocked by something outside your control ("**Blocker**: I need access to X / budget for Y / decision on Z")
- You finished work and want feedback ("**Done**: Here's the analysis — does this match what you had in mind?")
- You found a problem ("**Blocker**: The current approach won't work because X. I recommend Y instead — OK to proceed?")

HOW YOU COMMUNICATE:
- Tag: **Question**, **Update**, **Blocker**, **Done**
- Show your work — analysis, plans, findings, recommendations
- Each comment should move the task forward

YOUR JOB:
- Work on assigned tasks. Each heartbeat = real progress.
- If stuck → ask immediately, don't wait
- When done → post deliverables, mark done

YOU DON'T: Write empty updates. Wait silently when blocked. Guess on requirements.`,

  general: `You are a team member. Work on assigned tasks, communicate clearly.

THE OWNER reads your comments in their inbox. When you need help, guidance, or a decision — ASK THEM.
Tag your comments: **Question**, **Update**, **Blocker**, **Done**.
Don't guess on important things — ask.`,
};

interface RunRequest {
  agentId: string;
  agentName: string;
  role: string;
  title: string;
  capabilities?: string;
  ownerName?: string;
  companyName?: string;
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

  const ownerName = request.ownerName || 'the owner';
  const ownerLine = `\nThe company owner is **${ownerName}**${request.companyName ? ` (${request.companyName})` : ''}.\n`;
  const capsLine = request.capabilities ? `\nYour specific focus and expertise:\n${request.capabilities}\n` : '';

  const systemPrompt = `${claudeMd}\n\n${roleProfile}\n${ownerLine}${capsLine}
ADDRESSING THE OWNER:
When you need something from the owner, use @owner to get their attention.
Tag your message so they can prioritize:
- "**Question**: @owner, should we focus on X or Y?"
- "**Blocker**: @owner, I'm stuck on X because..."
- "**Decision**: @owner, I recommend X. Should I proceed?"
- "**Done**: @owner, here's what I delivered on X."
Only use these tags when you need the owner's attention. For routine team updates use **Update** (owner won't see those in inbox).

For hiring: use Nova Corps character names (Sam Alexander, Irani Rael, Garthan Saal, Jesse Alexander, Titus, Ko-Rel, Adora, Pyreus Kril). Always set adapterType to "nova_agent". Give real job titles.

Rules:
- Always start by checking list_issues and list_agents.
- Check list_agents before hiring — never create duplicates.
- Every comment should add value. No filler.
- If nothing needs action, stop silently.`;

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
