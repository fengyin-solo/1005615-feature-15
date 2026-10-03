<template>
  <section class="page" data-module="circpump">
    <header class="page-head">
      <div>
        <h2>循环泵运维管理</h2>
        <p class="page-desc">
          保养周期按换热站分组核定，上次保养日由设备员维护；系统只按「上次保养日 + 核定周期」推算提醒。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出循环泵运维清单</button>
      </div>
    </header>

    <div class="role-bar">
      <span>当前身份：</span>
      <label class="role-option"><input type="radio" value="值班员" v-model="roleModel" /> 值班员（流转操作）</label>
      <label class="role-option"><input type="radio" value="设备员" v-model="roleModel" /> 设备员（维护台账/核定周期）</label>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 待保养栏：只有周期、上次保养日都齐的泵才会进提醒；不齐的只在下面说明原因。 -->
    <div class="reminder-panel">
      <h3 class="panel-title">保养提醒（只按上次保养日 + 核定周期推算）</h3>
      <div v-if="reminders.due.length" class="reminder-group due">
        <strong>已到保养日（{{ reminders.due.length }}）：</strong>
        <ul class="reminder-list">
          <li v-for="row in reminders.due" :key="String(row.id)">
            {{ row['泵编号'] }} · {{ row['所属换热站'] }} ·
            上次保养 {{ row['上次保养日'] }}（{{ formatCycle(row) }}），
            已超期 {{ -(row.daysLeft ?? 0) }} 天
            <span v-if="row.issues.length" class="warn-text">（{{ row.issues.join('；') }}，保养提交会被挡下）</span>
          </li>
        </ul>
      </div>
      <div v-if="reminders.waiting.length" class="reminder-group soon">
        <strong>7 天内临近保养（{{ reminders.waiting.length }}）：</strong>
        <ul class="reminder-list">
          <li v-for="row in reminders.waiting" :key="String(row.id)">
            {{ row['泵编号'] }} · {{ row['所属换热站'] }} ·
            保养日 {{ row.dueDate }}，还剩 {{ row.daysLeft }} 天
          </li>
        </ul>
      </div>
      <div v-if="reminders.excluded.length" class="reminder-group excluded">
        <strong>未进提醒（{{ reminders.excluded.length }}）：</strong>
        <ul class="reminder-list">
          <li v-for="item in reminders.excluded" :key="String(item.row.id)">
            {{ item.row['泵编号'] }}：{{ item.reason }}
          </li>
        </ul>
      </div>
      <p v-if="!reminders.due.length && !reminders.waiting.length && !reminders.excluded.length" class="muted-text">
        当前没有运行中的泵需要保养。
      </p>
    </div>

    <!-- 保养周期按换热站分组核定，只有设备员能改。 -->
    <div class="cycle-panel">
      <h3 class="panel-title">保养周期核定（按换热站分组）</h3>
      <div v-if="session.isEquipment" class="cycle-edit">
        <input v-model="ruleStation" list="station-options" placeholder="换热站名称" />
        <datalist id="station-options">
          <option v-for="station in stations" :key="station" :value="station"></option>
        </datalist>
        <input v-model.number="ruleDays" type="number" min="1" max="365" placeholder="周期（天）" />
        <button class="btn primary" type="button" @click="saveRule">核定/修改周期</button>
        <span v-if="ruleMessage" :class="ruleOk ? 'ok-text' : 'error-text'">{{ ruleMessage }}</span>
      </div>
      <p v-else class="muted-text">只读视图，周期核定需切换到设备员身份。</p>
      <table class="data-table compact">
        <thead>
          <tr><th>换热站</th><th>保养周期（天）</th><th>最近核定</th><th>核定人</th></tr>
        </thead>
        <tbody>
          <tr v-for="rule in rules" :key="rule.station">
            <td>{{ rule.station }}</td>
            <td>{{ rule.cycleDays }}</td>
            <td>{{ rule.updatedAt }}</td>
            <td>{{ rule.updatedBy }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>下次保养日</th>
          <th>数据异常</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in visibleRows"
          :key="String(row.id)"
          :class="{ 'row-abnormal': isAbnormal(row) }"
        >
          <td>
            {{ row['泵编号'] }}
            <span v-if="row.reminder === 'due'" class="tag tag-due">到保</span>
            <span v-else-if="row.reminder === 'soon'" class="tag tag-soon">临近</span>
          </td>
          <td>{{ row['所属换热站'] }}</td>
          <td>{{ row['泵型号'] }}</td>
          <td>
            <template v-if="row.current.kind === 'ok'">{{ row.current.value }}</template>
            <template v-else-if="row.current.kind === 'empty'">—</template>
            <template v-else><span class="warn-text">{{ row['运行电流'] }}（异常）</span></template>
          </td>
          <td>
            <template v-if="row.head.kind === 'ok'">{{ row.head.value }}</template>
            <template v-else>
              <span class="warn-text">{{ row['扬程'] || '缺失' }}（异常）</span>
              <button v-if="session.isEquipment" class="link" type="button" @click="openHeadEdit(row)">补录</button>
            </template>
          </td>
          <td>
            <span :title="cycleTitle(row)">
              {{ row.cycleDays !== null ? `${row.cycleDays} 天` : '空' }}
              <small class="muted-text">{{ row.cycleSource ? `（${row.cycleSource}）` : '（未核定）' }}</small>
            </span>
          </td>
          <td>
            {{ row['上次保养日'] || '未登记' }}
            <button v-if="session.isEquipment" class="link" type="button" @click="openDateEdit(row)">改</button>
          </td>
          <td>{{ row['运行状态'] }}</td>
          <td>{{ row.dueDate ?? '—' }}</td>
          <td>
            <span v-if="isAbnormal(row)" class="warn-text">{{ row.issues.join('；') }}</span>
            <span v-else class="ok-text">正常</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in allowedActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!allowedActions(row).length" class="muted-text">无可用操作</span>
          </td>
        </tr>
        <tr v-if="!visibleRows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无循环泵运维数据</td>
        </tr>
      </tbody>
    </table>

    <!-- 设备员补录弹窗：扬程缺失 / 上次保养日补录 -->
    <div v-if="editing" class="modal-mask" @click.self="editing = null">
      <div class="modal-card">
        <h3>{{ editing.kind === 'head' ? '补录扬程' : '维护上次保养日' }}</h3>
        <p class="muted-text">泵 {{ editing.row['泵编号'] }}（{{ editing.row['所属换热站'] }}），操作人：{{ session.operator }}</p>
        <label class="filter-item">
          <span>{{ editing.kind === 'head' ? '扬程（米，大于 0）' : '上次保养日（YYYY-MM-DD）' }}</span>
          <input
            v-model="editing.value"
            :type="editing.kind === 'head' ? 'number' : 'date'"
            min="0"
          />
        </label>
        <p v-if="editMessage" class="error-text">{{ editMessage }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="editing = null">取消</button>
          <button class="btn primary" type="button" @click="submitEdit">保存</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条循环泵运维记录；异常记录不影响列表加载</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  BUSINESS_TODAY,
  listPumps,
  pumpReminders,
  runPumpAction,
  updateHead,
  updateLastMaintain,
  type PumpRow,
} from '@/data/circpump'
import { listCycleRules, saveCycleRule } from '@/data/cycle-rules'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()

const columns = ["泵编号", "所属换热站", "泵型号", "运行电流", "扬程", "保养周期", "上次保养日", "运行状态"]
const filterFields = columns.slice(0, 3)
const PUMP_STATUS_ORDER = ["待保养", "运行中", "已保养", "已停用"]

const pumps = ref<PumpRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const rules = ref(listCycleRules())
const ruleStation = ref('')
const ruleDays = ref<number | null>(null)
const ruleMessage = ref('')
const ruleOk = ref(false)

type Editing = { row: PumpRow; kind: 'head' | 'date'; value: string }
const editing = ref<Editing | null>(null)
const editMessage = ref('')

const roleModel = computed({
  get: () => session.role,
  set: (value: string) => session.setRole(value === '设备员' ? '设备员' : '值班员'),
})

const reminders = computed(() => pumpReminders(pumps.value))

const stations = computed(() => [
  ...new Set(pumps.value.map((row) => String(row['所属换热站'] ?? '').trim()).filter(Boolean)),
])

const statusSummary = computed(() =>
  PUMP_STATUS_ORDER.map((status) => ({
    status,
    count: pumps.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '运行中循环泵', value: pumps.value.filter((row) => String(row.status) === '运行中').length },
  { label: '待保养循环泵', value: reminders.value.due.length },
  { label: '本月保养数', value: monthMaintained.value },
])

const monthMaintained = computed(() =>
  pumps.value.filter((row) => {
    const date = String(row['上次保养日'] ?? '')
    return String(row.status) === '已保养' && date.startsWith(BUSINESS_TODAY.slice(0, 7))
  }).length,
)

const visibleRows = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return pumps.value
  }
  return pumps.value.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
})

function isAbnormal(row: PumpRow): boolean {
  return row.head.kind === 'bad' || row.current.kind === 'bad' || !row.lastDateValid && String(row['上次保养日'] ?? '') !== ''
}

// 越级挡回：只给「当前状态的下一步」一个按钮，已停用没有任何操作。
function allowedActions(row: PumpRow): string[] {
  const index = PUMP_STATUS_ORDER.indexOf(String(row.status))
  if (index < 0 || index >= PUMP_STATUS_ORDER.length - 1) {
    return []
  }
  return [PUMP_STATUS_ORDER[index + 1] === '运行中'
    ? '登记运行'
    : PUMP_STATUS_ORDER[index + 1] === '已保养'
      ? '完成保养'
      : '停用设备']
}

function formatCycle(row: PumpRow): string {
  return row.cycleDays !== null ? `周期 ${row.cycleDays} 天` : '周期为空'
}

function cycleTitle(row: PumpRow): string {
  if (row.cycleDays === null) {
    return '该换热站尚未核定周期，台账周期也为空：不进提醒'
  }
  return `周期来源：${row.cycleSource ?? '无'}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('circpump')
}

function runAction(action: string, row: PumpRow) {
  errorMessage.value = ''
  const result = runPumpAction(Number(row.id), action, session.role)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
  // 保养联动会刷新阀门井待检查清单的数据缓存。
  rules.value = listCycleRules()
}

function saveRule() {
  ruleMessage.value = ''
  if (ruleDays.value === null) {
    ruleOk.value = false
    ruleMessage.value = '请填写保养周期天数'
    return
  }
  const result = saveCycleRule(ruleStation.value, Number(ruleDays.value), session.role, BUSINESS_TODAY)
  ruleOk.value = result.ok
  ruleMessage.value = result.message
  if (result.ok) {
    ruleStation.value = ''
    ruleDays.value = null
    rules.value = listCycleRules()
    reload()
  }
}

function openHeadEdit(row: PumpRow) {
  editing.value = { row, kind: 'head', value: '' }
  editMessage.value = ''
}

function openDateEdit(row: PumpRow) {
  editing.value = {
    row,
    kind: 'date',
    value: String(row['上次保养日'] ?? '') || BUSINESS_TODAY,
  }
  editMessage.value = ''
}

function submitEdit() {
  if (!editing.value) {
    return
  }
  editMessage.value = ''
  const result =
    editing.value.kind === 'head'
      ? updateHead(Number(editing.value.row.id), editing.value.value, session.role)
      : updateLastMaintain(Number(editing.value.row.id), editing.value.value, session.role)
  if (!result.ok) {
    editMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  editing.value = null
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    pumps.value = listPumps()
    total.value = pumps.value.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '循环泵运维列表读取失败'
  }
}

onMounted(reload)
</script>
