import { useEffect, useState } from 'react';
import { fmtDateTime } from '../engine/format';
import type { BeddingState, Command, Role } from '../engine/types';
import { WorkerClient } from './client';
import { AnyCmd, InvariantsPanel, ROLE_LABEL, ReceiptsPanel, StatsBar } from './components';
import { DeliverPage, NeedsPage, PackPage, ReturnsPage, TrackingPage } from './pages';

const ROLES: Role[] = ['keeper', 'counter', 'auditor'];

type TabKey = 'pack' | 'needs' | 'deliver' | 'returns' | 'tracking';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'pack', label: '封拆包装' },
  { key: 'needs', label: '人员需求' },
  { key: 'deliver', label: '领取交付' },
  { key: 'returns', label: '退回与补领' },
  { key: 'tracking', label: '逐件追踪' },
];

const DEFAULT_TAB: Record<Role, TabKey> = {
  keeper: 'pack',
  counter: 'needs',
  auditor: 'tracking',
};

export default function App() {
  const [client] = useState(() => new WorkerClient());
  const [state, setState] = useState<BeddingState | null>(null);
  const [role, setRole] = useState<Role>(() => {
    const saved = localStorage.getItem('bedding-role');
    return saved === 'counter' || saved === 'auditor' ? saved : 'keeper';
  });
  const [tab, setTab] = useState<TabKey>(() => DEFAULT_TAB[role]);
  const [error, setError] = useState<string | null>(null);
  const [tabId] = useState(() => Math.random().toString(36).slice(2, 6).toUpperCase());

  useEffect(() => {
    client.onState(setState);
    void client.refreshState();
  }, [client]);

  const exec = async (cmd: AnyCmd | Command): Promise<boolean> => {
    const full: Command = ('commandId' in cmd ? cmd : { ...cmd, commandId: crypto.randomUUID() }) as Command;
    const r = await client.cmd(full, role);
    if (!r.ok && r.error) setError(r.error);
    else setError(null);
    await client.refreshState();
    return r.ok;
  };

  if (!state) return <div className="loading">正在加载本地数据…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">夜间寝具柜台</div>
        <label className="role-select">
          当前角色：
          <select
            value={role}
            onChange={(e) => {
              const r = e.target.value as Role;
              setRole(r);
              localStorage.setItem('bedding-role', r);
              setTab(DEFAULT_TAB[r]);
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
        <button onClick={() => void exec({ type: 'AdvanceClock', toVirtual: state.virtualNow + 30 * 60_000 })}>
          +30分钟
        </button>
        <button onClick={() => void exec({ type: 'AdvanceClock', toVirtual: state.virtualNow + 3600_000 })}>
          +1小时
        </button>
        <button
          className="ghost"
          onClick={() => {
            if (window.confirm('重置为初始演示场景？')) void exec({ type: 'ResetDemo' });
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

      <StatsBar state={state} />

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'tab-active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="layout">
        <main className="main-col">
          {tab === 'pack' && <PackPage state={state} role={role} exec={exec} />}
          {tab === 'needs' && <NeedsPage state={state} role={role} exec={exec} />}
          {tab === 'deliver' && <DeliverPage state={state} role={role} exec={exec} />}
          {tab === 'returns' && <ReturnsPage state={state} role={role} exec={exec} />}
          {tab === 'tracking' && <TrackingPage state={state} role={role} exec={exec} />}
        </main>
        <aside className="side-col">
          <InvariantsPanel state={state} />
          <ReceiptsPanel receipts={state.receipts} />
        </aside>
      </div>
    </div>
  );
}
