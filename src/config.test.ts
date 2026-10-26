import { describe, expect, test } from 'bun:test';
import { setConfigForTesting } from './config';
import { maskPlugin, restorePlugins } from './web/server';

describe('setConfigForTesting', () => {
  test('补齐 discord.privilegedIntents', () => {
    const cfg = setConfigForTesting({ discord: { enabled: false, privilegedIntents: { members: 'on', presences: 'nope' } } });
    expect(cfg.discord.privilegedIntents).toEqual({ members: 'on', presences: 'auto' });
  });
});

describe('WebUI 的插件配置密钥', () => {
  const prev = [
    {
      name: 'ai-chat',
      enabled: true,
      options: { apiKey: 'sk-real', model: 'm', webSearch: { apiKey: 'ws-real' }, embedding: { apiKey: '', model: 'bge-m3' } },
    },
  ];

  test('返回给前端时密钥打码（空值保持空），其它字段原样', () => {
    expect(maskPlugin(prev[0]).options).toEqual({
      apiKey: '••••••••',
      model: 'm',
      webSearch: { apiKey: '••••••••' },
      embedding: { apiKey: '', model: 'bge-m3' },
    });
  });

  test('保存时打码或空的密钥换回原值，填了新值就用新值', () => {
    const incoming = [
      { name: 'ai-chat', enabled: true, options: { apiKey: '••••••••', model: 'm2', webSearch: { apiKey: 'ws-new' }, embedding: { apiKey: '', model: 'bge-m3' } } },
    ];
    expect(restorePlugins(incoming, prev)[0].options).toEqual({
      apiKey: 'sk-real',
      model: 'm2',
      webSearch: { apiKey: 'ws-new' },
      embedding: { apiKey: '', model: 'bge-m3' },
    });
  });
});
