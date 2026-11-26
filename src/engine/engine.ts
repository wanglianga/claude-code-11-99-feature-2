import { fmtDateTime } from './format';
import { seedState } from './seed';
import type {
  BeddingState,
  CmdCtx,
  CmdOutcome,
  Command,
  Delivery,
  Family,
  ItemNode,
  Need,
  PackKind,
  PendingReturn,
  Receipt,
  Reclaim,
  Role,
  Voucher,
} from './types';

export const ROLE_LABEL: Record<Role, string> = {
  keeper: '仓管员',
  counter: '柜台职员',
  auditor: '稽核员',
};

export const PACK_KIND_LABEL: Record<PackKind, string> = {
  one_set: '一人套包',
  four_pack: '四人包',
  repack: '重封包',
};

export const PACK_PREFIX: Record<PackKind, string> = {
  one_set: 'SET',
  four_pack: 'PK4',
  repack: 'RPK',
};

export const ITEM_KIND_LABEL: Record<ItemNode['kind'], string> = {
  mat: '垫子',
  blanket: '毯子',
  pack: '包',
};

const PERMS: Record<Command['type'], Role[] | 'any'> = {
  RegisterFamily: ['counter'],
  SplitFamily: ['counter'],
  SealPack: ['keeper'],
  OpenPack: ['keeper'],
  DetachChild: ['keeper'],
  MoveStock: ['keeper'],
  Deliver: ['counter'],
  ReceiveReturn: ['counter'],
  Reclaim: ['counter'],
  CompleteCleaning: ['keeper'],
  AdvanceClock: 'any',
  ResetDemo: 'any',
};

// ---------------------------------------------------------------------------
// 派生计算（纯函数，UI 与引擎共用同一口径）
// ---------------------------------------------------------------------------

export function nodeById(state: BeddingState, id: string): ItemNode {
  const n = state.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`物资节点不存在: ${id}`);
  return n;
}

export function isLeaf(n: ItemNode): boolean {
  return n.kind !== 'pack';
}

export function childrenOf(state: BeddingState, id: string): ItemNode[] {
  return state.nodes.filter((n) => n.parentId === id);
}

/** 沿父链解析到根（核查单件时解析祖先；带成环保护） */
export function rootOf(state: BeddingState, id: string): ItemNode {
  let cur = nodeById(state, id);
  const seen = new Set<string>([cur.id]);
  while (cur.parentId) {
    cur = nodeById(state, cur.parentId);
    if (seen.has(cur.id)) throw new Error(`包含关系成环: ${cur.label}`);
    seen.add(cur.id);
  }
  return cur;
}

/** 祖先链（含自身，根在前） */
export function packPathOf(state: BeddingState, id: string): ItemNode[] {
  const path: ItemNode[] = [];
  let cur = nodeById(state, id);
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur.id)) throw new Error(`包含关系成环: ${cur.label}`);
    seen.add(cur.id);
    path.unshift(cur);
    if (!cur.parentId) break;
    cur = nodeById(state, cur.parentId);
  }
  return path;
}

/** 子树全部叶件（包壳不计寝具：只数垫/毯） */
export function leavesOf(state: BeddingState, id: string): ItemNode[] {
  const out: ItemNode[] = [];
  const walk = (nid: string) => {
    const n = nodeById(state, nid);
    if (isLeaf(n)) {
      out.push(n);
      return;
    }
    for (const c of childrenOf(state, nid)) walk(c.id);
  };
  walk(id);
  return out;
}

export interface LeafStats {
  mats: number;
  blankets: number;
  leaves: number;
  /** 人份 = 可组成的完整一垫一毯对数 */
  portions: number;
}

export function leafStats(state: BeddingState, id: string): LeafStats {
  const leaves = leavesOf(state, id);
  const mats = leaves.filter((l) => l.kind === 'mat').length;
  const blankets = leaves.filter((l) => l.kind === 'blanket').length;
  return { mats, blankets, leaves: leaves.length, portions: Math.min(mats, blankets) };
}

/** 库存五态：可用 / 包内 / 已交付 / 待清洁 / 报损（由根位置与父包派生） */
export type ItemStatus = 'available' | 'in_pack' | 'delivered' | 'cleaning' | 'damaged';

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  available: '可用',
  in_pack: '包内',
  delivered: '已交付',
  cleaning: '待清洁',
  damaged: '报损',
};

export function effectiveStatus(state: BeddingState, node: ItemNode | string): ItemStatus {
  const n = typeof node === 'string' ? nodeById(state, node) : node;
  const root = rootOf(state, n.id);
  const h = root.holder;
  if (!h) throw new Error(`根节点缺少位置: ${root.label}`);
  if (h.type === 'delivered') return 'delivered';
  if (h.type === 'cleaning') return 'cleaning';
  if (h.type === 'damaged') return 'damaged';
  return n.parentId ? 'in_pack' : 'available';
}

export type LocationKey = 'warehouse' | 'counter' | 'delivered' | 'cleaning' | 'damaged';

export function locationOf(state: BeddingState, node: ItemNode): LocationKey {
  return rootOf(state, node.id).holder!.type;
}

export function locationLabel(state: BeddingState, node: ItemNode): string {
  const root = rootOf(state, node.id);
  const h = root.holder!;
  switch (h.type) {
    case 'warehouse':
      return '库房';
    case 'counter':
      return '领取柜';
    case 'cleaning':
      return '待清洁区';
    case 'damaged':
      return '报损区';
    case 'delivered': {
      const d = state.deliveries.find((x) => x.id === h.deliveryId);
      const fam = d ? state.families.find((f) => f.id === d.familyId) : undefined;
      return `已交付·${fam?.name ?? '?'}`;
    }
  }
}

export function familyById(state: BeddingState, id: string): Family {
  const f = state.families.find((x) => x.id === id);
  if (!f) throw new Error(`家庭不存在: ${id}`);
  return f;
}

export function needsOf(state: BeddingState, familyId: string): Need[] {
  return state.needs
    .filter((n) => n.familyId === familyId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function fullyCovered(n: Need): boolean {
  return !!n.matItemId && !!n.blanketItemId;
}

export function voucherOf(state: BeddingState, familyId: string): Voucher | undefined {
  return state.vouchers.find((v) => v.familyId === familyId);
}

export function deliveryById(state: BeddingState, id: string): Delivery | undefined {
  return state.deliveries.find((d) => d.id === id);
}

/** 查原交付：物资当前根节点关联的交付单 */
export function originalDeliveryOfItem(state: BeddingState, itemId: string): Delivery | undefined {
  const root = rootOf(state, itemId);
  if (root.holder?.type === 'delivered') return deliveryById(state, root.holder.deliveryId);
  return undefined;
}

export function openPendingReturnsOf(state: BeddingState, familyId: string): PendingReturn[] {
  return state.pendingReturns.filter((p) => p.familyId === familyId && p.status === 'open');
}

export function openReclaimOf(
  state: BeddingState,
  needId: string,
  itemType: 'mat' | 'blanket',
): Reclaim | undefined {
  return state.reclaims.find(
    (r) => r.needId === needId && r.itemType === itemType && r.status === 'awaiting_old',
  );
}

/** 柜台可交付的根节点：在领取柜、可用、且为叶件或封签完好的包 */
export function deliverableRoots(state: BeddingState): ItemNode[] {
  return state.nodes.filter(
    (n) =>
      n.parentId === null &&
      n.holder?.type === 'counter' &&
      (isLeaf(n) || (n.kind === 'pack' && !!n.seal)),
  );
}

/** 可作为封包材料的节点：叶件或封签完好的包；在库房/领取柜（根，或已开封包内的直接子件） */
export function sealableNodes(state: BeddingState): ItemNode[] {
  return state.nodes.filter((n) => {
    if (!(isLeaf(n) || (n.kind === 'pack' && !!n.seal))) return false;
    if (n.parentId === null) return n.holder?.type === 'warehouse' || n.holder?.type === 'counter';
    const parent = state.nodes.find((p) => p.id === n.parentId);
    if (!parent || parent.seal) return false; // 已封包内须先开封
    const root = rootOf(state, n.id);
    return root.holder?.type === 'warehouse' || root.holder?.type === 'counter';
  });
}

// ---------------------------------------------------------------------------
// 交付预演（UI 预览与命令处理共用同一套核算）
// ---------------------------------------------------------------------------

export interface DeliverPlan {
  errors: string[];
  mats: ItemNode[];
  blankets: ItemNode[];
  lines: { need: Need; mat?: ItemNode; blanket?: ItemNode }[];
  newlyCovered: Need[];
  excessMats: ItemNode[];
  excessBlankets: ItemNode[];
}

export function planDelivery(state: BeddingState, familyId: string, nodeIds: string[]): DeliverPlan {
  const errors: string[] = [];
  const fam = state.families.find((f) => f.id === familyId);
  if (!fam) errors.push('家庭不存在');
  const ids = [...new Set(nodeIds)];
  if (ids.length === 0) errors.push('请选择要交付的物资');
  const nodes: ItemNode[] = [];
  for (const id of ids) {
    const n = state.nodes.find((x) => x.id === id);
    if (!n) {
      errors.push(`物资不存在: ${id}`);
      continue;
    }
    nodes.push(n);
    if (n.parentId !== null) {
      const parent = state.nodes.find((p) => p.id === n.parentId);
      errors.push(`物资 ${n.label} 在包 ${parent?.label ?? ''} 内，须先由仓管开封取出`);
      continue;
    }
    const h = n.holder;
    if (!h) {
      errors.push(`物资 ${n.label} 状态异常（根节点无位置）`);
      continue;
    }
    if (h.type === 'warehouse') errors.push(`物资 ${n.label} 仍在库房，请先送到领取柜`);
    else if (h.type === 'delivered') errors.push(`物资 ${n.label} 已交付（交付单 ${h.deliveryId}），不能重复交付`);
    else if (h.type === 'cleaning') errors.push(`物资 ${n.label} 在待清洁区，未完成清洁`);
    else if (h.type === 'damaged') errors.push(`物资 ${n.label} 已报损`);
    else if (n.kind === 'pack' && !n.seal)
      errors.push(`包 ${n.label} 已开封，包壳不能整包交付；请取出内容物或重新封包`);
  }
  const leaves = errors.length ? [] : ids.flatMap((id) => leavesOf(state, id));
  if (!errors.length && leaves.length === 0) errors.push('所选物资不含任何寝具叶件');
  const mats = leaves.filter((l) => l.kind === 'mat').sort((a, b) => a.label.localeCompare(b.label));
  const blankets = leaves
    .filter((l) => l.kind === 'blanket')
    .sort((a, b) => a.label.localeCompare(b.label));

  const lines: DeliverPlan['lines'] = [];
  const newlyCovered: Need[] = [];
  let mi = 0;
  let bi = 0;
  const open = fam ? needsOf(state, fam.id).filter((n) => !fullyCovered(n)) : [];
  for (const need of open) {
    const line: DeliverPlan['lines'][number] = { need };
    if (!need.matItemId && mi < mats.length) line.mat = mats[mi++];
    if (!need.blanketItemId && bi < blankets.length) line.blanket = blankets[bi++];
    if (line.mat || line.blanket) {
      lines.push(line);
      if ((need.matItemId || line.mat) && (need.blanketItemId || line.blanket)) newlyCovered.push(need);
    }
  }
  return {
    errors,
    mats,
    blankets,
    lines,
    newlyCovered,
    excessMats: mats.slice(mi),
    excessBlankets: blankets.slice(bi),
  };
}

// ---------------------------------------------------------------------------
// 全柜核对（不变量）
// ---------------------------------------------------------------------------

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function checkInvariants(state: BeddingState): InvariantResult[] {
  const results: InvariantResult[] = [];

  // 1. 包含树合法：单父、不成环、根⇔有位置、父必为包
  const treeBad: string[] = [];
  for (const n of state.nodes) {
    if (n.parentId === null && !n.holder) treeBad.push(`${n.label}:根节点无位置`);
    if (n.parentId !== null && n.holder) treeBad.push(`${n.label}:子件却持有位置`);
    if (n.parentId) {
      const p = state.nodes.find((x) => x.id === n.parentId);
      if (!p) treeBad.push(`${n.label}:父包不存在`);
      else if (p.kind !== 'pack') treeBad.push(`${n.label}:父节点${p.label}不是包`);
    }
    try {
      rootOf(state, n.id);
    } catch (e) {
      treeBad.push(`${n.label}:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  results.push({
    name: '包含树合法（单父·不成环·根持位置）',
    ok: treeBad.length === 0,
    detail: treeBad.join('；') || '每件物资至多一个当前父包，包含关系无环，位置只挂在根上',
  });

  // 2. 封签与组成：封签完好的包组成合规（一人套=1垫1毯；四人包=4个一人套）
  const sealBad: string[] = [];
  for (const p of state.nodes.filter((n) => n.kind === 'pack' && n.seal)) {
    const ch = childrenOf(state, p.id);
    if (p.packKind === 'one_set') {
      const mats = ch.filter((c) => c.kind === 'mat').length;
      const blankets = ch.filter((c) => c.kind === 'blanket').length;
      if (ch.length !== 2 || mats !== 1 || blankets !== 1)
        sealBad.push(`${p.label}:一人套应为1垫1毯，实际${ch.length}件`);
    } else if (p.packKind === 'four_pack') {
      if (ch.length !== 4 || ch.some((c) => c.packKind !== 'one_set'))
        sealBad.push(`${p.label}:四人包应为4个一人套`);
    } else if (ch.length === 0) sealBad.push(`${p.label}:重封包为空`);
  }
  results.push({
    name: '封签完好 ⇒ 组成合规',
    ok: sealBad.length === 0,
    detail: sealBad.join('；') || '一人套=1垫1毯、四人包=4个一人套；成套只覆盖其内部物资',
  });

  // 3. 叶件计数守恒：五态互斥且合计等于总叶件
  const leaves = state.nodes.filter(isLeaf);
  const cnt: Record<ItemStatus, number> = { available: 0, in_pack: 0, delivered: 0, cleaning: 0, damaged: 0 };
  for (const l of leaves) cnt[effectiveStatus(state, l)]++;
  const sum = cnt.available + cnt.in_pack + cnt.delivered + cnt.cleaning + cnt.damaged;
  results.push({
    name: '物资数量按叶件算（五态守恒）',
    ok: sum === leaves.length,
    detail: `总叶件${leaves.length}＝可用${cnt.available}＋包内${cnt.in_pack}＋已交付${cnt.delivered}＋待清洁${cnt.cleaning}＋报损${cnt.damaged}（包壳不计寝具）`,
  });

  // 4. 需求与凭证一致：凭证份数=需求人数；已核销=已覆盖人数
  const vBad: string[] = [];
  let needTotal = 0;
  let coveredTotal = 0;
  for (const f of state.families) {
    const needs = needsOf(state, f.id);
    const covered = needs.filter(fullyCovered).length;
    needTotal += needs.length;
    coveredTotal += covered;
    const v = voucherOf(state, f.id);
    if (!v) {
      vBad.push(`${f.name}:无领取凭证`);
      continue;
    }
    if (v.portions !== needs.length) vBad.push(`${f.name}:凭证${v.portions}份≠需求${needs.length}人`);
    if (v.consumed !== covered) vBad.push(`${f.name}:已核销${v.consumed}≠已覆盖${covered}人`);
    if (v.consumed > v.portions) vBad.push(`${f.name}:核销超过份数`);
  }
  results.push({
    name: '需求覆盖按人算（凭证一致）',
    ok: vBad.length === 0,
    detail: vBad.join('；') || `总需求${needTotal}人，已覆盖${coveredTotal}人；各家庭凭证份数=人数、已核销=已覆盖`,
  });

  // 5. 交付归属：已交付叶件的根都挂有效交付单；交付单引用的物资存在
  const dBad: string[] = [];
  for (const l of leaves) {
    if (effectiveStatus(state, l) !== 'delivered') continue;
    const root = rootOf(state, l.id);
    const h = root.holder as Extract<NonNullable<ItemNode['holder']>, { type: 'delivered' }>;
    const d = deliveryById(state, h.deliveryId);
    if (!d) dBad.push(`${l.label}:交付单${h.deliveryId}不存在`);
    else if (!d.leafItemIds.includes(l.id)) dBad.push(`${l.label}:不在交付单${d.id}的物资清单内`);
  }
  for (const d of state.deliveries) {
    for (const id of d.leafItemIds) if (!state.nodes.some((n) => n.id === id)) dBad.push(`交付单${d.id}:物资不存在`);
  }
  results.push({
    name: '已交付可查到原交付单',
    ok: dBad.length === 0,
    detail: dBad.join('；') || '每件已交付物资都能解析到唯一交付单（响应丢失查原交付，不再领一次）',
  });

  // 6. 待返还与补领：旧物待退回标记一致；同一需求同一品类无重复在办补领
  const rBad: string[] = [];
  for (const p of state.pendingReturns) {
    if (p.matsReturned > p.matsOwed || p.blanketsReturned > p.blanketsOwed)
      rBad.push(`${p.id}:退回数超过应返数`);
    if (p.status === 'closed' && (p.matsReturned !== p.matsOwed || p.blanketsReturned !== p.blanketsOwed))
      rBad.push(`${p.id}:已清讫但数目不符`);
  }
  const openKey = new Set<string>();
  for (const r of state.reclaims) {
    if (r.status !== 'awaiting_old') continue;
    const key = `${r.needId}:${r.itemType}`;
    if (openKey.has(key)) rBad.push(`需求${r.needId}存在重复在办补领`);
    openKey.add(key);
    const old = state.nodes.find((n) => n.id === r.oldItemId);
    if (!old?.awaitingReturn) rBad.push(`补领${r.id}:旧件未标记待退回`);
    if (old && effectiveStatus(state, old) !== 'delivered')
      rBad.push(`补领${r.id}:旧件未实际退回却已离开已交付态（申请≠已回）`);
  }
  results.push({
    name: '待返还 / 补领旧物核对',
    ok: rBad.length === 0,
    detail:
      rBad.join('；') ||
      '待返还数目与实收一致；在办补领的旧件均标记待退回且仍未离开已交付态（未实际退回不入清洁/报损）',
  });

  return results;
}

/** 库存统计（叶件口径，UI 用） */
export interface CounterStats {
  totalMats: number;
  totalBlankets: number;
  byStatus: Record<ItemStatus, { mats: number; blankets: number }>;
  warehouse: { looseMats: number; looseBlankets: number; inPackMats: number; inPackBlankets: number };
  counter: { looseMats: number; looseBlankets: number; inPackMats: number; inPackBlankets: number };
  needsTotal: number;
  needsCovered: number;
  portionsTotal: number;
  portionsConsumed: number;
}

export function counterStats(state: BeddingState): CounterStats {
  const leaves = state.nodes.filter(isLeaf);
  const byStatus: CounterStats['byStatus'] = {
    available: { mats: 0, blankets: 0 },
    in_pack: { mats: 0, blankets: 0 },
    delivered: { mats: 0, blankets: 0 },
    cleaning: { mats: 0, blankets: 0 },
    damaged: { mats: 0, blankets: 0 },
  };
  const wh = { looseMats: 0, looseBlankets: 0, inPackMats: 0, inPackBlankets: 0 };
  const ct = { looseMats: 0, looseBlankets: 0, inPackMats: 0, inPackBlankets: 0 };
  for (const l of leaves) {
    const st = effectiveStatus(state, l);
    if (l.kind === 'mat') byStatus[st].mats++;
    else byStatus[st].blankets++;
    const root = rootOf(state, l.id);
    const loc = root.holder!.type;
    if (loc === 'warehouse' || loc === 'counter') {
      const bucket = loc === 'warehouse' ? wh : ct;
      const inPack = !!l.parentId;
      if (l.kind === 'mat') {
        if (inPack) bucket.inPackMats++;
        else bucket.looseMats++;
      } else {
        if (inPack) bucket.inPackBlankets++;
        else bucket.looseBlankets++;
      }
    }
  }
  const needsTotal = state.needs.length;
  const needsCovered = state.needs.filter(fullyCovered).length;
  const portionsTotal = state.vouchers.reduce((s, v) => s + v.portions, 0);
  const portionsConsumed = state.vouchers.reduce((s, v) => s + v.consumed, 0);
  return {
    totalMats: leaves.filter((l) => l.kind === 'mat').length,
    totalBlankets: leaves.filter((l) => l.kind === 'blanket').length,
    byStatus,
    warehouse: wh,
    counter: ct,
    needsTotal,
    needsCovered,
    portionsTotal,
    portionsConsumed,
  };
}

// ---------------------------------------------------------------------------
// 命令处理（在调用方提供的 IndexedDB 事务内同步执行）
// ---------------------------------------------------------------------------

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}`;
}

function clone(s: BeddingState): BeddingState {
  return structuredClone(s);
}

type ReceiptSink = (kind: string, summary: string, lines?: string[], extra?: Partial<Receipt>) => Receipt;

function addReceipt(
  state: BeddingState,
  kind: string,
  actor: string,
  summary: string,
  lines: string[] = [],
  extra?: Partial<Receipt>,
): Receipt {
  const seq = ++state.seqCounter;
  const r: Receipt = { seq, id: `R${seq}`, at: state.virtualNow, kind, actor, summary, lines, ...extra };
  state.receipts.push(r);
  if (state.receipts.length > 600) state.receipts.splice(0, state.receipts.length - 600);
  return r;
}

function summarize(state: BeddingState, cmd: Command): string {
  const famName = (id: string) => state.families.find((f) => f.id === id)?.name ?? id;
  switch (cmd.type) {
    case 'RegisterFamily':
      return `登记家庭「${cmd.input.name}」`;
    case 'SplitFamily':
      return `家庭拆分 ${famName(cmd.familyId)}`;
    case 'SealPack':
      return `封包（${PACK_KIND_LABEL[cmd.packKind]}）`;
    case 'OpenPack':
      return '开封';
    case 'DetachChild':
      return '包内取件';
    case 'MoveStock':
      return cmd.to === 'counter' ? '送到领取柜' : '送回库房';
    case 'Deliver':
      return `交付 ${famName(cmd.familyId)}`;
    case 'ReceiveReturn':
      return `退回接收 ${famName(cmd.familyId)}`;
    case 'Reclaim':
      return `补领 ${famName(cmd.familyId)}`;
    case 'CompleteCleaning':
      return '完成清洁';
    case 'AdvanceClock':
      return '推进演示时间';
    case 'ResetDemo':
      return '重置演示数据';
  }
}

export function applyCommand(prev: BeddingState, cmd: Command, ctx: CmdCtx): CmdOutcome {
  if (cmd.type === 'ResetDemo') {
    const fresh = seedState();
    const r = addReceipt(fresh, 'reset', ROLE_LABEL[ctx.role], '演示数据已重置为初始场景', []);
    return { state: fresh, receipts: [r], changed: true };
  }

  // 幂等：同一 commandId 只生效一次，重复提交返回重复回执
  const seen = prev.commandLog.find((e) => e.commandId === cmd.commandId);
  if (seen) {
    const state = clone(prev);
    const r = addReceipt(
      state,
      'duplicate_submission',
      ROLE_LABEL[ctx.role],
      `重复提交已幂等忽略：${seen.summary}`,
      [`原回执：${seen.receiptIds.join('、') || '（无）'}`, '同一 commandId 的命令只会生效一次，状态未发生变化'],
      { duplicateOf: seen.receiptIds[0] },
    );
    state.version++;
    return { state, receipts: [r], changed: true };
  }

  const state = clone(prev);
  const receipts: Receipt[] = [];
  const R: ReceiptSink = (kind, summary, lines = [], extra) => {
    const r = addReceipt(state, kind, ROLE_LABEL[ctx.role], summary, lines, extra);
    receipts.push(r);
    return r;
  };

  const error = dispatch(state, cmd, ctx, R);
  const mutated = receipts.length > 0 || !!error;
  if (!mutated) return { state: prev, receipts: [], changed: false };

  state.version++;
  state.commandLog.push({
    commandId: cmd.commandId,
    at: state.virtualNow,
    ok: !error,
    summary: summarize(state, cmd),
    receiptIds: receipts.map((r) => r.id),
  });
  if (state.commandLog.length > 300) state.commandLog.splice(0, state.commandLog.length - 300);
  return { state, receipts, error, changed: true };
}

function dispatch(state: BeddingState, cmd: Command, ctx: CmdCtx, R: ReceiptSink): string | undefined {
  const perm = PERMS[cmd.type];
  if (perm !== 'any' && !perm.includes(ctx.role)) {
    return `当前角色（${ROLE_LABEL[ctx.role]}）无权执行此操作，需要：${perm.map((r) => ROLE_LABEL[r]).join('或')}`;
  }
  switch (cmd.type) {
    case 'RegisterFamily':
      return hRegisterFamily(state, cmd, R);
    case 'SplitFamily':
      return hSplitFamily(state, cmd, R);
    case 'SealPack':
      return hSealPack(state, cmd, ctx, R);
    case 'OpenPack':
      return hOpenPack(state, cmd, ctx, R);
    case 'DetachChild':
      return hDetachChild(state, cmd, R);
    case 'MoveStock':
      return hMoveStock(state, cmd, R);
    case 'Deliver':
      return hDeliver(state, cmd, R);
    case 'ReceiveReturn':
      return hReceiveReturn(state, cmd, R);
    case 'Reclaim':
      return hReclaim(state, cmd, R);
    case 'CompleteCleaning':
      return hCompleteCleaning(state, cmd, R);
    case 'AdvanceClock':
      return hAdvanceClock(state, cmd, R);
    default:
      return '未知命令';
  }
}

// ---------------------------------------------------------------------------
// 各命令处理器：返回错误文案，undefined 表示成功
// ---------------------------------------------------------------------------

function hRegisterFamily(
  state: BeddingState,
  cmd: Extract<Command, { type: 'RegisterFamily' }>,
  R: ReceiptSink,
): string | undefined {
  const name = cmd.input.name.trim();
  const members = cmd.input.memberNames.map((s) => s.trim()).filter(Boolean);
  if (!name) return '家庭名称不能为空';
  if (members.length < 1 || members.length > 20) return '住宿人员须为 1-20 人';
  if (new Set(members).size !== members.length) return '住宿人员姓名不能重复';
  const batch = state.batches[0];
  const fam: Family = { id: uid(), name, batchId: batch.id, createdAt: state.virtualNow };
  state.families.push(fam);
  for (const personName of members) {
    state.needs.push({
      id: uid(),
      batchId: batch.id,
      familyId: fam.id,
      personName,
      matItemId: null,
      blanketItemId: null,
      createdAt: state.virtualNow,
    });
  }
  state.vouchers.push({
    id: uid(),
    familyId: fam.id,
    batchId: batch.id,
    portions: members.length,
    consumed: 0,
  });
  R('family_registered', `已登记：${name}（${members.length}人，${batch.name}）`, [
    `人员需求（一人一垫一毯）：${members.join('、')}`,
    `开具领取凭证 ${members.length} 人份；需求与人绑定、与家庭归属分开`,
  ]);
  return undefined;
}

function hSplitFamily(
  state: BeddingState,
  cmd: Extract<Command, { type: 'SplitFamily' }>,
  R: ReceiptSink,
): string | undefined {
  const fam = familyById(state, cmd.familyId);
  const newName = cmd.newName.trim();
  if (!newName) return '新户名称不能为空';
  const famNeeds = needsOf(state, fam.id);
  const ids = [...new Set(cmd.needIds)];
  if (ids.length === 0) return '请选择要迁出的成员';
  const moved: Need[] = [];
  for (const id of ids) {
    const n = state.needs.find((x) => x.id === id);
    if (!n || n.familyId !== fam.id) return '所选成员不属于该家庭';
    moved.push(n);
  }
  if (moved.length >= famNeeds.length) return '拆分须为原家庭保留至少 1 人（全部迁出不是拆分）';
  const v = voucherOf(state, fam.id);
  if (!v) return '原家庭无领取凭证';
  const newFam: Family = {
    id: uid(),
    name: newName,
    batchId: fam.batchId,
    splitFromId: fam.id,
    createdAt: state.virtualNow,
  };
  state.families.push(newFam);
  const movedCovered = moved.filter(fullyCovered).length;
  for (const n of moved) n.familyId = newFam.id;
  const beforePortions = v.portions;
  const beforeConsumed = v.consumed;
  v.portions -= moved.length;
  v.consumed -= movedCovered;
  state.vouchers.push({
    id: uid(),
    familyId: newFam.id,
    batchId: fam.batchId,
    portions: moved.length,
    consumed: movedCovered,
  });
  const openPr = openPendingReturnsOf(state, fam.id);
  const openRc = state.reclaims.filter((r) => r.familyId === fam.id && r.status === 'awaiting_old');
  const lines = [
    `需求随人转移（需求单号不变、已覆盖关系不变）：${moved.map((n) => n.personName).join('、')}`,
    `领取权转移而非新增：凭证 ${beforePortions} 份 → 原户 ${v.portions} 份 ＋ 新户 ${moved.length} 份（合计不变，不重新生成领取权）`,
    `已核销随覆盖转移：${beforeConsumed} → ${v.consumed} ＋ ${movedCovered}`,
  ];
  if (openPr.length || openRc.length)
    lines.push('注意：待返还与在办补领义务仍记在原家庭名下（按交付发生时的归属核算）');
  R('family_split', `家庭拆分：${fam.name} → 「${fam.name}」${v.portions}人 ＋ 「${newName}」${moved.length}人`, lines);
  return undefined;
}

/** 解析封包材料：根（可用）或已开封包内的直接子件（自动取出） */
function resolveSealChildren(
  state: BeddingState,
  childIds: string[],
): { children?: ItemNode[]; error?: string } {
  const ids = [...new Set(childIds)];
  if (ids.length === 0) return { error: '请选择封包材料' };
  const children: ItemNode[] = [];
  let location: 'warehouse' | 'counter' | null = null;
  for (const id of ids) {
    const n = state.nodes.find((x) => x.id === id);
    if (!n) return { error: `物资不存在: ${id}` };
    if (n.kind === 'pack' && !n.seal) return { error: `包 ${n.label} 已开封，空包壳不能作为封包内容（包壳不计寝具）` };
    let rootHolder: NonNullable<ItemNode['holder']>;
    if (n.parentId === null) {
      if (!n.holder) return { error: `物资 ${n.label} 状态异常` };
      rootHolder = n.holder;
    } else {
      const parent = state.nodes.find((p) => p.id === n.parentId);
      if (!parent) return { error: `物资 ${n.label} 的父包不存在` };
      if (parent.seal) return { error: `物资 ${n.label} 在已封包 ${parent.label} 内，须先开封` };
      const root = rootOf(state, n.id);
      if (!root.holder) return { error: `物资 ${n.label} 状态异常` };
      rootHolder = root.holder;
    }
    if (rootHolder.type === 'delivered') return { error: `物资 ${n.label} 已交付，不能封包` };
    if (rootHolder.type === 'cleaning') return { error: `物资 ${n.label} 在待清洁区，不能封包` };
    if (rootHolder.type === 'damaged') return { error: `物资 ${n.label} 已报损，不能封包` };
    if (location && location !== rootHolder.type)
      return { error: '封包材料须在同一地点（同在库房或同在领取柜）' };
    location = rootHolder.type;
    children.push(n);
  }
  return { children };
}

function hSealPack(
  state: BeddingState,
  cmd: Extract<Command, { type: 'SealPack' }>,
  ctx: CmdCtx,
  R: ReceiptSink,
): string | undefined {
  const { children, error } = resolveSealChildren(state, cmd.childIds);
  if (error) return error;
  const kids = children!;
  // 组成核验：成套只覆盖其内部物资
  if (cmd.packKind === 'one_set') {
    const mats = kids.filter((k) => k.kind === 'mat').length;
    const blankets = kids.filter((k) => k.kind === 'blanket').length;
    if (kids.length !== 2 || mats !== 1 || blankets !== 1)
      return `一人套包须恰好 1 垫 1 毯（当前 ${kids.length} 件：垫${mats}毯${blankets}），不能再额外增加物资`;
    if (kids.some((k) => !isLeaf(k))) return '一人套包只能装散件叶件（垫、毯各一）';
  } else if (cmd.packKind === 'four_pack') {
    if (kids.length !== 4 || kids.some((k) => k.packKind !== 'one_set'))
      return '四人包须恰好由 4 个一人套包组成';
  } else {
    if (kids.length < 1) return '重封包至少装 1 件';
  }
  const first = kids[0];
  const location = (first.parentId ? rootOf(state, first.id).holder : first.holder) as Extract<
    NonNullable<ItemNode['holder']>,
    { type: 'warehouse' | 'counter' }
  >;
  const seq = ++state.packSeq[cmd.packKind];
  const label = `${PACK_PREFIX[cmd.packKind]}-${String(seq).padStart(2, '0')}`;
  const seal = { sealId: `SEAL-${++state.sealSeq}`, sealedAt: state.virtualNow, sealedBy: ROLE_LABEL[ctx.role] };
  const node: ItemNode = {
    id: uid(),
    label,
    kind: 'pack',
    packKind: cmd.packKind,
    parentId: null,
    holder: { type: location.type },
    seal,
    brokenSeals: [],
    awaitingReturn: false,
    createdAt: state.virtualNow,
  };
  state.nodes.push(node);
  for (const k of kids) {
    k.parentId = node.id; // 一件只能有一个当前父包：装入即改挂
    k.holder = null;
  }
  const st = leafStats(state, node.id);
  R(
    'pack_sealed',
    `封包 ${label}（${PACK_KIND_LABEL[cmd.packKind]}，封签 ${seal.sealId}）：${kids.map((k) => k.label).join('、')}`,
    [
      `叶件 ${st.leaves}（垫${st.mats} 毯${st.blankets}，${st.portions} 人份）；位置：${location.type === 'counter' ? '领取柜' : '库房'}`,
      '成套只覆盖其内部物资；包含树模型：子件位置随新根继承',
    ],
  );
  return undefined;
}

function hOpenPack(
  state: BeddingState,
  cmd: Extract<Command, { type: 'OpenPack' }>,
  ctx: CmdCtx,
  R: ReceiptSink,
): string | undefined {
  const p = state.nodes.find((n) => n.id === cmd.packId);
  if (!p || p.kind !== 'pack') return '包不存在';
  if (!p.seal) return `包 ${p.label} 已开封（封签已破）`;
  // 外层包未开封时，内层包不可拆（跨层拆包须自外而内）
  const path = packPathOf(state, p.id);
  const sealedAncestor = path.slice(0, -1).find((a) => a.seal);
  if (sealedAncestor) return `须先开封外层包 ${sealedAncestor.label}，才能拆 ${p.label}（跨层拆包自外而内）`;
  const root = path[0];
  const h = root.holder!;
  if (h.type === 'delivered') {
    const d = deliveryById(state, h.deliveryId);
    const fam = d ? state.families.find((f) => f.id === d.familyId) : undefined;
    return `包 ${p.label} 已交付给「${fam?.name ?? '?'}」（交付单 ${h.deliveryId}），不能开封；包内物资随交付锁定`;
  }
  if (h.type === 'cleaning' || h.type === 'damaged') return `包 ${p.label} 在${h.type === 'cleaning' ? '待清洁' : '报损'}状态，不能开封`;
  const brokenSeal = p.seal;
  p.brokenSeals.push({
    ...brokenSeal,
    brokenAt: state.virtualNow,
    brokenBy: ROLE_LABEL[ctx.role],
    cause: '柜台开封',
  });
  p.seal = null;
  const kids = childrenOf(state, p.id);
  const st = leafStats(state, p.id);
  R('pack_opened', `开封 ${p.label}（封签 ${brokenSeal.sealId} 已破）`, [
    `内含：${kids.map((k) => k.label).join('、') || '（空）'}（叶件 ${st.leaves}：垫${st.mats} 毯${st.blankets}）`,
    '内容物仍在已开封的包内，可逐件/逐套取出或重新封包；包壳本身不计寝具',
  ]);
  return undefined;
}

function hDetachChild(
  state: BeddingState,
  cmd: Extract<Command, { type: 'DetachChild' }>,
  R: ReceiptSink,
): string | undefined {
  const c = state.nodes.find((n) => n.id === cmd.childId);
  if (!c) return '物资不存在';
  if (!c.parentId) return `物资 ${c.label} 已在顶层，无需取出`;
  const parent = nodeById(state, c.parentId);
  if (parent.seal) return `包 ${parent.label} 封签完好，须先开封才能取件`;
  const root = rootOf(state, c.id);
  const h = root.holder!;
  if (h.type === 'delivered') return `包 ${parent.label} 已交付，包内物资随交付锁定，不能取件`;
  if (h.type === 'cleaning' || h.type === 'damaged') return `包 ${parent.label} 在待清洁/报损状态，不能取件`;
  c.parentId = null;
  c.holder = { type: h.type };
  const st = isLeaf(c) ? null : leafStats(state, c.id);
  R('child_detached', `取出 ${c.label} ← 包 ${parent.label}`, [
    st ? `含叶件 ${st.leaves}（垫${st.mats} 毯${st.blankets}）；位置：${h.type === 'counter' ? '领取柜' : '库房'}` : `位置：${h.type === 'counter' ? '领取柜' : '库房'}`,
  ]);
  return undefined;
}

function hMoveStock(
  state: BeddingState,
  cmd: Extract<Command, { type: 'MoveStock' }>,
  R: ReceiptSink,
): string | undefined {
  const ids = [...new Set(cmd.nodeIds)];
  if (ids.length === 0) return '请选择要移动的物资';
  const toLabel = cmd.to === 'counter' ? '领取柜' : '库房';
  // 先整体核验，再统一改写（避免部分生效）
  for (const id of ids) {
    const n = state.nodes.find((x) => x.id === id);
    if (!n) return `物资不存在: ${id}`;
    if (n.parentId !== null)
      return `物资 ${n.label} 在包内，位置随根继承；整包移动请选择其最外层包，或先开封取出`;
    const h = n.holder!;
    if (h.type === 'delivered') return `物资 ${n.label} 已交付，不能移动`;
    if (h.type === 'cleaning') return `物资 ${n.label} 在待清洁区，请先完成清洁`;
    if (h.type === 'damaged') return `物资 ${n.label} 已报损，不能移动`;
    if (h.type === cmd.to) return `物资 ${n.label} 已在${toLabel}`;
  }
  const lines: string[] = [];
  const moved: string[] = [];
  for (const id of ids) {
    const n = nodeById(state, id);
    n.holder = { type: cmd.to };
    const st = leafStats(state, n.id);
    moved.push(n.label);
    lines.push(
      st.leaves > 1
        ? `整包移动 ${n.label}（叶件 ${st.leaves}：垫${st.mats} 毯${st.blankets}）→ ${toLabel}｜包含树模型：仅更新 1 个根节点位置，${st.leaves} 件物资位置随根继承`
        : `单件移动 ${n.label} → ${toLabel}`,
    );
  }
  R(cmd.to === 'counter' ? 'moved_counter' : 'moved_warehouse', `移动 ${moved.join('、')} → ${toLabel}`, lines);
  return undefined;
}

function hDeliver(
  state: BeddingState,
  cmd: Extract<Command, { type: 'Deliver' }>,
  R: ReceiptSink,
): string | undefined {
  const fam = state.families.find((f) => f.id === cmd.familyId);
  if (!fam) return '家庭不存在';
  const v = voucherOf(state, fam.id);
  if (!v) return '该家庭无领取凭证';
  const plan = planDelivery(state, cmd.familyId, cmd.nodeIds);
  if (plan.errors.length) return plan.errors.join('；');
  if (v.consumed + plan.newlyCovered.length > v.portions) return '凭证核销将超过份数（内部校验）';
  const ids = [...new Set(cmd.nodeIds)];
  const did = `D${state.deliveries.length + 1}-${uid().slice(0, 6)}`;
  // 原子核销：交付物资 ↔ 领取凭证（同一事务内完成）
  for (const line of plan.lines) {
    const need = state.needs.find((n) => n.id === line.need.id)!;
    if (line.mat) need.matItemId = line.mat.id;
    if (line.blanket) need.blanketItemId = line.blanket.id;
  }
  v.consumed += plan.newlyCovered.length;
  const leafIds = ids.flatMap((id) => leavesOf(state, id).map((l) => l.id));
  for (const id of ids) {
    const n = nodeById(state, id);
    n.holder = { type: 'delivered', deliveryId: did };
  }
  const delivery: Delivery = {
    id: did,
    kind: 'normal',
    familyId: fam.id,
    batchId: fam.batchId,
    rootNodeIds: ids,
    leafItemIds: leafIds,
    assignments: plan.lines.map((l) => ({
      needId: l.need.id,
      matItemId: l.mat?.id,
      blanketItemId: l.blanket?.id,
    })),
    excessMats: plan.excessMats.length,
    excessBlankets: plan.excessBlankets.length,
    actor: '',
    at: state.virtualNow,
  };
  state.deliveries.push(delivery);
  const lines: string[] = [];
  for (const l of plan.lines) {
    const parts: string[] = [];
    if (l.mat) parts.push(`垫 ${l.mat.label}`);
    else if (l.need.matItemId) parts.push(`垫 ${nodeById(state, l.need.matItemId).label}（此前已发）`);
    if (l.blanket) parts.push(`毯 ${l.blanket.label}`);
    else if (l.need.blanketItemId) parts.push(`毯 ${nodeById(state, l.need.blanketItemId).label}（此前已发）`);
    lines.push(
      `${l.need.personName}：${parts.join(' ＋ ')}${plan.newlyCovered.includes(l.need) ? '（覆盖）' : '（部分覆盖）'}`,
    );
  }
  lines.push(`凭证核销 ${plan.newlyCovered.length} 人份（${v.consumed}/${v.portions}）`);
  let pr: PendingReturn | undefined;
  if (plan.excessMats.length || plan.excessBlankets.length) {
    pr = {
      id: `PR${state.pendingReturns.length + 1}`,
      familyId: fam.id,
      deliveryId: did,
      matsOwed: plan.excessMats.length,
      blanketsOwed: plan.excessBlankets.length,
      matsReturned: 0,
      blanketsReturned: 0,
      status: 'open',
      createdAt: state.virtualNow,
    };
    state.pendingReturns.push(pr);
    lines.push(
      `超出凭证 ${plan.excessMats.length + plan.excessBlankets.length} 件（垫${plan.excessMats.length} 毯${plan.excessBlankets.length}）→ 已记待返还 ${pr.id}：清点实收且确认为未用后才可重发`,
    );
  }
  const nodeLabels = ids.map((id) => nodeById(state, id).label).join('、');
  const r = R(
    'delivered',
    `交付 ${did}：${fam.name} ← ${nodeLabels}（叶件 ${leafIds.length}：垫${plan.mats.length} 毯${plan.blankets.length}）`,
    lines,
  );
  delivery.actor = r.actor;
  return undefined;
}

/** 退回时破开祖先封签（家庭开封取件），保证“封签完好 ⇒ 内容未变” */
function breakAncestorSeals(state: BeddingState, item: ItemNode, byLabel: string, notes: string[]): void {
  let p = item.parentId ? nodeById(state, item.parentId) : null;
  while (p) {
    if (p.seal) {
      p.brokenSeals.push({
        ...p.seal,
        brokenAt: state.virtualNow,
        brokenBy: byLabel,
        cause: `退回取出 ${item.label}`,
      });
      notes.push(`封签 ${p.seal.sealId}（${p.label}）失效：家庭已开封取件`);
      p.seal = null;
    }
    p = p.parentId ? nodeById(state, p.parentId) : null;
  }
}

function hReceiveReturn(
  state: BeddingState,
  cmd: Extract<Command, { type: 'ReceiveReturn' }>,
  R: ReceiptSink,
): string | undefined {
  const fam = state.families.find((f) => f.id === cmd.familyId);
  if (!fam) return '家庭不存在';
  const items = cmd.items;
  if (items.length === 0) return '请选择要接收的退回物资';
  const ids = items.map((i) => i.itemId);
  if (new Set(ids).size !== ids.length) return '退回物资不能重复';
  // 先整体核验（查原交付），再逐件入账
  for (const { itemId } of items) {
    const n = state.nodes.find((x) => x.id === itemId);
    if (!n) return `物资不存在: ${itemId}`;
    if (!isLeaf(n)) return `包 ${n.label} 不是寝具叶件，退回请按叶件清点（包壳不计寝具）`;
    const st = effectiveStatus(state, n.id);
    if (st !== 'delivered') return `物资 ${n.label} 当前为「${ITEM_STATUS_LABEL[st]}」，不是已交付状态，不能退回`;
    const d = originalDeliveryOfItem(state, n.id);
    if (!d) return `物资 ${n.label} 查不到原交付单`;
    if (d.familyId !== fam.id) {
      const other = state.families.find((f) => f.id === d.familyId);
      return `物资 ${n.label} 的原始交付单 ${d.id} 属于「${other?.name ?? '?'}」，不能由「${fam.name}」退回（响应丢失/退回须查原交付）`;
    }
  }
  const lines: string[] = [];
  const sealNotes: string[] = [];
  const openPrs = openPendingReturnsOf(state, fam.id).sort((a, b) => a.createdAt - b.createdAt);
  let closedReclaims = 0;
  for (const { itemId, condition } of items) {
    const n = nodeById(state, itemId);
    breakAncestorSeals(state, n, ROLE_LABEL.counter, sealNotes);
    n.parentId = null;
    n.holder =
      condition === 'unused'
        ? { type: 'warehouse' }
        : condition === 'used'
          ? { type: 'cleaning' }
          : { type: 'damaged', reason: '退回验收报损' };
    const dest =
      condition === 'unused' ? '确认为未用 → 回库（可重发）' : condition === 'used' ? '已使用 → 待清洁' : '报损';
    lines.push(`${n.label}：${dest}`);
    if (n.awaitingReturn && n.reclaimId) {
      n.awaitingReturn = false;
      const rc = state.reclaims.find((x) => x.id === n.reclaimId);
      n.reclaimId = undefined;
      if (rc && rc.status === 'awaiting_old') {
        rc.status = 'closed';
        rc.closedAt = state.virtualNow;
        closedReclaims++;
        lines.push(`补领 ${rc.id} 旧物已实际退回 → 进入${condition === 'unused' ? '回库' : condition === 'used' ? '待清洁' : '报损'}，补领闭环`);
      }
    }
    // 待返还核销（按叶件品类，先到先销）
    let remaining = 1;
    for (const pr of openPrs) {
      if (pr.status !== 'open' || remaining === 0) continue;
      if (n.kind === 'mat' && pr.matsReturned < pr.matsOwed) {
        pr.matsReturned++;
        remaining--;
      } else if (n.kind === 'blanket' && pr.blanketsReturned < pr.blanketsOwed) {
        pr.blanketsReturned++;
        remaining--;
      }
      if (pr.matsReturned === pr.matsOwed && pr.blanketsReturned === pr.blanketsOwed) {
        pr.status = 'closed';
        pr.closedAt = state.virtualNow;
        lines.push(`待返还 ${pr.id} 已清讫（垫${pr.matsOwed} 毯${pr.blanketsOwed} 全部实收）`);
      }
    }
  }
  const summary = `退回接收（清点实收）：${fam.name} 退回 ${items.length} 件`;
  R('return_received', summary, [...lines, ...sealNotes]);
  return undefined;
}

function hReclaim(
  state: BeddingState,
  cmd: Extract<Command, { type: 'Reclaim' }>,
  R: ReceiptSink,
): string | undefined {
  const fam = state.families.find((f) => f.id === cmd.familyId);
  if (!fam) return '家庭不存在';
  const need = state.needs.find((n) => n.id === cmd.needId);
  if (!need || need.familyId !== fam.id) return '需求不存在或不属于该家庭';
  const reason = cmd.reason.trim();
  if (!reason) return '补领须填写原因';
  const typeLabel = cmd.itemType === 'mat' ? '垫子' : '毯子';
  const oldItemId = cmd.itemType === 'mat' ? need.matItemId : need.blanketItemId;
  if (!oldItemId) return `${need.personName} 的${typeLabel}尚未发放，无需补领，请直接办理领取`;
  const dup = openReclaimOf(state, need.id, cmd.itemType);
  if (dup)
    return `重复补领核对未通过：${need.personName} 的${typeLabel}已有在办补领 ${dup.id}（旧件 ${nodeById(state, dup.oldItemId).label} 待退回），不得重复申请`;
  const oldItem = nodeById(state, oldItemId);
  if (effectiveStatus(state, oldItem) !== 'delivered') return `旧件 ${oldItem.label} 不在已交付状态，无法办理补领`;
  const origDelivery = originalDeliveryOfItem(state, oldItem.id);
  const rep = state.nodes.find((n) => n.id === cmd.replacementNodeId);
  if (!rep) return '换发物资不存在';
  if (!isLeaf(rep) || rep.kind !== cmd.itemType) return `换发物资须为${typeLabel}散件（如需套包请先由仓管开封取件）`;
  if (rep.parentId !== null) return `换发物资 ${rep.label} 在包内，须先由仓管开封取出`;
  if (rep.holder?.type !== 'counter') return `换发物资 ${rep.label} 须在领取柜（当前：${locationLabel(state, rep)}）`;
  const rid = `RC${state.reclaims.length + 1}`;
  const did = `D${state.deliveries.length + 1}-${uid().slice(0, 6)}`;
  oldItem.awaitingReturn = true;
  oldItem.reclaimId = rid;
  rep.holder = { type: 'delivered', deliveryId: did };
  if (cmd.itemType === 'mat') need.matItemId = rep.id;
  else need.blanketItemId = rep.id;
  const rc: Reclaim = {
    id: rid,
    familyId: fam.id,
    needId: need.id,
    itemType: cmd.itemType,
    reason,
    oldItemId: oldItem.id,
    newItemId: rep.id,
    status: 'awaiting_old',
    createdAt: state.virtualNow,
    actor: ROLE_LABEL.counter,
  };
  state.reclaims.push(rc);
  state.deliveries.push({
    id: did,
    kind: 'reclaim',
    familyId: fam.id,
    batchId: fam.batchId,
    rootNodeIds: [rep.id],
    leafItemIds: [rep.id],
    assignments: [{ needId: need.id, ...(cmd.itemType === 'mat' ? { matItemId: rep.id } : { blanketItemId: rep.id }) }],
    excessMats: 0,
    excessBlankets: 0,
    actor: ROLE_LABEL.counter,
    at: state.virtualNow,
    reclaimId: rid,
  });
  R('reclaim_applied', `补领 ${rid}（原因：${reason}）：${need.personName} ${typeLabel} 旧 ${oldItem.label} → 新 ${rep.label}`, [
    `查原交付：旧件来自交付单 ${origDelivery?.id ?? '?'}（响应丢失查原交付，不再领一次）`,
    '旧件已标记「待退回」：实际退回前不得进入清洁或报损（申请提交 ≠ 旧物已回）',
    '本次为置换补领，不新增核销凭证份数',
  ]);
  return undefined;
}

function hCompleteCleaning(
  state: BeddingState,
  cmd: Extract<Command, { type: 'CompleteCleaning' }>,
  R: ReceiptSink,
): string | undefined {
  const ids = [...new Set(cmd.itemIds)];
  if (ids.length === 0) return '请选择要完成清洁的物资';
  for (const id of ids) {
    const n = state.nodes.find((x) => x.id === id);
    if (!n) return `物资不存在: ${id}`;
    if (!isLeaf(n)) return `包 ${n.label} 不是寝具叶件`;
    if (n.parentId !== null) return `物资 ${n.label} 在包内`;
    if (n.holder?.type !== 'cleaning') return `物资 ${n.label} 不在待清洁区`;
  }
  const done: string[] = [];
  for (const id of ids) {
    const n = nodeById(state, id);
    n.holder = { type: 'warehouse' };
    done.push(n.label);
  }
  R('cleaning_done', `完成清洁：${done.join('、')} → 回库（可用）`, ['清洁完成的寝具回到库房可用状态，可再次封包或发放']);
  return undefined;
}

function hAdvanceClock(
  state: BeddingState,
  cmd: Extract<Command, { type: 'AdvanceClock' }>,
  R: ReceiptSink,
): string | undefined {
  if (cmd.toVirtual <= state.virtualNow) return '演示时间只能向前推进';
  state.virtualNow = cmd.toVirtual;
  R('clock_advanced', `演示时间推进至 ${fmtDateTime(cmd.toVirtual)}`, []);
  return undefined;
}
