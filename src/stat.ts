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
    if (source === 'stat') {
      if (type === 'user') query.command = '_message'
      else if (type === 'command') query.command = options.command || { $neq: '_message' }
      else if (options.command) query.command = options.command
    }
    let records: any[] = []
    if (source === 'daily') {
      // 构建日期条件
      let dateCond: any = {};
      if (options.period) {
        dateCond = this.buildDateCondition(options.period);
      }
      // 对于daily表的查询需要通过join方式获取完整信息
      const dailyRecords = await this.fetchDailyRecordsWithJoin(ctx, {
        ...query,
        dateCond,
        period: options.period
      });
      if (dailyRecords.length > 0) {
        // 计算差值
        records = this.processDailyRecords(dailyRecords, options.period);
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
   * 构建日期查询条件
   */
  buildDateCondition(period: string) {
    const p = String(period).toLowerCase();
    let dateCond: any = {};
    if (/^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(p)) {
      // 处理日期范围格式 (YYYY-MM-DD~YYYY-MM-DD)
      const [start, end] = p.split('~');
      dateCond = { $gte: start, $lte: end };
    } else if (/^\d{4}-\d{2}-\d{2}(?:\s+\d{1,2})?$/.test(p)) {
      // 处理单个日期格式 (YYYY-MM-DD [H])
      const [date] = p.split(/\s+/);
      dateCond = date;
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
      // 处理小时格式 (Nh)
      const hours = parseInt(p);
      const now = new Date();
      const cutoffTime = new Date(now.getTime() - hours * 60 * 60 * 1000);
      dateCond = { $gte: Utils.formatDate(cutoffTime) };
    }
    return dateCond;
  },

  /**
   * 通过关联查询获取daily记录和对应的stat信息
   */
  async fetchDailyRecordsWithJoin(ctx: Context, conditions: any) {
    const { dateCond, period, ...query } = conditions;
    // 首先找到匹配的stat记录ID
    let statQuery: any = { command: '_message' };
    if (query.userId) statQuery.userId = query.userId;
    if (query.guildId) statQuery.guildId = query.guildId;
    if (query.platform) statQuery.platform = query.platform;
    const statRecords = await ctx.database.get('analytics.stat', statQuery);
    if (!statRecords.length) return [];
    // 获取小时信息，如果有的话
    let hourFilter = null;
    if (period && /^\d{4}-\d{2}-\d{2}\s+\d{1,2}$/.test(period)) {
      const hourStr = period.split(/\s+/)[1];
      hourFilter = parseInt(hourStr);
    }
    // 构建daily表查询
    const dailyQuery: any = {
      statId: { $in: statRecords.map(r => r.id) },
      date: dateCond || {}
    };
    if (hourFilter !== null) {
      dailyQuery.hour = hourFilter;
    }
    // 获取daily记录
    const dailyRecords = await ctx.database.get('analytics.daily', dailyQuery);
    // 将stat记录信息合并到daily记录中
    return dailyRecords.map(daily => {
      const stat = statRecords.find(s => s.id === daily.statId);
      if (!stat) return null;
      return {
        ...daily,
        platform: stat.platform,
        guildId: stat.guildId,
        userId: stat.userId,
        userName: stat.userName,
        guildName: stat.guildName
      };
    }).filter(Boolean);
  },

  /**
   * 处理daily记录，计算差值
   */
  processDailyRecords(records: any[]) {
    // 按日期和小时排序
    records.sort((a, b) => {
      const dateComp = a.date.localeCompare(b.date);
      if (dateComp !== 0) return dateComp;
      // 处理hour可能为null的情况
      const aHour = a.hour === null ? -1 : a.hour;
      const bHour = b.hour === null ? -1 : b.hour;
      return aHour - bHour;
    });
    // 按用户分组
    const userGroups = new Map();
    records.forEach(record => {
      const key = `${record.platform}:${record.guildId}:${record.userId}`;
      if (!userGroups.has(key)) {
        userGroups.set(key, []);
      }
      userGroups.get(key).push(record);
    });
    // 计算每个用户的差值
    const processedRecords = [];
    userGroups.forEach((userRecords) => {
      // 如果只有一条记录，直接使用原始值
      if (userRecords.length === 1) {
        processedRecords.push({
          ...userRecords[0]
        });
        return;
      }
      // 对于多条记录，计算相邻记录之间的差值
      for (let i = 1; i < userRecords.length; i++) {
        const current = userRecords[i];
        const previous = userRecords[i - 1];
        const increment = Math.max(0, current.count - previous.count);
        if (increment > 0) {
          processedRecords.push({
            ...current,
            count: increment
          });
        }
      }
      // 第一条记录也需要保留
      processedRecords.push({
        ...userRecords[0]
      });
    });
    return processedRecords;
  },

  /**
   * 计算两组记录之间的差值
   * @private
   * @param {Array<any>} currentRecords - 当前记录
   * @param {Array<any>} baseRecords - 基准记录
   * @returns {Array<any>} 计算差值后的记录
   */
  calculateDifferences(currentRecords: any[], baseRecords: any[] = []): any[] {
    if (!baseRecords?.length) return currentRecords;
    // 创建基准记录的映射表以便快速查找
    const baseMap = new Map();
    baseRecords.forEach(record => {
      const key = `${record.platform}:${record.guildId}:${record.userId}`;
      baseMap.set(key, record);
    });
    // 计算差值
    return currentRecords.map(record => {
      const key = `${record.platform}:${record.guildId}:${record.userId}`;
      const baseRecord = baseMap.get(key);
      // 计算实际增量
      const baseCount = baseRecord ? baseRecord.count : 0;
      const increment = Math.max(0, record.count - baseCount);
      // 返回一个新对象，包含原始属性但count已更新为增量值
      return {
        ...record,
        count: increment
      };
    }).filter(record => record.count > 0);
  },

  /**
   * 获取记录中的最早日期
   * @private
   * @param {Array<any>} records - 记录数组
   * @returns {Date|null} 最早的日期，如果没有记录则返回null
   */
  getEarliestDate(records: any[]): Date | null {
    if (!records?.length) return null;
    let earliest: Date | null = null;
    records.forEach(record => {
      if (!record.date) return;
      const recordDate = new Date(record.date);
      if (!earliest || recordDate < earliest) {
        earliest = recordDate;
      }
    });
    return earliest;
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