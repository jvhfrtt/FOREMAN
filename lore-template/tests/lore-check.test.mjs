import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoreCheck } from '../scripts/lore-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checkPath = join(here, '..', 'scripts', 'lore-check.mjs');

const GLOSSARY = '| 词条 | 类别 | 定义 |\n| --- | --- | --- |\n| 阿斯特拉 | 人物 | 主角 |\n| 旧都 | 地名 | 城市 |\n';

const CLEAN = {
  'docs/术语表.md': GLOSSARY,
  'docs/档案/阿斯特拉.md': '# 人物：阿斯特拉\n\n@引用:旧都\n[F1] 身世之谜\n[R1] 回收身世\n',
  'docs/档案/旧都.md': '# 地名：旧都\n\n一座城市。\n',
  'docs/lore/纪元.md': '# 纪元\n\n星历-1024-07 风眼出现\n星历-1025-01 第一次远征\n',
};

async function withWorld(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'lore-check-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('干净样例 0 错误（五类检查都不误报）', async () => {
  await withWorld(CLEAN, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
    assert.equal(result.files, 4);
  });
});

test('① 人物/组织/地名标题全库唯一：重复报错', async () => {
  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/档案/甲.md': '# 人物：阿斯特拉\n',
    'docs/档案/乙.md': '# 人物：阿斯特拉\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /「阿斯特拉」重复/);
  });
});

test('② 时间线单调：倒退报错，同年月与纪元前进不报', async () => {
  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/lore/01.md': '# 纪元一\n\nAlpha-1-12 事件甲\nBeta-1-01 事件乙\n',
    'docs/lore/02.md': '# 纪元二\n\nBeta-1-05 事件丙\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/lore/01.md': '# 纪元\n\n星历-1025-01 事件甲\n星历-1024-12 事件乙\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /时间线倒退/);
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/lore/01.md': '# 纪元\n\nBeta-1-01 事件甲\nAlpha-1-02 事件乙\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /时间线倒退/);
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/lore/01.md': '# 纪元\n\n星历-1024-07 事件甲\n星历-1024-07 事件乙\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });
});

test('③ 伏笔回收：F 无 R、R 无 F、R 后再引用 F 都报错；F→R 不报', async () => {
  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/档案/阿斯特拉.md': '# 人物：阿斯特拉\n\n[F1] 谜\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /没有对应回收/);
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/档案/阿斯特拉.md': '# 人物：阿斯特拉\n\n[R2] 解谜\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /没有对应伏笔/);
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/档案/阿斯特拉.md': '# 人物：阿斯特拉\n\n[F3] 谜\n[R3] 解谜\n[F3] 再引用\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /已回收/);
  });
});

test('④ @引用:目标存在不报、不存在报错', async () => {
  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/档案/阿斯特拉.md': '# 人物：阿斯特拉\n\n@引用:旧都\n',
    'docs/档案/旧都.md': '# 地名：旧都\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/档案/阿斯特拉.md': '# 人物：阿斯特拉\n\n@引用:不存在的城\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /^docs\/档案\/阿斯特拉\.md:3: @引用:不存在的城 指向的条目不存在/);
    assert.match(result.errors[0], /目标须为文件首标题，术语表登记不算/);
  });
});

test('④+ 跨文件 F→R 只做配对不误报', async () => {
  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/档案/阿斯特拉.md': '# 人物：阿斯特拉\n\n[F7] 埋下谜团\n',
    'docs/档案/旧都.md': '# 地名：旧都\n\n[R7] 回收谜团\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });
});

test('⑤ 术语表：三类词条未登记报错；术语表缺失报错；登记后不报', async () => {
  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/档案/未登记者.md': '# 人物：未登记者\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /未在术语表登记/);
  });

  await withWorld({
    'docs/档案/阿斯特拉.md': '# 人物：阿斯特拉\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.ok(result.errors.some((error) => /术语表\.md 不存在/.test(error)));
  });

  await withWorld(CLEAN, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });
});

test('代码围栏内的内容不参与检查', async () => {
  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/档案/阿斯特拉.md': [
      '# 人物：阿斯特拉',
      '',
      '```',
      '[F9] 未回收的伏笔',
      '@引用:不存在的词条',
      '星历-9999-99 倒退的时间线',
      '```',
      '',
    ].join('\n'),
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });
});

test('⑥ 小神神域：窄域通过、大词/空/多词报错、未登记仍走⑤', async () => {
  const glossaryWith = (name) => `| 词条 | 类别 | 定义 |\n| --- | --- | --- |\n| ${name} | 小神 | 小神 |\n`;

  await withWorld({
    'docs/术语表.md': glossaryWith('铁锈'),
    'docs/档案/小神-铁锈.md': '# 小神：铁锈\n\n神域：铁锈\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });

  await withWorld({
    'docs/术语表.md': glossaryWith('战狂'),
    'docs/档案/战狂.md': '# 小神：战狂\n\n神域：战争\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /黑名单/);
  });

  await withWorld({
    'docs/术语表.md': glossaryWith('无名'),
    'docs/档案/无名.md': '# 小神：无名\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /缺少神域行/);
  });

  await withWorld({
    'docs/术语表.md': glossaryWith('无名'),
    'docs/档案/无名.md': '# 小神：无名\n\n神域：\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /神域为空/);
  });

  await withWorld({
    'docs/术语表.md': glossaryWith('双名'),
    'docs/档案/双名.md': '# 小神：双名\n\n神域：铁 与 锈\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /单一具体名词/);
  });

  await withWorld({
    'docs/术语表.md': '| 词条 | 类别 | 定义 |\n| --- | --- | --- |\n',
    'docs/档案/未登记.md': '# 小神：未登记\n\n神域：窄域\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /未在术语表登记/);
  });
});

test('时间线支持「末」：数字年之后接 末 不报，末 之后接数字年报倒退', async () => {
  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/lore/01.md': '# 纪元\n\n一纪元-0-1 事件甲\n一纪元-末-1 事件乙\n二纪元-1-1 事件丙\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/lore/01.md': '# 纪元\n\n一纪元-末-1 事件甲\n一纪元-1-1 事件乙\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /时间线倒退/);
  });
});

test('碎片类别：登记通过、重复报错、未登记报错', async () => {
  await withWorld({
    'docs/术语表.md': '| 词条 | 类别 | 定义 |\n| --- | --- | --- |\n| 烬原 | 碎片 | 灰烬平原 |\n',
    'docs/档案/碎片-烬原.md': '# 碎片：烬原\n\n灰烬平原碎片。\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });

  await withWorld({
    'docs/术语表.md': '| 词条 | 类别 | 定义 |\n| --- | --- | --- |\n| 烬原 | 碎片 | 灰烬平原 |\n',
    'docs/档案/甲.md': '# 碎片：烬原\n',
    'docs/档案/乙.md': '# 碎片：烬原\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /「烬原」重复/);
  });

  await withWorld({
    'docs/术语表.md': '| 词条 | 类别 | 定义 |\n| --- | --- | --- |\n',
    'docs/档案/碎片-烬原.md': '# 碎片：烬原\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /未在术语表登记/);
  });
});

test('伏笔账本：埋 F 未登记报错、登记通过、F/R 配对无登记通过', async () => {
  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/伏笔账本.md': '# 伏笔账本\n',
    'docs/档案/阿斯特拉.md': '# 人物：阿斯特拉\n\n[F1] 谜\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /未登记进伏笔账本/);
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/伏笔账本.md': '# 伏笔账本\n\n[F1] 神战真相\n',
    'docs/档案/阿斯特拉.md': '# 人物：阿斯特拉\n\n[F1] 谜\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/档案/阿斯特拉.md': '# 人物：阿斯特拉\n\n[F1] 谜\n[R1] 解谜\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });
});

test('CLI：干净样例 exit 0，错误样例 exit 1 且错误写 stderr', async () => {
  await withWorld(CLEAN, (dir) => {
    const ok = spawnSync(process.execPath, [checkPath, join(dir, 'docs')], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /0 个错误/);
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/档案/阿斯特拉.md': '# 人物：阿斯特拉\n\n[F1] 谜\n',
  }, (dir) => {
    const bad = spawnSync(process.execPath, [checkPath, join(dir, 'docs')], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /没有对应回收/);
  });
});

test('⑦ 防复读：长段近似重复报错；短句/不同长段/围栏内不报', async () => {
  const paraA = '烬原上的风从裂隙那头吹过来，卷着灰烬，从集东吹到集西，把每一座矮房都洗了一遍，'
    + '拾薪集的人在风里缩着脖子收衣服，只有老柯站在灰堆边上迎着风，看那些灰烬被卷起来，在半空里拧成一股一股的。';
  const paraB = paraA.replace('洗了一遍', '洗了两遍');
  const farA = '拾薪集的房子都矮，墙是灰泥糊的，顶是捡来的浮木搭的，风一吹，满集都是灰烬的细末，'
    + '像给日子铺了层旧被，老柯还是天不亮就出门，拖着新缝的灰袋，在灰堆里翻捡余烬。';
  const farB = '渡舟以神骸为炉，阿渡从腰囊里取出一枚指节大的神骸，掰成两半，一半投进炉口，一半收回去，'
    + '炉火腾起来是潮汐的颜色，他立在船头闭眼听了片刻裂隙里的风声，然后说潮信还在，船能走。';

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/故事/复读.md': `# 章一\n\n${paraA}\n\n${paraB}\n`,
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 1, result.errors.join('\n'));
    assert.match(result.errors[0], /疑似复读：段落 3 与段落 5 高度相似/);
    assert.match(result.errors[0], /相似度 0\.9\d+/);
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/故事/短句.md': '# 章二\n\n风起了。\n\n风起了。\n',
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/故事/不同.md': `# 章三\n\n${farA}\n\n${farB}\n`,
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });

  await withWorld({
    'docs/术语表.md': GLOSSARY,
    'docs/故事/围栏.md': `# 章四\n\n\`\`\`\n${paraA}\n${paraA}\n\`\`\`\n`,
  }, async (dir) => {
    const result = await runLoreCheck(join(dir, 'docs'));
    assert.equal(result.errors.length, 0, result.errors.join('\n'));
  });
});
