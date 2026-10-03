import { listRows, saveRows } from './local-store'
import type { ActionResult, EntryRow } from './types'

// 循环泵运维的业务规则集中在这里：保养提醒、周期核定、状态流转护栏、阀门井联动都不走通用动作。

export const PUMP_KEY = 'circpump'
export const VALVE_KEY = 'valvewell'
export const PUMP_STATUSES = ['待保养', '运行中', '已保养', '已停用'] as const
const STATION_CYCLE_KEY = 'district-heating:circpump:station-cycles'

// 换热站分组核定的默认保养周期：未核定的站一律为空，空周期不进入保养提醒。
const DEFAULT_STATION_CYCLES: Record<string, string> = {
  新华换热站: '90天',
  河西换热站: '半年',
}

// ---------- 文本/日期/数值解析（解析失败返回 null，由调用方按异常处理，不抛错、不拖垮整屏） ----------

/** 保养周期写法兼容既有台账：90天、180、半年、季度、3月、2周、一年都能认；认不出返回 null。 */
export function parseCycleDays(text: unknown): number | null {
  if (text === undefined || text === null) return null
  const raw = String(text).trim()
  if (!raw) return null
  const num = /\d+(?:\.\d+)?/.exec(raw)
  const n = num ? Number(num[0]) : null
  if (raw.includes('半') && raw.includes('年')) return 180
  if (raw.includes('年')) return n && n > 0 ? Math.round(n * 365) : 365
  if (raw.includes('季')) return n && n > 0 ? Math.round(n * 90) : 90
  if (raw.includes('月')) return n && n > 0 ? Math.round(n * 30) : 30
  if (raw.includes('周')) return n && n > 0 ? Math.round(n * 7) : 7
  if (raw.includes('天') || raw.includes('日')) return n && n > 0 ? Math.round(n) : null
  if (n && n > 0) return Math.round(n)
  return null
}

/** 解析 YYYY-MM-DD / YYYY/MM/DD，非法日期返回 null，按本地时区构造避免差一天。 */
export function parseDate(value: unknown): Date | null {
  if (value === undefined || value === null) return null
  const raw = String(value).trim()
  if (!raw) return null
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(raw)
  if (match) {
    const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    return Number.isNaN(d.getTime()) ? null : d
  }
  const fallback = new Date(raw)
  return Number.isNaN(fallback.getTime()) ? null : fallback
}

export function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 扬程/电流里的数值：86A、32m 取出 86、32；空着或「待校」这类取不出数的返回 null。 */
export function parsePositive(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const raw = String(value).trim()
  if (!raw) return null
  const match = /\d+(?:\.\d+)?/.exec(raw)
  if (!match) return null
  const n = Number(match[0])
  return n > 0 ? n : null
}

// 行数据的宽松读视图：台账行 EntryRow 与带派生字段的 PumpView 都能传入只读判断函数。
type RowLike = Record<string, string | number | boolean | Date | null>

export function isHeadMissing(row: RowLike): boolean {
  return parsePositive(row['扬程']) === null
}

export function isCurrentAbnormal(row: RowLike): boolean {
  const raw = String(row['运行电流'] ?? '').trim()
  return raw !== '' && parsePositive(raw) === null
}

/** 数值异常：扬程缺失/非数值，或运行电流登记了却取不出数。异常记录单独标出，不影响列表渲染。 */
export function isValueAbnormal(row: RowLike): boolean {
  return isHeadMissing(row) || isCurrentAbnormal(row)
}

// ---------- 保养周期：按换热站分组核定，台账行内登记的周期优先（兼容既有保养做法） ----------

function readStationCycles(): Record<string, string> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...DEFAULT_STATION_CYCLES }
  }
  const raw = window.localStorage.getItem(STATION_CYCLE_KEY)
  if (raw === null) {
    window.localStorage.setItem(STATION_CYCLE_KEY, JSON.stringify(DEFAULT_STATION_CYCLES))
    return { ...DEFAULT_STATION_CYCLES }
  }
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return { ...DEFAULT_STATION_CYCLES }
  }
}

function writeStationCycles(cycles: Record<string, string>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STATION_CYCLE_KEY, JSON.stringify(cycles))
  }
}

export function getStationCycles(): Record<string, string> {
  return readStationCycles()
}

/** 核定某换热站的保养周期；传空串表示该站不核定，其下各泵均不进入提醒。 */
export function setStationCycle(station: string, cycleText: string): void {
  const cycles = readStationCycles()
  const text = cycleText.trim()
  if (text) {
    cycles[station] = text
  } else {
    delete cycles[station]
  }
  writeStationCycles(cycles)
}

/** 有效周期文本：泵台账行内登记优先；行内为空才回落到换热站分组核定值。 */
export function effectiveCycleText(row: EntryRow, stationCycles: Record<string, string>): string {
  const own = String(row['保养周期'] ?? '').trim()
  if (own) return own
  return stationCycles[String(row['所属换热站'] ?? '')]?.trim() ?? ''
}

// ---------- 保养提醒 ----------

export type PumpView = {
  [field: string]: string | number | boolean | Date | null
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  displayStatus: string
  effectiveCycle: string
  cycleDays: number | null
  lastDate: Date | null
  nextDueDate: Date | null
  overdueDays: number
  reminderEligible: boolean
  due: boolean
  neverMaintained: boolean
  excludeReason: string
  headMissing: boolean
  valueAbnormal: boolean
}

function diffDays(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime()
  return Math.round((b - a) / 86400000)
}

/**
 * 展示态（不落库）：停用泵保持已停用；其余泵只按「有效保养周期 + 上次保养日」推算。
 * 周期未核定的不进提醒；从未登记上次保养日且周期已核定的，按到期提醒。
 */
export function derivePumpView(row: EntryRow, today: Date, stationCycles: Record<string, string>): PumpView {
  const stored = String(row.status)
  const cycle = effectiveCycleText(row, stationCycles)
  const cycleDays = parseCycleDays(cycle)
  const lastDate = parseDate(row['上次保养日'])
  const eligible = cycleDays !== null

  let nextDueDate: Date | null = null
  let overdueDays = 0
  if (cycleDays !== null && lastDate) {
    nextDueDate = new Date(lastDate.getTime())
    nextDueDate.setDate(nextDueDate.getDate() + cycleDays)
    overdueDays = diffDays(nextDueDate, today)
  }

  const neverMaintained = stored !== '已停用' && eligible && !lastDate
  const dueByDate = stored !== '已停用' && eligible && !!lastDate && nextDueDate !== null && diffDays(lastDate, today) >= cycleDays!
  const due = neverMaintained || dueByDate

  let displayStatus = stored
  if (stored !== '已停用') {
    if (due) displayStatus = '待保养'
    else if (stored === '待保养') displayStatus = '待保养'
  }

  let excludeReason = ''
  if (stored !== '已停用' && !eligible) {
    excludeReason = '保养周期未核定，不进入保养提醒'
  }

  return {
    ...row,
    displayStatus,
    effectiveCycle: cycle,
    cycleDays,
    lastDate,
    nextDueDate,
    overdueDays: overdueDays > 0 ? overdueDays : 0,
    reminderEligible: eligible,
    due,
    neverMaintained,
    excludeReason,
    headMissing: isHeadMissing(row),
    valueAbnormal: isValueAbnormal(row),
  }
}

export function listPumpViews(today: Date = new Date()): PumpView[] {
  const cycles = readStationCycles()
  return listRows(PUMP_KEY).map((row) => derivePumpView(row, today, cycles))
}

export type StationGroup = {
  station: string
  cycleText: string
  cycleDays: number | null
  total: number
  active: number
  due: number
  noCycle: number
}

/** 按换热站分组核定周期，一组看到：周期写法、泵数、到期数、未核定数。 */
export function listStationGroups(today: Date = new Date()): StationGroup[] {
  const cycles = readStationCycles()
  const rows = listRows(PUMP_KEY)
  const stations = new Set<string>()
  for (const row of rows) stations.add(String(row['所属换热站'] ?? ''))
  for (const station of Object.keys(cycles)) stations.add(station)

  return [...stations].sort().map((station) => {
    const members = rows.filter((row) => String(row['所属换热站'] ?? '') === station)
    const views = members.map((row) => derivePumpView(row, today, cycles))
    const active = views.filter((v) => v.status !== '已停用')
    // 在运行（运行中/待保养）的泵才计入保养提醒；刚完成保养在「已保养」中的不重复提醒。
    const inMaintenanceFlow = active.filter((v) => v.status === '运行中' || v.status === '待保养')
    return {
      station,
      cycleText: cycles[station] ?? '',
      cycleDays: parseCycleDays(cycles[station]),
      total: members.length,
      active: active.length,
      due: inMaintenanceFlow.filter((v) => v.due).length,
      noCycle: inMaintenanceFlow.filter((v) => !v.reminderEligible).length,
    }
  })
}

// ---------- 设备员台账维护：上次保养日、扬程补登等 ----------

export function updatePumpLedger(
  id: number,
  patch: { lastDate?: string; head?: string },
): ActionResult {
  const rows = listRows(PUMP_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的循环泵` }

  if (patch.lastDate !== undefined) {
    const text = patch.lastDate.trim()
    if (text && !parseDate(text)) {
      return { ok: false, message: '上次保养日格式无法识别，请使用 YYYY-MM-DD' }
    }
  }
  if (patch.head !== undefined) {
    const text = patch.head.trim()
    if (text && parsePositive(text) === null) {
      return { ok: false, message: '扬程需为正数（可带 m 等单位），「待校」这类写法请先核实再登记' }
    }
  }

  const updated: EntryRow = { ...rows[index] }
  if (patch.lastDate !== undefined) updated['上次保养日'] = patch.lastDate.trim()
  if (patch.head !== undefined) updated['扬程'] = patch.head.trim()
  updated.abnormal = isValueAbnormal(updated)

  const next = [...rows]
  next[index] = updated
  saveRows(PUMP_KEY, next)
  return { ok: true, message: '循环泵台账已更新' }
}

// ---------- 阀门井待检查清单联动（重复报送只记一次） ----------

function valvewellSourceKey(pumpId: number, today: string): string {
  return `CIRC-${pumpId}-${today}`
}

/** 保养结果落到阀门井「待检查」清单；同一台泵同一天的重复报送不重复登记。 */
export function createValvewellCheck(pump: EntryRow, today: string): { created: boolean } {
  const rows = listRows(VALVE_KEY)
  const sourceKey = valvewellSourceKey(Number(pump.id), today)
  if (rows.some((row) => String(row['来源单号'] ?? '') === sourceKey)) {
    return { created: false }
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const station = String(pump['所属换热站'] ?? '')
  const code = String(pump['泵编号'] ?? pump.id)
  const row: EntryRow = {
    id: nextId,
    status: '待检查',
    pending: true,
    abnormal: false,
    井编号: `FWJ-CIRC-${String(pump.id).padStart(4, '0')}`,
    所属管段: station ? `${station}循环泵支路` : `循环泵${code}支路`,
    井盖状况: '待检查',
    阀门型号: String(pump['泵型号'] ?? ''),
    检查人: '',
    检查日期: '',
    养护措施: `循环泵${code}已于${today}完成保养，待阀门井复查`,
    井体状态: '待检查',
    来源模块: '循环泵运维',
    来源单号: sourceKey,
  }
  saveRows(VALVE_KEY, [...rows, row])
  return { created: true }
}

// ---------- 状态流转：按 待保养→运行中→已保养→已停用 推进，越级挡回 ----------

export function availableActions(storedStatus: string): string[] {
  switch (storedStatus) {
    case '待保养':
      return ['登记运行']
    case '运行中':
      return ['完成保养']
    case '已保养':
      return ['停用设备']
    default:
      return []
  }
}

export function runPumpAction(id: number, action: string, today: Date = new Date()): ActionResult {
  const rows = listRows(PUMP_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${id} 的循环泵` }

  const current = rows[index]
  const stored = String(current.status)
  const todayText = formatDate(today)

  if (action === '登记运行') {
    if (stored === '已停用') return { ok: false, message: '该循环泵已停用，不能再登记运行' }
    if (stored !== '待保养') {
      return { ok: false, message: `越级流转被挡回：当前「${stored}」，只能从「待保养」登记运行` }
    }
    persist(index, { ...current, status: '运行中', pending: true })
    return { ok: true, message: '循环泵已登记运行，当前状态「运行中」' }
  }

  if (action === '停用设备') {
    if (stored === '已停用') return { ok: false, message: '该循环泵已经是「已停用」，不用重复操作' }
    if (stored !== '已保养') {
      return { ok: false, message: `越级流转被挡回：当前「${stored}」，按流程须先完成保养才能停用` }
    }
    persist(index, { ...current, status: '已停用', pending: false, abnormal: false })
    return { ok: true, message: '循环泵已停用，当前状态「已停用」' }
  }

  if (action !== '完成保养') {
    return { ok: false, message: `循环泵没有登记「${action}」这个动作` }
  }

  // 完成保养：先挡停用，再挡重复报送，再挡越级，最后挡扬程缺失。
  if (stored === '已停用') {
    return { ok: false, message: '已停用的循环泵不许再提交保养，请先核实设备状态' }
  }
  if (String(current['上次保养日'] ?? '') === todayText) {
    return { ok: false, message: '该泵今日已完成保养报送，保养只记一次，阀门井待检查清单不重复登记' }
  }
  if (stored !== '运行中') {
    return { ok: false, message: `越级流转被挡回：当前「${stored}」，保养只能在「运行中」提交` }
  }
  if (isHeadMissing(current)) {
    return {
      ok: false,
      message: '扬程缺失或无法取数，先在台账维护里补登扬程，再提交保养',
    }
  }

  const updated: EntryRow = {
    ...current,
    status: '已保养',
    pending: false,
    abnormal: isValueAbnormal(current),
    上次保养日: todayText,
  }
  persist(index, updated)
  const { created } = createValvewellCheck(updated, todayText)
  return {
    ok: true,
    message: created
      ? `循环泵已于${todayText}完成保养，已转入阀门井待检查清单`
      : `循环泵已于${todayText}完成保养（阀门井待检查项今日已存在，未重复登记）`,
  }
}

function persist(index: number, row: EntryRow): void {
  const rows = listRows(PUMP_KEY)
  const next = [...rows]
  next[index] = row
  saveRows(PUMP_KEY, next)
}
