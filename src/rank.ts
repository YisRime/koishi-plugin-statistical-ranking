import { Context } from 'koishi'
import { Utils } from './utils'
import { database } from './database'
import { statProcessor } from './stat'

/**
 * 日常发言记录数据结构
 */
export interface DailyRecord {
  id?: number
  platform: string
  guildId: string
  userId: string
  userName?: string
  guildName?: string
  date: string
  hour?: number
  count: number
}

/**
 * 日常统计功能模块
 */
export class DailyStats {
  private readonly cronExpression: string

  constructor(
    private ctx: Context,
    private enableAutoReset: boolean = true,
    private interval: '1h' | '6h' | '12h' | '1d' = '1d'
  ) {
    // 设置对应的 cron 表达式
    this.cronExpression = {
      '1h': '0 0 * * * *',
      '6h': '0 0 */6 * * *',
      '12h': '0 0 */12 * * *',
      '1d': '0 0 0 * * *'
    }[interval] || '0 0 0 * * *';
    if (this.enableAutoReset && typeof ctx.cron === 'function') {
      ctx.cron(this.cronExpression, this.scheduledCollect.bind(this));
    }
  }

  /**
   * 定时收集任务
   */
  async scheduledCollect() {
    const now = new Date();
    switch (this.interval) {
      case '1h': {
        const prevTime = new Date(now.getTime() - 3600000);
        return this.collectStatistics({
          dateStr: Utils.formatDate(prevTime),
          hour: prevTime.getHours(),
          isHourly: true
        });
      }
      case '6h':
      case '12h':
        return this.collectBatch(this.interval === '6h' ? 6 : 12);
      default: {
        // 收集昨天的整天数据
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        return this.collectStatistics({
          dateStr: Utils.formatDate(yesterday),
          isDaily: true
        });
      }
    }
  }

  /**
   * 批量收集多个小时的数据
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
      // 检查是否已有记录
      const existingRecords = await this.ctx.database.get('analytics.daily', { date: dateStr, hour });
      if (existingRecords.length > 0) return { success: true, count: 0 };
      // 获取所有消息记录
      const currentRecords = await this.ctx.database.get('analytics.stat', { command: '_message' });
      // 获取比较数据
      const [previousMap, oldDataMap] = await this.getPreviousData(dateStr, hour, options.isDaily);
      // 生成统计数据
      const dailyData = new Map<string, DailyRecord>();
      for (const record of currentRecords) {
        if (!this.isValidRecord(record)) continue;
        const key = `${record.platform}:${record.guildId}:${record.userId}`;
        const prevRecord = previousMap.get(key);
        const oldData = oldDataMap.get(key);
        // 计算增量
        const increment = prevRecord
          ? Math.max(0, record.count - prevRecord.count)
          : (oldData?.count || record.count);
        if (increment > 0) {
          dailyData.set(key, {
            platform: record.platform,
            guildId: record.guildId,
            userId: record.userId,
            userName: record.userName || oldData?.userName,
            guildName: record.guildName || oldData?.guildName,
            date: dateStr,
            ...(hour !== null && { hour }),
            count: increment
          });
        }
      }
      // 保存结果
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
   * 获取比较数据
   */
  private async getPreviousData(dateStr: string, hour: number | null, isDaily?: boolean) {
    const previousMap = new Map();
    const oldDataMap = new Map();
    if (isDaily) {
      // 获取前一天的daily记录和当天的stat记录
      const prevDate = new Date(dateStr);
      prevDate.setDate(prevDate.getDate() - 1);
      const prevDateStr = Utils.formatDate(prevDate);
      const [prevData, oldDayData] = await Promise.all([
        this.ctx.database.get('analytics.daily', { date: prevDateStr }),
        this.ctx.database.get('analytics.stat', {
          command: '_message',
          lastTime: {
            $gte: new Date(`${dateStr}T00:00:00`),
            $lte: new Date(`${dateStr}T23:59:59`)
          }
        }).catch(() => [])
      ]);
      prevData.forEach(r => previousMap.set(`${r.platform}:${r.guildId}:${r.userId}`, r));
      oldDayData
        .filter(r => this.isValidRecord(r))
        .forEach(r => oldDataMap.set(
          `${r.platform}:${r.guildId}:${r.userId}`,
          { count: r.count || 1, userName: r.userName, guildName: r.guildName }
        ));
    } else if (hour !== null) {
      // 获取上一个小时的记录
      let prevHour = hour - 1;
      let prevDate = new Date(dateStr);
      if (prevHour < 0) {
        prevHour = 23;
        prevDate.setDate(prevDate.getDate() - 1);
      }
      const prevRecords = await this.ctx.database.get('analytics.daily', {
        date: Utils.formatDate(prevDate),
        hour: prevHour
      });
      prevRecords.forEach(r => previousMap.set(`${r.platform}:${r.guildId}:${r.userId}`, r));
    }
    return [previousMap, oldDataMap];
  }

  /**
   * 检查记录是否有效
   */
  private isValidRecord(record: any): boolean {
    return record.platform && record.guildId && record.guildId !== 'private' && record.userId;
  }

  /**
   * 注册统计排行命令
   */
  registerCommands(parent: any) {
    return parent.subcommand('.rank [arg:string]', '查看发言排行')
      .option('visual', '-v 切换可视化模式')
      .option('platform', '-p [platform:string] 指定平台统计')
      .option('guild', '-g [guild:string] 指定群组统计')
      .option('sort', '-s [method:string] 排序方式', { fallback: 'count' })
      .option('date', '-d [period:string] 指定时期', { fallback: '1d' })
      .usage('支持格式: h时/d天/w周/m月/y年 或 YYYY-MM-DD')
      .action(async ({ session, options, args }) => {
        // 参数处理
        const arg = args[0]?.toLowerCase();
        const page = arg && /^\d+$/.test(arg) ? parseInt(arg) : 1;
        const showAll = arg === 'all';
        // 查询参数
        const queryOptions = {
          platform: options.platform,
          guild: options.guild || session?.guildId,
          period: options.date || '1d',
          source: 'daily' as 'daily'
        };
        // 查询数据
        const result = await statProcessor.handleStatQuery(this.ctx, queryOptions, 'user');
        if (typeof result === 'string') return result;
        // 处理数据
        const sortBy = options.sort === 'name' ? 'key' : 'count';
        const processed = await statProcessor.processStatRecords(result.records, 'userId', {
          sortBy, truncateId: true, source: 'daily',
          period: queryOptions.period, page, pageSize: 15,
          title: result.title, skipPaging: showAll
        });
        // 渲染处理
        const renderSuccess = await Utils.tryRenderImage(
          session, this.ctx,
          renderer => renderer.generateStatImage(
            result.records, 'userId',
            result.title.replace(' ——', ''),
            { sortBy, truncateId: true, source: 'daily',
              period: queryOptions.period, limit: 15 }
          ),
          () => processed.title + '\n' + processed.items.join('\n')
        );
        if (renderSuccess && options.visual) return;
        return processed.title + '\n' + processed.items.join('\n');
      });
  }
}