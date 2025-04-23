import { Context } from 'koishi'
import { StatRecord } from './index'
import { Utils } from './utils'

/**
 * 查询选项接口，用于指定统计查询的各种条件
 * @interface QueryOptions
 * @property {string} [user] - 用户ID过滤条件
 * @property {string} [guild] - 群组ID过滤条件
 * @property {string} [platform] - 平台过滤条件
 * @property {string} [command] - 命令过滤条件
 * @property {string} [period] - 时间段过滤条件，格式可以是"Nd"(天数)、"Nh"(小时)或"YYYY-MM-DD~YYYY-MM-DD"(日期范围)
 * @property {'stat' | 'daily'} [source] - 数据源类型，stat为常规统计，daily为按日期统计
 * @property {boolean} [isRanking] - 是否为排行榜查询模式
 */
interface QueryOptions {
  user?: string
  guild?: string
  platform?: string
  command?: string
  period?: string
  source?: 'stat' | 'daily'
  isRanking?: boolean
}

/**
 * 统计处理选项接口，用于配置统计结果的处理方式
 * @interface StatProcessOptions
 * @property {'key' | 'count' | 'time'} [sortBy='count'] - 排序方式：按键名、计数或时间排序
 * @property {number} [limit] - 结果数量限制
 * @property {boolean} [disableCommandMerge=false] - 是否禁用命令合并（命令前缀相同的视为同一类）
 * @property {boolean} [truncateId=false] - 是否截断长ID显示
 * @property {string[]} [displayBlacklist=[]] - 不显示的项目黑名单
 * @property {string[]} [displayWhitelist=[]] - 仅显示的项目白名单
 * @property {number} [page=1] - 当前页码
 * @property {number} [pageSize=15] - 每页显示条目数
 * @property {string} [title=''] - 结果显示的标题
 * @property {boolean} [skipPaging=false] - 是否跳过分页处理
 * @property {string} [period] - 时间段过滤
 * @property {'stat' | 'daily'} [source] - 数据源类型
 * @property {boolean} [isRanking=false] - 是否为排行榜模式
 */
export interface StatProcessOptions {
  sortBy?: 'key' | 'count' | 'time'
  limit?: number
  disableCommandMerge?: boolean
  truncateId?: boolean
  displayBlacklist?: string[]
  displayWhitelist?: string[]
  page?: number
  pageSize?: number
  title?: string
  skipPaging?: boolean
  period?: string
  source?: 'stat' | 'daily'
  isRanking?: boolean
}

/**
 * 统计处理器对象，提供统计数据处理与查询的方法
 * @namespace statProcessor
 */
export const statProcessor = {
  /**
   * 处理统计记录，将其聚合并格式化为可显示的结果
   * @param {any[]} records - 统计记录数组
   * @param {string} aggregateKey - 聚合键名
   * @param {StatProcessOptions} [options={}] - 处理选项
   * @returns {Promise<{items: string[], page: number, totalPages: number, totalItems: number, title: string}>} 处理后的结果对象
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
      source,
      isRanking = false
    } = options;
    const filtered = Utils.filterStatRecords(records, {
      keyField: aggregateKey,
      displayWhitelist,
      displayBlacklist,
      disableCommandMerge
    });
    // 创建统计映射
    const statsMap = this.createStatsMap(filtered, aggregateKey, source, disableCommandMerge);
    // 排序条目
    let entries = Array.from(statsMap.entries()).sort((a, b) => {
      if (sortBy === 'count') return b[1].count - a[1].count;
      if (sortBy === 'time') return new Date(b[1].lastTime).getTime() - new Date(a[1].lastTime).getTime();
      return a[0].localeCompare(b[0]);
    });
    // 处理分页
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
    // 格式化每一项
    const items = this.formatItems(paged, statsMap, aggregateKey, truncateId, isRanking);
    return { items, page: currentPage, totalPages, totalItems, title: formattedTitle };
  },

  /**
   * 创建统计映射，根据记录生成聚合后的数据映射
   * @param {any[]} records - 统计记录数组
   * @param {string} aggregateKey - 聚合键名
   * @param {string} [source] - 数据源类型
   * @param {boolean} [disableCommandMerge=false] - 是否禁用命令合并
   * @returns {Map<string, any>} 统计映射表
   */
  createStatsMap(records: any[], aggregateKey: string, source?: string, disableCommandMerge = false) {
    if (source === 'daily') {
      const statsMap = new Map();
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
      return statsMap;
    } else {
      const keyFormatter = (aggregateKey === 'command' && !disableCommandMerge)
        ? (k: string) => k?.split('.')[0] || '' : undefined;
      return Utils.generateStatsMap(records, aggregateKey, keyFormatter);
    }
  },

  /**
   * 格式化数据项为可显示的文本行
   * @param {[string, any][]} entries - 待格式化的数据项
   * @param {Map<string, any>} statsMap - 统计映射表
   * @param {string} aggregateKey - 聚合键名
   * @param {boolean} [truncateId=false] - 是否截断ID显示
   * @param {boolean} [isRanking=false] - 是否为排行榜模式
   * @returns {string[]} 格式化后的文本行数组
   */
  formatItems(entries: [string, any][], statsMap: Map<string, any>, aggregateKey: string, truncateId = false, isRanking = false) {
    const countWidth = 6, timeWidth = 10, nameWidth = 18;
    return entries.map(([key, {count, lastTime}], index) => {
      const displayName = Utils.formatDisplayName(
        statsMap.get(key)?.displayName || key,
        key,
        truncateId
      );
      const truncatedName = Utils.truncateByDisplayWidth(displayName, nameWidth);
      const countStr = count.toString() + (aggregateKey === 'command' ? '次' : '条');
      const truncatedCount = Utils.truncateByDisplayWidth(countStr, countWidth);
      // 排行榜模式显示排名，否则显示时间信息
      let rankOrTimeStr = isRanking
        ? `#${index + 1}`
        : Utils.truncateByDisplayWidth(Utils.formatTimeAgo(lastTime), timeWidth);
      const namePadding = ' '.repeat(Math.max(0, nameWidth - Utils.getStringDisplayWidth(truncatedName)));
      const countPadding = ' '.repeat(Math.max(0, countWidth - Utils.getStringDisplayWidth(truncatedCount)));
      // 排行榜格式与常规格式不同
      return isRanking
        ? `${rankOrTimeStr} ${truncatedName}${namePadding} ${countPadding}${truncatedCount}`
        : `${truncatedName}${namePadding} ${countPadding}${truncatedCount} ${rankOrTimeStr}`;
    });
  },

  /**
   * 处理统计查询请求，根据查询条件获取并处理数据
   * @param {Context} ctx - Koishi上下文
   * @param {QueryOptions} options - 查询选项
   * @param {'command' | 'user' | 'guild'} type - 查询类型
   * @returns {Promise<string | {records: any[], title: string, isRanking?: boolean, rankingData?: any}>} 查询结果
   */
  async handleStatQuery(ctx: Context, options: QueryOptions, type: 'command' | 'user' | 'guild') {
    const source = options.source || 'stat';
    const query: Record<string, any> = {};
    const typeMap = { command: '命令', user: '发言', guild: '群组' };
    // 构建基本查询条件
    if (options.user) query.userId = options.user;
    if (options.guild) query.guildId = options.guild;
    if (options.platform) query.platform = options.platform;
    if (source === 'stat') {
      // 常规统计查询条件
      if (type === 'user') query.command = '_message';
      else if (type === 'command') query.command = options.command || { $neq: '_message' };
      else if (options.command) query.command = options.command;
      // 执行查询
      const records = await ctx.database.get('analytics.stat', query);
      if (!records?.length) return '未找到记录';
      return {
        records,
        title: this.generateTitle(records, options, type, typeMap)
      };
    } else {
      // daily表查询
      const dateCond = options.period ? this.buildDateCondition(options.period) : {};
      // 获取daily记录
      const dailyRecords = await this.fetchDailyRecordsWithJoin(ctx, {
        ...query,
        dateCond,
        period: options.period
      });
      if (!dailyRecords.length) return '未找到记录';
      // 处理daily记录
      const processedRecords = this.processDailyRecords(dailyRecords, options.period);
      // 排行榜专用处理
      if (options.isRanking && type === 'user') {
        const aggregatedRecords = this.aggregateUserRecords(processedRecords);
        // 生成排行榜数据
        const periodInfo = options.period ? this.getPeriodDates(options.period) : null;
        const guildName = this.findGuildName(options.guild, processedRecords);
        const totalCount = aggregatedRecords.reduce((sum, r) => sum + r.count, 0);
        return {
          records: aggregatedRecords,
          title: this.generateTitle(processedRecords, options, type, typeMap),
          isRanking: true,
          rankingData: {
            totalCount,
            guildName,
            period: periodInfo?.label || '全部时间',
            startDate: periodInfo?.startDate || '',
            endDate: periodInfo?.endDate || ''
          }
        };
      }
      return {
        records: processedRecords,
        title: this.generateTitle(processedRecords, options, type, typeMap)
      };
    }
  },

  /**
   * 聚合用户记录（用于排行榜），将同一用户的多条记录合并为一条
   * @param {any[]} records - 用户记录数组
   * @returns {any[]} 聚合后的用户记录数组
   */
  aggregateUserRecords(records: any[]) {
    const userMap = new Map();
    for (const record of records) {
      const key = `${record.platform}:${record.userId}`;
      if (!userMap.has(key)) {
        userMap.set(key, { ...record, count: 0 });
      }
      userMap.get(key).count += record.count;
    }
    return Array.from(userMap.values()).sort((a, b) => b.count - a.count);
  },

  /**
   * 查找群组名称
   * @param {string | undefined} guildId - 群组ID
   * @param {any[]} records - 记录数组
   * @returns {string} 群组名称，未找到则返回空字符串或原ID
   */
  findGuildName(guildId: string | undefined, records: any[]) {
    if (!guildId) return '';
    const guildRecord = records.find(r => r.guildId === guildId && r.guildName);
    return guildRecord?.guildName || guildId;
  },

  /**
   * 构建日期查询条件，根据不同格式的时间参数构建对应的查询条件
   * @param {string} period - 时间段参数
   * @returns {any} 构建的日期查询条件对象
   */
  buildDateCondition(period: string) {
    const p = String(period).toLowerCase();
    // 日期范围格式 (YYYY-MM-DD~YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(p)) {
      const [start, end] = p.split('~');
      return { $gte: start, $lte: end };
    }
    // 单个日期格式 (YYYY-MM-DD [H])
    if (/^\d{4}-\d{2}-\d{2}(?:\s+\d{1,2})?$/.test(p)) {
      return p.split(/\s+/)[0];
    }
    // 天数格式 (Nd)
    if (/^\d+d$/.test(p)) {
      const days = parseInt(p);
      const today = new Date();
      const end = new Date(today);
      end.setDate(today.getDate() - 1);
      const start = new Date(end);
      start.setDate(end.getDate() - days + 1);
      return { $gte: Utils.formatDate(start), $lte: Utils.formatDate(end) };
    }
    // 小时格式 (Nh)
    if (/^\d+h$/.test(p)) {
      const hours = parseInt(p);
      const now = new Date();
      const cutoffTime = new Date(now.getTime() - hours * 60 * 60 * 1000);
      const nowDateStr = Utils.formatDate(now);
      const cutoffDateStr = Utils.formatDate(cutoffTime);
      // 同一天内使用hour字段过滤，否则使用日期范围
      return nowDateStr === cutoffDateStr
        ? nowDateStr
        : { $gte: cutoffDateStr, $lte: nowDateStr };
    }
    return {};
  },

  /**
   * 通过关联查询获取daily记录和对应的stat信息
   * @param {Context} ctx - Koishi上下文
   * @param {any} conditions - 查询条件
   * @returns {Promise<any[]>} 关联查询后的记录数组
   */
  async fetchDailyRecordsWithJoin(ctx: Context, conditions: any) {
    const { dateCond, period, ...query } = conditions;
    // 获取匹配的stat记录
    const statQuery: any = { command: '_message' };
    if (query.userId) statQuery.userId = query.userId;
    if (query.guildId) statQuery.guildId = query.guildId;
    if (query.platform) statQuery.platform = query.platform;
    const statRecords = await ctx.database.get('analytics.stat', statQuery);
    if (!statRecords.length) return [];
    // 构建daily查询
    const dailyQuery: any = {
      statId: { $in: statRecords.map(r => r.id) }
    };
    // 添加日期和小时条件
    if (Object.keys(dateCond || {}).length > 0) {
      dailyQuery.date = dateCond;
    }
    // 处理小时条件
    if (period && /^\d{4}-\d{2}-\d{2}\s+\d{1,2}$/.test(period)) {
      dailyQuery.hour = parseInt(period.split(/\s+/)[1]);
    }
    // 获取并关联记录
    const dailyRecords = await ctx.database.get('analytics.daily', dailyQuery);
    return dailyRecords
      .map(daily => {
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
      })
      .filter(Boolean);
  },

  /**
   * 处理daily记录，计算差值并支持各种时间过滤
   * @param {any[]} records - daily记录数组
   * @param {string} [period] - 时间段参数
   * @returns {any[]} 处理后的记录数组
   */
  processDailyRecords(records: any[], period?: string) {
    if (!records.length) return [];
    // 针对小时级别的查询特殊处理
    if (period && /^\d+h$/.test(period)) {
      return this.processHourlyRecords(records, period);
    }
    // 常规处理
    return this.processRegularDailyRecords(records);
  },

  /**
   * 处理小时级别的记录，用于小时粒度的统计数据
   * @param {any[]} records - 记录数组
   * @param {string} period - 小时级别时间参数（如"24h"）
   * @returns {any[]} 处理后的小时级别记录
   */
  processHourlyRecords(records: any[], period: string) {
    const hours = parseInt(period.match(/\d+/)[0]);
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - hours * 60 * 60 * 1000);
    // 按用户分组并排序
    const userGroups = this.groupRecordsByUser(records);
    const processedRecords = [];
    userGroups.forEach((userRecords) => {
      // 按日期和小时排序
      userRecords.sort((a, b) => {
        const dateA = new Date(`${a.date}T${a.hour || 0}:00:00`);
        const dateB = new Date(`${b.date}T${b.hour || 0}:00:00`);
        return dateA.getTime() - dateB.getTime();
      });
      for (let i = 0; i < userRecords.length; i++) {
        const record = userRecords[i];
        const recordDate = new Date(`${record.date}T${record.hour || 0}:00:00`);
        // 只处理截止时间之后的记录
        if (recordDate >= cutoffTime) {
          // 第一条记录或跨天记录直接使用count值，否则计算增量
          if (i === 0 || record.date !== userRecords[i-1].date) {
            processedRecords.push({ ...record });
          } else {
            const increment = Math.max(0, record.count - userRecords[i-1].count);
            if (increment > 0) {
              processedRecords.push({ ...record, count: increment });
            }
          }
        }
      }
    });
    return processedRecords;
  },

  /**
   * 处理常规日期记录，按日期分组并计算每日增量
   * @param {any[]} records - 记录数组
   * @returns {any[]} 处理后的日期记录
   */
  processRegularDailyRecords(records: any[]) {
    // 按用户分组
    const userGroups = this.groupRecordsByUser(records);
    const processedRecords = [];
    userGroups.forEach((userRecords) => {
      // 如果只有一条记录，直接使用原始值
      if (userRecords.length === 1) {
        processedRecords.push({ ...userRecords[0] });
        return;
      }
      // 按日期分组
      const dateGroups = new Map();
      userRecords.forEach(record => {
        if (!dateGroups.has(record.date)) {
          dateGroups.set(record.date, []);
        }
        dateGroups.get(record.date).push(record);
      });
      // 处理每个日期组
      dateGroups.forEach(dateRecords => {
        // 按小时排序
        dateRecords.sort((a, b) => {
          const aHour = a.hour === null ? -1 : a.hour;
          const bHour = b.hour === null ? -1 : b.hour;
          return aHour - bHour;
        });
        // 添加第一条记录
        processedRecords.push({ ...dateRecords[0] });
        // 计算其他记录的增量
        for (let i = 1; i < dateRecords.length; i++) {
          const increment = Math.max(0, dateRecords[i].count - dateRecords[i-1].count);
          if (increment > 0) {
            processedRecords.push({ ...dateRecords[i], count: increment });
          }
        }
      });
    });
    return processedRecords;
  },

  /**
   * 按用户分组记录
   * @param {any[]} records - 记录数组
   * @returns {Map<string, any[]>} 用户分组后的记录映射
   */
  groupRecordsByUser(records: any[]) {
    const userGroups = new Map();
    records.forEach(record => {
      const key = `${record.platform}:${record.guildId}:${record.userId}`;
      if (!userGroups.has(key)) {
        userGroups.set(key, []);
      }
      userGroups.get(key).push(record);
    });
    return userGroups;
  },

  /**
   * 获取时间段的起止日期和描述标签
   * @param {string} period - 时间段参数
   * @returns {null | {label: string, startDate: string, endDate: string}} 时间段信息对象
   */
  getPeriodDates(period: string) {
    const p = String(period).toLowerCase();
    // 天数格式 (Nd)
    if (/^\d+d$/.test(p)) {
      const days = parseInt(p);
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      if (days === 1) {
        return {
          label: '昨日',
          startDate: Utils.formatDate(yesterday),
          endDate: Utils.formatDate(yesterday)
        };
      }
      const end = new Date(yesterday);
      const start = new Date(end);
      start.setDate(end.getDate() - days + 1);
      return {
        label: `近${days}天`,
        startDate: Utils.formatDate(start),
        endDate: Utils.formatDate(end)
      };
    }
    // 小时格式 (Nh)
    if (/^\d+h$/.test(p)) {
      const hours = parseInt(p);
      const now = new Date();
      const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
      return {
        label: `近${hours}小时`,
        startDate: Utils.formatDate(start, 'datetime'),
        endDate: Utils.formatDate(now, 'datetime')
      };
    }
    // 日期范围格式 (YYYY-MM-DD~YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(p)) {
      const [startDate, endDate] = p.split('~');
      return {
        label: `${startDate}至${endDate}`,
        startDate,
        endDate
      };
    }
    // 单个日期格式 (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}$/.test(p)) {
      return {
        label: p,
        startDate: p,
        endDate: p
      };
    }
    return null;
  },

  /**
   * 生成查询结果的标题
   * @param {any[]} records - 记录数组
   * @param {QueryOptions} options - 查询选项
   * @param {'command' | 'user' | 'guild'} type - 查询类型
   * @param {Record<string, string>} typeMap - 类型映射表
   * @returns {string} 生成的标题
   */
  generateTitle(records: any[], options: QueryOptions, type: 'command' | 'user' | 'guild', typeMap: Record<string, string>): string {
    // 获取用户和群组名称
    let userName = '', guildName = '';
    if (options.user) {
      const userRecord = records.find(r => r.userId === options.user && r.userName);
      userName = userRecord?.userName || '';
    }
    if (options.guild) {
      const guildRecord = records.find(r => r.guildId === options.guild && r.guildName);
      guildName = guildRecord?.guildName || '';
    }
    // 构建条件描述信息
    const conditions = Utils.buildConditions({
      user: options.user ? (userName || options.user) : null,
      guild: options.guild ? (guildName || `群组${options.guild}`) : null,
      platform: options.platform,
      command: options.command
    });
    // 生成基础标题
    let title = '';
    if (conditions.length) {
      title = `${conditions.join('、')}的${typeMap[type]}统计`;
    } else if (options.guild && type !== 'guild') {
      const guildDisplay = guildName || `群组${options.guild}`;
      title = `${guildDisplay}的${typeMap[type]}统计`;
    } else {
      title = `全局${typeMap[type]}统计`;
    }
    // 添加时间信息
    if (options.source === 'daily' && options.period) {
      const periodInfo = this.getPeriodDates(options.period);
      if (periodInfo) {
        const timeInfo = periodInfo.label;
        // 插入时间信息到标题中
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
   * @param {StatRecord[]} records - 记录数组
   * @param {keyof StatRecord} key - 要列出的键名
   * @param {string} title - 列表标题
   * @returns {string | null} 格式化后的列表文本，无内容则返回null
   */
  formatList: (records: StatRecord[], key: keyof StatRecord, title: string): string | null => {
    const uniqueKeys = [...new Set(records.map(r => r[key] as string).filter(Boolean))];
    if (key === 'command') {
      const commands = uniqueKeys.filter(cmd => cmd !== '_message');
      return commands.length ? `${title} ——\n${commands.join(',')}` : null;
    } else if (key === 'userId' || key === 'guildId') {
      const items = uniqueKeys.map(id => {
        const record = records.find(r => r[key] === id);
        const name = key === 'userId' ? record?.userName : record?.guildName;
        return name ? `${name} (${id})` : id;
      });
      return items.length ? `${title} ——\n${items.join(',')}` : null;
    }
    return uniqueKeys.length ? `${title} ——\n${uniqueKeys.join(',')}` : null;
  },

  /**
   * 注册list子命令，用于查看类型列表
   * @param {Context} ctx - Koishi上下文
   * @param {any} parent - 父命令对象
   */
  registerListCommand(ctx: Context, parent: any) {
    parent.subcommand('.list', '查看类型列表', { authority: 3 })
      .option('user', '-u 显示用户列表')
      .option('guild', '-g 显示群组列表')
      .action(async ({ options }) => {
        const records = await ctx.database.get('analytics.stat', {});
        if (!records?.length) return '未找到记录';
        const hasParams = options.user || options.guild;
        const parts: (string | null)[] = [];
        if (!hasParams) {
          parts.push(this.formatList(records, 'platform', '平台列表'));
          parts.push(this.formatList(records, 'command', '命令列表'));
        }
        if (options.user) parts.push(this.formatList(records, 'userId', '用户列表'));
        if (options.guild) parts.push(this.formatList(records, 'guildId', '群组列表'));
        return parts.filter(Boolean).join('\n');
      });
  }
}