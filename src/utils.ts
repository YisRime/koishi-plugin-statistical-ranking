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
  page?: number
  pageSize?: number
  title?: string
  skipPaging?: boolean
}

/**
 * 统计数据聚合管理器
 * @description 用于处理和聚合统计数据
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
 * 工具函数集合
 * @internal
 */
export const utils = {
  /**
   * 格式化时间差
   */
  formatTimeAgo(date: Date): string {
    if (!date?.getTime()) return '未知时间'

    const diff = Date.now() - date.getTime()
    if (Math.abs(diff) < 10000) return (diff < 0 ? '一会后' : '一会前')

    const units = [
      [31536000000, '年'],
      [2592000000, '月'],
      [86400000, '天'],
      [3600000, '时'],
      [60000, '分']
    ] as const

    const absDiff = Math.abs(diff)
    const suffix = diff < 0 ? '后' : '前'

    for (const [mainDiv, mainUnit] of units) {
      const mainVal = Math.floor(absDiff / mainDiv)
      if (mainVal > 0) {
        return `${mainVal}${mainUnit}${suffix}`
      }
    }

    const minutes = Math.floor(absDiff / 60000)
    return minutes > 0 ? `${minutes}分${suffix}` : `一会${suffix}`
  },

  /**
   * 计算字符串的显示宽度
   */
  getStringDisplayWidth(str: string): number {
    if (!str) return 0
    return Array.from(str).reduce((width, char) => {
      return width + (/[\u3000-\u9fff\uff01-\uff60\u2E80-\u2FDF\u3040-\u30FF\u2600-\u26FF\u2700-\u27BF]/.test(char) ? 2 : 1)
    }, 0)
  },

  /**
   * 按显示宽度截断字符串
   */
  truncateByDisplayWidth(str: string, maxWidth: number): string {
    if (!str) return str
    let width = 0
    let result = ''

    for (const char of Array.from(str)) {
      const charWidth = /[\u3000-\u9fff\uff01-\uff60\u2E80-\u2FDF\u3040-\u30FF\u2600-\u26FF\u2700-\u27BF]/.test(char) ? 2 : 1
      if (width + charWidth > maxWidth) break
      width += charWidth
      result += char
    }

    return result
  },

  /**
   * 根据显示宽度填充字符串
   */
  padByDisplayWidth(str: string, width: number, char: string = ' ', end: boolean = false): string {
    const displayWidth = utils.getStringDisplayWidth(str)
    const padLength = Math.max(0, width - displayWidth)
    const padding = char.repeat(padLength)
    return end ? str + padding : padding + str
  },

  /**
   * 安全处理字符串，防止特殊字符
   */
  sanitizeString(input: string): string {
    if (input == null) return ''

    let result = String(input)
      // 移除零宽字符和控制字符
      .replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\x00-\x1F\x7F]/g, '')
      // 处理特殊Unicode字符
      .replace(/[\u{10000}-\u{10FFFF}]/u, '□')
      // 去除超长重复字符
      .replace(/(.)\1{9,}/g, '$1$1$1…')
      // 移除特殊字符
      .replace(/[\<\>\`\$\(\)\[\]\{\}\;\'\"\\\=]/g, '*')
      // 规范化空格
      .replace(/\s+/g, ' ').trim()

    // 限制长度
    return result.length > 64 ? result.slice(0, 61) + '...' : result
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
      displayWhitelist = [],
      page = 1,
      pageSize = 15,
      title = '',
      skipPaging = false
    } = options

    // 创建聚合器并过滤数据
    const stats = new StatMap(
      (aggregateKey === 'command' && !disableCommandMerge)
        ? (k: string) => k?.split('.')[0] || ''
        : undefined
    )

    let filteredRecords = records
    if (aggregateKey === 'command' && !disableCommandMerge) {
      filteredRecords = records.filter(record => record.command !== 'mess_age')
    }

    // 记录名称映射
    const nameMap = new Map<string, string>()

    // 处理每条记录
    for (const record of filteredRecords) {
      stats.add(record[aggregateKey] as string, record.count, record.lastTime)

      // 保存名称映射
      if ((aggregateKey === 'userId' && record.userName) ||
          (aggregateKey === 'guildId' && record.guildName)) {
        nameMap.set(record[aggregateKey] as string,
          record[aggregateKey === 'userId' ? 'userName' : 'guildName'])
      }
    }

    // 排序并过滤记录
    let entries = stats.sortedEntries(sortBy)

    if (displayWhitelist.length || displayBlacklist.length) {
      const shouldInclude = (key: string) => {
        if (displayWhitelist.length) {
          return displayWhitelist.some(pattern => key.includes(pattern))
        }
        if (displayBlacklist.length) {
          return !displayBlacklist.some(pattern => key.includes(pattern))
        }
        return true
      }

      entries = entries.filter(([key]) => shouldInclude(key))
    }

    // 处理分页
    const totalItems = entries.length
    let pagedEntries = entries
    let currentPage = 1
    let totalPages = 1

    if (!skipPaging) {
      totalPages = limit ? Math.ceil(Math.min(totalItems, limit) / pageSize) : Math.ceil(totalItems / pageSize)
      currentPage = Math.min(Math.max(1, page), totalPages || 1)
      const startIdx = (currentPage - 1) * pageSize
      const endIdx = limit ? Math.min(startIdx + pageSize, limit, totalItems) : Math.min(startIdx + pageSize, totalItems)
      pagedEntries = entries.slice(startIdx, endIdx)
    }

    // 格式化标题
    let formattedTitle = title
    if (!skipPaging && totalPages > 1) {
      formattedTitle = `${title.endsWith(' ——') ? title.substring(0, title.length - 3) : title}（第${currentPage}/${totalPages}页）——`
    }

    // 固定宽度设置
    const countWidth = 6     // 计数固定宽度
    const timeWidth = 10     // 时间固定宽度
    const nameWidth = 18     // 名称固定宽度

    // 生成显示项
    const items = pagedEntries.map(([key, {count, lastTime}]) => {
      // 获取显示名称
      let displayName = nameMap.get(key) || key
      if (truncateId) {
        displayName = nameMap.has(key) ? (displayName || key) : key
      }

      // 格式化显示内容
      const truncatedName = this.truncateByDisplayWidth(displayName, nameWidth)
      const countStr = count.toString() + (aggregateKey === 'command' ? '次' : '条')
      const truncatedCount = this.truncateByDisplayWidth(countStr, countWidth)
      const timeAgo = this.formatTimeAgo(lastTime)
      const truncatedTime = this.truncateByDisplayWidth(timeAgo, timeWidth)

      // 计算填充
      const namePadding = ' '.repeat(Math.max(0, nameWidth - this.getStringDisplayWidth(truncatedName)))
      const countPadding = ' '.repeat(Math.max(0, countWidth - this.getStringDisplayWidth(truncatedCount)))

      // 返回格式化的行
      return `${truncatedName}${namePadding} ${countPadding}${truncatedCount} ${truncatedTime}`
    })

    return {
      items,
      page: currentPage,
      totalPages,
      totalItems,
      title: formattedTitle
    }
  },

  /**
   * 检查目标是否匹配规则列表
   */
  matchRuleList(list: string[], target: { platform: string, guildId: string, userId: string, command?: string }): boolean {
    return list.some(rule => {
      if (target.command && rule === target.command) return true

      const [rulePlatform = '', ruleGuild = '', ruleUser = ''] = rule.split(':')
      return (rulePlatform && target.platform === rulePlatform) ||
             (ruleGuild && target.guildId === ruleGuild) ||
             (ruleUser && target.userId === ruleUser) ||
             (rule.endsWith(':') && target.platform && rule.startsWith(target.platform + ':'))
    })
  },

  getUniqueKeys(records: StatRecord[], key: keyof StatRecord): string[] {
    const keySet = new Set<string>()
    records.forEach(record => {
      const value = record[key] as string
      if (value) keySet.add(value)
    })
    return Array.from(keySet)
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

    let userName = session.username ?? (bot?.getGuildMember
      ? (await bot.getGuildMember(guildId, userId).catch(() => null))?.username
      : '') ?? ''
    userName = utils.sanitizeString(userName)

    let guildName = guildId === 'private'
      ? ''
      : (await bot?.getGuild?.(guildId).catch(() => null))?.name ?? ''
    guildName = utils.sanitizeString(guildName)

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

    // 构建查询条件
    if (options.user) query.userId = options.user
    if (options.guild) query.guildId = options.guild
    if (options.platform) query.platform = options.platform

    // 根据类型设置额外条件
    if (type === 'user') {
      query.command = 'mess_age'
    } else if (type === 'command') {
      query.command = options.command || { $neq: 'mess_age' }
    } else if (options.command) {
      query.command = options.command
    }

    // 执行查询
    const records = await ctx.database.get('analytics.stat', query)
    if (!records?.length) return '未找到记录'

    // 构建标题
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
