import { StatRecord } from './index'

type NameType = 'user' | 'guild'

interface QueryOptions {
  user?: string
  guild?: string
  platform?: string
  command?: string
}

/**
 * @internal
 * 统计数据聚合管理器
 * 用于处理和聚合统计数据，支持自定义键格式化
 */
export class StatMap {
  private data = new Map<string, { count: number, lastTime: Date }>()
  private keyFormat: (key: string) => string

  constructor(keyFormat?: (key: string) => string) {
    this.keyFormat = keyFormat || ((k) => k)
  }

  add(key: string, count: number, time: Date) {
    const formattedKey = this.keyFormat(key)
    const curr = this.data.get(formattedKey) || { count: 0, lastTime: time }
    curr.count += count
    if (time > curr.lastTime) curr.lastTime = time
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
 * 工具函数集合对象
 */
export const utils = {
  /**
   * 批量获取用户或群组名称
   */
  async getName(session: any, id: string, type: NameType): Promise<string> {
    const cacheKey = `${type}:${id}`

    if (utils._nameQueue.has(cacheKey)) {
      return utils._nameQueue.get(cacheKey)
    }

    const namePromise = (async () => {
      try {
        if (type === 'user') {
          if (session.userId === id) {
            return session.username || session.nickname || id
          }
          const result = await session.bot.getGuildMember?.(session.guildId, id)
          return result?.nickname || result?.username || id
        } else {
          const result = await session.bot.getGuild?.(id)
          return result?.name || id
        }
      } catch {
        return id
      }
    })()

    utils._nameQueue.set(cacheKey, namePromise)
    utils._queueCount++

    if (utils._queueCount >= utils._batchSize) {
      await new Promise(resolve => setTimeout(resolve, utils._batchDelay))
      utils._nameQueue.clear()
      utils._queueCount = 0
    }

    return namePromise
  },

  _nameQueue: new Map<string, Promise<string>>(),
  _queueCount: 0,
  _batchSize: 10,
  _batchDelay: 100,

  formatTimeAgo(date: Date): string {
    if (isNaN(date.getTime())) {
      return '未知时间'.padStart(9)
    }

    const now = Date.now()
    if (date.getTime() > now) {
      date = new Date()
    }

    const diff = Math.max(0, now - date.getTime())
    if (diff < 60000) return '一会前'.padStart(9)

    const units = [
      { div: 31536000000, unit: '年' },
      { div: 2592000000, unit: '月' },
      { div: 86400000, unit: '天' },
      { div: 3600000, unit: '小时' },
      { div: 60000, unit: '分钟' }
    ]

    const parts = []
    let remaining = diff

    for (const { div, unit } of units) {
      const val = Math.floor(remaining / div)
      if (val > 0) {
        parts.push(`${val}${unit}`)
        remaining %= div
        if (parts.length === 2) break
      }
    }

    const timeText = parts.length ? parts.join('') + '前' : '一会前'
    return timeText.padStart(9)
  },

  /**
   * 验证和规范化查询选项，并直接构建数据库查询
   */
  buildQueryFromOptions(options: QueryOptions) {
    const query: Record<string, any> = {}
    if (options.user) query.userId = options.user
    if (options.guild) query.guildId = options.guild
    if (options.platform) query.platform = options.platform
    if (options.command) query.command = options.command
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
    for (const record of records) {
      stats.addRecord(record, aggregateKey)
    }

    const entries = stats.sortedEntries(sortBy)

    if (formatFn) {
      return Promise.all(entries.map(([key, data]) => formatFn(key, data)))
    }

    return entries.map(([key, {count, lastTime}]) => {
      const displayKey = truncateId ? key.slice(0, 10) : key
      return `${displayKey.padEnd(10, ' ')}${count.toString().padStart(5)}次 ${utils.formatTimeAgo(lastTime)}`
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
    const platform = session.platform
    const guildId = utils.getGuildId(session)
    const userId = await utils.getPlatformId(session)
    const bot = session.bot

    let userName = session.username || ''
    if (!userName && bot?.getGuildMember) {
      const userInfo = await bot.getGuildMember(guildId, userId).catch(() => null)
      userName = userInfo?.nickname || userInfo?.username || ''
    }

    const guildName = guildId === 'private'
      ? ''
      : (await bot?.getGuild?.(guildId).catch(() => null))?.name || ''

    return {
      platform,
      guildId,
      userId,
      userName,
      guildName
    }
  },
}
