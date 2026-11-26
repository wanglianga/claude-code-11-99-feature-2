import type { ShelterState } from './types';

/**
 * 虚构演示数据，严格对应题目示例：
 * - A 房 6 床，有无障碍设施；B 房 6 床，普通房，已有 2 人实际入住（王芳与女儿）
 * - 李强一家 4 人住 A 房，不需无障碍，已同意返所换房（稍后将暂离至 18:00）
 * - 赵敏一家 3 人需要无障碍，已到达待安置
 * - 陈伟 2 人不同意共房、吴磊一家 3 人，用于演示共房同意与并发分房
 */
export function seedState(): ShelterState {
  const virtualNow = new Date('2026-11-26T15:00:00').getTime();
  return {
    version: 1,
    virtualNow,
    rooms: [
      { id: 'room-A', name: 'A', capacity: 6, accessible: true, status: 'open' },
      { id: 'room-B', name: 'B', capacity: 6, accessible: false, status: 'open' },
    ],
    families: [
      {
        id: 'fam-wang',
        name: '王芳与女儿',
        size: 2,
        needsAccessible: false,
        coRoomConsent: true,
        consentRoomChange: true,
        status: 'checked_in',
        currentRoomId: 'room-B',
      },
      {
        id: 'fam-li',
        name: '李强一家',
        size: 4,
        needsAccessible: false,
        coRoomConsent: true,
        consentRoomChange: true,
        status: 'checked_in',
        currentRoomId: 'room-A',
      },
      {
        id: 'fam-zhao',
        name: '赵敏一家',
        size: 3,
        needsAccessible: true,
        coRoomConsent: true,
        consentRoomChange: false,
        status: 'registered',
      },
      {
        id: 'fam-chen',
        name: '陈伟',
        size: 2,
        needsAccessible: false,
        coRoomConsent: false,
        consentRoomChange: false,
        status: 'registered',
      },
      {
        id: 'fam-wu',
        name: '吴磊一家',
        size: 3,
        needsAccessible: false,
        coRoomConsent: true,
        consentRoomChange: true,
        status: 'registered',
      },
    ],
    assignments: [
      {
        id: 'as-wang',
        familyId: 'fam-wang',
        roomId: 'room-B',
        beds: 2,
        kind: 'checkin',
        status: 'active',
        createdAt: virtualNow - 3 * 3600_000,
        confirmedAt: virtualNow - 3 * 3600_000,
      },
      {
        id: 'as-li',
        familyId: 'fam-li',
        roomId: 'room-A',
        beds: 4,
        kind: 'checkin',
        status: 'active',
        createdAt: virtualNow - 2 * 3600_000,
        confirmedAt: virtualNow - 2 * 3600_000,
      },
    ],
    promises: [],
    contactTasks: [],
    receipts: [
      {
        seq: 1,
        id: 'R1',
        at: virtualNow,
        kind: 'seed',
        actor: '系统',
        summary: '演示数据已就绪（虚构家庭与房间，全部数据仅保存在本浏览器）',
        lines: [
          'A 房 6 床（无障碍）；B 房 6 床（普通房）',
          '王芳与女儿 2 人在住 B 房；李强一家 4 人在住 A 房（不需无障碍，已同意返所换房）',
          '赵敏一家 3 人需无障碍，等待安置；陈伟 2 人未同意共房；吴磊一家 3 人等待安置',
          '演示时间 15:00，可用右上角按钮推进时间',
        ],
      },
    ],
    pending: [],
    commandLog: [],
    seqCounter: 1,
  };
}
