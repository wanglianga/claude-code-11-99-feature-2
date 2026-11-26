import {
  ITEM_STATUS_LABEL,
  PACK_KIND_LABEL,
  ROLE_LABEL,
  checkInvariants,
  counterStats,
} from '../engine/engine';
import { fmtDateTime } from '../engine/format';
import type { BeddingState, Command, Receipt, Role } from '../engine/types';

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** 不带 commandId 的命令（由 App 统一补 commandId） */
export type AnyCmd = DistributiveOmit<Command, 'commandId'>;

/** 页面通用属性：exec 接受新命令（自动补 commandId）或完整命令（相同 commandId 重发→幂等重复回执） */
export interface PageProps {
  state: BeddingState;
  role: Role;
  exec: (cmd: AnyCmd | Command) => Promise<boolean>;
}

export function Badge({ text, tone = 'gray' }: { text: string; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{text}</span>;
}

export const STATUS_TONE: Record<string, string> = {
  available: 'green',
  in_pack: 'blue',
  delivered: 'purple',
  cleaning: 'orange',
  damaged: 'red',
};

export function StatusBadge({ status }: { status: keyof typeof ITEM_STATUS_LABEL }) {
  return <Badge text={ITEM_STATUS_LABEL[status]} tone={STATUS_TONE[status]} />;
}

// ---------------------------------------------------------------------------
// 库存统计条（叶件口径）
// ---------------------------------------------------------------------------

export function StatsBar({ state }: { state: BeddingState }) {
  const s = counterStats(state);
  const cell = (label: string, value: string, tone?: string) => (
    <div className={`stat-cell ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
  const pair = (m: number, b: number) => `垫${m} 毯${b}`;
  return (
    <div className="stats-bar">
      {cell('总叶件（包壳不计）', `垫${s.totalMats} 毯${s.totalBlankets}`)}
      {cell('库房可用', `散 ${pair(s.warehouse.looseMats, s.warehouse.looseBlankets)}｜包内 ${pair(s.warehouse.inPackMats, s.warehouse.inPackBlankets)}`)}
      {cell('领取柜可用', `散 ${pair(s.counter.looseMats, s.counter.looseBlankets)}｜包内 ${pair(s.counter.inPackMats, s.counter.inPackBlankets)}`)}
      {cell('已交付', pair(s.byStatus.delivered.mats, s.byStatus.delivered.blankets), 'purple')}
      {cell('待清洁', pair(s.byStatus.cleaning.mats, s.byStatus.cleaning.blankets), 'orange')}
      {cell('报损', pair(s.byStatus.damaged.mats, s.byStatus.damaged.blankets), 'red')}
      {cell('需求覆盖（按人）', `${s.needsCovered}/${s.needsTotal} 人`, 'green')}
      {cell('凭证核销（人份）', `${s.portionsConsumed}/${s.portionsTotal}`, 'blue')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 回执流
// ---------------------------------------------------------------------------

const RECEIPT_KIND_LABEL: Record<string, string> = {
  seed: '初始化',
  reset: '重置',
  family_registered: '登记',
  family_split: '拆分',
  pack_sealed: '封包',
  pack_opened: '开封',
  child_detached: '取件',
  moved_counter: '移动',
  moved_warehouse: '移动',
  delivered: '交付',
  return_received: '退回',
  reclaim_applied: '补领',
  cleaning_done: '清洁',
  duplicate_submission: '重复回执',
  clock_advanced: '时钟',
};

export function ReceiptsPanel({ receipts }: { receipts: Receipt[] }) {
  const sorted = [...receipts].sort((a, b) => b.seq - a.seq).slice(0, 100);
  return (
    <div className="card receipts">
      <div className="panel-title">操作回执（{receipts.length}）</div>
      {sorted.map((r) => (
        <div key={r.id} className={`receipt ${r.duplicateOf ? 'receipt-dup' : ''}`}>
          <div className="receipt-head">
            <span className="receipt-seq">#{r.seq}</span>
            <span className="muted">{fmtDateTime(r.at)}</span>
            <Badge text={RECEIPT_KIND_LABEL[r.kind] ?? r.kind} tone="gray" />
            <span className="muted">{r.actor}</span>
            {r.duplicateOf && <Badge text={`重复·原${r.duplicateOf}`} tone="blue" />}
          </div>
          <div>{r.summary}</div>
          {r.lines.map((l, i) => (
            <div key={i} className="muted receipt-line">
              {l}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 全柜核对（不变量）
// ---------------------------------------------------------------------------

export function InvariantsPanel({ state }: { state: BeddingState }) {
  const results = checkInvariants(state);
  return (
    <div className="card">
      <div className="panel-title">全柜核对（包含树 / 叶件计数 / 需求覆盖 / 交付与补领）</div>
      {results.map((r) => (
        <div key={r.name} className={`invariant ${r.ok ? 'inv-ok' : 'inv-bad'}`}>
          <span>{r.ok ? '✓' : '✗'}</span>
          <span>
            <b>{r.name}</b>　<span className="muted">{r.detail}</span>
          </span>
        </div>
      ))}
      <div className="muted">
        口径说明：需求覆盖按人算（一人一垫一毯）；物资数量按叶件算（包壳不计寝具）；两个计数都可追到实物与操作者（回执含操作者与物资编号）。
      </div>
    </div>
  );
}

export function packKindLabel(kind: keyof typeof PACK_KIND_LABEL | undefined): string {
  return kind ? PACK_KIND_LABEL[kind] : '包';
}

export { ROLE_LABEL };
