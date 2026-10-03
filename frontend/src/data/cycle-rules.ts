import type { OperatorRole } from './circpump'

// 保养周期按换热站分组核定：站点核定一条，站里所有泵共用，泵台账里的旧值只作回退。

export type CycleRule = {
  station: string
  cycleDays: number
  updatedAt: string
  updatedBy: string
}

const RULE_STORAGE_KEY = 'district-heating:cycle-rules:v1'

// 首次播种的分组核定结果，设备员可在页面上继续维护。
const DEFAULT_RULES: CycleRule[] = [
  { station: '振兴路站', cycleDays: 90, updatedAt: '2026-09-30', updatedBy: '设备员' },
  { station: '河滨花园站', cycleDays: 60, updatedAt: '2026-09-30', updatedBy: '设备员' },
  { station: '工业园站', cycleDays: 120, updatedAt: '2026-09-30', updatedBy: '设备员' },
  { station: '老城站', cycleDays: 45, updatedAt: '2026-09-30', updatedBy: '设备员' },
]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readRules(): CycleRule[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(DEFAULT_RULES)
  }
  const raw = window.localStorage.getItem(RULE_STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(RULE_STORAGE_KEY, JSON.stringify(DEFAULT_RULES))
    return clone(DEFAULT_RULES)
  }
  try {
    const parsed = JSON.parse(raw) as CycleRule[]
    return Array.isArray(parsed) ? parsed : clone(DEFAULT_RULES)
  } catch {
    return clone(DEFAULT_RULES)
  }
}

let cache: CycleRule[] | null = null

function allRules(): CycleRule[] {
  if (cache === null) {
    cache = readRules()
  }
  return cache
}

function persist(rules: CycleRule[]): void {
  cache = rules
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(RULE_STORAGE_KEY, JSON.stringify(rules))
  }
}

export function listCycleRules(): CycleRule[] {
  return [...allRules()].sort((a, b) => a.station.localeCompare(b.station, 'zh-Hans-CN'))
}

export function cycleRuleDays(station: string): number | null {
  const name = station.trim()
  if (!name) {
    return null
  }
  const hit = allRules().find((rule) => rule.station === name)
  return hit ? hit.cycleDays : null
}

export function saveCycleRule(
  station: string,
  cycleDays: number,
  role: OperatorRole,
  today: string,
): { ok: boolean; message: string } {
  if (role !== '设备员') {
    return { ok: false, message: '保养周期由设备员按换热站分组核定，值班员只能查看' }
  }
  const name = station.trim()
  if (!name) {
    return { ok: false, message: '换热站名称不能为空' }
  }
  if (!Number.isInteger(cycleDays) || cycleDays < 1 || cycleDays > 365) {
    return { ok: false, message: '保养周期需为 1~365 之间的整数（天）' }
  }
  const rules = allRules()
  const index = rules.findIndex((rule) => rule.station === name)
  const rule: CycleRule = { station: name, cycleDays, updatedAt: today, updatedBy: '设备员' }
  if (index >= 0) {
    rules[index] = rule
  } else {
    rules.push(rule)
  }
  persist(rules)
  return { ok: true, message: `「${name}」保养周期已核定为 ${cycleDays} 天` }
}
