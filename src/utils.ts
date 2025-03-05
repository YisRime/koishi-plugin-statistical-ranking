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
    const formattedKey = this.keyFormat(key)
    const curr = this.data.get(formattedKey) ?? { count: 0, lastTime: time }
    curr.count += count
    curr.lastTime = time > curr.lastTime ? time : curr.lastTime
    this.data.set(formattedKey, curr)
  }

  addRecord(record: StatRecord, key: keyof StatRecord) {
    this.add(record[key] as string, record.count, record.lastTime)
  }

  entries() {
    return Array.from(this.data.entries())
  }

  sortedEntries(sortBy: 'count' | 'key' = 'count') {
    return this.entries().sort((a, b) =>
      sortBy === 'count'
        ? b[1].count - a[1].count
        : a[0].localeCompare(b[0])
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
        if (session.userId === id) return session.username ?? id
        const member = await session.bot.getGuildMember?.(session.guildId, id)
        return member?.username ?? id
      }

      const guild = await session.bot.getGuild?.(id)
      return guild?.name ?? id
    } catch {
      return id
    }
  },

  _nameQueue: new Map<string, Promise<string>>(),
  _queueCount: 0,
  _batchSize: 10,
  _batchDelay: 100,

  /**
   * 格式化时间差
   * @param date - 目标时间
   * @returns string 格式化后的时间差字符串
   * @description 将时间转换为"X年X月前"等易读格式
   */
  formatTimeAgo(date: Date): string {
    if (!date?.getTime() || isNaN(date.getTime())) return '未知时间'.padStart(9)

    const diff = Math.max(0, Date.now() - date.getTime())
    if (diff < 60000) return '一会前'.padStart(9)

    const units = [
      [31536000000, '年'],
      [2592000000, '月'],
      [86400000, '天'],
      [3600000, '小时'],
      [60000, '分钟']
    ]

    const parts = []
    let remaining = diff

    for (const [div, unit] of units) {
      const val = Math.floor(remaining / Number(div))
      if (val > 0) {
        parts.push(`${val}${unit}`)
        if (parts.length === 2) break
        remaining %= Number(div)
      }
    }

    return (parts.length ? parts.join('') + '前' : '一会前').padStart(9)
  },

  /**
   * 验证和规范化查询选项，并直接构建数据库查询
   */
  buildQueryFromOptions(options: QueryOptions) {
    const query: Record<string, any> = {}
    options.user && (query.userId = options.user)
    options.guild && (query.guildId = options.guild)
    options.platform && (query.platform = options.platform)
    options.command && (query.command = options.command)
    return query
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
    formatFn?: (key: string, data: { count: number, lastTime: Date }) => Promise<string>,
    sortBy: 'count' | 'key' = 'count',
    truncateId = false
  ) {
    const keyFormat = aggregateKey === 'command'
      ? (k: string) => k?.split('.')[0] || ''
      : undefined

    const stats = new StatMap(keyFormat)
    const nameMap = new Map<string, string>()

    for (const record of records) {
      stats.addRecord(record, aggregateKey)

      if (aggregateKey === 'userId' && record.userName) {
        nameMap.set(record.userId, record.userName)
      } else if (aggregateKey === 'guildId' && record.guildName) {
        nameMap.set(record.guildId, record.guildName)
      }
    }

    const entries = stats.sortedEntries(sortBy)

    if (formatFn) {
      return Promise.all(entries.map(([key, data]) => formatFn(key, data)))
    }

    return entries.map(([key, {count, lastTime}]) => {
      const displayName = nameMap.get(key) || (truncateId ? key.slice(0, 10) : key)
      return `${displayName.padEnd(10, ' ')}${count.toString().padStart(5)}次 ${utils.formatTimeAgo(lastTime)}`
    })
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
    if (!session?.userId) return ''

    const [binding] = await session.ctx.database.get('binding', {
      aid: session.userId,
      platform: session.platform
    })

    return binding?.pid || session.userId
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
