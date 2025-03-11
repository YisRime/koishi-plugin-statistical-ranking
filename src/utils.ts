import { Context } from 'koishi'
import { StatRecord } from './index'

interface QueryOptions {
  user?: string
  guild?: string
  platform?: string
  command?: string
}

export interface StatProcessOptions {
  sortBy?: 'key' | 'count'
  limit?: number
  disableCommandMerge?: boolean
  truncateId?: boolean
  displayBlacklist?: string[]
  displayWhitelist?: string[]
}

/**
 * 统计数据聚合管理器
 * @class StatMap
 * @description 用于处理和聚合统计数据，支持自定义键格式化和排序
 * @internal
 */
class StatMap {
  private data = new Map<string, { count: number, lastTime: Date }>()
  constructor(private keyFormat: (key: string) => string = (k) => k) {}
  add(key: string, count: number, time: Date) {
    const k = this.keyFormat(key) || ''
    const curr = this.data.get(k) ?? { count: 0, lastTime: time }
    curr.count += count
    curr.lastTime = time > curr.lastTime ? time : curr.lastTime
    this.data.set(k, curr)
  }
  entries() {
    return Array.from(this.data.entries())
  }
  sortedEntries(sortBy: 'count' | 'key' = 'count') {
    return this.entries().sort((a, b) =>
      sortBy === 'count' ? b[1].count - a[1].count : a[0].localeCompare(b[0])
    )
  }
}

/**
 * @internal
 * 工具函数集合
 * @description 提供各种辅助功能，如时间格式化、名称获取、数据处理等
 */
export const utils = {
  /**
   * 格式化时间差
   * @param date - 目标时间
   * @returns string 格式化后的时间差字符串
   * @description 将时间转换为"X年X月前"等易读格式
   */
  formatTimeAgo(date: Date): string {
    if (!date?.getTime()) return '未知时间'.padStart(7)
    const diff = Date.now() - date.getTime()
    if (diff === 0) return '现在'.padStart(7)
    if (Math.abs(diff) < 10000) return (diff < 0 ? '一会后' : '一会前').padStart(7)
    const units = [
      [31536000000, '年'],
      [2592000000, '月'],
      [86400000, '天'],
      [3600000, '时'],
      [60000, '分']
    ] as const
    const absDiff = Math.abs(diff)
    const suffix = diff < 0 ? '后' : '前'
    for (let i = 0; i < units.length - 1; i++) {
      const [mainDiv, mainUnit] = units[i]
      const [subDiv, subUnit] = units[i + 1]
      const mainVal = Math.floor(absDiff / mainDiv)
      if (mainVal > 0) {
        const remaining = absDiff % mainDiv
        const subVal = Math.floor(remaining / subDiv)
        const text = subVal > 0
          ? `${mainVal}${mainUnit}${subVal}${subUnit}${suffix}`
          : `${mainVal}${mainUnit}${suffix}`
        return text.padStart(7)
      }
    }
    const minutes = Math.floor(absDiff / 60000)
    return (minutes > 0 ? `${minutes}分${suffix}` : `一会${suffix}`).padStart(7)
  },

  async processStatRecords(
    records: StatRecord[],
    aggregateKey: keyof StatRecord,
    options: StatProcessOptions = {}
  ) {
    const {
      sortBy = 'count',
      limit,
      disableCommandMerge,
      truncateId,
      displayBlacklist = [],
      displayWhitelist = []
    } = options
    const stats = new StatMap(
      (aggregateKey === 'command' && !disableCommandMerge)
        ? (k: string) => k?.split('.')[0] || ''
        : undefined
    )
    const nameMap = new Map<string, string>()
    for (const record of records) {
      stats.add(record[aggregateKey] as string, record.count, record.lastTime)
      if ((aggregateKey === 'userId' && record.userName) ||
          (aggregateKey === 'guildId' && record.guildName)) {
        nameMap.set(record[aggregateKey] as string,
          record[aggregateKey === 'userId' ? 'userName' : 'guildName'])
      }
    }
    let entries = stats.sortedEntries(sortBy)
    if (displayWhitelist.length || displayBlacklist.length) {
      const filteredEntries = []
      for (const [key, value] of entries) {
        // 优先应用白名单
        if (displayWhitelist.length) {
          if (displayWhitelist.some(pattern => key.includes(pattern))) {
            filteredEntries.push([key, value])
          }
        }
        // 没有白名单时应用黑名单
        else if (displayBlacklist.length) {
          if (!displayBlacklist.some(pattern => key.includes(pattern))) {
            filteredEntries.push([key, value])
          }
        }
        else {
          filteredEntries.push([key, value])
        }
      }
      entries = filteredEntries
    }
    const limitedEntries = limit && entries.length > limit
      ? entries.slice(0, limit)
      : entries
    return limitedEntries.map(([key, {count, lastTime}]) => {
      let displayName = nameMap.get(key) || key
      if (truncateId) {
        displayName = displayName.length > 15 ? displayName.slice(0, 15) : displayName
        if (!nameMap.has(key)) {
          displayName = key.slice(0, 15)
        }
      }
      return `${displayName.padEnd(16)}${count.toString().padStart(5)}次 ${utils.formatTimeAgo(lastTime)}`
    })
  },

  /**
   * 检查目标是否匹配规则列表
   * @param list - 规则列表
   * @param target - 目标对象
   * @returns boolean - 是否匹配某一规则
   */
  matchRuleList(list: string[], target: { platform: string, guildId: string, userId: string, command?: string }): boolean {
    return list.some(rule => {
      const [rulePlatform = '', ruleGuild = '', ruleUser = ''] = rule.split(':')
      if (target.command && rule === target.command) {
        return true
      }
      return (rulePlatform && target.platform === rulePlatform) ||
             (ruleGuild && target.guildId === ruleGuild) ||
             (ruleUser && target.userId === ruleUser) ||
             (rule.endsWith(':') && target.platform && rule.startsWith(target.platform + ':'))
    })
  },

  getUniqueKeys(records: StatRecord[], key: keyof StatRecord): string[] {
    const stats = new StatMap()
    for (const record of records) {
      stats.add(record[key] as string, 0, new Date())
    }
    return stats.entries().map(([key]) => key).filter(Boolean)
  },

  async getPlatformId(session: any): Promise<string> {
    if (!session?.userId || !session?.platform || !session?.app?.database) return session?.userId || ''
    try {
      const [binding] = await session.app.database.get('binding', {
        aid: session.userId,
        platform: session.platform
      })
      return binding?.pid || session.userId
    } catch (e) {
      return session.userId || ''
    }
  },

  /**
   * 获取会话完整信息
   */
  async getSessionInfo(session: any) {
    if (!session) return null
    const platform = session.platform
    const guildId = session.guildId || session.groupId || session.channelId
    const userId = await utils.getPlatformId(session)
    const bot = session.bot
    const userName = session.username ?? (bot?.getGuildMember
      ? (await bot.getGuildMember(guildId, userId).catch(() => null))?.username
      : '') ?? ''
    const guildName = guildId === 'private'
      ? ''
      : (await bot?.getGuild?.(guildId).catch(() => null))?.name ?? ''
    return {
      platform,
      guildId,
      userId,
      userName,
      guildName
    }
  },

  /**
   * 处理统计查询
   */
  async handleStatQuery(ctx: Context, options: QueryOptions, type: 'command' | 'user' | 'guild') {
    const query: Record<string, any> = {}
    const typeMap = { command: '命令', user: '发言', guild: '群组' }
    if (options.user) query.userId = options.user
    if (options.guild) query.guildId = options.guild
    if (options.platform) query.platform = options.platform
    if (type === 'user') query.command = null
    else if (type === 'command') query.command = options.command || { $not: null }
    else if (options.command) query.command = options.command
    const records = await ctx.database.get('analytics.stat', query)
    if (!records?.length) return '未找到记录'
    const conditions = Object.entries({
      user: ['用户', options.user],
      guild: ['群组', options.guild],
      platform: ['平台', options.platform],
      command: ['命令', options.command]
    })
      .filter(([_, [__, value]]) => value)
      .map(([_, [label, value]]) => `${label}${value}`)
    const title = conditions.length
      ? `${conditions.join('、')}的${typeMap[type]}统计 ——`
      : `全局${typeMap[type]}统计 ——`
    return { records, title }
  },
}
