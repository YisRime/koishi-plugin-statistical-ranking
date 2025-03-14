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
  skipPaging?: boolean  // 添加跳过分页选项
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
    if (!date?.getTime()) return '未知时间'
    const diff = Date.now() - date.getTime()
    if (diff === 0) return '现在'
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
        return text
      }
    }
    const minutes = Math.floor(absDiff / 60000)
    return minutes > 0 ? `${minutes}分${suffix}` : `一会${suffix}`
  },

  /**
   * 计算字符串的显示宽度
   * @param str 要计算宽度的字符串
   * @returns 显示宽度（全角字符算2，半角字符算1）
   */
  getStringDisplayWidth(str: string): number {
    if (!str) return 0
    return Array.from(str).reduce((width, char) => {
      const isFullWidth = /[\u3000-\u9fff\uff01-\uff60\u2E80-\u2FDF\u3040-\u30FF]/.test(char) ||
                         /[\u2600-\u26FF\u2700-\u27BF\u2B00-\u2BFF\u2000-\u206F]/.test(char);
      return width + (isFullWidth ? 2 : 1)
    }, 0)
  },

  /**
   * 按显示宽度截断字符串
   * @param str 要截断的字符串
   * @param maxWidth 最大显示宽度
   * @returns 截断后的字符串
   */
  truncateByDisplayWidth(str: string, maxWidth: number): string {
    if (!str) return str
    let width = 0
    let result = ''
    for (const char of Array.from(str)) {
      const isFullWidth = /[\u3000-\u9fff\uff01-\uff60\u2E80-\u2FDF\u3040-\u30FF]/.test(char) ||
                         /[\u2600-\u26FF\u2700-\u27BF\u2B00-\u2BFF\u2000-\u206F]/.test(char);
      const charWidth = isFullWidth ? 2 : 1
      if (width + charWidth > maxWidth) break
      width += charWidth
      result += char
    }
    return result
  },

  /**
   * 根据显示宽度填充字符串
   * @param str 要填充的字符串
   * @param width 目标宽度
   * @param char 填充字符，默认为空格
   * @param end 是否右对齐，默认为false（左对齐）
   * @returns 填充后的字符串
   */
  padByDisplayWidth(str: string, width: number, char: string = ' ', end: boolean = false): string {
    const displayWidth = utils.getStringDisplayWidth(str)
    const padLength = Math.max(0, width - displayWidth)
    const padding = char.repeat(padLength)
    return end ? str + padding : padding + str
  },

  /**
   * 安全处理字符串，防止SQL注入和特殊昵称
   * @param input 输入字符串
   * @returns 处理后的安全字符串
   */
  sanitizeString(input: string): string {
    // 改进: 处理undefined和null输入
    if (input === undefined || input === null) return ''

    // 移除SQL注入并替换
    const sqlKeywords = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'SELECT', 'UNION', 'CREATE', 'ALTER']
    let result = input
    for (const keyword of sqlKeywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi')
      result = result.replace(regex, `${keyword.charAt(0)}*${keyword.charAt(keyword.length-1)}`)
    }
    // 移除特殊字符与控制字符
    result = result.replace(/[;'"\\=]/g, '*')
    result = result.replace(/[\x00-\x1F\x7F]/g, '')
    // 限制长度
    return result.slice(0, 64)
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
    const stats = new StatMap(
      (aggregateKey === 'command' && !disableCommandMerge)
        ? (k: string) => k?.split('.')[0] || ''
        : undefined
    )

    // 添加预过滤步骤，确保命令统计时不包含 __message__
    let filteredRecords = records;
    if (aggregateKey === 'command' && !options.disableCommandMerge) {
      filteredRecords = records.filter(record => record.command !== '__message__');
    }

    const nameMap = new Map<string, string>()
    for (const record of filteredRecords) {
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

    // 计算分页
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
    let formattedTitle = title
    if (!skipPaging && totalPages > 1) {
      formattedTitle = `${title.endsWith(' ——') ? title.substring(0, title.length - 3) : title}（第${currentPage}/${totalPages}页）——`
    }

    // 预处理所有数据，获取显示信息
    const displayItems = pagedEntries.map(([key, {count, lastTime}]) => {
      let displayName = nameMap.get(key) || key
      // 处理显示名称
      if (truncateId) {
        if (nameMap.has(key)) {
          displayName = displayName || key
        } else {
          displayName = key
        }
      }
      // 格式化数字并添加单位
      const countLabel = aggregateKey === 'command' ? '次' : '条'
      const countStr = count.toString() + countLabel
      // 格式化时间
      const timeAgo = utils.formatTimeAgo(lastTime)
      return {
        key,
        displayName,
        countStr,
        timeAgo
      }
    })
    const countWidth = 6               // 计数固定宽度
    const timeWidth = 10              // 时间固定宽度
    const nameWidth = 18              // 名称固定宽度
    return {
      items: displayItems.map(item => {
        // 截断名称到固定宽度
        const truncatedName = utils.truncateByDisplayWidth(item.displayName, nameWidth);
        // 截断计数和时间
        const truncatedCount = utils.truncateByDisplayWidth(item.countStr, countWidth);
        const truncatedTime = utils.truncateByDisplayWidth(item.timeAgo, timeWidth);
        // 计算填充
        const nameDisplayWidth = utils.getStringDisplayWidth(truncatedName);
        const namePadding = ' '.repeat(Math.max(0, nameWidth - nameDisplayWidth));
        const countDisplayWidth = utils.getStringDisplayWidth(truncatedCount);
        const countPadding = ' '.repeat(Math.max(0, countWidth - countDisplayWidth));
        // 组合最终显示字符串，确保计数右对齐
        return `${truncatedName}${namePadding} ${countPadding}${truncatedCount} ${truncatedTime}`;
      }),
      page: currentPage,
      totalPages,
      totalItems,
      title: formattedTitle
    }
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
    if (options.user) query.userId = options.user
    if (options.guild) query.guildId = options.guild
    if (options.platform) query.platform = options.platform
    if (type === 'user') {
      // 用户发言统计只查询普通消息
      query.command = 'mmeessssaaggee' // 修改从 $neq 改为 $ne，确保正确排除
    } else if (type === 'command') {
      if (options.command) {
        // 指定了命令，直接查询该命令
        query.command = options.command
      } else {
        // 没指定命令，则排除普通消息
        query.command = { $neq: 'mmeessssaaggee' }
      }
    } else if (options.command) {
      // 群组统计且指定了命令
      query.command = options.command
    }

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
