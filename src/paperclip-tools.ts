interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export function buildPaperclipTools(
  apiUrl: string,
  authToken: string,
  companyId: string,
): {
  tools: ToolDef[];
  execute: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ ok: boolean; body: unknown }>;
} {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
  };

  const tools: ToolDef[] = [
    {
      name: 'list_issues',
      description: 'List all tasks for the company.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_issue',
      description: 'Get a task by ID.',
      input_schema: {
        type: 'object',
        properties: { issueId: { type: 'string' } },
        required: ['issueId'],
      },
    },
    {
      name: 'update_issue_status',
      description:
        'Update task status: backlog, todo, in_progress, in_review, done, cancelled.',
      input_schema: {
        type: 'object',
        properties: {
          issueId: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['issueId', 'status'],
      },
    },
    {
      name: 'add_comment',
      description:
        'Post a comment on a task. The user sees this in their inbox. Tag: **Question**, **Update**, **Blocker**, **Done**.',
      input_schema: {
        type: 'object',
        properties: {
          issueId: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['issueId', 'content'],
      },
    },
    {
      name: 'create_sub_issue',
      description: 'Create a sub-task.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          parentId: { type: 'string' },
          assigneeAgentId: { type: 'string' },
        },
        required: ['title', 'description', 'parentId'],
      },
    },
    {
      name: 'list_agents',
      description: 'List all agents. Check before hiring.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'hire_agent',
      description:
        'Hire a new agent. Use Nova Corps names. Set adapterType to nova_agent.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          title: { type: 'string' },
          adapterType: { type: 'string' },
          capabilities: { type: 'string' },
        },
        required: ['name', 'role', 'title', 'adapterType'],
      },
    },
  ];

  async function execute(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; body: unknown }> {
    let url: string;
    let method = 'GET';
    let body: string | undefined;

    switch (name) {
      case 'list_issues':
        url = `${apiUrl}/companies/${companyId}/issues`;
        break;
      case 'get_issue':
        url = `${apiUrl}/issues/${input.issueId}`;
        break;
      case 'update_issue_status':
        url = `${apiUrl}/issues/${input.issueId}`;
        method = 'PATCH';
        body = JSON.stringify({ status: input.status });
        break;
      case 'add_comment':
        url = `${apiUrl}/issues/${input.issueId}/comments`;
        method = 'POST';
        body = JSON.stringify({ body: input.content });
        break;
      case 'create_sub_issue':
        url = `${apiUrl}/companies/${companyId}/issues`;
        method = 'POST';
        body = JSON.stringify({
          title: input.title,
          description: input.description,
          parentId: input.parentId,
          assigneeAgentId: input.assigneeAgentId,
        });
        break;
      case 'list_agents':
        url = `${apiUrl}/companies/${companyId}/agents`;
        break;
      case 'hire_agent':
        url = `${apiUrl}/companies/${companyId}/agent-hires`;
        method = 'POST';
        body = JSON.stringify({
          name: input.name,
          role: input.role,
          title: input.title,
          adapterType: input.adapterType || 'nova_agent',
          capabilities: input.capabilities,
          runtimeConfig: {
            heartbeat: {
              enabled: true,
              intervalSec: 7200,
              wakeOnDemand: true,
              maxConcurrentRuns: 1,
            },
          },
        });
        break;
      default:
        return { ok: false, body: { error: `Unknown tool: ${name}` } };
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        ...(body ? { body } : {}),
      });
      const text = await res.text();
      try {
        return { ok: res.ok, body: JSON.parse(text) };
      } catch {
        return { ok: res.ok, body: text };
      }
    } catch (err) {
      return { ok: false, body: { error: String(err) } };
    }
  }

  return { tools: tools as any, execute };
}
