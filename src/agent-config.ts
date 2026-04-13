import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { RAILWAY_VOLUME } from './config.js';

const AGENTS_DIR = join(RAILWAY_VOLUME || '/data', 'agents');

export function agentDir(agentId: string): string {
  return join(AGENTS_DIR, agentId);
}

export async function ensureAgentDir(
  agentId: string,
  meta: { name: string; role: string; title: string; capabilities?: string },
): Promise<string> {
  const dir = agentDir(agentId);
  await mkdir(join(dir, 'workspace'), { recursive: true });
  await mkdir(join(dir, 'history'), { recursive: true });

  const claudeMdPath = join(dir, 'CLAUDE.md');
  try {
    await stat(claudeMdPath);
  } catch {
    const content = `# ${meta.name} — ${meta.title}, Nova Corps\n\n## Identity\nYou are ${meta.name}, ${meta.title} at Nova Corps.\n${meta.capabilities ? `\n## Focus\n${meta.capabilities}\n` : ''}\n## Memory\n(Updated as you learn things. Edit this file to remember context.)\n`;
    await writeFile(claudeMdPath, content, 'utf-8');
  }
  return dir;
}

export async function readClaudeMd(agentId: string): Promise<string> {
  try {
    return await readFile(join(agentDir(agentId), 'CLAUDE.md'), 'utf-8');
  } catch {
    return '';
  }
}

export async function listAgentFiles(
  agentId: string,
): Promise<Array<{ path: string; size: number }>> {
  const dir = join(agentDir(agentId), 'workspace');
  try {
    const entries = await readdir(dir, { recursive: true });
    const files: Array<{ path: string; size: number }> = [];
    for (const entry of entries) {
      const s = await stat(join(dir, String(entry)));
      if (s.isFile()) files.push({ path: String(entry), size: s.size });
    }
    return files;
  } catch {
    return [];
  }
}

export async function readAgentFile(
  agentId: string,
  filePath: string,
): Promise<string | null> {
  if (filePath.includes('..')) return null;
  try {
    return await readFile(join(agentDir(agentId), 'workspace', filePath), 'utf-8');
  } catch {
    return null;
  }
}
