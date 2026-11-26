import type { BeddingState, Family, ItemNode, Need, Voucher } from './types';

/**
 * 虚构演示数据（全部物资编号均为虚构）：
 * - 预封四人包 PK4-01 / PK4-02：各含 4 个一人套（SET-01..08），共 16 件寝具，在库房
 * - 散件一人套 SET-11 / SET-12（各 1 垫 1 毯），在库房
 * - 散件：MAT-101..104、BLK-101..104、备用 MAT-201/202、BLK-201/202，在库房
 *   合计垫子 16 件、毯子 16 件（叶件 32；包壳不计寝具）
 * - 家庭（本夜批次，需求按人、凭证按人份）：
 *   周明一家 3 人、吴刚一家 3 人（超发/待返还 与 现场拣配 两条演示路径）、
 *   郑钱家 2 人（拣配余量 / 缺垫多毯）、陈军一家 4 人（家庭拆分）、林浩家 2 人（套散混用）
 */
export function seedState(): BeddingState {
  const virtualNow = new Date('2026-11-26T21:00:00').getTime();
  const nodes: ItemNode[] = [];
  let sealN = 0;

  const leaf = (label: string, kind: 'mat' | 'blanket', parentId: string | null): ItemNode => ({
    id: `n-${label.toLowerCase()}`,
    label,
    kind,
    parentId,
    holder: parentId ? null : { type: 'warehouse' },
    seal: null,
    brokenSeals: [],
    awaitingReturn: false,
    createdAt: virtualNow,
  });

  const pack = (
    label: string,
    packKind: ItemNode['packKind'],
    parentId: string | null,
  ): ItemNode => ({
    id: `n-${label.toLowerCase()}`,
    label,
    kind: 'pack',
    packKind,
    parentId,
    holder: parentId ? null : { type: 'warehouse' },
    seal: { sealId: `SEAL-${++sealN}`, sealedAt: virtualNow, sealedBy: '仓管员（预封）' },
    brokenSeals: [],
    awaitingReturn: false,
    createdAt: virtualNow,
  });

  // 两个预封四人包：PK4 → SET → 垫/毯
  for (const pk of ['PK4-01', 'PK4-02'] as const) {
    nodes.push(pack(pk, 'four_pack', null));
    const base = pk === 'PK4-01' ? 0 : 4;
    for (let i = 1; i <= 4; i++) {
      const setLabel = `SET-0${base + i}`;
      nodes.push(pack(setLabel, 'one_set', `n-${pk.toLowerCase()}`));
      nodes.push(leaf(`MAT-00${base + i}`, 'mat', `n-${setLabel.toLowerCase()}`));
      nodes.push(leaf(`BLK-00${base + i}`, 'blanket', `n-${setLabel.toLowerCase()}`));
    }
  }
  // 散件一人套
  for (const s of ['SET-11', 'SET-12'] as const) {
    nodes.push(pack(s, 'one_set', null));
    nodes.push(leaf(`MAT-0${s.slice(4)}`, 'mat', `n-${s.toLowerCase()}`));
    nodes.push(leaf(`BLK-0${s.slice(4)}`, 'blanket', `n-${s.toLowerCase()}`));
  }
  // 散件（现场拣配 / 补领换发）
  for (const l of ['MAT-101', 'MAT-102', 'MAT-103', 'MAT-104', 'MAT-201', 'MAT-202']) nodes.push(leaf(l, 'mat', null));
  for (const l of ['BLK-101', 'BLK-102', 'BLK-103', 'BLK-104', 'BLK-201', 'BLK-202']) nodes.push(leaf(l, 'blanket', null));

  const batch = { id: 'batch-night', name: '11月26日 夜间批次' };

  const families: Family[] = [
    { id: 'fam-zhou', name: '周明一家', batchId: batch.id, createdAt: virtualNow },
    { id: 'fam-wu', name: '吴刚一家', batchId: batch.id, createdAt: virtualNow },
    { id: 'fam-zheng', name: '郑钱家', batchId: batch.id, createdAt: virtualNow },
    { id: 'fam-chen', name: '陈军一家', batchId: batch.id, createdAt: virtualNow },
    { id: 'fam-lin', name: '林浩家', batchId: batch.id, createdAt: virtualNow },
  ];
  const members: Record<string, string[]> = {
    'fam-zhou': ['周明', '李婷', '周小宝'],
    'fam-wu': ['吴刚', '张兰', '吴雨'],
    'fam-zheng': ['郑钱', '孙丽'],
    'fam-chen': ['陈军', '王芳', '陈大', '陈二'],
    'fam-lin': ['林浩', '赵敏'],
  };
  const needs: Need[] = [];
  const vouchers: Voucher[] = [];
  for (const f of families) {
    const names = members[f.id];
    names.forEach((personName, i) => {
      needs.push({
        id: `need-${f.id.slice(4)}-${i + 1}`,
        batchId: batch.id,
        familyId: f.id,
        personName,
        matItemId: null,
        blanketItemId: null,
        createdAt: virtualNow,
      });
    });
    vouchers.push({
      id: `vou-${f.id.slice(4)}`,
      familyId: f.id,
      batchId: batch.id,
      portions: names.length,
      consumed: 0,
    });
  }

  return {
    version: 1,
    virtualNow,
    batches: [batch],
    nodes,
    families,
    needs,
    vouchers,
    deliveries: [],
    pendingReturns: [],
    reclaims: [],
    receipts: [
      {
        seq: 1,
        id: 'R1',
        at: virtualNow,
        kind: 'seed',
        actor: '系统',
        summary: '演示数据已就绪（虚构物资与家庭，全部数据仅保存在本浏览器）',
        lines: [
          '库存（库房）：四人包 PK4-01、PK4-02（各4个一人套共8件）；散件一人套 SET-11、SET-12；散垫 6、散毯 6',
          '内部模型：有根包含树——包内物资位置随根继承，整包搬运只改根；核查单件沿父链解析祖先',
          '家庭：周明一家3人、吴刚一家3人、郑钱家2人、陈军一家4人、林浩家2人（需求按人、凭证按人份）',
          '演示时间 21:00（夜间开柜），可用右上角按钮推进时间',
        ],
      },
    ],
    commandLog: [],
    seqCounter: 1,
    packSeq: { one_set: 12, four_pack: 2, repack: 0 },
    sealSeq: sealN,
  };
}
