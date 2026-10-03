import { defineStore } from 'pinia'

// 值班员只能执行运转操作；上次保养日、扬程补录、周期核定都归设备员。
export type OperatorRole = '值班员' | '设备员'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '城市集中供热管网与换热站运行管理平台',
    role: '值班员' as OperatorRole,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isEquipment: (state) => state.role === '设备员',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: OperatorRole) {
      this.role = role
      this.operator = role === '设备员' ? '设备管理员' : '值班管理员'
    },
  },
})
