import { Context } from 'koishi'
import { StatRecord } from './index'
import { Utils } from './utils'

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
 * 统计数据处理函数集合
 */
export const statProcessor = {
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

    const filteredRecords = Utils.filterStatRecords(records, {
      keyField: aggregateKey as string,
      displayWhitelist,
      displayBlacklist,
      disableCommandMerge
    });
    // 创建聚合器
    const keyFormatter = (aggregateKey === 'command' && !disableCommandMerge)
      ? (k: string) => k?.split('.')[0] || '' : undefined;
    const statsMap = Utils.generateStatsMap(filteredRecords, aggregateKey as string, keyFormatter);
    // 排序和处理数据
    let entries = Array.from(statsMap.entries()).sort((a, b) =>
      sortBy === 'count' ? b[1].count - a[1].count : a[0].localeCompare(b[0])
    );

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

    const countWidth = 6, timeWidth = 10, nameWidth = 18;

    const items = pagedEntries.map(([key, {count, lastTime}]) => {
      const displayName = Utils.formatDisplayName(
        statsMap.get(key)?.displayName || key,
        key,
        truncateId
      );

      const truncatedName = Utils.truncateByDisplayWidth(displayName, nameWidth);
      const countStr = count.toString() + (aggregateKey === 'command' ? '次' : '条');
      const truncatedCount = Utils.truncateByDisplayWidth(countStr, countWidth);
      const timeAgo = Utils.formatTimeAgo(lastTime);
      const truncatedTime = Utils.truncateByDisplayWidth(timeAgo, timeWidth);
      const namePadding = ' '.repeat(Math.max(0, nameWidth - Utils.getStringDisplayWidth(truncatedName)));
      const countPadding = ' '.repeat(Math.max(0, countWidth - Utils.getStringDisplayWidth(truncatedCount)));

      return `${truncatedName}${namePadding} ${countPadding}${truncatedCount} ${truncatedTime}`;
    });

    return { items, page: currentPage, totalPages, totalItems, title: formattedTitle };
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
    // 查找并获取用户和群组的昵称
    let userName = '', guildName = ''
    if (options.user) {
      // 尝试从记录中获取用户昵称
      const userRecord = records.find(r => r.userId === options.user && r.userName)
      if (userRecord?.userName) {
        userName = userRecord.userName
      }
    }
    if (options.guild) {
      // 尝试从记录中获取群组昵称
      const guildRecord = records.find(r => r.guildId === options.guild && r.guildName)
      if (guildRecord?.guildName) {
        guildName = guildRecord.guildName
      }
    }

    const conditions = Utils.buildConditions({
      user: options.user ? (userName || options.user) : null,
      guild: options.guild ? (guildName || options.guild) : null,
      platform: options.platform,
      command: options.command
    })

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
    const uniqueKeys = statProcessor.getUniqueKeys(records, key)

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
  },

  /**
   * 注册列表查看子命令
   * @param {Context} ctx - Koishi上下文
   * @param {any} parent - 父命令对象
   */
  registerListCommand(ctx: Context, parent: any) {
    parent.subcommand('.list', '查看类型列表', { authority: 3 })
      .option('user', '-u 显示用户列表')
      .option('guild', '-g 显示群组列表')
      .action(async ({ options }) => {
        const records = await ctx.database.get('analytics.stat', {})
        if (!records?.length) return '未找到记录'

        const hasParams = options.user || options.guild
        const parts: (string | null)[] = []

        if (!hasParams) {
          parts.push(this.formatList(records, 'platform', '平台列表'))
          parts.push(this.formatList(records, 'command', '命令列表'))
        }
        if (options.user) parts.push(this.formatList(records, 'userId', '用户列表'))
        if (options.guild) parts.push(this.formatList(records, 'guildId', '群组列表'))

        return parts.filter(Boolean).join('\n')
      })
  }
}
