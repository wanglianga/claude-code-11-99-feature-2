/** 领域模型类型定义：夜间寝具柜台（一垫一毯发放、退回、拆包与补领） */

/** 操作角色：仓管员 / 柜台职员 / 稽核员 */
export type Role = 'keeper' | 'counter' | 'auditor';

/** 物资节点种类：垫子 / 毯子（叶件），包（容器节点；包壳本身不计寝具） */
export type NodeKind = 'mat' | 'blanket' | 'pack';

/** 包型：一人套包（1垫1毯）/ 四人包（4个一人套）/ 重封包（开封后重新封装） */
export type PackKind = 'one_set' | 'four_pack' | 'repack';

/**
 * 根节点位置与状态（内部模型选择：有根包含树）。
 * 叶件与包的位置一律沿包含树继承自根节点——整包搬运只改根；
 * 核查单件时沿 parentId 解析祖先。库存五态：可用 / 包内 / 已交付 / 待清洁 / 报损，
 * 其中「包内」由“根可用且自身有父包”派生，不单独落库。
 */
export type Holder =
  | { type: 'warehouse' } // 库房（可用）
  | { type: 'counter' } // 领取柜现场（可用）
  | { type: 'delivered'; deliveryId: string } // 已交付（关联交付单）
  | { type: 'cleaning' } // 待清洁
  | { type: 'damaged'; reason: string }; // 报损

/** 有效封签 */
export interface Seal {
  sealId: string;
  sealedAt: number;
  sealedBy: string; // 操作者（角色名）
}

/** 封签历史（可核查的封装来源） */
export interface BrokenSeal extends Seal {
  brokenAt: number;
  brokenBy: string;
  cause: string;
}

/**
 * 包含树节点：叶件（垫/毯）或包。
 * 不变量：parentId 唯一且不成环；parentId === null ⇔ holder !== null（仅根节点持有位置）。
 */
export interface ItemNode {
  id: string;
  /** 虚构物资编号：MAT-001 / BLK-001 / SET-01 / PK4-01 / RPK-01 */
  label: string;
  kind: NodeKind;
  packKind?: PackKind;
  /** 当前父包（一件不能有两个当前父包） */
  parentId: string | null;
  /** 仅根节点：位置与状态；子件为 null（位置随根继承） */
  holder: Holder | null;
  /** 当前有效封签（仅包；开封后为 null） */
  seal: Seal | null;
  /** 已破封签历史 */
  brokenSeals: BrokenSeal[];
  /** 补领旧物：待实际退回（实际退回前不得进入清洁或报损） */
  awaitingReturn: boolean;
  reclaimId?: string;
  createdAt: number;
}

/** 住宿批次 */
export interface Batch {
  id: string;
  name: string;
}

export interface Family {
  id: string;
  name: string;
  batchId: string;
  /** 由拆分产生的家庭记录其来源（审计） */
  splitFromId?: string;
  createdAt: number;
}

/**
 * 人员需求：每人每住宿批次一垫一毯。
 * 需求与人绑定、与家庭归属分开：分房或拆成两户只改 familyId，不重新生成领取权。
 */
export interface Need {
  id: string;
  batchId: string;
  familyId: string;
  personName: string;
  /** 覆盖该需求的实际物资（叶件） */
  matItemId: string | null;
  blanketItemId: string | null;
  createdAt: number;
}

/** 领取凭证：按实际住宿人数开具的人份领取权；交付时按实际物资原子核销 */
export interface Voucher {
  id: string;
  familyId: string;
  batchId: string;
  portions: number;
  consumed: number;
}

export interface DeliveryLine {
  needId: string;
  matItemId?: string;
  blanketItemId?: string;
}

/** 交付单：实际物资与领取凭证的原子核销记录 */
export interface Delivery {
  id: string;
  kind: 'normal' | 'reclaim';
  familyId: string;
  batchId: string;
  /** 交付的根节点（整包或散件） */
  rootNodeIds: string[];
  /** 交付的全部叶件 */
  leafItemIds: string[];
  assignments: DeliveryLine[];
  /** 超出凭证的物资（记入待返还） */
  excessMats: number;
  excessBlankets: number;
  actor: string;
  at: number;
  reclaimId?: string;
}

/** 待返还：交付超出凭证人份的物资；清点实收且确认为未用后才可重发 */
export interface PendingReturn {
  id: string;
  familyId: string;
  deliveryId: string;
  matsOwed: number;
  blanketsOwed: number;
  matsReturned: number;
  blanketsReturned: number;
  status: 'open' | 'closed';
  createdAt: number;
  closedAt?: number;
}

/** 补领：须给原因；旧物实际退回后才能进入清洁或报损（申请提交 ≠ 旧物已回） */
export interface Reclaim {
  id: string;
  familyId: string;
  needId: string;
  itemType: 'mat' | 'blanket';
  reason: string;
  /** 旧件（查原交付确定）；遗失件在实际退回前保持「待退回」 */
  oldItemId: string;
  newItemId: string;
  status: 'awaiting_old' | 'closed';
  createdAt: number;
  closedAt?: number;
  actor: string;
}

/** 操作回执（审计：每个计数都可追到实物与操作者） */
export interface Receipt {
  seq: number;
  id: string;
  at: number;
  kind: string;
  actor: string;
  summary: string;
  lines: string[];
  /** 重复提交被幂等忽略时，指向原回执 */
  duplicateOf?: string;
}

export interface CommandLogEntry {
  commandId: string;
  at: number;
  ok: boolean;
  summary: string;
  receiptIds: string[];
}

export interface BeddingState {
  version: number;
  /** 演示用虚拟时钟（业务时间） */
  virtualNow: number;
  batches: Batch[];
  nodes: ItemNode[];
  families: Family[];
  needs: Need[];
  vouchers: Voucher[];
  deliveries: Delivery[];
  pendingReturns: PendingReturn[];
  reclaims: Reclaim[];
  receipts: Receipt[];
  commandLog: CommandLogEntry[];
  seqCounter: number;
  /** 包编号序号（按包型分别计数：SET-/PK4-/RPK-） */
  packSeq: Record<PackKind, number>;
  /** 封签序号 */
  sealSeq: number;
}

export type Command =
  | { type: 'RegisterFamily'; commandId: string; input: { name: string; memberNames: string[] } }
  | { type: 'SplitFamily'; commandId: string; familyId: string; newName: string; needIds: string[] }
  | { type: 'SealPack'; commandId: string; packKind: PackKind; childIds: string[] }
  | { type: 'OpenPack'; commandId: string; packId: string }
  | { type: 'DetachChild'; commandId: string; childId: string }
  | { type: 'MoveStock'; commandId: string; nodeIds: string[]; to: 'warehouse' | 'counter' }
  | { type: 'Deliver'; commandId: string; familyId: string; nodeIds: string[] }
  | {
      type: 'ReceiveReturn';
      commandId: string;
      familyId: string;
      items: { itemId: string; condition: 'unused' | 'used' | 'damaged' }[];
    }
  | {
      type: 'Reclaim';
      commandId: string;
      familyId: string;
      needId: string;
      itemType: 'mat' | 'blanket';
      reason: string;
      replacementNodeId: string;
    }
  | { type: 'CompleteCleaning'; commandId: string; itemIds: string[] }
  | { type: 'AdvanceClock'; commandId: string; toVirtual: number }
  | { type: 'ResetDemo'; commandId: string };

export interface CmdCtx {
  role: Role;
  realNow: number;
}

export interface CmdOutcome {
  state: BeddingState;
  receipts: Receipt[];
  error?: string;
  /** 是否产生了需要持久化/广播的变化 */
  changed: boolean;
}
