import { useMemo, useState } from 'react';
import {
  ITEM_KIND_LABEL,
  ITEM_STATUS_LABEL,
  PACK_KIND_LABEL,
  childrenOf,
  counterStats,
  deliverableRoots,
  effectiveStatus,
  fullyCovered,
  isLeaf,
  leafStats,
  leavesOf,
  locationLabel,
  needsOf,
  nodeById,
  openReclaimOf,
  originalDeliveryOfItem,
  packPathOf,
  planDelivery,
  rootOf,
  sealableNodes,
  voucherOf,
} from '../engine/engine';
import { fmtDateTime } from '../engine/format';
import type { BeddingState, Command, ItemNode, Need, PackKind } from '../engine/types';
import type { ItemStatus } from '../engine/engine';
import { Badge, PageProps, StatusBadge } from './components';

// ---------------------------------------------------------------------------
// 页面一：封拆包装（仓管员）
// ---------------------------------------------------------------------------

export function PackPage({ state, role, exec }: PageProps) {
  const isKeeper = role === 'keeper';
  const [selected, setSelected] = useState<string[]>([]);
  const [packKind, setPackKind] = useState<PackKind>('repack');

  const sealable = useMemo(() => new Set(sealableNodes(state).map((n) => n.id)), [state]);
  const isEmptyShell = (n: ItemNode) => n.kind === 'pack' && !n.seal && childrenOf(state, n.id).length === 0;
  const roots = state.nodes.filter((n) => n.parentId === null);
  const whRoots = roots.filter((n) => n.holder?.type === 'warehouse' && !isEmptyShell(n));
  const ctRoots = roots.filter((n) => n.holder?.type === 'counter' && !isEmptyShell(n));
  const shells = roots.filter(isEmptyShell);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const selNodes = selected.map((id) => state.nodes.find((n) => n.id === id)).filter(Boolean) as ItemNode[];
  const selMats = selNodes.filter((n) => n.kind === 'mat').length;
  const selBlankets = selNodes.filter((n) => n.kind === 'blanket').length;
  const selSets = selNodes.filter((n) => n.packKind === 'one_set').length;
  const kindHint =
    packKind === 'one_set'
      ? `一人套包须恰好 1 垫 1 毯（当前：垫${selMats} 毯${selBlankets}）`
      : packKind === 'four_pack'
        ? `四人包须恰好 4 个一人套（当前：${selSets} 个一人套）`
        : `重封包可装任意已封套包与散件（当前 ${selNodes.length} 件）`;

  const renderNode = (n: ItemNode, depth: number): React.ReactNode => {
    const kids = childrenOf(state, n.id);
    const st = n.kind === 'pack' ? leafStats(state, n.id) : null;
    const parent = n.parentId ? state.nodes.find((p) => p.id === n.parentId) : null;
    const canDetach = !!parent && !parent.seal && sealable.has(n.id);
    const canOpen = n.kind === 'pack' && !!n.seal && (() => {
      // 外层包均已开封时才可开封（与引擎一致）
      try {
        const path = packPathOf(state, n.id);
        return path.slice(0, -1).every((a) => !a.seal) && ['warehouse', 'counter'].includes(rootOf(state, n.id).holder!.type);
      } catch {
        return false;
      }
    })();
    return (
      <div key={n.id}>
        <div className="tree-row" style={{ paddingLeft: depth * 20 }}>
          {sealable.has(n.id) && (
            <input
              type="checkbox"
              title="选为封包材料"
              checked={selected.includes(n.id)}
              disabled={!isKeeper}
              onChange={() => toggle(n.id)}
            />
          )}
          <span className="tree-label">{n.label}</span>
          <Badge
            text={n.kind === 'pack' ? PACK_KIND_LABEL[n.packKind!] : ITEM_KIND_LABEL[n.kind]}
            tone={n.kind === 'pack' ? 'blue' : n.kind === 'mat' ? 'green' : 'orange'}
          />
          {n.kind === 'pack' &&
            (n.seal ? <Badge text={`封签 ${n.seal.sealId}`} tone="green" /> : <Badge text="已开封" tone="orange" />)}
          {st && (
            <span className="muted">
              叶件 {st.leaves}（垫{st.mats} 毯{st.blankets}，{st.portions}人份）
            </span>
          )}
          <span className="tree-actions">
            {n.parentId === null && (n.holder?.type === 'warehouse' || n.holder?.type === 'counter') && (
              <button
                className="mini"
                disabled={!isKeeper}
                title={isKeeper ? '整包/单件移动：包含树模型仅更新根节点位置' : '需仓管员角色'}
                onClick={() =>
                  void exec({ type: 'MoveStock', nodeIds: [n.id], to: n.holder!.type === 'warehouse' ? 'counter' : 'warehouse' })
                }
              >
                {n.holder!.type === 'warehouse' ? '送到领取柜' : '送回库房'}
              </button>
            )}
            {canOpen && (
              <button
                className="mini"
                disabled={!isKeeper}
                title={isKeeper ? '破封签，内容物留在已开封包内' : '需仓管员角色'}
                onClick={() => void exec({ type: 'OpenPack', packId: n.id })}
              >
                开封
              </button>
            )}
            {canDetach && (
              <button
                className="mini"
                disabled={!isKeeper}
                title={isKeeper ? '从已开封的包中取出（成为顶层）' : '需仓管员角色'}
                onClick={() => void exec({ type: 'DetachChild', childId: n.id })}
              >
                取出
              </button>
            )}
          </span>
        </div>
        {kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  const submitSeal = async () => {
    const ok = await exec({ type: 'SealPack', packKind, childIds: selected });
    if (ok) setSelected([]);
  };

  return (
    <div>
      <div className="card">
        <div className="panel-title">封包工作台（仓管员）</div>
        <div className="muted">
          内部模型：有根包含树——包内物资位置随根继承，整包搬运只改根；核查单件沿父链解析祖先。勾选可用物资（散件、已封套包、已开封包内的内容物）进行封装；已交付/待清洁/报损物资不可封包。
        </div>
      </div>

      <div className="card panel">
        <div className="panel-title">封包（已选 {selected.length} 件材料）</div>
        <div className="muted">材料：{selNodes.map((n) => n.label).join('、') || '（在下方库存树勾选）'}</div>
        <div className="panel-sub">
          包型：
          <select value={packKind} onChange={(e) => setPackKind(e.target.value as PackKind)}>
            <option value="one_set">一人套包（1垫1毯）</option>
            <option value="four_pack">四人包（4个一人套）</option>
            <option value="repack">重封包（开封后重新封装）</option>
          </select>
          　<span className="muted">{kindHint}</span>
        </div>
        <div className="row-actions">
          <button disabled={!isKeeper || selected.length === 0} title={isKeeper ? '' : '需仓管员角色'} onClick={() => void submitSeal()}>
            封装并打印封签
          </button>
          <button className="ghost" onClick={() => setSelected([])}>
            清空选择
          </button>
        </div>
      </div>

      <div className="card">
        <div className="panel-title">领取柜（现场可用）</div>
        {ctRoots.length === 0 && <div className="muted">（领取柜暂无物资，请从库房送到）</div>}
        {ctRoots.map((n) => renderNode(n, 0))}
      </div>

      <div className="card">
        <div className="panel-title">库房</div>
        {whRoots.length === 0 && <div className="muted">（库房暂无可用物资）</div>}
        {whRoots.map((n) => renderNode(n, 0))}
      </div>

      {shells.length > 0 && (
        <div className="card">
          <div className="panel-title">空包壳（{shells.length}，不计寝具）</div>
          {shells.map((n) => (
            <div key={n.id} className="tree-row">
              <span className="tree-label">{n.label}</span>
              <Badge text="已开封·空壳" tone="gray" />
              <span className="muted">
                封签历史：{n.brokenSeals.map((s) => s.sealId).join('、') || '无'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面二：人员需求（柜台职员）
// ---------------------------------------------------------------------------

export function NeedsPage({ state, role, exec }: PageProps) {
  const isCounter = role === 'counter';
  const [name, setName] = useState('');
  const [membersText, setMembersText] = useState('');
  const [splitFor, setSplitFor] = useState<string | null>(null);
  const stats = counterStats(state);
  const batch = state.batches[0];

  const submitRegister = async () => {
    const memberNames = membersText
      .split(/[\n,，、]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const ok = await exec({ type: 'RegisterFamily', input: { name, memberNames } });
    if (ok) {
      setName('');
      setMembersText('');
    }
  };

  const splitFam = splitFor ? state.families.find((f) => f.id === splitFor) : null;

  return (
    <div>
      <div className="card">
        <div className="panel-title">
          {batch.name} · 需求覆盖 {stats.needsCovered}/{stats.needsTotal} 人 · 凭证核销 {stats.portionsConsumed}/{stats.portionsTotal} 人份
        </div>
        <div className="muted">
          需求与人绑定（每人一垫一毯）、与家庭归属分开：分房或拆成两户只改归属，不重新生成领取权。
        </div>
      </div>

      {state.families.map((f) => {
        const needs = needsOf(state, f.id);
        const v = voucherOf(state, f.id);
        const covered = needs.filter(fullyCovered).length;
        return (
          <div key={f.id} className="card">
            <div className="family-head">
              <span className="family-name">
                {f.name} · {needs.length}人
              </span>
              {f.splitFromId && <Badge text="拆分新户" tone="blue" />}
              <Badge text={`凭证 ${v?.consumed ?? 0}/${v?.portions ?? 0} 人份`} tone={covered === needs.length ? 'green' : 'orange'} />
              <Badge text={`覆盖 ${covered}/${needs.length} 人`} tone={covered === needs.length ? 'green' : 'gray'} />
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>成员</th>
                  <th>垫子</th>
                  <th>毯子</th>
                  <th>覆盖</th>
                </tr>
              </thead>
              <tbody>
                {needs.map((n) => (
                  <tr key={n.id}>
                    <td>{n.personName}</td>
                    <td className={n.matItemId ? 'c-ok' : 'c-bad'}>
                      {n.matItemId ? nodeById(state, n.matItemId).label : '✗ 缺垫'}
                    </td>
                    <td className={n.blanketItemId ? 'c-ok' : 'c-bad'}>
                      {n.blanketItemId ? nodeById(state, n.blanketItemId).label : '✗ 缺毯'}
                    </td>
                    <td>{fullyCovered(n) ? <Badge text="已覆盖" tone="green" /> : <Badge text="未覆盖" tone="orange" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row-actions">
              <button
                className="mini"
                disabled={!isCounter || needs.length < 2}
                title={!isCounter ? '需柜台职员角色' : needs.length < 2 ? '单人不构成拆分' : '迁出部分成员组成新户，领取权转移而非新增'}
                onClick={() => setSplitFor(f.id)}
              >
                拆分成两户
              </button>
            </div>
          </div>
        );
      })}

      {splitFam && (
        <SplitPanel
          state={state}
          familyId={splitFam.id}
          onCancel={() => setSplitFor(null)}
          onSubmit={async (newName, needIds) => {
            const ok = await exec({ type: 'SplitFamily', familyId: splitFam.id, newName, needIds });
            if (ok) setSplitFor(null);
          }}
        />
      )}

      <div className="card">
        <div className="panel-title">新到家庭登记</div>
        <div className="form-grid">
          <label>
            家庭名称
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：孙强一家" />
          </label>
          <label>
            住宿人员（每行一人）
            <textarea
              rows={4}
              value={membersText}
              onChange={(e) => setMembersText(e.target.value)}
              placeholder={'孙强\n周洁\n孙小妹'}
            />
          </label>
        </div>
        <div className="row-actions">
          <button
            disabled={!isCounter || !name.trim() || !membersText.trim()}
            title={isCounter ? '' : '需柜台职员角色'}
            onClick={() => void submitRegister()}
          >
            登记并开具领取凭证
          </button>
        </div>
      </div>
    </div>
  );
}

function SplitPanel({
  state,
  familyId,
  onSubmit,
  onCancel,
}: {
  state: BeddingState;
  familyId: string;
  onSubmit: (newName: string, needIds: string[]) => void;
  onCancel: () => void;
}) {
  const fam = state.families.find((f) => f.id === familyId)!;
  const needs = needsOf(state, familyId);
  const [picked, setPicked] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const toggle = (id: string) => setPicked((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const remain = needs.length - picked.length;
  return (
    <div className="card panel">
      <div className="panel-title">家庭拆分：{fam.name}（需求随人转移，领取权不新增）</div>
      {needs.map((n) => (
        <label key={n.id} className="option">
          <input type="checkbox" checked={picked.includes(n.id)} onChange={() => toggle(n.id)} />
          <span>
            {n.personName}（{fullyCovered(n) ? '已覆盖' : '未覆盖'}）
          </span>
        </label>
      ))}
      <div className="panel-sub">
        新户名称：
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如：陈军家（分户）" />
        　<span className="muted">
          拆分后：原户 {remain} 人 ＋ 新户 {picked.length} 人（合计不变）
        </span>
      </div>
      <div className="row-actions">
        <button disabled={picked.length === 0 || remain < 1 || !newName.trim()} onClick={() => onSubmit(newName.trim(), picked)}>
          确认拆分（权利守恒）
        </button>
        <button className="ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面三：领取交付（柜台职员）
// ---------------------------------------------------------------------------

export function DeliverPage({ state, role, exec }: PageProps) {
  const isCounter = role === 'counter';
  const [familyId, setFamilyId] = useState(state.families[0]?.id ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [lastCmd, setLastCmd] = useState<Command | null>(null);
  const fam = state.families.find((f) => f.id === familyId);
  const deliverables = deliverableRoots(state);
  const packs = deliverables.filter((n) => n.kind === 'pack');
  const loose = deliverables.filter(isLeaf);
  const plan = fam ? planDelivery(state, familyId, selected) : null;
  const v = fam ? voucherOf(state, fam.id) : undefined;
  const openNeeds = fam ? needsOf(state, fam.id).filter((n) => !fullyCovered(n)) : [];

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = async () => {
    const cmd: Command = { type: 'Deliver', commandId: crypto.randomUUID(), familyId, nodeIds: selected };
    const ok = await exec(cmd);
    if (ok) {
      setLastCmd(cmd);
      setSelected([]);
    }
  };

  const renderPick = (n: ItemNode) => {
    const st = n.kind === 'pack' ? leafStats(state, n.id) : null;
    return (
      <label key={n.id} className="option">
        <input type="checkbox" checked={selected.includes(n.id)} onChange={() => toggle(n.id)} />
        <span>
          <b>{n.label}</b>{' '}
          <Badge
            text={n.kind === 'pack' ? PACK_KIND_LABEL[n.packKind!] : ITEM_KIND_LABEL[n.kind]}
            tone={n.kind === 'pack' ? 'blue' : n.kind === 'mat' ? 'green' : 'orange'}
          />
          {n.kind === 'pack' && n.seal && <Badge text={`封签 ${n.seal.sealId}`} tone="green" />}
          {st && (
            <span className="muted">
              　叶件 {st.leaves}（垫{st.mats} 毯{st.blankets}，{st.portions}人份）
            </span>
          )}
        </span>
      </label>
    );
  };

  return (
    <div>
      <div className="card">
        <div className="panel-title">领取交付（交付按实际物资与领取凭证原子核销）</div>
        <div className="form-grid">
          <label>
            领取家庭
            <select value={familyId} onChange={(e) => setFamilyId(e.target.value)}>
              {state.families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {fam && v && (
          <div className="muted">
            凭证：{v.consumed}/{v.portions} 人份已核销｜待覆盖需求：
            {openNeeds.length ? openNeeds.map((n) => n.personName).join('、') : '（全部已覆盖）'}
          </div>
        )}
      </div>

      <div className="card">
        <div className="panel-title">整包交付（提前封好的家庭包，封签完好）</div>
        {packs.length === 0 && <div className="muted">（领取柜暂无密封包，请仓管员送包到柜）</div>}
        {packs.map(renderPick)}
      </div>

      <div className="card">
        <div className="panel-title">现场拣配（散件逐件拣选，可套散混用）</div>
        {loose.length === 0 && <div className="muted">（领取柜暂无散件）</div>}
        {loose.map(renderPick)}
      </div>

      <div className="card panel">
        <div className="panel-title">交付预览</div>
        {!fam && <div className="muted">（请选择家庭）</div>}
        {plan && plan.errors.length > 0 && (
          <ul className="reason-list">
            {plan.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
        {plan && plan.errors.length === 0 && (
          <div>
            <div>
              本次交付：垫 {plan.mats.length} 件（{plan.mats.map((m) => m.label).join('、') || '无'}）；毯 {plan.blankets.length}{' '}
              件（{plan.blankets.map((b) => b.label).join('、') || '无'}）
            </div>
            <div className="c-ok">
              可覆盖 {plan.newlyCovered.length} 人：
              {plan.newlyCovered.map((n) => n.personName).join('、') || '（无新增覆盖）'}
            </div>
            {(plan.excessMats.length > 0 || plan.excessBlankets.length > 0) && (
              <div className="c-bad">
                超出凭证 {plan.excessMats.length + plan.excessBlankets.length} 件（垫{plan.excessMats.length} 毯
                {plan.excessBlankets.length}）→ 交付后将记「待返还」，清点实收且确认为未用后才可重发
              </div>
            )}
          </div>
        )}
        <div className="row-actions">
          <button
            disabled={!isCounter || !plan || plan.errors.length > 0 || selected.length === 0}
            title={isCounter ? '' : '需柜台职员角色'}
            onClick={() => void submit()}
          >
            交付并核销凭证
          </button>
          {lastCmd && (
            <button
              className="ghost"
              title="以相同 commandId 重发上次交付命令，验证幂等（应只产生重复回执）"
              onClick={() => void exec(lastCmd)}
            >
              模拟重复提交上次交付
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="panel-title">交付单（最近 {Math.min(8, state.deliveries.length)} 笔）</div>
        {state.deliveries.length === 0 && <div className="muted">（尚无交付）</div>}
        {[...state.deliveries]
          .sort((a, b) => b.at - a.at)
          .slice(0, 8)
          .map((d) => {
            const f = state.families.find((x) => x.id === d.familyId);
            return (
              <div key={d.id} className="receipt">
                <div className="receipt-head">
                  <b>{d.id}</b>
                  <Badge text={d.kind === 'reclaim' ? '补领换发' : '正常交付'} tone={d.kind === 'reclaim' ? 'orange' : 'blue'} />
                  <span className="muted">
                    {fmtDateTime(d.at)} · {d.actor}
                  </span>
                </div>
                <div>
                  {f?.name} ← 叶件 {d.leafItemIds.length}（覆盖 {d.assignments.length} 项需求
                  {d.excessMats + d.excessBlankets > 0 ? `，超出 垫${d.excessMats} 毯${d.excessBlankets} 已记待返还` : ''}）
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面四：退回与补领（柜台职员）
// ---------------------------------------------------------------------------

export function ReturnsPage({ state, role, exec }: PageProps) {
  const isCounter = role === 'counter';
  const isKeeper = role === 'keeper';
  const [retFamily, setRetFamily] = useState('');
  const [picked, setPicked] = useState<Record<string, 'unused' | 'used' | 'damaged'>>({});
  const [rcFamily, setRcFamily] = useState('');
  const [rcNeed, setRcNeed] = useState('');
  const [rcType, setRcType] = useState<'mat' | 'blanket'>('blanket');
  const [rcReason, setRcReason] = useState('');
  const [rcReplacement, setRcReplacement] = useState('');

  // 各家庭已交付叶件
  const deliveredLeaves = state.nodes.filter((n) => isLeaf(n) && effectiveStatus(state, n.id) === 'delivered');
  const famsWithDelivered = useMemo(() => {
    const set = new Set<string>();
    for (const l of deliveredLeaves) {
      const d = originalDeliveryOfItem(state, l.id);
      if (d) set.add(d.familyId);
    }
    return state.families.filter((f) => set.has(f.id));
  }, [state, deliveredLeaves]);

  const retFamId = famsWithDelivered.some((f) => f.id === retFamily) ? retFamily : (famsWithDelivered[0]?.id ?? '');
  const retItems = deliveredLeaves.filter((l) => originalDeliveryOfItem(state, l.id)?.familyId === retFamId);

  const togglePicked = (id: string) =>
    setPicked((m) => {
      const next = { ...m };
      if (id in next) delete next[id];
      else next[id] = 'used';
      return next;
    });

  const submitReturn = async () => {
    const items = Object.entries(picked).map(([itemId, condition]) => ({ itemId, condition }));
    const ok = await exec({ type: 'ReceiveReturn', familyId: retFamId, items });
    if (ok) setPicked({});
  };

  // 补领
  const rcFamId = rcFamily || state.families[0]?.id || '';
  const rcNeeds = needsOf(state, rcFamId).filter((n) => n.matItemId || n.blanketItemId);
  const need = rcNeeds.find((n) => n.id === rcNeed) ?? rcNeeds[0];
  const oldItemId = need ? (rcType === 'mat' ? need.matItemId : need.blanketItemId) : null;
  const dupReclaim = need ? openReclaimOf(state, need.id, rcType) : undefined;
  const replacements = state.nodes.filter(
    (n) => n.kind === rcType && n.parentId === null && n.holder?.type === 'counter',
  );
  const repId = replacements.some((n) => n.id === rcReplacement) ? rcReplacement : (replacements[0]?.id ?? '');

  const submitReclaim = async () => {
    if (!need) return;
    const ok = await exec({
      type: 'Reclaim',
      familyId: rcFamId,
      needId: need.id,
      itemType: rcType,
      reason: rcReason,
      replacementNodeId: repId,
    });
    if (ok) {
      setRcReason('');
      setRcReplacement('');
    }
  };

  const cleaningLeaves = state.nodes.filter(
    (n) => isLeaf(n) && n.parentId === null && n.holder?.type === 'cleaning',
  );
  const damagedLeaves = state.nodes.filter(
    (n) => isLeaf(n) && n.parentId === null && n.holder?.type === 'damaged',
  );

  return (
    <div>
      <div className="card">
        <div className="panel-title">待返还（{state.pendingReturns.filter((p) => p.status === 'open').length}）</div>
        {state.pendingReturns.length === 0 && (
          <div className="muted">（无待返还：整包交付超出凭证人份时自动生成，清点实收且确认为未用后才可重发）</div>
        )}
        {state.pendingReturns.map((p) => {
          const f = state.families.find((x) => x.id === p.familyId);
          return (
            <div key={p.id} className="receipt">
              <div className="receipt-head">
                <b>{p.id}</b>
                <Badge text={p.status === 'open' ? '待返还' : '已清讫'} tone={p.status === 'open' ? 'orange' : 'green'} />
                <span className="muted">来源交付单 {p.deliveryId}</span>
              </div>
              <div>
                {f?.name}：应返 垫{p.matsOwed} 毯{p.blanketsOwed}；实收 垫{p.matsReturned} 毯{p.blanketsReturned}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <div className="panel-title">退回接收（清点实收；查原交付，不能跨家庭退回）</div>
        {famsWithDelivered.length === 0 && <div className="muted">（暂无已交付物资的家庭）</div>}
        {famsWithDelivered.length > 0 && (
          <>
            <div className="form-grid">
              <label>
                退回家庭
                <select value={retFamId} onChange={(e) => setRetFamily(e.target.value)}>
                  {famsWithDelivered.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th></th>
                  <th>物资编号</th>
                  <th>品类</th>
                  <th>备注</th>
                  <th>验收</th>
                </tr>
              </thead>
              <tbody>
                {retItems.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <input type="checkbox" checked={l.id in picked} onChange={() => togglePicked(l.id)} />
                    </td>
                    <td>{l.label}</td>
                    <td>{ITEM_KIND_LABEL[l.kind]}</td>
                    <td>{l.awaitingReturn ? <Badge text="补领旧物·待退回" tone="orange" /> : <span className="muted">—</span>}</td>
                    <td>
                      <select
                        value={picked[l.id] ?? 'used'}
                        disabled={!(l.id in picked)}
                        onChange={(e) => setPicked((m) => ({ ...m, [l.id]: e.target.value as 'unused' | 'used' | 'damaged' }))}
                      >
                        <option value="unused">未使用 → 回库可重发</option>
                        <option value="used">已使用 → 待清洁</option>
                        <option value="damaged">报损</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row-actions">
              <button
                disabled={!isCounter || Object.keys(picked).length === 0}
                title={isCounter ? '' : '需柜台职员角色'}
                onClick={() => void submitReturn()}
              >
                接收退回（{Object.keys(picked).length} 件）
              </button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="panel-title">补领（须给原因；旧物实际退回后才可入清洁或报损）</div>
        <div className="form-grid">
          <label>
            家庭
            <select value={rcFamId} onChange={(e) => setRcFamily(e.target.value)}>
              {state.families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            人员
            <select value={need?.id ?? ''} onChange={(e) => setRcNeed(e.target.value)}>
              {rcNeeds.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.personName}
                </option>
              ))}
            </select>
          </label>
          <label>
            品类
            <select value={rcType} onChange={(e) => setRcType(e.target.value as 'mat' | 'blanket')}>
              <option value="mat">垫子</option>
              <option value="blanket">毯子</option>
            </select>
          </label>
          <label>
            换发物资（领取柜散件）
            <select value={repId} onChange={(e) => setRcReplacement(e.target.value)}>
              {replacements.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            原因
            <input value={rcReason} onChange={(e) => setRcReason(e.target.value)} placeholder="如：毯子被水浸湿 / 遗失" />
          </label>
        </div>
        {need && !oldItemId && <div className="c-bad">该人员此品类尚未发放，无需补领，请直接办理领取</div>}
        {dupReclaim && (
          <div className="c-bad">
            重复补领核对：{need!.personName} 的{rcType === 'mat' ? '垫子' : '毯子'}已有在办补领 {dupReclaim.id}
            （旧件 {nodeById(state, dupReclaim.oldItemId).label} 待退回），不得重复申请
          </div>
        )}
        <div className="row-actions">
          <button
            disabled={!isCounter || !need || !oldItemId || !!dupReclaim || !rcReason.trim() || !repId}
            title={isCounter ? '' : '需柜台职员角色'}
            onClick={() => void submitReclaim()}
          >
            提交补领并换发
          </button>
        </div>
        {state.reclaims.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {state.reclaims.map((r) => {
              const n = state.needs.find((x) => x.id === r.needId);
              return (
                <div key={r.id} className="receipt">
                  <div className="receipt-head">
                    <b>{r.id}</b>
                    <Badge text={r.status === 'awaiting_old' ? '旧物待退回' : '已闭环'} tone={r.status === 'awaiting_old' ? 'orange' : 'green'} />
                    <span className="muted">
                      {fmtDateTime(r.createdAt)} · {r.actor}
                    </span>
                  </div>
                  <div>
                    {n?.personName} · {r.itemType === 'mat' ? '垫子' : '毯子'} · 原因：{r.reason}｜旧{' '}
                    {nodeById(state, r.oldItemId).label} → 新 {nodeById(state, r.newItemId).label}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <div className="panel-title">待清洁（{cleaningLeaves.length}）与报损（{damagedLeaves.length}）</div>
        {cleaningLeaves.map((n) => (
          <div key={n.id} className="tree-row">
            <span className="tree-label">{n.label}</span>
            <StatusBadge status="cleaning" />
            <span className="tree-actions">
              <button
                className="mini"
                disabled={!isKeeper}
                title={isKeeper ? '清洁完成，回库可用' : '需仓管员角色'}
                onClick={() => void exec({ type: 'CompleteCleaning', itemIds: [n.id] })}
              >
                完成清洁
              </button>
            </span>
          </div>
        ))}
        {damagedLeaves.map((n) => (
          <div key={n.id} className="tree-row">
            <span className="tree-label">{n.label}</span>
            <StatusBadge status="damaged" />
            <span className="muted">{n.holder?.type === 'damaged' ? n.holder.reason : ''}</span>
          </div>
        ))}
        {cleaningLeaves.length === 0 && damagedLeaves.length === 0 && <div className="muted">（无）</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面五：逐件追踪（任何角色）
// ---------------------------------------------------------------------------

export function TrackingPage({ state }: PageProps) {
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<ItemStatus | ''>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const leaves = state.nodes.filter(isLeaf);
  const rows = leaves
    .map((l) => ({ node: l, status: effectiveStatus(state, l.id) }))
    .filter((r) => (!q || r.node.label.toLowerCase().includes(q.toLowerCase())) && (!statusFilter || r.status === statusFilter))
    .sort((a, b) => a.node.label.localeCompare(b.node.label));

  const packs = state.nodes
    .filter((n) => n.kind === 'pack')
    .sort((a, b) => a.label.localeCompare(b.label));

  const sel = selectedId ? state.nodes.find((n) => n.id === selectedId) : null;

  return (
    <div>
      <div className="card">
        <div className="panel-title">逐件追踪（叶件 {leaves.length} 件；包壳不计寝具）</div>
        <div className="track-filters">
          <input placeholder="按物资编号搜索，如 MAT-001" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ItemStatus | '')}>
            <option value="">全部状态</option>
            {Object.entries(ITEM_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>物资编号</th>
              <th>品类</th>
              <th>状态</th>
              <th>位置（解析祖先）</th>
              <th>包路径</th>
              <th>待退回</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, status }) => (
              <tr key={node.id} className={selectedId === node.id ? 'row-selected' : ''} onClick={() => setSelectedId(node.id)}>
                <td>{node.label}</td>
                <td>{ITEM_KIND_LABEL[node.kind]}</td>
                <td>
                  <StatusBadge status={status} />
                </td>
                <td>{locationLabel(state, node)}</td>
                <td className="muted">{packPathOf(state, node.id).map((p) => p.label).join(' / ')}</td>
                <td>{node.awaitingReturn ? <Badge text="补领旧物" tone="orange" /> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sel && <ItemDetail state={state} itemId={sel.id} />}

      <div className="card">
        <div className="panel-title">包与包壳（{packs.length}）</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>包号</th>
              <th>包型</th>
              <th>封签</th>
              <th>叶件</th>
              <th>位置/状态</th>
              <th>封签历史</th>
            </tr>
          </thead>
          <tbody>
            {packs.map((p) => {
              const st = leafStats(state, p.id);
              return (
                <tr key={p.id}>
                  <td>{p.label}</td>
                  <td>{PACK_KIND_LABEL[p.packKind!]}</td>
                  <td>{p.seal ? <Badge text={`${p.seal.sealId}（${p.seal.sealedBy}）`} tone="green" /> : <Badge text="已开封" tone="orange" />}</td>
                  <td>
                    {st.leaves}（垫{st.mats} 毯{st.blankets}）
                  </td>
                  <td>{locationLabel(state, p)}</td>
                  <td className="muted">
                    {p.brokenSeals.length
                      ? p.brokenSeals.map((s) => `${s.sealId}（${s.brokenBy}·${s.cause}）`).join('；')
                      : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ItemDetail({ state, itemId }: { state: BeddingState; itemId: string }) {
  const item = nodeById(state, itemId);
  const path = packPathOf(state, itemId);
  const status = effectiveStatus(state, itemId);
  const delivery = originalDeliveryOfItem(state, itemId);
  const asOld = state.reclaims.filter((r) => r.oldItemId === itemId);
  const asNew = state.reclaims.filter((r) => r.newItemId === itemId);
  const need = state.needs.find((n) => n.matItemId === itemId || n.blanketItemId === itemId);
  const related = state.receipts
    .filter((r) => r.summary.includes(item.label) || r.lines.some((l) => l.includes(item.label)))
    .sort((a, b) => b.seq - a.seq)
    .slice(0, 12);
  return (
    <div className="card panel">
      <div className="panel-title">
        单件核查：{item.label}（{ITEM_KIND_LABEL[item.kind]}） <StatusBadge status={status} />
      </div>
      <div className="muted">位置：{locationLabel(state, item)}（沿父链解析祖先得出）</div>
      <div className="panel-sub">包含链（根 → 叶）：</div>
      {path.map((p, i) => (
        <div key={p.id} className="tree-row" style={{ paddingLeft: i * 18 }}>
          <span className="tree-label">{p.label}</span>
          <Badge text={p.kind === 'pack' ? PACK_KIND_LABEL[p.packKind!] : ITEM_KIND_LABEL[p.kind]} tone={p.kind === 'pack' ? 'blue' : 'gray'} />
          {p.kind === 'pack' &&
            (p.seal ? <Badge text={`封签 ${p.seal.sealId} 有效`} tone="green" /> : <Badge text="已开封" tone="orange" />)}
          {i === path.length - 1 && p.parentId === null && <Badge text="当前为顶层" tone="purple" />}
        </div>
      ))}
      {delivery && (
        <div className="panel-sub">
          原交付单：{delivery.id}（{state.families.find((f) => f.id === delivery.familyId)?.name} · {fmtDateTime(delivery.at)} ·{' '}
          {delivery.actor}）
        </div>
      )}
      {need && (
        <div className="panel-sub">
          当前覆盖需求：{need.personName}（{state.families.find((f) => f.id === need.familyId)?.name}）
        </div>
      )}
      {asOld.map((r) => (
        <div key={r.id} className="c-bad">
          补领 {r.id} 旧件：{r.status === 'awaiting_old' ? '待实际退回（未退回不入清洁/报损）' : '已退回闭环'}；原因：{r.reason}
        </div>
      ))}
      {asNew.map((r) => (
        <div key={r.id} className="c-ok">
          补领 {r.id} 换发新件（原因：{r.reason}）
        </div>
      ))}
      <div className="panel-sub">相关回执（含本编号）：</div>
      {related.length === 0 && <div className="muted">（暂无）</div>}
      {related.map((r) => (
        <div key={r.id} className="muted receipt-line">
          #{r.seq} {fmtDateTime(r.at)} · {r.actor} · {r.summary}
        </div>
      ))}
    </div>
  );
}
