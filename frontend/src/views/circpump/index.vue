<template>
  <section class="page" data-module="circpump">
    <header class="page-head">
      <div>
        <h2>循环泵运维管理</h2>
        <p class="page-desc">
          保养提醒按「上次保养日 + 按换热站核定的保养周期」推算；周期未核定不提醒，停用泵不再受理保养，数值异常记录单独标出。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记循环泵</button>
        <button class="btn" type="button" @click="openStationDialog">按站核定保养周期</button>
        <button class="btn" type="button" @click="exportRows">导出循环泵运维清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 待保养栏：到期的给原因，周期未核定的说明为什么不提醒 -->
    <div class="reminder-panel">
      <div class="reminder-col">
        <h3 class="reminder-title">待保养提醒（{{ duePumps.length }}）</h3>
        <p v-if="!duePumps.length" class="reminder-empty">暂无到期泵：已按上次保养日与核定周期核算。</p>
        <ul v-else class="reminder-list">
          <li v-for="pump in duePumps" :key="pump.id" class="reminder-item due">
            <span class="reminder-name">{{ pump['泵编号'] }} · {{ pump['所属换热站'] }}</span>
            <span class="tag tag-warn">{{ dueReason(pump) }}</span>
            <span class="reminder-sub">上次保养日：{{ pump['上次保养日'] || '未登记' }}</span>
          </li>
        </ul>
      </div>
      <div class="reminder-col">
        <h3 class="reminder-title">未纳入提醒（{{ excludedPumps.length }}）</h3>
        <p v-if="!excludedPumps.length" class="reminder-empty">在役泵均已核定保养周期。</p>
        <ul v-else class="reminder-list">
          <li v-for="pump in excludedPumps" :key="pump.id" class="reminder-item muted">
            <span class="reminder-name">{{ pump['泵编号'] }} · {{ pump['所属换热站'] }}</span>
            <span class="tag tag-muted">{{ pump.excludeReason }}</span>
            <span class="reminder-sub">请先在「按站核定保养周期」或台账行内补登周期。</span>
          </li>
        </ul>
      </div>
    </div>

    <p class="status-legend">
      <a
        class="legend-item clickable"
        :class="{ active: statusFilter === '全部' }"
        @click="statusFilter = '全部'"
      >全部：{{ views.length }}</a>
      <a
        v-for="item in statusSummary"
        :key="item.status"
        class="legend-item clickable"
        :class="{ active: statusFilter === item.status }"
        @click="statusFilter = item.status"
      >
        {{ item.status }}：{{ item.count }}
      </a>
    </p>

    <form class="filter-bar" @submit.prevent>
      <label class="filter-item">
        <span>泵编号</span>
        <input v-model="filters['泵编号']" placeholder="按泵编号检索" />
      </label>
      <label class="filter-item">
        <span>所属换热站</span>
        <input v-model="filters['所属换热站']" placeholder="按换热站检索" />
      </label>
      <label class="filter-item">
        <span>泵型号</span>
        <input v-model="filters['泵型号']" placeholder="按泵型号检索" />
      </label>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>泵编号</th>
          <th>所属换热站</th>
          <th>泵型号</th>
          <th>运行电流</th>
          <th>扬程</th>
          <th>保养周期</th>
          <th>上次保养日</th>
          <th>应保养日</th>
          <th>运行状态</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="pump in filteredPumps" :key="String(pump.id)" :class="{ 'row-abnormal': pump.valueAbnormal }">
          <td>{{ pump['泵编号'] }}</td>
          <td>{{ pump['所属换热站'] }}</td>
          <td>{{ pump['泵型号'] }}</td>
          <td>
            {{ pump['运行电流'] || '—' }}
            <span v-if="isCurrentBad(pump)" class="tag tag-danger">数值异常</span>
          </td>
          <td>
            <template v-if="pump.headMissing">
              <span class="tag tag-danger">扬程缺失</span>
            </template>
            <template v-else>{{ pump['扬程'] }}</template>
          </td>
          <td>
            <template v-if="pump.effectiveCycle">
              {{ pump.effectiveCycle }}
              <span v-if="!String(pump['保养周期'] ?? '').trim()" class="tag tag-muted">站核</span>
            </template>
            <span v-else class="tag tag-muted">未核定</span>
          </td>
          <td>{{ pump['上次保养日'] || '未登记' }}</td>
          <td>
            {{ pump.nextDueDate ? formatDate(pump.nextDueDate) : '—' }}
            <span v-if="pump.displayStatus === '待保养' && pump.reminderEligible && pump.lastDate" class="tag tag-warn">
              已逾期{{ pump.overdueDays }}天
            </span>
          </td>
          <td>{{ pump['运行状态'] || '—' }}</td>
          <td>
            {{ pump.displayStatus }}
            <span v-if="pump.valueAbnormal" class="tag tag-danger">异常记录</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionList(pump)"
              :key="action.name"
              class="link"
              type="button"
              :disabled="action.disabled"
              :title="action.hint"
              @click="runAction(action.name, pump)"
            >
              {{ action.name }}
            </button>
            <button class="link" type="button" @click="openLedger(pump)">台账维护</button>
          </td>
        </tr>
        <tr v-if="!filteredPumps.length">
          <td colspan="11" class="empty-state">暂无符合条件的循环泵记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredPumps.length }} 条循环泵记录 · 上次保养日由设备员在「台账维护」中维护</span>
      <span v-if="notice" :class="noticeOk ? 'ok-text' : 'error-text'">{{ notice }}</span>
    </footer>

    <!-- 设备员台账维护：上次保养日 + 扬程补登 -->
    <div v-if="ledgerTarget" class="modal-mask" @click.self="closeLedger">
      <div class="modal">
        <h3 class="modal-title">台账维护 · {{ ledgerTarget['泵编号'] }}</h3>
        <label class="modal-field">
          <span>上次保养日（设备员维护）</span>
          <input v-model="ledgerForm.lastDate" type="date" />
        </label>
        <label class="modal-field">
          <span>扬程（缺失将无法提交保养，可带 m 单位）</span>
          <input v-model="ledgerForm.head" placeholder="如 32m" />
        </label>
        <p v-if="ledgerError" class="error-text">{{ ledgerError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeLedger">取消</button>
          <button class="btn primary" type="button" @click="saveLedger">保存台账</button>
        </div>
      </div>
    </div>

    <!-- 按换热站分组核定保养周期 -->
    <div v-if="stationDialog" class="modal-mask" @click.self="closeStationDialog">
      <div class="modal wide">
        <h3 class="modal-title">按换热站核定保养周期</h3>
        <p class="page-desc">周期写法兼容既有台账：90天、180、半年、季度、3月、2周、一年均可；清空表示该站不核定，其下泵不进提醒。</p>
        <table class="data-table">
          <thead>
            <tr><th>换热站</th><th>在役泵</th><th>待保养</th><th>未核定</th><th>保养周期</th><th>识别结果</th></tr>
          </thead>
          <tbody>
            <tr v-for="group in stationGroups" :key="group.station">
              <td>{{ group.station }}</td>
              <td>{{ group.active }}</td>
              <td>{{ group.due }}</td>
              <td>{{ group.noCycle }}</td>
              <td>
                <input v-model="group.cycleText" class="cycle-input" placeholder="如 90天 / 半年" />
              </td>
              <td>
                <span v-if="!group.cycleText.trim()" class="tag tag-muted">不核定</span>
                <span v-else-if="parseCycleDays(group.cycleText) === null" class="tag tag-danger">无法识别</span>
                <span v-else class="tag tag-ok">{{ parseCycleDays(group.cycleText) }} 天</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="stationError" class="error-text">{{ stationError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeStationDialog">取消</button>
          <button class="btn primary" type="button" @click="saveStationCycles">保存核定</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  availableActions,
  formatDate,
  isCurrentAbnormal,
  listPumpViews,
  listStationGroups,
  parseCycleDays,
  PUMP_KEY,
  runPumpAction,
  setStationCycle,
  updatePumpLedger,
  type PumpView,
  type StationGroup,
} from '@/data/circpump'

const views = ref<PumpView[]>([])
const filters = ref<Record<string, string>>({ '泵编号': '', '所属换热站': '', '泵型号': '' })
const statusFilter = ref('全部')
const notice = ref('')
const noticeOk = ref(false)

const ledgerTarget = ref<PumpView | null>(null)
const ledgerForm = ref({ lastDate: '', head: '' })
const ledgerError = ref('')

const stationDialog = ref(false)
const stationGroups = ref<StationGroup[]>([])
const stationError = ref('')

// 只对在保养流程内（运行中/待保养）的泵提醒；已停用不受理，已保养不重复提醒。
const inFlow = (pump: PumpView) => pump.status === '运行中' || pump.status === '待保养'
const duePumps = computed(() => views.value.filter((pump) => inFlow(pump) && pump.due))
const excludedPumps = computed(() =>
  views.value.filter((pump) => inFlow(pump) && !pump.reminderEligible),
)

const stats = computed(() => [
  { label: '运行中循环泵', value: views.value.filter((p) => p.displayStatus === '运行中').length },
  { label: '待保养循环泵', value: duePumps.value.length },
  { label: '本月保养数', value: maintainedThisMonth() },
  { label: '周期未核定（在役）', value: excludedPumps.value.length },
])

const statusSummary = computed(() =>
  ['待保养', '运行中', '已保养', '已停用'].map((status) => ({
    status,
    count: views.value.filter((pump) => pump.displayStatus === status).length,
  })),
)

const filteredPumps = computed(() => {
  const keyword = (field: '泵编号' | '所属换热站' | '泵型号') =>
    filters.value[field].trim()
  return views.value.filter((pump) => {
    if (statusFilter.value !== '全部' && pump.displayStatus !== statusFilter.value) return false
    const code = keyword('泵编号')
    const station = keyword('所属换热站')
    const model = keyword('泵型号')
    if (code && !String(pump['泵编号'] ?? '').includes(code)) return false
    if (station && !String(pump['所属换热站'] ?? '').includes(station)) return false
    if (model && !String(pump['泵型号'] ?? '').includes(model)) return false
    return true
  })
})

function maintainedThisMonth(): number {
  const now = new Date()
  return views.value.filter((pump) => {
    if (String(pump.status) !== '已保养') return false
    const d = pump.lastDate
    return !!d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
  }).length
}

function dueReason(pump: PumpView): string {
  if (pump.neverMaintained) return '未登记上次保养日，按到期提醒'
  return `已逾期${pump.overdueDays}天`
}

function isCurrentBad(pump: PumpView): boolean {
  return isCurrentAbnormal(pump)
}

function actionList(pump: PumpView): { name: string; disabled: boolean; hint: string }[] {
  return availableActions(String(pump.status)).map((name) => {
    if (name === '完成保养' && pump.headMissing) {
      return { name, disabled: true, hint: '扬程缺失，先在台账维护补登后才能提交保养' }
    }
    return { name, disabled: false, hint: '' }
  })
}

function resetFilters() {
  filters.value = { '泵编号': '', '所属换热站': '', '泵型号': '' }
  statusFilter.value = '全部'
}

function exportRows() {
  downloadEntries(PUMP_KEY)
}

function openCreate() {
  noticeOk.value = false
  notice.value = '循环泵登记入口尚未接入审批流'
}

function runAction(action: string, pump: PumpView) {
  const result = runPumpAction(Number(pump.id), action)
  noticeOk.value = result.ok
  notice.value = result.message
  reload()
}

function openLedger(pump: PumpView) {
  ledgerTarget.value = pump
  ledgerForm.value = {
    lastDate: String(pump['上次保养日'] ?? ''),
    head: String(pump['扬程'] ?? ''),
  }
  ledgerError.value = ''
}

function closeLedger() {
  ledgerTarget.value = null
}

function saveLedger() {
  if (!ledgerTarget.value) return
  const result = updatePumpLedger(Number(ledgerTarget.value.id), { ...ledgerForm.value })
  if (!result.ok) {
    ledgerError.value = result.message
    return
  }
  ledgerTarget.value = null
  noticeOk.value = true
  notice.value = '台账已更新：上次保养日与扬程已同步到泵台账、保养提醒与导出清单'
  reload()
}

function openStationDialog() {
  stationGroups.value = listStationGroups()
  stationError.value = ''
  stationDialog.value = true
}

function closeStationDialog() {
  stationDialog.value = false
}

function saveStationCycles() {
  for (const group of stationGroups.value) {
    const text = group.cycleText.trim()
    if (text && parseCycleDays(text) === null) {
      stationError.value = `「${group.station}」的周期「${text}」无法识别，请改成 90天、半年、3月 这类写法`
      return
    }
  }
  for (const group of stationGroups.value) {
    setStationCycle(group.station, group.cycleText.trim())
  }
  stationDialog.value = false
  noticeOk.value = true
  notice.value = '换热站保养周期核定已保存，提醒范围已按新周期重算'
  reload()
}

function reload() {
  views.value = listPumpViews()
}

onMounted(reload)
</script>
