import { Context } from 'koishi'
import { Utils } from './utils'
import { database } from './database'
import { statProcessor } from './stat'

/**
 * 日常发言记录数据结构
 * @interface DailyRecord
 * @property {string} platform - 平台标识
 * @property {string} guildId - 群组ID
 * @property {string} userId - 用户ID
 * @property {string} [userName] - 用户名称
 * @property {string} [guildName] - 群组名称
 * @property {string} date - 记录日期，格式为YYYY-MM-DD
 * @property {number} [hour] - 小时，可选
 * @property {number} count - 计数
 * @property {number} [statId] - 统计ID
 */
export interface DailyRecord {
  platform: string
  guildId: string
  userId: string
  userName?: string
  guildName?: string
  date: string
  hour?: number
  count: number
  statId?: number
}

/**
 * 日常统计功能模块
 */
export class DailyStats {
  private readonly cronExpression: string

  /**
   * 创建日常统计实例
   * @param {Context} ctx - Koishi上下文
   * @param {boolean} enableAutoReset - 是否启用自动重置
   * @param {'1h' | '6h' | '12h' | '1d'} interval - 统计间隔
   */
  constructor(
    private ctx: Context,
    private enableAutoReset: boolean = true,
    private interval: '1h' | '6h' | '12h' | '1d' = '1d'
  ) {
    const cronMap = {
      '1h': '0 0 * * * *',
      '6h': '0 0 */6 * * *',
      '12h': '0 0 */12 * * *',
      '1d': '0 0 0 * * *'
    };
    this.cronExpression = cronMap[interval];
    if (this.enableAutoReset && typeof ctx.cron === 'function') {
      ctx.cron(this.cronExpression, this.scheduledCollect.bind(this));
    }
  }

  /**
   * 定时收集任务
   * @returns {Promise<{success: boolean, count?: number, totalCount?: number, errors?: any[]}>} 收集结果
   */
  async scheduledCollect() {
    const now = new Date();
    if (this.interval === '1h') {
      const prevTime = new Date(now.getTime() - 3600000);
      return this.collectStatistics({
        dateStr: Utils.formatDate(prevTime),
        hour: prevTime.getHours(),
        isHourly: true
      });
    }
    if (this.interval === '6h' || this.interval === '12h') {
      return this.collectBatch(this.interval === '6h' ? 6 : 12);
    }
    // 收集昨天的整天数据
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return this.collectStatistics({
      dateStr: Utils.formatDate(yesterday),
      isDaily: true
    });
  }

  /**
   * 批量收集多个小时的数据
   * @param {number} hours - 要收集的小时数
   * @returns {Promise<{success: boolean, totalCount: number, errors?: any[]}>} 收集结果
   */
  private async collectBatch(hours: number) {
    const now = new Date();
    let totalCount = 0;
    const errors = [];
    for (let i = 1; i <= hours; i++) {
      const targetTime = new Date(now.getTime() - i * 3600000);
      try {
        const result = await this.collectStatistics({
          dateStr: Utils.formatDate(targetTime),
          hour: targetTime.getHours(),
          isHourly: true
        });
        if (result.success) totalCount += result.count || 0;
        else if (result.error) errors.push(result.error);
      } catch (error) {
        errors.push(error);
      }
    }
    return {
      success: errors.length === 0,
      totalCount,
      errors: errors.length ? errors : undefined
    };
  }

  /**
   * 收集统计数据的通用方法
   * @param {Object} options - 收集选项
   * @param {string} [options.dateStr] - 日期字符串，格式为YYYY-MM-DD
   * @param {number} [options.hour] - 小时
   * @param {boolean} [options.isDaily] - 是否为日统计
   * @param {boolean} [options.isHourly] - 是否为小时统计
   * @returns {Promise<{success: boolean, count?: number, error?: any}>} 收集结果
   */
  async collectStatistics(options: {
    dateStr?: string,
    hour?: number,
    isDaily?: boolean,
    isHourly?: boolean,
  } = {}) {
    try {
      const now = new Date();
      const dateStr = options.dateStr || Utils.formatDate(now);
      const hour = options.isDaily ? null : (options.hour ?? now.getHours());
      // 获取所有消息记录
      const records = await this.ctx.database.get('analytics.stat', { command: '_message' });
      // 过滤并转换数据
      const dailyData = new Map();
      for (const record of records) {
        if (!(record.platform && record.guildId && record.guildId !== 'private' && record.userId)) continue;
        const key = `${record.platform}:${record.guildId}:${record.userId}`;
        dailyData.set(key, {
          platform: record.platform,
          guildId: record.guildId,
          userId: record.userId,
          userName: record.userName,
          guildName: record.guildName,
          date: dateStr,
          ...(hour !== null && { hour }),
          count: record.count
        });
      }
      if (dailyData.size > 0) {
        const result = await database.saveDailyRecords(this.ctx, dailyData, dateStr, hour);
        return { success: true, count: result.savedCount };
      }
      return { success: true, count: 0 };
    } catch (error) {
      this.ctx.logger.error('收集统计数据失败:', error);
      return { success: false, error };
    }
  }

  /**
   * 处理daily记录，计算差值并支持各种时间过滤
   * @param {any[]} records - 要处理的记录数组
   * @param {string} [period] - 时间周期，例如 "24h"
   * @returns {any[]} 处理后的记录数组
   */
  processDailyRecords(records: any[], period?: string) {
    if (!records.length) return [];
    // 辅助函数
    const createDateTime = (record) => new Date(`${record.date}T${record.hour || 0}:00:00`);
    const getUserKey = (record) => `${record.platform}:${record.guildId}:${record.userId}`;
    // 按用户分组记录
    const groupByUser = (records) => {
      const groups = new Map();
      records.forEach(record => {
        const key = getUserKey(record);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
      });
      return groups;
    };
    // 处理小时级别查询
    if (period && /^\d+h$/.test(period)) {
      const hours = parseInt(period.match(/\d+/)[0]);
      const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
      // 按时间排序
      records.sort((a, b) => createDateTime(a).getTime() - createDateTime(b).getTime());
      const userGroups = groupByUser(records);
      const result = [];
      userGroups.forEach(userRecords => {
        userRecords.sort((a, b) => createDateTime(a).getTime() - createDateTime(b).getTime());
        userRecords.forEach((record, i) => {
          if (createDateTime(record) < cutoffTime) return;
          if (i === 0) {
            result.push({ ...record });
          } else {
            const increment = Math.max(0, record.count - userRecords[i-1].count);
            if (increment > 0) {
              result.push({ ...record, count: increment });
            }
          }
        });
      });
      return result;
    }
    // 按日期和小时排序
    records.sort((a, b) => {
      const dateComp = a.date.localeCompare(b.date);
      return dateComp !== 0 ? dateComp : (a.hour ?? -1) - (b.hour ?? -1);
    });
    const userGroups = groupByUser(records);
    const result = [];
    userGroups.forEach(userRecords => {
      // 单条记录直接添加
      if (userRecords.length === 1) {
        result.push({ ...userRecords[0] });
        return;
      }
      // 按日期分组
      const dateGroups = new Map();
      userRecords.forEach(record => {
        if (!dateGroups.has(record.date)) dateGroups.set(record.date, []);
        dateGroups.get(record.date).push(record);
      });
      dateGroups.forEach(dateRecords => {
        // 按小时排序
        dateRecords.sort((a, b) => (a.hour ?? -1) - (b.hour ?? -1));
        // 第一条记录直接添加
        result.push({ ...dateRecords[0] });
        // 后续记录计算增量
        for (let i = 1; i < dateRecords.length; i++) {
          const increment = Math.max(0, dateRecords[i].count - dateRecords[i-1].count);
          if (increment > 0) {
            result.push({ ...dateRecords[i], count: increment });
          }
        }
      });
    });
    return result;
  }

  /**
   * 注册统计排行命令
   * @param {any} parent - 父命令
   * @returns {any} 注册的命令实例
   */
  registerCommands(parent: any) {
    return parent.subcommand('.rank [arg:string]', '查看发言排行')
      .option('visual', '-v 切换可视化模式')
      .option('platform', '-p [platform:string] 指定平台统计')
      .option('guild', '-g [guild:string] 指定群组统计')
      .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
      .option('date', '-d [period:string] 指定时期', { fallback: '1d' })
      .option('detail', '-D 显示详细信息')
      .usage('支持格式: [数字]h时/d天/w周/m月 或 YYYY-MM-DD 或 YYYY-MM-DD~YYYY-MM-DD')
      .action(async ({ session, options, args }) => {
        const arg = args[0]?.toLowerCase();
        const page = /^\d+$/.test(arg || '') ? parseInt(arg) : 1;
        const showAll = arg === 'all';
        // 查询参数
        const queryOptions = {
          platform: options.platform,
          guild: options.guild || session?.guildId,
          period: options.date || '1d',
          source: 'daily' as 'daily',
          isRanking: true
        };
        // 查询数据
        const result = await statProcessor.handleStatQuery(this.ctx, queryOptions, 'user');
        if (typeof result === 'string') return result;
        // 排序方式
        const sortBy = options.sort === 'name' ? 'key' :
                       options.sort === 'time' ? 'time' : 'count';
        // 处理记录
        const processed = await statProcessor.processStatRecords(result.records, 'userId', {
          sortBy,
          truncateId: true,
          source: 'daily',
          period: queryOptions.period,
          page,
          pageSize: 15,
          title: result.title,
          skipPaging: showAll,
          isRanking: true
        });
        // 渲染模式
        const defaultImageMode = this.ctx.config?.['statistical-ranking']?.defaultImageMode || false;
        const useImageMode = options.visual ? !defaultImageMode : defaultImageMode;
        // 详细信息
        let detailInfo = '';
        if (options.detail && result.rankingData) {
          const { rankingData } = result;
          detailInfo = [
            `\n统计时段: ${rankingData.period}`,
            rankingData.startDate && `\n开始日期: ${rankingData.startDate}`,
            rankingData.endDate && `\n结束日期: ${rankingData.endDate}`,
            `\n总发言量: ${rankingData.totalCount}条`
          ].filter(Boolean).join('');
        }
        // 渲染结果
        const textResult = processed.title + '\n' + processed.items.join('\n') + detailInfo;
        // 尝试渲染图片
        if (useImageMode) {
          const renderSuccess = await Utils.tryRenderImage(
            session,
            this.ctx,
            async (renderer) => {
              return renderer.generateStatImage(
                result.records,
                'userId',
                // 移除标题中的后缀，使其更适合显示在图片中
                result.title.replace(' ——', ''),
                {
                  sortBy,
                  truncateId: true,
                  // 确保传递排行榜需要的特殊参数
                  source: 'daily',
                  period: queryOptions.period,
                  limit: showAll ? undefined : 15,
                  isRanking: true
                }
              );
            },
            () => textResult
          );
          if (renderSuccess) return;
        }
        return textResult;
      });
  }
}