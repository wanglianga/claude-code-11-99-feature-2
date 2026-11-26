import { useEffect, useMemo, useState } from 'react';
import { activePromiseOf } from '../engine/engine';
import { fmtDateTime } from '../engine/format';
import type { Command, ProtectionStrategy, Role, ShelterState } from '../engine/types';
import { WorkerClient } from './client';
import {
  DraftPanel,
  FamilyList,
  InvariantsPanel,
  LeavePanel,
  NewFamilyForm,
  PendingPlacementPanel,
  ReceiptsPanel,
  ROLE_LABEL,
  RoomCard,
  TasksPanel,
} from './components';

const ROLES: Role[] = ['receptionist', 'duty', 'bed_manager'];

export default function App() {
  const [client] = useState(() => new WorkerClient());
  const [state, setState] = useState<ShelterState | null>(null);
  const [role, setRole] = useState<Role>(() => {
    const saved = localStorage.getItem('shelter-role');
    return saved === 'duty' || saved === 'bed_manager' ? saved : 'receptionist';
  });
  const [error, setError] = useState<string | null>(null);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [leaveFor, setLeaveFor] = useState<string | null>(null);
  /** 每个家庭最近一次暂离命令（用于演示“重复暂离回执”的幂等） */
  const [lastLeaveCmd, setLastLeaveCmd] = useState<Record<string, Command>>({});
  const [tabId] = useState(() => Math.random().toString(36).slice(2, 6).toUpperCase());

  useEffect(() => {
    client.onState(setState);
    void client.refreshState();
  }, [client]);

  const run = async (cmd: Command): Promise<boolean> => {
    const r = await client.cmd(cmd, role);
    if (!r.ok && r.error) setError(r.error);
    else setError(null);
    await client.refreshState();
    return r.ok;
  };

  const newCmd = <T extends Omit<Command, 'commandId'>>(cmd: T): Command => ({
    ...cmd,
    commandId: crypto.randomUUID(),
  }) as Command;

  const handlers = useMemo(
    () => ({
      onStartDraft: (familyId: string) => {
        setLeaveFor(null);
        setDraftFor(familyId);
      },
      onCancelDraft: (assignmentId: string) => void run(newCmd({ type: 'CancelDraft', assignmentId })),
      onSubmitCheckIn: (assignmentId: string) => void run(newCmd({ type: 'SubmitCheckIn', assignmentId })),
      onStartLeave: (familyId: string) => {
        setDraftFor(null);
        setLeaveFor(familyId);
      },
      onReturn: (familyId: string) => void run(newCmd({ type: 'ConfirmReturn', familyId })),
      onExtend: (familyId: string) => {
        if (!state) return;
        const p = activePromiseOf(state, familyId);
        if (!p) return;
        const base = Math.max(p.expectedReturnAt, state.virtualNow);
        void run(newCmd({ type: 'ExtendPromise', familyId, newExpectedReturnAt: base + 3600_000 }));
      },
      onCheckout: (familyId: string) => void run(newCmd({ type: 'SubmitCheckout', familyId })),
      onRetryStale: (familyId: string, roomId: string) => void run(newCmd({ type: 'CreateDraft', familyId, roomId })),
      onDuplicateLeave: (familyId: string) => {
        const cmd = lastLeaveCmd[familyId];
        if (cmd) void run(cmd); // 相同 commandId 重发 → 幂等重复回执
      },
      canDuplicateLeave: (familyId: string) => !!lastLeaveCmd[familyId],
    }),
    [state, role, lastLeaveCmd],
  );

  if (!state) return <div className="loading">正在加载本地数据…</div>;

  const draftFamily = draftFor ? state.families.find((f) => f.id === draftFor) : null;
  const leaveFamily = leaveFor ? state.families.find((f) => f.id === leaveFor) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">避难所入住与返所工作台</div>
        <label className="role-select">
          当前角色：
          <select
            value={role}
            onChange={(e) => {
              const r = e.target.value as Role;
              setRole(r);
              localStorage.setItem('shelter-role', r);
            }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <span className="clock">演示时间：{fmtDateTime(state.virtualNow)}</span>
        <button onClick={() => void run(newCmd({ type: 'AdvanceClock', toVirtual: state.virtualNow + 15 * 60_000 }))}>
          +15分钟
        </button>
        <button onClick={() => void run(newCmd({ type: 'AdvanceClock', toVirtual: state.virtualNow + 3600_000 }))}>
          +1小时
        </button>
        <button
          className="ghost"
          onClick={() => {
            if (window.confirm('重置为初始演示场景？')) void run(newCmd({ type: 'ResetDemo' }));
          }}
        >
          重置演示数据
        </button>
        <span className="tab-badge" title="同一站点多标签页共享 IndexedDB 存储，操作实时同步">
          标签页 #{tabId} · 多标签已同步
        </span>
      </header>

      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          ✗ {error}（点击关闭）
        </div>
      )}

      <div className="layout">
        <section className="col">
          <h2>房间看板</h2>
          {state.rooms.map((room) => (
            <RoomCard
              key={room.id}
              state={state}
              room={room}
              role={role}
              onCloseRoom={(roomId) => {
                const reason = window.prompt('关闭原因', '消杀临时关闭');
                if (reason !== null) void run(newCmd({ type: 'CloseRoom', roomId, reason: reason || '临时关闭' }));
              }}
              onReopenRoom={(roomId) => void run(newCmd({ type: 'ReopenRoom', roomId }))}
            />
          ))}
          <NewFamilyForm
            role={role}
            onSubmit={(input) => void run(newCmd({ type: 'RegisterFamily', input }))}
          />
        </section>

        <section className="col">
          <h2>家庭与操作</h2>
          {draftFamily && (
            <DraftPanel
              state={state}
              family={draftFamily}
              onCancel={() => setDraftFor(null)}
              onSubmit={(roomId) => {
                void run(newCmd({ type: 'CreateDraft', familyId: draftFamily.id, roomId })).then((ok) => {
                  if (ok) setDraftFor(null);
                });
              }}
            />
          )}
          {leaveFamily && (
            <LeavePanel
              state={state}
              family={leaveFamily}
              onCancel={() => setLeaveFor(null)}
              onSubmit={(strategy: ProtectionStrategy, protectionRoomId: string | undefined, hours: number) => {
                const cmd = newCmd({
                  type: 'RegisterLeave',
                  familyId: leaveFamily.id,
                  strategy,
                  protectionRoomId,
                  expectedReturnAt: state.virtualNow + hours * 3600_000,
                });
                void run(cmd).then((ok) => {
                  if (ok) {
                    setLastLeaveCmd((m) => ({ ...m, [leaveFamily.id]: cmd }));
                    setLeaveFor(null);
                  }
                });
              }}
            />
          )}
          <FamilyList state={state} role={role} h={handlers} />
        </section>

        <section className="col">
          <PendingPlacementPanel state={state} />
          <TasksPanel
            state={state}
            role={role}
            onExtend={handlers.onExtend}
            onCheckout={handlers.onCheckout}
            onNote={(taskId, note) => void run(newCmd({ type: 'AddTaskNote', taskId, note }))}
          />
          <InvariantsPanel state={state} />
          <ReceiptsPanel receipts={state.receipts} />
        </section>
      </div>
    </div>
  );
}
