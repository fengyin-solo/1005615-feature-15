import type { EntryRow } from './types'
import { listRows, saveRows } from './local-store'
import { cycleRuleDays } from './cycle-rules'

// 循环泵保养领域规则：提醒推算、状态流转守卫、异常隔离、阀门井联动都集中在这里，
// 页面只负责展示，概览、台账、待保养栏取的是同一份口径。

export const PUMP_KEY = 'circpump'
export const WELL_KEY = 'valvewell'

// 状态必须沿这个顺序逐级推进，越级一律挡回。
export const PUMP_STATUSES = ['待保养', '运行中', '已保养', '已停用'] as const
export const PUMP_ACTIVE_STATUSES = ['待保养', '运行中'] as const

// 示例环境没有后端时钟，演示日期固定在数据播种的当季；接回后端时改成服务端日期即可。
export const BUSINESS_TODAY = '2026-10-03'
// 距保养日多少天内算「临近保养」。
const SOON_DAYS = 7

export type OperatorRole = '值班员' | '设备员'

type NumberRead =
  | { kind: 'empty' }
  | { kind: 'ok'; value: number }
  | { kind: 'bad'; raw: string }

export type PumpRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: unknown
  head: NumberRead
  current: NumberRead
  lastDateValid: boolean
  cycleDays: number | null
  cycleSource: '换热站核定' | '泵台账旧值' | null
  dueDate: string | null
  daysLeft: number | null
  reminder: 'due' | 'soon' | null
  issues: string[]
}

export type PumpActionResult = {
  ok: boolean
  message: string
  syncedWell?: boolean
}

function textOf(row: Record<string, unknown>, field: string): string {
  return String(row[field] ?? '').trim()
}

/** 数值字段逐列读：空、合法正数、非法文本三种结果互不相扰，一条坏数据不拖垮整屏。 */
function readNumber(raw: string, { allowEmpty }: { allowEmpty: boolean }): NumberRead {
  const text = raw.trim()
  if (text === '') {
    return allowEmpty ? { kind: 'empty' } : { kind: 'bad', raw }
  }
  const value = Number(text)
  if (!Number.isFinite(value)) {
    return { kind: 'bad', raw }
  }
  return { kind: 'ok', value }
}

function isValidDate(value: string): boolean {
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false
  }
  const [y, m, d] = text.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  )
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + days))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

function diffDays(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number)
  const [ty, tm, td] = toIso.split('-').map(Number)
  const from = Date.UTC(fy, fm - 1, fd)
  const to = Date.UTC(ty, tm - 1, td)
  return Math.round((to - from) / 86400000)
}

function readLegacyCycle(raw: string): number | null {
  const text = raw.trim()
  if (text === '') {
    return null
  }
  // 兼容泵台账里既有的填法：「90」「90天」都认。
  const matched = text.match(/^(\d{1,4})\s*天?$/)
  if (!matched) {
    return null
  }
  const days = Number(matched[1])
  return days > 0 && days <= 365 ? days : null
}

/** 逐条解析泵台账：任何一条字段异常只挂到该条上，绝不让列表整体抛错。 */
export function decoratePump(row: EntryRow): PumpRow {
  const headRaw = textOf(row, '扬程')
  const currentRaw = textOf(row, '运行电流')
  const lastRaw = textOf(row, '上次保养日')
  const station = textOf(row, '所属换热站')
  const legacyDays = readLegacyCycle(textOf(row, '保养周期'))

  // 保养周期按换热站分组核定；站点没有核定时，回退台账旧值，仍没有就空着（不提醒）。
  const approvedDays = cycleRuleDays(station)
  const cycleDays = approvedDays ?? legacyDays
  const cycleSource: PumpRow['cycleSource'] =
    approvedDays !== null ? '换热站核定' : legacyDays !== null ? '泵台账旧值' : null

  const head = readNumber(headRaw, { allowEmpty: false })
  const current = readNumber(currentRaw, { allowEmpty: true })
  const lastDateValid = lastRaw !== '' && isValidDate(lastRaw)

  const issues: string[] = []
  if (head.kind === 'bad' && head.raw.trim() === '') {
    issues.push('扬程缺失')
  } else if (head.kind === 'bad') {
    issues.push(`扬程数值异常（${head.raw || '空'}）`)
  } else if (head.kind === 'ok' && head.value <= 0) {
    issues.push('扬程需为正数')
  }
  if (current.kind === 'bad') {
    issues.push(`运行电流数值异常（${current.raw || '空'}）`)
  } else if (current.kind === 'ok' && current.value < 0) {
    issues.push('运行电流不能为负')
  }
  if (lastRaw !== '' && !lastDateValid) {
    issues.push(`上次保养日格式异常（${lastRaw}）`)
  }

  const active = (PUMP_ACTIVE_STATUSES as readonly string[]).includes(String(row.status))
  let dueDate: string | null = null
  let daysLeft: number | null = null
  let reminder: PumpRow['reminder'] = null
  if (active && cycleDays !== null && lastDateValid) {
    dueDate = addDays(lastRaw, cycleDays)
    daysLeft = diffDays(BUSINESS_TODAY, dueDate)
    if (daysLeft <= 0) {
      reminder = 'due'
    } else if (daysLeft <= SOON_DAYS) {
      reminder = 'soon'
    }
  }

  return {
    ...row,
    head,
    current,
    lastDateValid,
    cycleDays,
    cycleSource,
    dueDate,
    daysLeft,
    reminder,
    issues,
  }
}

export function decoratePumpRows(rows: EntryRow[]): PumpRow[] {
  return rows.map((row) => {
    try {
      return decoratePump(row)
    } catch {
      // 兜底：单条解析失败也降级展示原始行，绝不整屏空白。
      return decoratePump({ ...row, abnormal: true })
    }
  })
}

export function listPumps(): PumpRow[] {
  return decoratePumpRows(listRows(PUMP_KEY))
}

export type PumpReminderGroups = {
  due: PumpRow[]
  waiting: PumpRow[]
  excluded: { row: PumpRow; reason: string }[]
}

/** 待保养栏口径：到期/临近的进提醒；周期为空、日期缺失等只列原因，不进提醒。 */
export function pumpReminders(rows: PumpRow[] = listPumps()): PumpReminderGroups {
  const due: PumpRow[] = []
  const waiting: PumpRow[] = []
  const excluded: { row: PumpRow; reason: string }[] = []

  for (const row of rows) {
    if (!PUMP_ACTIVE_STATUSES.includes(String(row.status) as (typeof PUMP_ACTIVE_STATUSES)[number])) {
      continue
    }
    if (row.reminder === 'due') {
      due.push(row)
      continue
    }
    if (row.reminder === 'soon') {
      waiting.push(row)
      continue
    }
    const station = textOf(row, '所属换热站')
    if (row.cycleDays === null) {
      excluded.push({
        row,
        reason: `所属换热站「${station || '未填'}」尚未核定保养周期，台账周期也为空，不进提醒`,
      })
      continue
    }
    if (textOf(row, '上次保养日') === '') {
      excluded.push({ row, reason: '上次保养日未登记，无法推算，待设备员补录' })
      continue
    }
    if (!row.lastDateValid) {
      excluded.push({ row, reason: `上次保养日「${textOf(row, '上次保养日')}」无法识别，无法推算` })
      continue
    }
  }

  due.sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
  waiting.sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
  return { due, waiting, excluded }
}

function deriveAbnormal(row: PumpRow): boolean {
  const badHead = row.head.kind === 'bad' || (row.head.kind === 'ok' && row.head.value <= 0)
  const badCurrent =
    row.current.kind === 'bad' || (row.current.kind === 'ok' && row.current.value < 0)
  return Boolean(badHead || badCurrent || row.issues.some((item) => item.includes('保养日格式')))
}

function persistPump(rows: EntryRow[], index: number, next: EntryRow): void {
  const copy = [...rows]
  copy[index] = next
  saveRows(PUMP_KEY, copy)
}

/** 完成保养后把阀门井待检查清单记一条；同一台泵有未结项时不重复记。 */
function syncValveWell(pump: EntryRow, maintainDate: string): boolean {
  const pumpCode = textOf(pump, '泵编号')
  const station = textOf(pump, '所属换热站')
  const wells = listRows(WELL_KEY)
  const open = wells.some(
    (item) =>
      textOf(item, '来源泵编号') === pumpCode &&
      ['待检查', '检查中'].includes(String(item.status)) &&
      textOf(item, '保养日期') === maintainDate,
  )
  if (open) {
    return false
  }
  const nextId = wells.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  wells.push({
    id: nextId,
    status: '待检查',
    pending: true,
    abnormal: false,
    井编号: `VW-${pumpCode}`,
    所属管段: `${station}泵组回水母管`,
    井盖状况: `循环泵 ${pumpCode} 保养联动（${maintainDate}）`,
    阀门型号: '循环泵保养联动',
    检查人: '待安排',
    检查日期: '',
    养护措施: '保养后检查',
    井体状态: '待检查',
    来源: '泵保养联动',
    来源泵编号: pumpCode,
    保养日期: maintainDate,
  })
  saveRows(WELL_KEY, wells)
  return true
}

/**
 * 循环泵动作守卫：逐级流转 + 停用设备封死 + 扬程先挡 + 保养联动阀门井。
 * 返回 ok=false 时数据原样不动。
 */
export function runPumpAction(
  id: number,
  action: string,
  role: OperatorRole = '值班员',
): PumpActionResult {
  const targetByAction: Record<string, (typeof PUMP_STATUSES)[number]> = {
    登记运行: '运行中',
    完成保养: '已保养',
    停用设备: '已停用',
  }
  const target = targetByAction[action]
  if (!target) {
    return { ok: false, message: `循环泵没有登记「${action}」这个动作` }
  }

  const rows = listRows(PUMP_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的循环泵` }
  }
  const raw = rows[index]
  const currentStatus = String(raw.status)

  if (currentStatus === '已停用') {
    return { ok: false, message: `泵 ${textOf(raw, '泵编号')} 已停用，不能再提交${action}` }
  }
  if (currentStatus === target) {
    return action === '完成保养'
      ? { ok: false, message: `泵 ${textOf(raw, '泵编号')} 已是「已保养」，保养报送只记一次，请勿重复提交` }
      : { ok: false, message: `泵 ${textOf(raw, '泵编号')} 已经是「${target}」，请勿重复操作` }
  }
  const fromIndex = PUMP_STATUSES.indexOf(currentStatus as (typeof PUMP_STATUSES)[number])
  const toIndex = PUMP_STATUSES.indexOf(target)
  if (fromIndex < 0 || toIndex !== fromIndex + 1) {
    return {
      ok: false,
      message: `状态只能按 待保养→运行中→已保养→已停用 逐级推进，「${currentStatus}」不能直接${action}到「${target}」`,
    }
  }

  const pump = decoratePump(raw)
  const headOk = pump.head.kind === 'ok' && pump.head.value > 0
  if (['登记运行', '完成保养'].includes(action) && !headOk) {
    const detail =
      textOf(raw, '扬程') === '' ? '扬程缺失' : `扬程「${textOf(raw, '扬程')}」不是有效数值`
    return { ok: false, message: `${detail}，请先由设备员补录后再${action}` }
  }

  const now = BUSINESS_TODAY
  const next: EntryRow = { ...raw, status: target }
  let synced = false

  if (action === '完成保养') {
    // 保养日写当天，阀门井联动在 syncValveWell 内按同泵同日未结项去重，重复报送只记一次。
    next['上次保养日'] = now
    synced = syncValveWell(raw, now)
  }

  const decorated = decoratePump(next)
  next.abnormal = deriveAbnormal(decorated)
  next.pending = target !== '已停用'
  persistPump(rows, index, next)

  const suffix =
    action === '完成保养'
      ? synced
        ? '，阀门井待检查清单已新增一条联动记录'
        : '，阀门井已有同日未结检查项，未重复登记'
      : ''
  return { ok: true, message: `泵 ${textOf(raw, '泵编号')} 已${action}，当前状态「${target}」${suffix}`, syncedWell: synced }
}

function ensureEquipment(role: OperatorRole): string | null {
  return role === '设备员' ? null : '只有设备员可以维护该信息'
}

/** 上次保养日由设备员维护；看板与台账都从这里读同一值。 */
export function updateLastMaintain(id: number, date: string, role: OperatorRole): PumpActionResult {
  const denied = ensureEquipment(role)
  if (denied) {
    return { ok: false, message: denied }
  }
  if (!isValidDate(date)) {
    return { ok: false, message: '上次保养日需为 YYYY-MM-DD 格式的有效日期' }
  }
  if (date > BUSINESS_TODAY) {
    return { ok: false, message: '上次保养日不能晚于今天' }
  }
  const rows = listRows(PUMP_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的循环泵` }
  }
  const next: EntryRow = { ...rows[index], ['上次保养日']: date }
  next.abnormal = deriveAbnormal(decoratePump(next))
  persistPump(rows, index, next)
  return { ok: true, message: `泵 ${textOf(next, '泵编号')} 的上次保养日已登记为 ${date}` }
}

/** 扬程缺失的先挡下：设备员补录后才能推进保养，这里做受控补录。 */
export function updateHead(id: number, head: string, role: OperatorRole): PumpActionResult {
  const denied = ensureEquipment(role)
  if (denied) {
    return { ok: false, message: denied }
  }
  const value = Number(head.trim())
  if (head.trim() === '' || !Number.isFinite(value) || value <= 0) {
    return { ok: false, message: '扬程需为大于 0 的数字（米）' }
  }
  const rows = listRows(PUMP_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的循环泵` }
  }
  const next: EntryRow = { ...rows[index], 扬程: String(value) }
  next.abnormal = deriveAbnormal(decoratePump(next))
  persistPump(rows, index, next)
  return { ok: true, message: `泵 ${textOf(next, '泵编号')} 的扬程已补录为 ${value} 米` }
}

export function isPumpRowAbnormal(row: PumpRow): boolean {
  return deriveAbnormal(row)
}

export { cycleRuleDays }
