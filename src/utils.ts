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
   * 统一处理异步获取名称的错误
   * @param fn - 异步函数，用于获取名称
   * @returns 获取到的名称或null
   */
  async safeGetName(fn: () => Promise<any>): Promise<string | null> {
    try {
      const result = await fn()
      return result?.nickname || result?.username || result?.name || null
    } catch {
      return null
    }
  },

  /**
   * @private
   * 名称获取队列相关变量
   */
  _nameQueue: new Map<string, Promise<string>>(),
  _queueCount: 0,
  _batchSize: 10,
  _batchDelay: 100,

  /**
   * 批量获取用户或群组名称
   * @param session - Koishi会话对象
   * @param id - 用户或群组ID
   * @param type - 类型：'user' 或 'guild'
   * @returns Promise<string> 名称或ID
   */
  async getName(session: any, id: string, type: NameType): Promise<string> {
    const cacheKey = `${type}:${id}`

    if (utils._nameQueue.has(cacheKey)) {
      return utils._nameQueue.get(cacheKey)
    }

    const namePromise = (async () => {
      const name = await (type === 'user'
        ? utils.safeGetName(() => session.bot.getGuildMember?.(session.guildId, id))
        : utils.safeGetName(() => session.bot.getGuild?.(id)))

      return name || id
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

  /**
   * 将时间转换为"多久之前"的格式
   * @param date 目标时间
   * @returns 格式化后的字符串
   */
  formatTimeAgo(date: Date): string {
    if (isNaN(date.getTime())) {
      return '未知时间'.padStart(9)
    }

    const now = Date.now()
    if (date.getTime() > now) {
      date = new Date()
    }

    const diff = Math.max(0, now - date.getTime())
    if (diff < 300000) return '一会前'.padStart(9)

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
   * 验证和规范化查询选项
   * @param options - 查询选项对象
   * @returns 标准化后的查询选项
   */
  normalizeQueryOptions(options: QueryOptions): Required<QueryOptions> {
    return {
      user: options.user || '',
      guild: options.guild || '',
      platform: options.platform || '',
      command: options.command || ''
    }
  },

  /**
   * 格式化查询条件为可读文本
   * @param options - 查询选项
   * @returns 格式化后的条件数组
   */
  formatConditions(options: QueryOptions): string[] {
    const normalized = utils.normalizeQueryOptions(options)
    return Object.entries(normalized)
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

  /**
   * 将查询选项转换为数据库查询条件
   * @param options 查询选项
   * @returns 数据库查询对象
   */
  buildQueryFromOptions(options: QueryOptions) {
    const normalized = utils.normalizeQueryOptions(options)
    const query: Record<string, any> = {}

    if (normalized.user) query.userId = normalized.user
    if (normalized.guild) query.guildId = normalized.guild
    if (normalized.platform) query.platform = normalized.platform
    if (normalized.command) query.command = normalized.command

    return query
  },

  /**
   * 处理统计记录，聚合并格式化结果
   * @param records 统计记录数组
   * @param aggregateKey 聚合键名
   * @param formatFn 可选的格式化函数
   * @param sortBy 排序方式：'count' 按次数或 'key' 按键名
   * @param truncateId 是否截断ID (仅用于展示用户/群组ID)
   * @returns 格式化后的结果数组
   */
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
   * 检查目标是否匹配规则
   * @param rule 规则字符串 platform:guild:user
   * @param target 目标对象
   * @returns 是否匹配
   */
  matchRule(rule: string, target: { platform: string, guildId: string, userId: string }): boolean {
    const parts = rule.split(':')
    const [rulePlatform = '', ruleGuild = '', ruleUser = ''] = parts

    if (ruleUser && target.userId === ruleUser) return true
    if (ruleGuild && target.guildId === ruleGuild) return true
    if (rulePlatform && target.platform === rulePlatform) return true

    return false
  },

  /**
   * 检查目标是否在列表中匹配
   * @param list 规则列表
   * @param target 目标对象
   * @returns 是否匹配
   */
  matchRuleList(list: string[], target: { platform: string, guildId: string, userId: string }): boolean {
    return list.some(rule => utils.matchRule(rule, target))
  },

  /**
   * 获取统计数据中的唯一键列表
   * @param records 统计记录数组
   * @param key 要提取的键名
   * @returns 唯一值数组
   */
  getUniqueKeys(records: StatRecord[], key: keyof StatRecord): string[] {
    const stats = new StatMap()
    for (const record of records) {
      stats.add(record[key] as string, 0, new Date())
    }
    return stats.entries().map(([key]) => key).filter(Boolean)
  },

  /**
   * 获取会话的群组ID
   * @param session 会话对象
   * @returns 群组ID
   */
  getGuildId(session: any): string {
    return session.guildId || session.groupId || session.channelId || 'private'
  },

  /**
   * 获取用户的平台ID
   * @param session 会话对象
   * @returns Promise<string> 平台ID
   */
  async getPlatformId(session: any): Promise<string> {
    if (!session?.userId) return ''

    const [binding] = await session.ctx.database.get('binding', {
      aid: session.userId,
      platform: session.platform
    })

    if (binding?.pid) {
      return binding.pid
    }

    return session.userId
  },
}
