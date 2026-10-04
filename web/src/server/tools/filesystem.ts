import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type Tool, type ToolOutput, failed, succeeded } from './types';

/**
 * Filesystem tools, bounded by an allowlist of roots.
 *
 * The allowlist is checked after canonicalisation, not before. A check on the
 * string the model produced is a check on a guess: `data/../../etc/passwd`
 * contains no forbidden substring and reaches the whole disk. So the path is
 * resolved, followed through symlinks, and only then compared — and compared
 * twice, because a symlink inside the allowlist can point outside it.
 */

export interface FsLimits {
  /** Hard ceiling on a single read or write. */
  maxBytes: number;
}

export interface FilesystemToolDeps {
  roots: string[];
  limits: FsLimits;
  now?: () => Date;
}

/** `true` when `target` is `root` itself or lives under it. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  // A relative path that starts with `..` escaped. Checking the first segment
  // rather than `startsWith('..')` alone, because `..foo` is a legitimate name
  // and not an escape.
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Resolve a model-supplied path to a canonical absolute path inside the
 * allowlist, or explain why it is not.
 */
export async function resolveInsideRoots(
  rawPath: string,
  roots: string[],
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  if (rawPath.includes('\0')) {
    return { ok: false, reason: 'path contains a null byte' };
  }
  if (rawPath.trim() === '') {
    return { ok: false, reason: 'path is empty' };
  }

  const canonicalRoots: string[] = [];
  for (const root of roots) {
    try {
      // Follow the root's own symlinks once, so the comparison below is against
      // the real directory rather than a link that could itself be repointed.
      canonicalRoots.push(await realpath(root));
    } catch {
      return { ok: false, reason: `allowlisted root does not exist: ${root}` };
    }
  }

  // The path is interpreted relative to the first root. A model that sends
  // `data/x` means the file under the workspace, not one relative to whatever
  // the process cwd happens to be.
  const base = canonicalRoots[0]!;
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(base, rawPath);

  if (!canonicalRoots.some((r) => isInside(r, absolute))) {
    return { ok: false, reason: 'path is outside every allowlisted root' };
  }

  // Second pass, after resolving symlinks. A link inside the allowlist pointing
  // out of it passes the string check above and fails here.
  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch {
    // Does not exist yet. That is legitimate for a write, and the parent has
    // already been confirmed inside the allowlist.
    const parent = resolve(absolute, '..');
    try {
      const realParent = await realpath(parent);
      if (!canonicalRoots.some((r) => isInside(r, realParent))) {
        return { ok: false, reason: 'parent directory is outside every allowlisted root' };
      }
      canonical = join(realParent, absolute.slice(parent.length + 1));
    } catch {
      return { ok: false, reason: 'parent directory does not exist' };
    }
  }

  if (!canonicalRoots.some((r) => isInside(r, canonical))) {
    return { ok: false, reason: 'path resolves outside every allowlisted root' };
  }

  return { ok: true, path: canonical };
}

/**
 * Reduce an absolute path to the form the policy rules are written in.
 *
 * The rules say `fs.read:data/**`. If the permission carried the resolved
 * absolute path, that rule would match on exactly one machine and nowhere else,
 * and every policy file would have to be rewritten per checkout. So the resource
 * is always root-relative, and the absolute path never reaches the policy.
 */
export function toPolicyResource(roots: string[], absolute: string): string {
  const normalized = absolute.replace(/\\/g, '/');
  for (const root of roots) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized === r) return '.';
    if (normalized.startsWith(`${r}/`)) return normalized.slice(r.length + 1);
  }
  // Outside every root. Kept as the full path rather than dropped, so the audit
  // log shows what was actually asked for.
  return normalized;
}

/** Absolute interpretation of a model-supplied path, without touching the disk. */
function resolveInRoot(roots: string[], rawPath: string): string {
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(roots[0]!, rawPath);
}

export interface WriteArgs {
  path: string;
  /** Root-relative, and what the policy judges. */
  resource: string;
  content: string;
  /**
   * Overwriting something that already exists is the destructive case, so it is
   * the one the policy can gate. The runner reads this flag; the tool does not
   * decide.
   */
  overwrite: boolean;
}

export interface ReadArgs {
  path: string;
  /** Root-relative, and what the policy judges. */
  resource: string;
}

export function createReadTool(deps: FilesystemToolDeps): Tool<ReadArgs, string> {
  return {
    name: 'filesystem.read',
    description: 'Read a UTF-8 file from an allowlisted directory.',
    permission: (args) => ({ kind: 'fs.read', resource: args.resource }),
    validate: (args): ReadArgs => {
      if (typeof args !== 'object' || args === null) {
        throw new Error('filesystem.read expects an object');
      }
      const { path } = args as Record<string, unknown>;
      if (typeof path !== 'string') throw new Error('filesystem.read needs a string `path`');
      return { path, resource: toPolicyResource(deps.roots, resolveInRoot(deps.roots, path)) };
    },
    execute: async (args): Promise<ToolOutput<string>> => {
      const resolved = await resolveInsideRoots(args.path, deps.roots);
      if (!resolved.ok) return failed(resolved.reason);

      let info;
      try {
        info = await stat(resolved.path);
      } catch {
        return failed(`no such file: ${args.path}`);
      }

      if (!info.isFile()) return failed(`not a regular file: ${args.path}`);
      if (info.size > deps.limits.maxBytes) {
        // Refuse rather than truncate. A silent partial read looks like a
        // complete answer to whatever comes next.
        return failed(
          `file is ${info.size} bytes, limit is ${deps.limits.maxBytes}`,
        );
      }

      try {
        const content = await readFile(resolved.path, 'utf8');
        return succeeded(content, { size: content.length, contentType: 'text/plain' });
      } catch (error) {
        return failed(`read failed: ${(error as Error).message}`);
      }
    },
  };
}

export function createWriteTool(deps: FilesystemToolDeps): Tool<WriteArgs, { bytes: number }> {
  return {
    name: 'filesystem.write',
    description: 'Write a UTF-8 file into an allowlisted directory.',
    /**
     * The permission carries whether the file already exists, so a policy can
     * write `fs.write:data/**` for new files and gate the overwrite case with a
     * different rule. Both are decided by the policy, not by this tool.
     */
    permission: (args) => ({ kind: 'fs.write', resource: args.resource }),
    validate: (args): WriteArgs => {
      if (typeof args !== 'object' || args === null) {
        throw new Error('filesystem.write expects an object');
      }
      const { path, content, overwrite } = args as Record<string, unknown>;
      if (typeof path !== 'string') throw new Error('filesystem.write needs a string `path`');
      if (typeof content !== 'string') {
        throw new Error('filesystem.write needs a string `content`');
      }
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > deps.limits.maxBytes) {
        throw new Error(`content is ${bytes} bytes, limit is ${deps.limits.maxBytes}`);
      }
      return {
        path,
        resource: toPolicyResource(deps.roots, resolveInRoot(deps.roots, path)),
        content,
        overwrite: overwrite === true,
      };
    },
    execute: async (args): Promise<ToolOutput<{ bytes: number }>> => {
      const resolved = await resolveInsideRoots(args.path, deps.roots);
      if (!resolved.ok) return failed(resolved.reason);

      let exists = false;
      try {
        await stat(resolved.path);
        exists = true;
      } catch {
        exists = false;
      }

      if (exists && !args.overwrite) {
        // Not a refusal — the tool does not get to make that call. Reported so
        // the model can retry with the flag set, which the policy then sees.
        return failed(`file already exists: ${args.path} (set overwrite to replace it)`);
      }

      try {
        await mkdir(resolve(resolved.path, '..'), { recursive: true });
        const bytes = Buffer.byteLength(args.content, 'utf8');
        await writeFile(resolved.path, args.content, 'utf8');
        return succeeded({ bytes }, { size: bytes, contentType: 'text/plain' });
      } catch (error) {
        return failed(`write failed: ${(error as Error).message}`);
      }
    },
  };
}