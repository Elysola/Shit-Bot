import { describe, expect, test } from 'bun:test';
import { mentionedPeople, renderDiscordContent, sanitizeOutgoingMentions } from './mentions';
import { CHANNEL_ID, SELF_ID, personRef, resolverOf } from '@/testing/fixtures';

const A = '100000000000000001';
const B = '100000000000000002';
const C = '100000000000000003';

describe('renderDiscordContent', () => {
  const resolver = {
    ...resolverOf([personRef(A, '阿伟'), personRef(B, '小红'), personRef(C, '阿伟'), personRef(SELF_ID, 'memecat')]),
    role: (id: string) => (id === '500000000000000001' ? { id, name: '管理员', isSelfRole: false } : id === '500000000000000002' ? { id, name: 'memecat', isSelfRole: true } : null),
  };

  test('用户、昵称写法、频道、角色、表情、斜杠命令', () => {
    const r = renderDiscordContent(
      `<@${A}> 和 <@!${B}> 去 <#${CHANNEL_ID}> 找 <@&500000000000000001> <:doge:123456789012345678> 用 </ping:123456789012345678>`,
      resolver
    );
    expect(r.text).toBe('@阿伟 和 @小红 去 #闲聊 找 @角色:管理员 :doge: 用 /ping');
    expect(mentionedPeople(r).map((p) => p.id)).toEqual([A, B]);
    expect(r.mentions.map((m) => m.t)).toEqual(['user', 'user', 'channel', 'role']);
  });

  test('同名的两个人：后一个加序号消歧；同一人多次出现只记一次', () => {
    const r = renderDiscordContent(`<@${A}> <@${C}> <@${A}>`, resolver);
    expect(r.text).toBe('@阿伟 @阿伟(2) @阿伟');
    expect(mentionedPeople(r).map((p) => p.id)).toEqual([A, C]);
  });

  test('未知用户/角色/频道给出占位，不暴露裸 ID', () => {
    const r = renderDiscordContent('<@199999999999999999> <@&599999999999999999> <#799999999999999999>', resolver);
    expect(r.text).toBe('@未知用户 @未知角色 #未知频道');
    expect(r.mentions).toEqual([{ t: 'unknown_user', id: '199999999999999999' }]);
  });

  test('stripSelfMention 去掉对 bot 自己和 bot 角色的 @，但仍记录', () => {
    const r = renderDiscordContent(`<@${SELF_ID}> 你好 <@&500000000000000002>`, resolver, { stripSelfMention: true });
    expect(r.text).toBe('你好');
    expect(r.mentions.map((m) => m.t)).toEqual(['user', 'role']);
    expect(mentionedPeople(r)[0].isSelf).toBe(true);
  });

  test('时间戳按 UTC+8 展开；@everyone/@here 记录类型', () => {
    // 2026-10-29 12:00:00 UTC = 20:00 UTC+8
    const ts = Date.UTC(2026, 9, 29, 12, 0, 0) / 1000;
    const r = renderDiscordContent(`<t:${ts}:t> <t:${ts}:D> <t:${ts}> @everyone @here`, resolver);
    expect(r.text).toBe('20:00 2026-10-29 2026-10-29 20:00 @everyone @here');
    expect(r.mentions.map((m) => m.t)).toEqual(['everyone', 'here']);
  });
});

describe('sanitizeOutgoingMentions', () => {
  test('只保留白名单内的用户提醒，其余改纯文本；屏蔽群发和角色提醒', () => {
    const allowed = new Set([A]);
    const res = sanitizeOutgoingMentions(`<@${A}> 和 <@!${B}> 看 @everyone @here <@&500000000000000001>`, allowed, (id) =>
      id === B ? '小红' : null
    );
    expect(res.text).toBe(`<@${A}> 和 @小红 看 @​everyone @​here @某个角色`);
    expect(res.userIds).toEqual([A]);
  });
});
