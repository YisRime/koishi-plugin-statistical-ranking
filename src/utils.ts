import { StatRecord } from './index'

type NameType = 'user' | 'guild'

interface QueryOptions {
  user?: string
  guild?: string
  platform?: string
  command?: string
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
   * 获取用户或群组名称
   * @param session - 会话对象
   * @param id - 目标 ID
   * @param type - 类型(user/guild)
   * @returns Promise<string> 返回名称，获取失败则返回原始 ID
   */
  async getName(session: any, id: string, type: NameType): Promise<string> {
    if (!session?.bot) return id

    try {
      if (type === 'user') {
        return session.userId === id ? session.username ?? id
          : (await session.bot.getGuildMember?.(session.guildId, id))?.username ?? id
      }

      return (await session.bot.getGuild?.(id))?.name ?? id
    } catch {
      return id
    }
  },

  /**
   * 格式化时间差
   * @param date - 目标时间
   * @returns string 格式化后的时间差字符串
   * @description 将时间转换为"X年X月前"等易读格式
   */
  formatTimeAgo(date: Date): string {
    if (!date?.getTime() || isNaN(date.getTime())) return '未知时间'.padStart(9)

    const diff = Math.max(0, Date.now() - date.getTime())
    if (diff < 10000) return '一会前'.padStart(9)

    const units: [number, string][] = [[31536000000, '年'], [2592000000, '月'],
      [86400000, '天'], [3600000, '小时'], [60000, '分钟']]

    const parts = []
    let remaining = diff

    for (const [div, unit] of units) {
      const val = Math.floor(remaining / div)
      if (val > 0) {
        parts.push(`${val}${unit}`)
        if (parts.length === 2) break
        remaining %= div
      }
    }

    const text = (parts.length ? parts.join('') : '一会') + '前'
    return text.padStart(9)
  },

  /**
   * 验证和规范化查询选项，并直接构建数据库查询
   */
  buildQueryFromOptions(options: QueryOptions) {
    return Object.entries({
      userId: options.user,
      guildId: options.guild,
      platform: options.platform,
      command: options.command
    }).reduce((query, [key, value]) => {
      if (value) query[key] = value
      return query
    }, {} as Record<string, any>)
  },

  /**
   * 格式化查询条件为可读文本
   */
  formatConditions(options: QueryOptions): string[] {
    return Object.entries(options)
      .filter(([_, value]) => value)
      .map(([key, value]) => {
        switch(key) {
          case 'user': return `用户 ${value}`
          case 'guild': return `群组 ${value}`
          case 'platform': return `平台 ${value}`
          case 'command': return `命令 ${value}`
          default: return ''
        }
      })
      .filter(Boolean)
  },

  async processStatRecords(
    records: StatRecord[],
    aggregateKey: keyof StatRecord,
    options: {
      truncateId?: boolean
      sortBy?: 'count' | 'key'
    } = {}
  ) {
    const stats = new StatMap(aggregateKey === 'command' ?
      (k: string) => k?.split('.')[0] || '' : undefined)
    const nameMap = new Map<string, string>()

    for (const record of records) {
      stats.add(record[aggregateKey] as string, record.count, record.lastTime)
      if ((aggregateKey === 'userId' && record.userName) ||
          (aggregateKey === 'guildId' && record.guildName)) {
        nameMap.set(record[aggregateKey] as string,
          record[aggregateKey === 'userId' ? 'userName' : 'guildName'])
      }
    }

    const entries = stats.sortedEntries(options.sortBy || 'count')
    return entries.map(([key, {count, lastTime}]) =>
      `${(nameMap.get(key) || (options.truncateId ? key.slice(0, 10) : key)).padEnd(10)}${
        count.toString().padStart(5)}次 ${utils.formatTimeAgo(lastTime)}`)
  },

  /**
   * 检查目标是否匹配规则列表
   */
  matchRuleList(list: string[], target: { platform: string, guildId: string, userId: string }): boolean {
    return list.some(rule => {
      const [rulePlatform = '', ruleGuild = '', ruleUser = ''] = rule.split(':')
      return (ruleUser && target.userId === ruleUser) ||
             (ruleGuild && target.guildId === ruleGuild) ||
             (rulePlatform && target.platform === rulePlatform)
    })
  },

  getUniqueKeys(records: StatRecord[], key: keyof StatRecord): string[] {
    const stats = new StatMap()
    for (const record of records) {
      stats.add(record[key] as string, 0, new Date())
    }
    return stats.entries().map(([key]) => key).filter(Boolean)
  },

  getGuildId(session: any): string {
    return session.guildId || session.groupId || session.channelId || 'private'
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
    const guildId = utils.getGuildId(session)
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
}
