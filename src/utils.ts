import { Context } from 'koishi'
import { StatRecord } from './index'

/**
 * 统计查询选项接口
 * @interface QueryOptions
 */
interface QueryOptions {
  user?: string
  guild?: string
  platform?: string
  command?: string
}

/**
 * 统计数据处理选项接口
 * @interface StatProcessOptions
 * @property {'key' | 'count'} [sortBy] - 排序方式，按键名或计数排序
 * @property {number} [limit] - 限制返回的条目数量
 * @property {boolean} [disableCommandMerge] - 是否禁用命令合并
 * @property {boolean} [truncateId] - 是否缩短ID显示
 * @property {string[]} [displayBlacklist] - 显示黑名单
 * @property {string[]} [displayWhitelist] - 显示白名单
 * @property {number} [page] - 当前页码
 * @property {number} [pageSize] - 每页条目数
 * @property {string} [title] - 标题文本
 * @property {boolean} [skipPaging] - 是否跳过分页
 */
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
 * @class StatMap
 */
class StatMap {
  private data = new Map<string, { count: number, lastTime: Date }>()
  constructor(private keyFormat: (key: string) => string = (k) => k) {}

  /**
   * 添加统计数据
   * @param {string} key - 统计键
   * @param {number} count - 计数值
   * @param {Date} time - 时间戳
   */
  add(key: string, count: number, time: Date) {
    const k = this.keyFormat(key) || ''
    const curr = this.data.get(k) ?? { count: 0, lastTime: time }
    curr.count += count
    curr.lastTime = time > curr.lastTime ? time : curr.lastTime
    this.data.set(k, curr)
  }

  /**
   * 获取排序后的条目
   * @param {'count' | 'key'} [sortBy='count'] - 排序方式
   * @returns {Array<[string, {count: number, lastTime: Date}]>} 排序后的条目数组
   */
  sortedEntries(sortBy: 'count' | 'key' = 'count') {
    return Array.from(this.data.entries()).sort((a, b) =>
      sortBy === 'count' ? b[1].count - a[1].count : a[0].localeCompare(b[0])
    )
  }
}

export const utils = {
  /**
   * 获取字符串显示宽度（中文字符计为2，其他字符计为1）
   * @param {string} str - 输入字符串
   * @returns {number} 字符串显示宽度
   */
  getStringDisplayWidth(str: string): number {
    if (!str) return 0
    return Array.from(str).reduce((w, c) =>
      w + (/[\u3000-\u9fff\uff01-\uff60\u2E80-\u2FDF\u3040-\u30FF\u2600-\u26FF\u2700-\u27BF]/.test(c) ? 2 : 1), 0)
  },

  /**
   * 按显示宽度截断字符串
   * @param {string} str - 输入字符串
   * @param {number} maxWidth - 最大显示宽度
   * @returns {string} 截断后的字符串
   */
  truncateByDisplayWidth(str: string, maxWidth: number): string {
    if (!str) return str
    let width = 0, result = ''
    for (const char of Array.from(str)) {
      const charWidth = /[\u3000-\u9fff\uff01-\uff60\u2E80-\u2FDF\u3040-\u30FF\u2600-\u26FF\u2700-\u27BF]/.test(char) ? 2 : 1
      if (width + charWidth > maxWidth) break
      width += charWidth
      result += char
    }
    return result
  },

  /**
   * 清理字符串，移除不可见字符和特殊字符，限制长度
   * @param {string} input - 输入字符串
   * @returns {string} 清理后的字符串
   */
  sanitizeString(input: string): string {
    if (input == null) return ''
    return String(input)
      .replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\x00-\x1F\x7F]/g, '')
      .replace(/[\u{10000}-\u{10FFFF}]/u, '□')
      .replace(/(.)\1{9,}/g, '$1$1$1…')
      .replace(/[\<\>\`\$\(\)\[\]\{\}\;\'\"\\\=]/g, '*')
      .replace(/\s+/g, ' ').trim()
      .slice(0, 64)
  },

  /**
   * 格式化时间为"多久前"的形式
   * @param {Date} date - 日期对象
   * @returns {string} 格式化后的时间字符串
   */
  formatTimeAgo(date: Date): string {
    if (!date?.getTime()) return '未知时间'
    const diff = Date.now() - date.getTime()
    if (Math.abs(diff) < 3000) return (diff < 0 ? '一会后' : '一会前')

    const units: [number, string][] = [
      [31536000000, '年'],
      [2592000000, '月'],
      [86400000, '天'],
      [3600000, '时'],
      [60000, '分'],
      [1000, '秒']
    ]

    const absDiff = Math.abs(diff)
    const suffix = diff < 0 ? '后' : '前'

    for (let i = 0; i < units.length; i++) {
      const [primaryDiv, primaryUnit] = units[i]
      if (absDiff < primaryDiv) continue
      const primaryVal = Math.floor(absDiff / primaryDiv)
      // 计算次要单位
      if (i < units.length - 1) {
        const [secondaryDiv, secondaryUnit] = units[i + 1]
        const remainder = absDiff % primaryDiv
        const secondaryVal = Math.floor(remainder / secondaryDiv)

        if (secondaryVal > 0) {
          return `${primaryVal}${primaryUnit}${secondaryVal}${secondaryUnit}${suffix}`
        }
      }
      return `${primaryVal}${primaryUnit}${suffix}`
    }

    return `一会${suffix}`
  },

  /**
   * 处理统计记录并格式化显示
   * @param {StatRecord[]} records - 统计记录数组
   * @param {keyof StatRecord} aggregateKey - 聚合键
   * @param {StatProcessOptions} [options={}] - 处理选项
   * @returns {Promise<{items: string[], page: number, totalPages: number, totalItems: number, title: string}>}
   * 处理后的结果，包含格式化项目、分页信息和标题
   */
  async processStatRecords(records: StatRecord[], aggregateKey: keyof StatRecord, options: StatProcessOptions = {}) {
    const {
      sortBy = 'count',
      limit,
      disableCommandMerge = false,
      truncateId = false,
      displayBlacklist = [],
      displayWhitelist = [],
      page = 1,
      pageSize = 15,
      title = '',
      skipPaging = false
    } = options;
    // 创建聚合器并过滤数据
    const keyFormatter = (aggregateKey === 'command' && !disableCommandMerge)
      ? (k: string) => k?.split('.')[0] || '' : undefined;

    const stats = new StatMap(keyFormatter);
    const filteredRecords = (aggregateKey === 'command' && !disableCommandMerge)
      ? records.filter(r => r.command !== '_message') : records;
    // 名称映射和数据聚合
    const nameMap = new Map<string, string>();
    for (const record of filteredRecords) {
      stats.add(record[aggregateKey] as string, record.count, record.lastTime);

      if ((aggregateKey === 'userId' && record.userName) ||
          (aggregateKey === 'guildId' && record.guildName)) {
        nameMap.set(
          record[aggregateKey] as string,
          record[aggregateKey === 'userId' ? 'userName' : 'guildName']
        );
      }
    }
    // 过滤和分页
    let entries = stats.sortedEntries(sortBy);
    if (displayWhitelist.length || displayBlacklist.length) {
      entries = entries.filter(([key]) => {
        if (displayWhitelist.length) return displayWhitelist.some(p => key.includes(p));
        return !displayBlacklist.some(p => key.includes(p));
      });
    }

    const totalItems = entries.length;
    let pagedEntries = entries;
    let currentPage = 1, totalPages = 1;

    if (!skipPaging) {
      const effectiveLimit = limit ? Math.min(totalItems, limit) : totalItems;
      totalPages = Math.ceil(effectiveLimit / pageSize) || 1;
      currentPage = Math.min(Math.max(1, page), totalPages);

      const startIdx = (currentPage - 1) * pageSize;
      const endIdx = limit
        ? Math.min(startIdx + pageSize, limit, totalItems)
        : Math.min(startIdx + pageSize, totalItems);

      pagedEntries = entries.slice(startIdx, endIdx);
    }
    // 格式化标题和项目
    const formattedTitle = (!skipPaging && totalPages > 1)
      ? `${title.endsWith(' ——') ? title.slice(0, -3) : title}（第${currentPage}/${totalPages}页）——`
      : title;

    const countWidth = 5, timeWidth = 10, nameWidth = 15;
    // 使用Unicode中Braille空白符(U+2800)代替普通空格进行占位
    const padChar = '\u2800';

    const items = pagedEntries.map(([key, {count, lastTime}]) => {
      const displayName = truncateId && nameMap.has(key)
        ? (nameMap.get(key) || key) : (nameMap.get(key) || key);

      const truncatedName = this.truncateByDisplayWidth(displayName, nameWidth);
      const countStr = count.toString() + (aggregateKey === 'command' ? '次' : '条');
      const truncatedCount = this.truncateByDisplayWidth(countStr, countWidth);
      const timeAgo = this.formatTimeAgo(lastTime);
      const truncatedTime = this.truncateByDisplayWidth(timeAgo, timeWidth);
      const namePadding = padChar.repeat(Math.max(0, nameWidth - this.getStringDisplayWidth(truncatedName)));
      const countPadding = padChar.repeat(Math.max(0, countWidth - this.getStringDisplayWidth(truncatedCount)));

      return `${truncatedName}${namePadding} ${countPadding}${truncatedCount} ${truncatedTime}`;
    });

    return { items, page: currentPage, totalPages, totalItems, title: formattedTitle };
  },

  /**
   * 检查目标是否匹配规则列表中的任何规则
   * @param {string[]} list - 规则列表
   * @param {{platform: string, guildId: string, userId: string, command?: string}} target - 目标对象
   * @returns {boolean} 是否匹配
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

  /**
   * 获取记录中某个键的所有唯一值
   * @param {StatRecord[]} records - 统计记录数组
   * @param {keyof StatRecord} key - 要获取的键
   * @returns {string[]} 唯一值数组
   */
  getUniqueKeys(records: StatRecord[], key: keyof StatRecord): string[] {
    return [...new Set(records.map(r => r[key] as string).filter(Boolean))]
  },

  /**
   * 获取平台用户ID，尝试从绑定数据中查找
   * @param {any} session - 会话对象
   * @returns {Promise<string>} 平台用户ID
   */
  async getPlatformId(session: any): Promise<string> {
    if (!session?.userId || !session?.platform || !session?.app?.database) return session?.userId || ''
    try {
      const [binding] = await session.app.database.get('binding', {
        aid: session.userId,
        platform: session.platform
      })
      return binding?.pid || session.userId
    } catch {
      return session.userId || ''
    }
  },

  /**
   * 获取会话信息，包括平台、群组、用户等信息
   * @param {any} session - 会话对象
   * @returns {Promise<{platform: string, guildId: string, userId: string, userName: string, guildName: string} | null>}
   * 会话信息对象，获取失败时返回null
   */
  async getSessionInfo(session: any) {
    if (!session) return null

    const platform = session.platform
    const guildId = session.guildId || session.groupId || session.channelId
    const userId = await this.getPlatformId(session)
    const bot = session.bot

    let userName = '', guildName = ''
    try {
      userName = session.username ?? (bot?.getGuildMember
        ? (await bot.getGuildMember(guildId, userId).catch(() => null))?.username
        : '') ?? ''

      guildName = guildId === 'private'
        ? ''
        : (await bot?.getGuild?.(guildId).catch(() => null))?.name ?? ''
    } catch {}

    return {
      platform,
      guildId,
      userId,
      userName: this.sanitizeString(userName),
      guildName: this.sanitizeString(guildName)
    }
  },

  /**
   * 处理统计查询并返回结果
   * @param {Context} ctx - Koishi上下文
   * @param {QueryOptions} options - 查询选项
   * @param {'command' | 'user' | 'guild'} type - 查询类型
   * @returns {Promise<string | {records: StatRecord[], title: string}>} 查询结果或错误信息
   */
  async handleStatQuery(ctx: Context, options: QueryOptions, type: 'command' | 'user' | 'guild') {
    const query: Record<string, any> = {}
    const typeMap = { command: '命令', user: '发言', guild: '群组' }

    if (options.user) query.userId = options.user
    if (options.guild) query.guildId = options.guild
    if (options.platform) query.platform = options.platform

    if (type === 'user') {
      query.command = '_message'
    } else if (type === 'command') {
      query.command = options.command || { $neq: '_message' }
    } else if (options.command) {
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

  /**
   * 格式化并返回指定类型的列表
   * @param {StatRecord[]} records - 统计记录数组
   * @param {keyof StatRecord} key - 要获取的键名
   * @param {string} title - 列表标题
   * @returns {string|null} 格式化后的列表字符串，无内容则返回null
   */
  formatList: (records: StatRecord[], key: keyof StatRecord, title: string): string | null => {
    const uniqueKeys = utils.getUniqueKeys(records, key)

    if (key === 'command') {
      const commands = uniqueKeys.filter(cmd => cmd !== '_message')
      return commands.length ? `${title} ——\n${commands.join(', ')}` : null
    } else if (key === 'userId' || key === 'guildId') {
      const items = uniqueKeys.map(id => {
        const record = records.find(r => r[key] === id)
        const name = key === 'userId' ? record?.userName : record?.guildName
        return name ? `${name} (${id})` : id
      })
      return items.length ? `${title} ——\n${items.join(', ')}` : null
    }

    return uniqueKeys.length ? `${title} ——\n${uniqueKeys.join(', ')}` : null
  }
}
