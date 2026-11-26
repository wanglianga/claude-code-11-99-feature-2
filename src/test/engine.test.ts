import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  checkInvariants,
  counterStats,
  effectiveStatus,
  fullyCovered,
  leafStats,
  needsOf,
  nodeById,
  openReclaimOf,
  voucherOf,
} from '../engine/engine';
import { seedState } from '../engine/seed';
import type { BeddingState, Command, Role } from '../engine/types';

let cid = 0;
const nid = () => `test-${++cid}`;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type AnyCmd = DistributiveOmit<Command, 'commandId'> & { commandId?: string };

function run(state: BeddingState, cmd: AnyCmd, role: Role = 'counter', realNow = 10_000) {
  const full = { ...cmd, commandId: cmd.commandId ?? nid() } as Command;
  return applyCommand(state, full, { role, realNow });
}

/** 断言命令成功并返回新状态 */
function ok(state: BeddingState, cmd: AnyCmd, role: Role = 'counter'): BeddingState {
  const out = run(state, cmd, role);
  if (out.error) throw new Error(`命令意外失败: ${out.error}`);
  return out.state;
}

function fail(state: BeddingState, cmd: AnyCmd, role: Role = 'counter'): string {
  const out = run(state, cmd, role);
  if (!out.error) throw new Error('命令意外成功');
  return out.error;
}

function expectInvariantsOk(state: BeddingState) {
  const bad = checkInvariants(state).filter((r) => !r.ok);
  expect(bad.map((b) => `${b.name}: ${b.detail}`)).toEqual([]);
}

const byLabel = (s: BeddingState, label: string) => {
  const n = s.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`节点不存在: ${label}`);
  return n;
};
const idOf = (s: BeddingState, label: string) => byLabel(s, label).id;

/** 常用前置：把指定标签物资（根）送到领取柜 */
function toCounter(state: BeddingState, labels: string[]): BeddingState {
  return ok(
    state,
    { type: 'MoveStock', nodeIds: labels.map((l) => idOf(state, l)), to: 'counter' },
    'keeper',
  );
}

describe('包含树模型：整包移动、开封取件、重封', () => {
  it('四人包整包送到领取柜：树模型只更新一个根位置，8件位置随根继承', () => {
    let s = seedState();
    s = toCounter(s, ['PK4-01']);
    const pk = byLabel(s, 'PK4-01');
    expect(pk.holder).toEqual({ type: 'counter' });
    // 子件不持位置（继承根），仅根节点位置变化
    const mat1 = byLabel(s, 'MAT-001');
    expect(mat1.holder).toBeNull();
    expect(mat1.parentId).toBe(idOf(s, 'SET-01'));
    expect(effectiveStatus(s, mat1)).toBe('in_pack');
    // 包内 8 件都在领取柜
    expect(leafStats(s, pk.id)).toMatchObject({ mats: 4, blankets: 4, leaves: 8, portions: 4 });
    expectInvariantsOk(s);
  });

  it('开封取出一套、重封三人包：6件在包内、2件在现场，包壳不计寝具', () => {
    let s = seedState();
    s = toCounter(s, ['PK4-01']);
    s = ok(s, { type: 'OpenPack', packId: idOf(s, 'PK4-01') }, 'keeper');
    expect(byLabel(s, 'PK4-01').seal).toBeNull();
    expect(byLabel(s, 'PK4-01').brokenSeals).toHaveLength(1);
    // 取出一套（仍为密封一人套）
    s = ok(s, { type: 'DetachChild', childId: idOf(s, 'SET-01') }, 'keeper');
    expect(byLabel(s, 'SET-01').parentId).toBeNull();
    expect(byLabel(s, 'SET-01').holder).toEqual({ type: 'counter' });
    // 重封三人包
    s = ok(
      s,
      { type: 'SealPack', packKind: 'repack', childIds: ['SET-02', 'SET-03', 'SET-04'].map((l) => idOf(s, l)) },
      'keeper',
    );
    const rpk = s.nodes.find((n) => n.label === 'RPK-01')!;
    expect(rpk.seal).not.toBeNull();
    expect(leafStats(s, rpk.id).leaves).toBe(6); // 6件在包内
    expect(leafStats(s, idOf(s, 'SET-01')).leaves).toBe(2); // 2件在现场
    // 包壳不计寝具：PK4-01 已为空壳，叶件 0
    expect(leafStats(s, idOf(s, 'PK4-01')).leaves).toBe(0);
    // 总叶件守恒
    const stats = counterStats(s);
    expect(stats.totalMats + stats.totalBlankets).toBe(32);
    expectInvariantsOk(s);
  });

  it('跨层拆包须自外而内：外层未开封时内层不可拆', () => {
    let s = seedState();
    s = toCounter(s, ['PK4-01']);
    // 四人包未开封时直接拆一人套 → 拒绝
    const err = fail(s, { type: 'OpenPack', packId: idOf(s, 'SET-01') }, 'keeper');
    expect(err).toContain('须先开封外层包');
    // 自外而内：开四人包 → 取出一套 → 开一人套 → 取出垫子
    s = ok(s, { type: 'OpenPack', packId: idOf(s, 'PK4-01') }, 'keeper');
    s = ok(s, { type: 'DetachChild', childId: idOf(s, 'SET-01') }, 'keeper');
    s = ok(s, { type: 'OpenPack', packId: idOf(s, 'SET-01') }, 'keeper');
    s = ok(s, { type: 'DetachChild', childId: idOf(s, 'MAT-001') }, 'keeper');
    expect(byLabel(s, 'MAT-001').parentId).toBeNull();
    expect(effectiveStatus(s, idOf(s, 'MAT-001'))).toBe('available');
    expectInvariantsOk(s);
  });

  it('一件不能有两个当前父包；已封包内物资须先开封才能再封', () => {
    let s = seedState();
    // MAT-001 在已封 SET-01 内 → 不能作为封包材料
    const err = fail(s, { type: 'SealPack', packKind: 'one_set', childIds: [idOf(s, 'MAT-001'), idOf(s, 'BLK-101')] }, 'keeper');
    expect(err).toContain('须先开封');
    // 组成核验：一人套须 1 垫 1 毯，不能额外增加
    const err2 = fail(
      s,
      { type: 'SealPack', packKind: 'one_set', childIds: [idOf(s, 'MAT-101'), idOf(s, 'MAT-102')] },
      'keeper',
    );
    expect(err2).toContain('1 垫 1 毯');
    // 合法封装：MAT-101 + BLK-101 → 新一人套
    s = ok(s, { type: 'SealPack', packKind: 'one_set', childIds: [idOf(s, 'MAT-101'), idOf(s, 'BLK-101')] }, 'keeper');
    const set = s.nodes.find((n) => n.label === 'SET-13')!;
    expect(byLabel(s, 'MAT-101').parentId).toBe(set.id);
    expect(byLabel(s, 'MAT-101').holder).toBeNull();
    expectInvariantsOk(s);
  });
});

describe('交付：凭证原子核销、并发冲突、两种工作方式', () => {
  it('整包交付与取单件并发：交付后开封被拒，子件不可单独动用', () => {
    let s = seedState();
    s = toCounter(s, ['PK4-01']);
    s = ok(s, { type: 'Deliver', familyId: 'fam-zhou', nodeIds: [idOf(s, 'PK4-01')] });
    // 包已交付 → 不能开封
    const err = fail(s, { type: 'OpenPack', packId: idOf(s, 'PK4-01') }, 'keeper');
    expect(err).toContain('已交付');
    // 包已交付 → 子件不能单独交付（包已交付而子件仍可用 不得出现）
    expect(effectiveStatus(s, idOf(s, 'MAT-001'))).toBe('delivered');
    const err2 = fail(s, { type: 'Deliver', familyId: 'fam-wu', nodeIds: [idOf(s, 'MAT-001')] });
    expect(err2).toContain('包');
    // 已交付包也不能移动
    const err3 = fail(s, { type: 'MoveStock', nodeIds: [idOf(s, 'PK4-01')], to: 'warehouse' }, 'keeper');
    expect(err3).toContain('已交付');
    expectInvariantsOk(s);
  });

  it('整包交付与取单件并发（另一顺序）：开封后整包交付被拒', () => {
    let s = seedState();
    s = toCounter(s, ['PK4-01']);
    s = ok(s, { type: 'OpenPack', packId: idOf(s, 'PK4-01') }, 'keeper');
    const err = fail(s, { type: 'Deliver', familyId: 'fam-zhou', nodeIds: [idOf(s, 'PK4-01')] });
    expect(err).toContain('已开封');
    expectInvariantsOk(s);
  });

  it('两个三人家庭各领一个四人包：共多出两人份，先记待返还', () => {
    let s = seedState();
    s = toCounter(s, ['PK4-01', 'PK4-02']);
    s = ok(s, { type: 'Deliver', familyId: 'fam-zhou', nodeIds: [idOf(s, 'PK4-01')] });
    s = ok(s, { type: 'Deliver', familyId: 'fam-wu', nodeIds: [idOf(s, 'PK4-02')] });
    // 凭证按 3 人份核销
    expect(voucherOf(s, 'fam-zhou')).toMatchObject({ portions: 3, consumed: 3 });
    expect(voucherOf(s, 'fam-wu')).toMatchObject({ portions: 3, consumed: 3 });
    // 每家多出 1 人份（垫1毯1）→ 共两人份待返还
    expect(s.pendingReturns).toHaveLength(2);
    expect(s.pendingReturns[0]).toMatchObject({ familyId: 'fam-zhou', matsOwed: 1, blanketsOwed: 1, status: 'open' });
    expect(s.pendingReturns[1]).toMatchObject({ familyId: 'fam-wu', matsOwed: 1, blanketsOwed: 1, status: 'open' });
    // 需求覆盖按人算：两家 6 人全覆盖
    expect(needsOf(s, 'fam-zhou').every(fullyCovered)).toBe(true);
    expect(needsOf(s, 'fam-wu').every(fullyCovered)).toBe(true);
    expectInvariantsOk(s);
  });

  it('待返还：清点实收且确认为未用才可重发；已用入清洁、报损入报损', () => {
    let s = seedState();
    s = toCounter(s, ['PK4-01']);
    s = ok(s, { type: 'Deliver', familyId: 'fam-zhou', nodeIds: [idOf(s, 'PK4-01')] });
    // 超出的正是一套（MAT-004 + BLK-004，按编号顺序分配后剩余）
    s = ok(s, {
      type: 'ReceiveReturn',
      familyId: 'fam-zhou',
      items: [
        { itemId: idOf(s, 'MAT-004'), condition: 'unused' },
        { itemId: idOf(s, 'BLK-004'), condition: 'unused' },
      ],
    });
    // 待返还清讫；未用件回库可重发
    expect(s.pendingReturns[0].status).toBe('closed');
    expect(effectiveStatus(s, idOf(s, 'MAT-004'))).toBe('available');
    expect(byLabel(s, 'MAT-004').holder).toEqual({ type: 'warehouse' });
    // 退回时祖先封签自动失效（家庭开封取件），留痕可查
    expect(byLabel(s, 'SET-04').seal).toBeNull();
    expect(byLabel(s, 'SET-04').brokenSeals.length).toBeGreaterThan(0);
    // 重发：送到柜台交付给郑钱家
    s = toCounter(s, ['MAT-004', 'BLK-004']);
    s = ok(s, { type: 'Deliver', familyId: 'fam-zheng', nodeIds: [idOf(s, 'MAT-004'), idOf(s, 'BLK-004')] });
    expect(voucherOf(s, 'fam-zheng')!.consumed).toBe(1);
    // 已用退回 → 待清洁；报损退回 → 报损
    const zhouMat = needsOf(s, 'fam-zhou')[0].matItemId!;
    const zhouBlk = needsOf(s, 'fam-zhou')[0].blanketItemId!;
    s = ok(s, {
      type: 'ReceiveReturn',
      familyId: 'fam-zhou',
      items: [
        { itemId: zhouMat, condition: 'used' },
        { itemId: zhouBlk, condition: 'damaged' },
      ],
    });
    expect(effectiveStatus(s, zhouMat)).toBe('cleaning');
    expect(effectiveStatus(s, zhouBlk)).toBe('damaged');
    // 完成清洁 → 回库可用
    s = ok(s, { type: 'CompleteCleaning', itemIds: [zhouMat] }, 'keeper');
    expect(effectiveStatus(s, zhouMat)).toBe('available');
    expectInvariantsOk(s);
  });

  it('现场拣配：各拣3份则余2份可直接给后来两人家庭（与整包超发对照）', () => {
    let s = seedState();
    s = toCounter(s, ['PK4-01', 'PK4-02']);
    // 现场开封两个四人包，取出全部 8 个一人套
    for (const pk of ['PK4-01', 'PK4-02']) s = ok(s, { type: 'OpenPack', packId: idOf(s, pk) }, 'keeper');
    for (const set of ['SET-01', 'SET-02', 'SET-03', 'SET-04', 'SET-05', 'SET-06', 'SET-07', 'SET-08'])
      s = ok(s, { type: 'DetachChild', childId: idOf(s, set) }, 'keeper');
    // 两个三人家庭各拣 3 套：恰好核销，无待返还
    s = ok(s, { type: 'Deliver', familyId: 'fam-zhou', nodeIds: ['SET-01', 'SET-02', 'SET-03'].map((l) => idOf(s, l)) });
    s = ok(s, { type: 'Deliver', familyId: 'fam-wu', nodeIds: ['SET-05', 'SET-06', 'SET-07'].map((l) => idOf(s, l)) });
    expect(s.pendingReturns).toHaveLength(0);
    expect(voucherOf(s, 'fam-zhou')!.consumed).toBe(3);
    expect(voucherOf(s, 'fam-wu')!.consumed).toBe(3);
    // 余 2 套直接给后来两人家庭
    s = ok(s, { type: 'Deliver', familyId: 'fam-zheng', nodeIds: ['SET-04', 'SET-08'].map((l) => idOf(s, l)) });
    expect(voucherOf(s, 'fam-zheng')!.consumed).toBe(2);
    expect(s.pendingReturns).toHaveLength(0);
    expectInvariantsOk(s);
  });

  it('套散混用：一人套 + 散垫散毯混合交付', () => {
    let s = seedState();
    s = toCounter(s, ['SET-11', 'MAT-101', 'BLK-101']);
    s = ok(s, { type: 'Deliver', familyId: 'fam-lin', nodeIds: [idOf(s, 'SET-11'), idOf(s, 'MAT-101'), idOf(s, 'BLK-101')] });
    const needs = needsOf(s, 'fam-lin');
    expect(needs.every(fullyCovered)).toBe(true);
    expect(voucherOf(s, 'fam-lin')).toMatchObject({ portions: 2, consumed: 2 });
    expect(s.pendingReturns).toHaveLength(0);
    expectInvariantsOk(s);
  });

  it('缺垫多毯：覆盖按人算，毯多不抵垫；补垫后覆盖', () => {
    let s = seedState();
    s = toCounter(s, ['MAT-101', 'BLK-101', 'BLK-102']);
    s = ok(s, { type: 'Deliver', familyId: 'fam-zheng', nodeIds: [idOf(s, 'MAT-101'), idOf(s, 'BLK-101'), idOf(s, 'BLK-102')] });
    const [n1, n2] = needsOf(s, 'fam-zheng');
    expect(fullyCovered(n1)).toBe(true);
    // 第二人有毯无垫 → 未覆盖；多出的毯记在其名下，不算覆盖、也不算超发
    expect(n2.blanketItemId).not.toBeNull();
    expect(n2.matItemId).toBeNull();
    expect(fullyCovered(n2)).toBe(false);
    expect(voucherOf(s, 'fam-zheng')!.consumed).toBe(1);
    expect(s.pendingReturns).toHaveLength(0);
    // 补发一垫后覆盖
    s = toCounter(s, ['MAT-102']);
    s = ok(s, { type: 'Deliver', familyId: 'fam-zheng', nodeIds: [idOf(s, 'MAT-102')] });
    expect(needsOf(s, 'fam-zheng').every(fullyCovered)).toBe(true);
    expect(voucherOf(s, 'fam-zheng')!.consumed).toBe(2);
    expectInvariantsOk(s);
  });

  it('交付核验：库房物资与已开封包壳不能交付', () => {
    let s = seedState();
    const err = fail(s, { type: 'Deliver', familyId: 'fam-lin', nodeIds: [idOf(s, 'SET-11')] });
    expect(err).toContain('库房');
    s = toCounter(s, ['SET-11']);
    s = ok(s, { type: 'OpenPack', packId: idOf(s, 'SET-11') }, 'keeper');
    const err2 = fail(s, { type: 'Deliver', familyId: 'fam-lin', nodeIds: [idOf(s, 'SET-11')] });
    expect(err2).toContain('已开封');
    expectInvariantsOk(s);
  });
});

describe('家庭拆分：领取权守恒', () => {
  it('拆成两户不重新生成领取权：需求随人转移、凭证合计不变', () => {
    let s = seedState();
    // 先交付 2 人份给陈军一家（4人）
    s = toCounter(s, ['MAT-101', 'BLK-101', 'MAT-102', 'BLK-102']);
    s = ok(s, {
      type: 'Deliver',
      familyId: 'fam-chen',
      nodeIds: [idOf(s, 'MAT-101'), idOf(s, 'BLK-101'), idOf(s, 'MAT-102'), idOf(s, 'BLK-102')],
    });
    expect(voucherOf(s, 'fam-chen')).toMatchObject({ portions: 4, consumed: 2 });
    // 拆出未覆盖的陈大、陈二为新户
    const moveIds = needsOf(s, 'fam-chen')
      .filter((n) => !fullyCovered(n))
      .map((n) => n.id);
    s = ok(s, { type: 'SplitFamily', familyId: 'fam-chen', newName: '陈二家', needIds: moveIds });
    const newFam = s.families.find((f) => f.name === '陈二家')!;
    expect(newFam.splitFromId).toBe('fam-chen');
    // 权利守恒：4 = 2 + 2；已核销随覆盖转移 2 = 2 + 0
    expect(voucherOf(s, 'fam-chen')).toMatchObject({ portions: 2, consumed: 2 });
    expect(voucherOf(s, newFam.id)).toMatchObject({ portions: 2, consumed: 0 });
    const totalPortions = s.vouchers.reduce((sum, v) => sum + v.portions, 0);
    expect(totalPortions).toBe(14);
    // 需求单号不变、归属已改
    const moved = needsOf(s, newFam.id);
    expect(moved.map((n) => n.id)).toEqual(moveIds);
    // 全部迁出不是拆分
    const err = fail(s, {
      type: 'SplitFamily',
      familyId: 'fam-chen',
      newName: 'x',
      needIds: needsOf(s, 'fam-chen').map((n) => n.id),
    });
    expect(err).toContain('保留至少 1 人');
    expectInvariantsOk(s);
  });
});

describe('补领：原因、旧物待退回、重复核对、查原交付', () => {
  function deliveredLin(): BeddingState {
    let s = seedState();
    s = toCounter(s, ['SET-11', 'SET-12', 'BLK-101', 'MAT-101']);
    s = ok(s, { type: 'Deliver', familyId: 'fam-lin', nodeIds: [idOf(s, 'SET-11'), idOf(s, 'SET-12')] });
    return s;
  }

  it('补领须给原因；旧物实际退回前不得入清洁或报损（申请≠已回）', () => {
    let s = deliveredLin();
    const need = needsOf(s, 'fam-lin')[0];
    const oldBlk = need.blanketItemId!;
    // 不给原因 → 拒绝
    const err0 = fail(s, { type: 'Reclaim', familyId: 'fam-lin', needId: need.id, itemType: 'blanket', reason: ' ', replacementNodeId: idOf(s, 'BLK-101') });
    expect(err0).toContain('原因');
    s = ok(s, { type: 'Reclaim', familyId: 'fam-lin', needId: need.id, itemType: 'blanket', reason: '毯子被水浸湿', replacementNodeId: idOf(s, 'BLK-101') });
    // 新件已交付并覆盖需求；凭证不新增核销
    expect(needsOf(s, 'fam-lin')[0].blanketItemId).toBe(idOf(s, 'BLK-101'));
    expect(voucherOf(s, 'fam-lin')!.consumed).toBe(2);
    // 旧件标记待退回，但仍在已交付态：申请提交 ≠ 旧物已回
    const old = nodeById(s, oldBlk);
    expect(old.awaitingReturn).toBe(true);
    expect(effectiveStatus(s, old)).toBe('delivered');
    expect(openReclaimOf(s, need.id, 'blanket')).toBeTruthy();
    expectInvariantsOk(s);
    // 旧物实际退回 → 进入待清洁，补领闭环
    s = ok(s, { type: 'ReceiveReturn', familyId: 'fam-lin', items: [{ itemId: oldBlk, condition: 'used' }] });
    expect(effectiveStatus(s, oldBlk)).toBe('cleaning');
    expect(s.reclaims[0].status).toBe('closed');
    expectInvariantsOk(s);
  });

  it('重复补领核对：同一需求同一品类不得重复申请', () => {
    let s = deliveredLin();
    const need = needsOf(s, 'fam-lin')[0];
    s = ok(s, { type: 'Reclaim', familyId: 'fam-lin', needId: need.id, itemType: 'blanket', reason: '遗失', replacementNodeId: idOf(s, 'BLK-101') });
    const err = fail(s, { type: 'Reclaim', familyId: 'fam-lin', needId: need.id, itemType: 'blanket', reason: '又丢了', replacementNodeId: idOf(s, 'BLK-102') });
    expect(err).toContain('重复补领');
    expectInvariantsOk(s);
  });

  it('响应丢失查原交付：旧件不能由他家庭退回，不再领一次', () => {
    let s = deliveredLin();
    const need = needsOf(s, 'fam-lin')[0];
    const oldBlk = need.blanketItemId!;
    s = ok(s, { type: 'Reclaim', familyId: 'fam-lin', needId: need.id, itemType: 'blanket', reason: '遗失', replacementNodeId: idOf(s, 'BLK-101') });
    // 遗失旧件仍记在原交付上；其他家庭不能代为退回
    const err = fail(s, { type: 'ReceiveReturn', familyId: 'fam-zhou', items: [{ itemId: oldBlk, condition: 'unused' }] });
    expect(err).toContain('原始交付单');
    // 换发新件不消耗新凭证份数（不再领一次）
    expect(voucherOf(s, 'fam-lin')!.consumed).toBe(2);
    expect(s.deliveries.filter((d) => d.kind === 'reclaim')).toHaveLength(1);
    expectInvariantsOk(s);
  });
});

describe('幂等与权限', () => {
  it('相同 commandId 重发只生效一次并开具重复回执', () => {
    let s = seedState();
    s = toCounter(s, ['SET-11']);
    const cmd: Command = { type: 'Deliver', commandId: 'dup-1', familyId: 'fam-lin', nodeIds: [idOf(s, 'SET-11')] };
    const out1 = run(s, cmd);
    expect(out1.error).toBeUndefined();
    const s1 = out1.state;
    const out2 = run(s1, cmd);
    expect(out2.error).toBeUndefined();
    // 状态未二次变化：交付仍一笔、核销仍一份
    expect(out2.state.deliveries).toHaveLength(1);
    expect(voucherOf(out2.state, 'fam-lin')!.consumed).toBe(1);
    expect(out2.receipts[0].kind).toBe('duplicate_submission');
    expectInvariantsOk(out2.state);
  });

  it('角色权限：仓管/柜台/稽核分工', () => {
    let s = seedState();
    // 柜台职员不能封包
    expect(fail(s, { type: 'SealPack', packKind: 'one_set', childIds: [idOf(s, 'MAT-101'), idOf(s, 'BLK-101')] }, 'counter')).toContain('无权');
    // 仓管员不能交付
    expect(fail(s, { type: 'Deliver', familyId: 'fam-lin', nodeIds: [idOf(s, 'SET-11')] }, 'keeper')).toContain('无权');
    // 稽核员只读
    expect(fail(s, { type: 'RegisterFamily', input: { name: 'x', memberNames: ['y'] } }, 'auditor')).toContain('无权');
    s = ok(s, { type: 'RegisterFamily', input: { name: '孙强一家', memberNames: ['孙强', '周洁'] } }, 'counter');
    expect(s.families.some((f) => f.name === '孙强一家')).toBe(true);
    expect(voucherOf(s, s.families.find((f) => f.name === '孙强一家')!.id)).toMatchObject({ portions: 2, consumed: 0 });
    expectInvariantsOk(s);
  });
});

describe('全场景链核对', () => {
  it('封拆包→交付→退回→补领→拆分→清洁 全链后两个计数始终一致', () => {
    let s = seedState();
    // 仓管：整包到柜 + 散件到柜
    s = toCounter(s, ['PK4-01', 'SET-11', 'MAT-101', 'BLK-101']);
    // 柜台：周家整包领四人包（超 1 人份）
    s = ok(s, { type: 'Deliver', familyId: 'fam-zhou', nodeIds: [idOf(s, 'PK4-01')] });
    // 柜台：林浩家套散混用
    s = ok(s, { type: 'Deliver', familyId: 'fam-lin', nodeIds: [idOf(s, 'SET-11'), idOf(s, 'MAT-101'), idOf(s, 'BLK-101')] });
    // 柜台：周家退回多出的一套（未用）
    s = ok(s, {
      type: 'ReceiveReturn',
      familyId: 'fam-zhou',
      items: [
        { itemId: idOf(s, 'MAT-004'), condition: 'unused' },
        { itemId: idOf(s, 'BLK-004'), condition: 'unused' },
      ],
    });
    // 柜台：林浩补领一垫（原因：破损），旧垫待退回
    const linNeed = needsOf(s, 'fam-lin')[0];
    s = toCounter(s, ['MAT-102']);
    s = ok(s, { type: 'Reclaim', familyId: 'fam-lin', needId: linNeed.id, itemType: 'mat', reason: '垫子破损', replacementNodeId: idOf(s, 'MAT-102') });
    // 柜台：旧垫实际退回（报损）
    s = ok(s, { type: 'ReceiveReturn', familyId: 'fam-lin', items: [{ itemId: linNeed.matItemId!, condition: 'damaged' }] });
    // 柜台：陈家拆分
    const chenUncovered = needsOf(s, 'fam-chen').slice(2).map((n) => n.id);
    s = ok(s, { type: 'SplitFamily', familyId: 'fam-chen', newName: '陈大家', needIds: chenUncovered });
    // 仓管：重封周家退回的一套并再次交付给郑钱家
    s = toCounter(s, ['MAT-004', 'BLK-004']);
    s = ok(s, { type: 'SealPack', packKind: 'one_set', childIds: [idOf(s, 'MAT-004'), idOf(s, 'BLK-004')] }, 'keeper');
    const newSet = s.nodes.find((n) => n.label === 'SET-13')!;
    s = ok(s, { type: 'Deliver', familyId: 'fam-zheng', nodeIds: [newSet.id] });
    // 两个计数：需求覆盖按人算、物资按叶件算
    const stats = counterStats(s);
    expect(stats.needsCovered).toBe(stats.portionsConsumed);
    expect(stats.totalMats + stats.totalBlankets).toBe(32);
    const byStatusSum = Object.values(stats.byStatus).reduce((sum, b) => sum + b.mats + b.blankets, 0);
    expect(byStatusSum).toBe(32);
    expectInvariantsOk(s);
  });
});
