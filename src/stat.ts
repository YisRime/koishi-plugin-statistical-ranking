import { Context } from 'koishi'
import { StatRecord } from './index'
import { Utils } from './utils'

/**
 * 查询选项接口，用于指定统计查询的各种条件
 * @interface QueryOptions
 */
interface QueryOptions {
  /** 用户ID */
  user?: string
  /** 群组ID */
  guild?: string
  /** 平台名称 */
  platform?: string
  /** 命令名称 */
  command?: string
  /** 时间段 */
  period?: string
  /** 数据源类型：'stat'常规统计或'daily'每日统计 */
  source?: 'stat' | 'daily'
}

/**
 * 统计处理选项接口，用于配置统计结果的处理方式
 * @interface StatProcessOptions
 */
export interface StatProcessOptions {
  /** 排序依据: 'key'按键名, 'count'按计数, 'time'按时间 */
  sortBy?: 'key' | 'count' | 'time'
  /** 限制结果数量 */
  limit?: number
  /** 是否禁用命令合并 */
  disableCommandMerge?: boolean
  /** 是否截断ID */
  truncateId?: boolean
  /** 显示黑名单 */
  displayBlacklist?: string[]
  /** 显示白名单 */
  displayWhitelist?: string[]
  /** 页码 */
  page?: number
  /** 每页大小 */
  pageSize?: number
  /** 自定义标题 */
  title?: string
  /** 是否跳过分页 */
  skipPaging?: boolean
  /** 时间段 */
  period?: string
  /** 数据源类型：'stat'常规统计或'daily'每日统计 */
  source?: 'stat' | 'daily'
}

/**
 * 统计处理器对象，提供统计数据处理与查询的方法
 */
export const statProcessor = {
  /**
   * 处理统计记录，将其聚合并格式化为可显示的结果
   * @param {any[]} records - 要处理的统计记录数组
   * @param {string} aggregateKey - 聚合键名
   * @param {StatProcessOptions} options - 处理选项
   * @returns {Promise<{items: string[], page: number, totalPages: number, totalItems: number, title: string}>} 处理后的统计结果，包含项目列表、分页信息和标题
   */
  async processStatRecords(records: any[], aggregateKey: string, options: StatProcessOptions = {}) {
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
      skipPaging = false,
      source
    } = options;
    const filtered = Utils.filterStatRecords(records, {
      keyField: aggregateKey,
      displayWhitelist,
      displayBlacklist,
      disableCommandMerge
    });
    let statsMap: Map<string, any>;
    if (source === 'daily') {
      statsMap = new Map();
      records.forEach(record => {
        const key = record[aggregateKey];
        if (!key) return;
        let displayName = key;
        if (aggregateKey === 'userId' && record.userName) displayName = record.userName;
        if (aggregateKey === 'guildId' && record.guildName) displayName = record.guildName;
        const curr = statsMap.get(key) || { count: 0, lastTime: new Date(record.date), displayName };
        curr.count += record.count;
        if (new Date(record.date) > curr.lastTime) curr.lastTime = new Date(record.date);
        statsMap.set(key, curr);
      });
    } else {
      const keyFormatter = (aggregateKey === 'command' && !disableCommandMerge)
        ? (k: string) => k?.split('.')[0] || '' : undefined;
      statsMap = Utils.generateStatsMap(filtered, aggregateKey, keyFormatter);
    }
    let entries = Array.from(statsMap.entries()).sort((a, b) => {
      if (sortBy === 'count') return b[1].count - a[1].count;
      if (sortBy === 'time') return new Date(b[1].lastTime).getTime() - new Date(a[1].lastTime).getTime();
      return a[0].localeCompare(b[0]);
    });
    const totalItems = entries.length;
    let paged = entries;
    let currentPage = 1, totalPages = 1;
    if (!skipPaging) {
      const effLimit = limit ? Math.min(totalItems, limit) : totalItems;
      totalPages = Math.ceil(effLimit / pageSize) || 1;
      currentPage = Math.min(Math.max(1, page), totalPages);
      const start = (currentPage - 1) * pageSize;
      const end = limit
        ? Math.min(start + pageSize, limit, totalItems)
        : Math.min(start + pageSize, totalItems);
      paged = entries.slice(start, end);
    }
    const formattedTitle = (!skipPaging && totalPages > 1)
      ? `${title.endsWith(' ——') ? title.slice(0, -3) : title}（第${currentPage}/${totalPages}页）——`
      : title;
    const countWidth = 6, timeWidth = 10, nameWidth = 18;
    const items = paged.map(([key, {count, lastTime}]) => {
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
   * 处理统计查询请求
   * @param {Context} ctx - Koishi上下文
   * @param {QueryOptions} options - 查询选项
   * @param {'command' | 'user' | 'guild'} type - 查询类型：'command'命令统计,'user'用户统计,'guild'群组统计
   * @returns {Promise<string | {records: any[], title: string}>} 查询结果，包含记录和标题，或错误信息
   */
  async handleStatQuery(ctx: Context, options: QueryOptions, type: 'command' | 'user' | 'guild') {
    const source = options.source || 'stat';
    const query: Record<string, any> = {}
    const typeMap = { command: '命令', user: '发言', guild: '群组' }
    if (options.user) query.userId = options.user
    if (options.guild) query.guildId = options.guild
    if (options.platform) query.platform = options.platform
    if (type === 'user') query.command = '_message'
    else if (type === 'command') query.command = options.command || { $neq: '_message' }
    else if (options.command) query.command = options.command
    let records: any[] = []
    if (source === 'daily') {
      let dateCond: any = {};
      if (options.period) {
        const p = String(options.period).toLowerCase();
        if (/^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(p)) {
          // 处理日期范围格式 (YYYY-MM-DD~YYYY-MM-DD)
          const [start, end] = p.split('~');
          dateCond = { $gte: start, $lte: end };
        } else if (/^\d{4}-\d{2}-\d{2}(?:\s+\d{1,2})?$/.test(p)) {
          // 处理单个日期格式 (YYYY-MM-DD [H])
          const [date, hourStr] = p.split(/\s+/);
          dateCond = date;
          if (hourStr !== undefined) {
            const hourNum = parseInt(hourStr);
            if (!isNaN(hourNum)) {
              // 指定了具体小时，直接查询该小时的数据
              const hourQuery = { ...query, date: dateCond, hour: hourNum };
              records = await ctx.database.get('analytics.daily', hourQuery);
              if (records.length > 0) {
                return { records, title: this.generateTitle(records, options, type, typeMap) };
              }
            }
          }
        } else if (/^\d+d$/.test(p)) {
          // 处理天数格式 (Nd)
          const days = parseInt(p);
          const today = new Date();
          const end = new Date(today);
          end.setDate(today.getDate() - 1);
          const start = new Date(end);
          start.setDate(end.getDate() - days + 1);
          dateCond = { $gte: Utils.formatDate(start), $lte: Utils.formatDate(end) };
        } else if (/^\d+h$/.test(p)) {
          // 处理小时格式 (Nh)，需要查询最近N小时的数据
          const hours = parseInt(p);
          const now = new Date();
          const endDate = Utils.formatDate(now);
          const startDate = now.getHours() >= hours ?
            endDate :
            Utils.formatDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
          // 小时查询需要特殊处理，查询两天内带有小时信息的记录
          const hourlyRecords = await ctx.database.get('analytics.daily', {
            ...query,
            date: { $in: [startDate, endDate] },
            hour: { $ne: null }
          });
          if (hourlyRecords.length > 0) {
            // 过滤出最近N小时的记录
            const cutoffTime = new Date();
            cutoffTime.setHours(cutoffTime.getHours() - hours);
            const filteredRecords = hourlyRecords.filter(record => {
              const recordDate = new Date(record.date);
              recordDate.setHours(record.hour || 0);
              return recordDate.getTime() >= cutoffTime.getTime();
            });
            if (filteredRecords.length > 0) {
              return { records: filteredRecords, title: this.generateTitle(filteredRecords, options, type, typeMap) };
            }
          }
        }
      }
      // 先尝试查询整天数据（hour为null的记录）
      const dailyQuery = { ...query, date: dateCond, hour: null };
      const dailyRecords = await ctx.database.get('analytics.daily', dailyQuery);
      // 如果找到了整天数据，使用整天数据
      if (dailyRecords.length > 0) {
        records = dailyRecords;
      } else {
        // 如果没有整天数据，查询所有符合日期条件的数据（可能包含小时数据）
        const allQuery = { ...query, date: dateCond };
        records = await ctx.database.get('analytics.daily', allQuery);
        // 如果同一天同时有整天数据和小时数据，按日期分组并优先使用整天数据
        const recordsByDate = new Map();
        records.forEach(record => {
          const date = record.date;
          const key = `${record.platform}:${record.guildId}:${record.userId}:${date}`;
          const existingRecord = recordsByDate.get(key);
          // 如果已经有记录，且当前记录hour为null，则替换为整天数据
          // 或者如果没有现有记录，直接添加
          if (!existingRecord || record.hour === null) {
            recordsByDate.set(key, record);
          }
        });
        records = Array.from(recordsByDate.values());
      }
    } else {
      records = await ctx.database.get('analytics.stat', query);
    }
    if (!records?.length) return '未找到记录';
    return {
      records,
      title: this.generateTitle(records, options, type, typeMap)
    };
  },

  /**
   * 生成查询结果的标题
   * @private
   */
  generateTitle(records: any[], options: QueryOptions, type: 'command' | 'user' | 'guild', typeMap: Record<string, string>): string {
    let userName = '', guildName = '';
    if (options.user) {
      const userRecord = records.find(r => r.userId === options.user && r.userName);
      userName = userRecord?.userName || '';
    }
    if (options.guild) {
      const guildRecord = records.find(r => r.guildId === options.guild && r.guildName);
      guildName = guildRecord?.guildName || '';
    }
    const conditions = Utils.buildConditions({
      user: options.user ? (userName || options.user) : null,
      guild: options.guild ? (guildName || options.guild) : null,
      platform: options.platform,
      command: options.command
    });
    // 生成基础标题
    let title = '';
    if (conditions.length) {
      title = `${conditions.join('、')}的${typeMap[type]}统计`;
    } else if (options.guild && type !== 'guild') {
      const guildDisplay = guildName || options.guild;
      title = `${guildDisplay}的${typeMap[type]}统计`;
    } else {
      title = `全局${typeMap[type]}统计`;
    }
    // 如果是每日统计，添加时间范围信息
    if (options.source === 'daily' && options.period) {
      const period = options.period;
      let timeInfo = '';
      // 解析时间段参数
      if (/^\d+d$/.test(period)) {
        // 天数格式 (Nd)
        const days = parseInt(period);
        if (days === 1) {
          timeInfo = '昨日';
        } else {
          const today = new Date();
          const end = new Date(today);
          end.setDate(today.getDate() - 1);
          const start = new Date(end);
          start.setDate(end.getDate() - days + 1);
          timeInfo = `近${days}天(${Utils.formatDate(start)}~${Utils.formatDate(end)})`;
        }
      } else if (/^\d+h$/.test(period)) {
        // 小时格式 (Nh)
        const hours = parseInt(period);
        if (hours <= 24) {
          timeInfo = `近${hours}小时`;
        } else {
          const days = Math.floor(hours / 24);
          const remainingHours = hours % 24;
          timeInfo = `近${days}天${remainingHours > 0 ? remainingHours + '小时' : ''}`;
        }
      } else if (/^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(period)) {
        // 日期范围格式 (YYYY-MM-DD~YYYY-MM-DD)
        const [start, end] = period.split('~');
        timeInfo = `${start}~${end}`;
      } else if (/^\d{4}-\d{2}-\d{2}(?:\s+\d{1,2})?$/.test(period)) {
        // 单个日期格式 (YYYY-MM-DD [H])
        const [date, hourStr] = period.split(/\s+/);
        timeInfo = hourStr !== undefined ? `${date} ${hourStr}时` : date;
      }
      // 如果解析出了时间信息，插入到标题中
      if (timeInfo) {
        if (title.includes(`的${typeMap[type]}统计`)) {
          title = title.replace(`的${typeMap[type]}统计`, `的${timeInfo}${typeMap[type]}统计`);
        } else if (title.startsWith(`全局${typeMap[type]}统计`)) {
          title = `全局${timeInfo}${typeMap[type]}统计`;
        }
      }
    }
    return title + ' ——';
  },

  /**
   * 格式化列表显示
   * @param {StatRecord[]} records - 统计记录数组
   * @param {keyof StatRecord} key - 要提取的键名
   * @param {string} title - 列表标题
   * @returns {string | null} 格式化后的列表文本，如果没有记录则返回null
   */
  formatList: (records: StatRecord[], key: keyof StatRecord, title: string): string | null => {
    const uniqueKeys = [...new Set(records.map(r => r[key] as string).filter(Boolean))];
    if (key === 'command') {
      const commands = uniqueKeys.filter(cmd => cmd !== '_message')
      return commands.length ? `${title} ——\n${commands.join(',')}` : null
    } else if (key === 'userId' || key === 'guildId') {
      const items = uniqueKeys.map(id => {
        const record = records.find(r => r[key] === id)
        const name = key === 'userId' ? record?.userName : record?.guildName
        return name ? `${name} (${id})` : id
      })
      return items.length ? `${title} ——\n${items.join(',')}` : null
    }
    return uniqueKeys.length ? `${title} ——\n${uniqueKeys.join(',')}` : null
  },

  /**
   * 注册list子命令，用于查看类型列表
   * @param {Context} ctx - Koishi上下文
   * @param {any} parent - 父命令
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