import assert from 'node:assert'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import fs from 'node:fs'

// 把 TS 源码连同 store 一起打成一个临时 ESM，自带 localStorage 桩，直接在 Node 里跑业务逻辑。
const result = await build({
  entryPoints: ['src/data/circpump.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
})
const tmp = `${os.tmpdir()}/circpump-test.mjs`
fs.writeFileSync(tmp, result.outputFiles[0].text)

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
}
// 代码以 window 存在与否区分浏览器环境，补一个 window 桩让持久化分支也被验证到。
globalThis.window = { localStorage: globalThis.localStorage }
const mod = await import(pathToFileURL(tmp).href)

const TODAY = new Date(2026, 9, 3) // 2026-10-03
let pass = 0
function ok(name, cond) {
  assert.ok(cond, name)
  pass++
  console.log(`  ✓ ${name}`)
}

// 周期解析：兼容既有写法
ok('周期 90天=90', mod.parseCycleDays('90天') === 90)
ok('周期 180（裸数字）=180', mod.parseCycleDays('180') === 180)
ok('周期 半年=180', mod.parseCycleDays('半年') === 180)
ok('周期 一年=365', mod.parseCycleDays('一年') === 365)
ok('周期 3月=90', mod.parseCycleDays('3月') === 90)
ok('周期 2周=14', mod.parseCycleDays('2周') === 14)
ok('周期空=null', mod.parseCycleDays('') === null)
ok('周期乱写=null', mod.parseCycleDays('待定') === null)

// 数值解析：异常取数不抛错
ok('扬程 32m=32', mod.parsePositive('32m') === 32)
ok('电流 86A=86', mod.parsePositive('86A') === 86)
ok('扬程空=null', mod.parsePositive('') === null)
ok('扬程 待校=null', mod.parsePositive('待校') === null)

const views = mod.listPumpViews(TODAY)
const byCode = Object.fromEntries(views.map((v) => [v['泵编号'], v]))

// 提醒：周期空的不进提醒，只在未纳入栏说明
ok('CIRC-0004（东郊空周期）不具备提醒资格', byCode['CIRC-0004'].reminderEligible === false)
ok('CIRC-0004 未到期（不提醒）', byCode['CIRC-0004'].due === false)
ok('CIRC-0004 有未纳入原因', byCode['CIRC-0004'].excludeReason.includes('保养周期未核定'))
ok('CIRC-0004 不显示待保养', byCode['CIRC-0004'].displayStatus !== '待保养')

// 提醒：只按上次保养日+周期推
ok('CIRC-0001（5/1+90天=7/30，已逾期）到期', byCode['CIRC-0001'].due === true)
ok('CIRC-0001 显示待保养', byCode['CIRC-0001'].displayStatus === '待保养')
ok('CIRC-0001 逾期65天', byCode['CIRC-0001'].overdueDays === 65)
ok('CIRC-0002（8/20+90天=11/18）未到期', byCode['CIRC-0002'].due === false)
ok('CIRC-0003（9/10+180天=3/9）未到期', byCode['CIRC-0003'].due === false)
ok('CIRC-0006（无上次保养日但周期已核定）到期', byCode['CIRC-0006'].due === true)
ok('CIRC-0006 标记从未保养', byCode['CIRC-0006'].neverMaintained === true)

// 停用泵：不参与提醒，且不能提交保养
ok('CIRC-0008 停用态保持', byCode['CIRC-0008'].displayStatus === '已停用')
ok('CIRC-0008 即使早过周期也不提醒', byCode['CIRC-0008'].due === false)
ok('停用泵没有任何动作', mod.availableActions('已停用').length === 0)
let r = mod.runPumpAction(byCode['CIRC-0008'].id, '完成保养', TODAY)
ok('停用泵提交保养被挡', r.ok === false && r.message.includes('已停用'))
r = mod.runPumpAction(byCode['CIRC-0009'].id, '完成保养', TODAY)
ok('无周期的停用泵同样被挡', r.ok === false && r.message.includes('已停用'))

// 越级流转挡回（待保养→运行中→已保养→已停用）
r = mod.runPumpAction(byCode['CIRC-0007'].id, '完成保养', TODAY)
ok('已保养泵再保养=越级挡回', r.ok === false && r.message.includes('越级'))
r = mod.runPumpAction(byCode['CIRC-0002'].id, '停用设备', TODAY)
ok('运行中直接停用=越级挡回', r.ok === false && r.message.includes('越级'))
r = mod.runPumpAction(byCode['CIRC-0007'].id, '登记运行', TODAY)
ok('已保养泵登记运行=越级挡回', r.ok === false && r.message.includes('越级'))

// 扬程缺失：完成保养先挡下；台账补登后可保养
ok('CIRC-0005 扬程缺失标记', byCode['CIRC-0005'].headMissing === true)
ok('CIRC-0005 异常记录标记', byCode['CIRC-0005'].valueAbnormal === true)
r = mod.runPumpAction(byCode['CIRC-0005'].id, '完成保养', TODAY)
ok('CIRC-0005 缺扬程被挡（列表照样渲染，不整屏白）', r.ok === false && r.message.includes('扬程'))
r = mod.updatePumpLedger(byCode['CIRC-0005'].id, { head: '22m' })
ok('补登扬程成功', r.ok === true)
r = mod.updatePumpLedger(byCode['CIRC-0005'].id, { head: '待校' })
ok('非数值扬程补登被挡', r.ok === false)

// 运行电流异常：单独标出，不阻塞
ok('CIRC-0010 电流“待校”标异常', byCode['CIRC-0010'].valueAbnormal === true)
ok('CIRC-0010 扬程正常不缺', byCode['CIRC-0010'].headMissing === false)
ok('CIRC-0002 无异常', byCode['CIRC-0002'].valueAbnormal === false)

// 正常完成保养：更新上次保养日、状态→已保养、落阀门井待检查清单
r = mod.runPumpAction(byCode['CIRC-0002'].id, '完成保养', TODAY)
ok('CIRC-0002 保养成功', r.ok === true && r.message.includes('阀门井'))
const after = Object.fromEntries(mod.listPumpViews(TODAY).map((v) => [v['泵编号'], v]))
ok('保养后上次保养日=今天', after['CIRC-0002']['上次保养日'] === '2026-10-03')
ok('保养后存储状态=已保养', after['CIRC-0002'].status === '已保养')

// 阀门井待检查清单联动 + 幂等：重复报送只记一次
const raw = JSON.parse(store.get('district-heating:entries:v2'))
const linked = raw.valvewell.filter((x) => x['来源单号'] === `CIRC-${byCode['CIRC-0002'].id}-2026-10-03`)
ok('阀门井生成 1 条待检查联动项', linked.length === 1)
ok('联动项状态=待检查', linked[0].status === '待检查')
ok('联动项带来源模块=循环泵运维', linked[0]['来源模块'] === '循环泵运维')
ok('联动项井编号指向该泵', linked[0]['井编号'] === 'FWJ-CIRC-0002')

r = mod.runPumpAction(after['CIRC-0002'].id, '完成保养', TODAY)
ok('同泵同日重复保养被挡（幂等）', r.ok === false && r.message.includes('只记一次'))
const raw2 = JSON.parse(store.get('district-heating:entries:v2'))
const linked2 = raw2.valvewell.filter((x) => x['来源单号'] === `CIRC-${byCode['CIRC-0002'].id}-2026-10-03`)
ok('阀门井联动项仍是 1 条', linked2.length === 1)

// 台账维护上次保养日
r = mod.updatePumpLedger(byCode['CIRC-0006'].id, { lastDate: '2026-10-01' })
ok('设备员登记上次保养日成功', r.ok === true)
const v6 = mod.listPumpViews(TODAY).find((v) => v['泵编号'] === 'CIRC-0006')
ok('登记后 CIRC-0006 上次保养日同步', v6['上次保养日'] === '2026-10-01')
ok('登记后 CIRC-0006 不再是从未保养', v6.neverMaintained === false)
r = mod.updatePumpLedger(byCode['CIRC-0006'].id, { lastDate: '不是日期' })
ok('非法日期被挡', r.ok === false)

// 按站核定周期：清空后该站在役泵全部不进提醒
mod.setStationCycle('东郊换热站', '季度')
let v4 = mod.listPumpViews(TODAY).find((v) => v['泵编号'] === 'CIRC-0004')
ok('核定东郊=季度后周期生效（90天）', v4.cycleDays === 90)
ok('核定后 CIRC-0004（8/1+90天=10/30）暂不到期', v4.due === false)
mod.setStationCycle('东郊换热站', '')
v4 = mod.listPumpViews(TODAY).find((v) => v['泵编号'] === 'CIRC-0004')
ok('清空核定后 CIRC-0004 又不进提醒', v4.reminderEligible === false && v4.due === false)

// 行内周期优先于站核定（兼容既有保养做法）；此时 0002 已保养（仍在役）、0008 停用，到期仅 0001
const groups = mod.listStationGroups(TODAY)
const xh = groups.find((g) => g.station === '新华换热站')
ok('新华站分组能看到泵数与到期数', xh.total === 4 && xh.active === 3 && xh.due === 1)
const dj = groups.find((g) => g.station === '东郊换热站')
ok('东郊站未核定数=1（在役）', dj.noCycle === 1 && dj.active === 1)

// 正向流转全链路：待保养→登记运行→完成保养→停用
const id6 = v6.id
r = mod.runPumpAction(id6, '登记运行', TODAY)
ok('待保养→登记运行成功', r.ok === true)
r = mod.runPumpAction(id6, '登记运行', TODAY)
ok('运行中再登记运行=越级', r.ok === false)
r = mod.runPumpAction(id6, '完成保养', TODAY)
ok('运行中→完成保养成功', r.ok === true)
r = mod.runPumpAction(id6, '停用设备', TODAY)
ok('已保养→停用成功', r.ok === true)
r = mod.runPumpAction(id6, '停用设备', TODAY)
ok('已停用再停用被挡', r.ok === false)
const v6end = mod.listPumpViews(TODAY).find((v) => v.id === id6)
ok('最终态=已停用', v6end.displayStatus === '已停用' && v6end.status === '已停用')

console.log(`\n全部 ${pass} 项断言通过`)
