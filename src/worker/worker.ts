import { applyCommand } from '../engine/engine';
import type { CmdOutcome, Command, Role } from '../engine/types';
import { readState, transact } from './store';

/**
 * WebWorker：所有写操作都经过「IndexedDB 事务 + 领域引擎」管线，
 * 计算与持久化均在本地完成，不依赖任何后端。
 *
 * 并发口径：同一站点多标签页的命令在 IndexedDB readwrite 事务上串行，
 * 后到命令在新事务内基于最新状态重新校验——例如一个标签整包交付某四人包后，
 * 另一个标签对同包的开封/取件会在事务重核中得到明确冲突结果
 * （包已交付不能开封；包已开封不能整包交付）。
 */

interface WorkerScope {
  postMessage: (msg: unknown) => void;
  onmessage: ((e: MessageEvent) => void) | null;
}
const ctx = self as unknown as WorkerScope;

const bc = new BroadcastChannel('bedding-counter');

interface CmdResultView {
  ok: boolean;
  error?: string;
  receipts: CmdOutcome['receipts'];
  changed: boolean;
}

async function runInTx(cmd: Command, role: Role): Promise<CmdOutcome> {
  const realNow = Date.now();
  return transact((s) => {
    const r = applyCommand(s, cmd, { role, realNow });
    return r.changed ? { state: r.state, out: r } : { out: r };
  });
}

async function handleCmd(cmd: Command, role: Role): Promise<CmdResultView> {
  const out = await runInTx(cmd, role);
  if (out.changed) bc.postMessage({ type: 'invalidate', version: out.state.version });
  return { ok: !out.error, error: out.error, receipts: out.receipts, changed: out.changed };
}

ctx.onmessage = async (e: MessageEvent) => {
  const data = e.data as { reqId: number; kind: string; cmd?: Command; role?: Role };
  const { reqId, kind } = data;
  try {
    if (kind === 'cmd') {
      const result = await handleCmd(data.cmd as Command, data.role as Role);
      ctx.postMessage({ reqId, result });
    } else if (kind === 'getState') {
      const state = await readState();
      ctx.postMessage({ reqId, state });
    } else {
      ctx.postMessage({ reqId, result: { ok: false, error: `未知请求: ${kind}`, receipts: [], changed: false } });
    }
  } catch (err) {
    ctx.postMessage({
      reqId,
      result: { ok: false, error: err instanceof Error ? err.message : String(err), receipts: [], changed: false },
    });
  }
};
