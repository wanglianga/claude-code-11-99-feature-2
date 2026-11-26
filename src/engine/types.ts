/** 领域模型类型定义：避难所入住与返所工作台 */

/** 操作角色：接待员 / 楼层值班员 / 床位管理员 */
export type Role = 'receptionist' | 'duty' | 'bed_manager';

/** 家庭当前状态（唯一位置口径） */
export type FamilyStatus =
  | 'registered' // 已登记，待安置（无床位）
  | 'draft' // 已有分房草稿（草稿不占床位）
  | 'confirming' // 入住确认中（已预占，尚未计入实际在场）
  | 'checked_in' // 在场在住
  | 'temp_leave' // 暂离在外（持有有效返所承诺）
  | 'checked_out'; // 已退住

export type RoomStatus = 'open' | 'closed';

export type AssignmentStatus =
  | 'draft_open' // 草稿有效
  | 'draft_stale' // 草稿失效（保留输入与冲突原因）
  | 'draft_cancelled'
  | 'confirming' // 入住确认中
  | 'active' // 正式入住
  | 'ended';

export type PromiseStatus =
  | 'active' // 有效返所承诺
  | 'fulfilled' // 已兑现（家庭已返所）
  | 'expired_contact' // 到期未归，联系核实中（不自动退住）
  | 'cancelled'; // 已取消（核实退住，返所权结束）

/** 床位保护策略：原房原床保留 / 容量保护（事先同意返所换房） */
export type ProtectionStrategy = 'keep_room' | 'capacity';

export interface Room {
  id: string;
  name: string;
  capacity: number;
  accessible: boolean;
  status: RoomStatus;
  closedReason?: string;
}

export interface Family {
  id: string;
  name: string;
  size: number;
  needsAccessible: boolean;
  /** 是否同意与其他家庭共房 */
  coRoomConsent: boolean;
  /** 是否事先同意返所时换房（容量保护策略的前提） */
  consentRoomChange: boolean;
  status: FamilyStatus;
  /** 在场/确认中时所在房间 */
  currentRoomId?: string;
}

export interface Assignment {
  id: string;
  familyId: string;
  roomId: string;
  beds: number;
  kind: 'draft' | 'checkin';
  status: AssignmentStatus;
  createdAt: number;
  confirmedAt?: number;
  endedAt?: number;
  endReason?: string;
  /** 失效草稿的冲突说明（输入保留） */
  conflictReason?: string;
}

/** 返所承诺：暂离家庭的床位权利 */
export interface ReturnPromise {
  id: string;
  familyId: string;
  strategy: ProtectionStrategy;
  /** 保护床位所在房间（keep_room=原房；capacity=保护房） */
  roomId: string;
  /** 暂离前所在房间（用于返所换房说明） */
  originRoomId: string;
  beds: number;
  expectedReturnAt: number;
  status: PromiseStatus;
  createdAt: number;
  fulfilledAt?: number;
  cancelledAt?: number;
}

/** 承诺到期未归产生的联系核实任务（不自动退住） */
export interface ContactTask {
  id: string;
  familyId: string;
  promiseId: string;
  createdAt: number;
  status: 'open' | 'resolved';
  resolution?: string;
  resolvedAt?: number;
  notes: string[];
}

/** 操作回执（可推进工作流程） */
export interface Receipt {
  seq: number;
  id: string;
  at: number;
  kind: string;
  actor: string;
  summary: string;
  lines: string[];
  /** 异步确认类回执：已提交、待完成 */
  pending?: boolean;
  /** 重复提交被幂等忽略时，指向原回执 */
  duplicateOf?: string;
}

/** 本地模拟适配器的异步确认单 */
export interface PendingConfirmation {
  id: string;
  kind: 'checkin' | 'checkout';
  familyId: string;
  assignmentId?: string;
  submittedAtReal: number;
  resolveAtReal: number;
  atVirtual: number;
  actor: Role;
}

export interface CommandLogEntry {
  commandId: string;
  at: number;
  ok: boolean;
  summary: string;
  receiptIds: string[];
}

export interface ShelterState {
  version: number;
  /** 演示用虚拟时钟（业务时间，如承诺到期的判定依据） */
  virtualNow: number;
  rooms: Room[];
  families: Family[];
  assignments: Assignment[];
  promises: ReturnPromise[];
  contactTasks: ContactTask[];
  receipts: Receipt[];
  pending: PendingConfirmation[];
  commandLog: CommandLogEntry[];
  seqCounter: number;
}

export type Command =
  | { type: 'RegisterFamily'; commandId: string; input: { name: string; size: number; needsAccessible: boolean; coRoomConsent: boolean; consentRoomChange: boolean } }
  | { type: 'CreateDraft'; commandId: string; familyId: string; roomId: string }
  | { type: 'CancelDraft'; commandId: string; assignmentId: string }
  | { type: 'SubmitCheckIn'; commandId: string; assignmentId: string }
  | { type: 'RegisterLeave'; commandId: string; familyId: string; strategy: ProtectionStrategy; protectionRoomId?: string; expectedReturnAt: number }
  | { type: 'ConfirmReturn'; commandId: string; familyId: string }
  | { type: 'ExtendPromise'; commandId: string; familyId: string; newExpectedReturnAt: number }
  | { type: 'SubmitCheckout'; commandId: string; familyId: string }
  | { type: 'AddTaskNote'; commandId: string; taskId: string; note: string }
  | { type: 'CloseRoom'; commandId: string; roomId: string; reason: string }
  | { type: 'ReopenRoom'; commandId: string; roomId: string }
  | { type: 'AdvanceClock'; commandId: string; toVirtual: number }
  | { type: 'ResetDemo'; commandId: string }
  | { type: 'FinalizeDue'; commandId: string };

export interface CmdCtx {
  role: Role;
  realNow: number;
}

export interface CmdOutcome {
  state: ShelterState;
  receipts: Receipt[];
  error?: string;
  /** 是否产生了需要持久化/广播的变化 */
  changed: boolean;
}
