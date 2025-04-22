import { Context } from 'koishi'
import { Utils } from './utils'
import { database } from './database'

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
  count: number
}

/**
 * 排行时间段类型
 */
export type RankPeriod = 'yesterday' | 'lastweek' | 'lastmonth' | 'lastyear' | string;

/**
 * 查询排行数据的参数接口
 */
interface RankQueryParams {
  period?: RankPeriod
  platform?: string
  guildId?: string
  sortBy?: 'count' | 'name'
  page?: number
}

/**
 * 排行数据结果接口
 */
interface RankResult {
  records: DailyRecord[]
  totalCount: number
  guildName: string
  period: string
  startDate: string
  endDate: string
}

/**
 * 分页排行结果接口
 */
interface PaginatedRankResult {
  items: string[]
  title: string
  totalCount: number
  page?: number
  totalPages?: number
}

/**
 * 日常统计功能模块
 */
export class DailyStats {
  private readonly CRON_TIME: string

  constructor(
    private ctx: Context,
    private enableAutoReset: boolean = true,
    cronTime: string = '0 0 0 * * *'
  ) {
    this.CRON_TIME = cronTime
    if (this.enableAutoReset && typeof ctx.cron === 'function') {
      ctx.cron(this.CRON_TIME, this.dailyReset.bind(this))
    }
  }

  /**
   * 获取日期相关数据与记录
   */
  private async getDates(daysBack: number = 1) {
    const date = new Date()
    date.setDate(date.getDate() - daysBack)
    const dateStr = Utils.formatDate(date)
    // 获取指定日期的统计记录
    const records = await this.ctx.database.get('analytics.daily', { date: dateStr })
    return { date, dateStr, records }
  }

  /**
   * 每日重置任务 - 计算昨天的消息增量并存储
   */
  async dailyReset() {
    try {
      // 获取昨天和前天的日期
      const { dateStr: yesterdayStr, records: existingRecords } = await this.getDates(1)
      const { dateStr: dayBeforeYesterdayStr } = await this.getDates(2)
      // 已有记录则跳过
      if (existingRecords.length > 0) {
        return
      }
      // 并行获取所有需要的数据
      const [currentStatRecords, previousDailyData, oldYesterdayData] = await Promise.all([
        // 当前所有消息记录
        this.ctx.database.get('analytics.stat', { command: '_message' }),
        // 前天的daily记录
        this.ctx.database.get('analytics.daily', { date: dayBeforeYesterdayStr }),
        // 昨天基于lastTime的历史记录
        this.ctx.database.get('analytics.stat', {
          command: '_message',
          lastTime: {
            $gte: new Date(`${yesterdayStr}T00:00:00`),
            $lte: new Date(`${yesterdayStr}T23:59:59`)
          }
        }).catch(() => [])
      ])
      // 构建查询Maps
      const previousDailyMap = new Map(
        previousDailyData.map(r => [`${r.platform}:${r.guildId}:${r.userId}`, r])
      )
      const oldDataMap = new Map(
        oldYesterdayData
          .filter(r => r.platform && r.guildId && r.guildId !== 'private' && r.userId)
          .map(r => [
            `${r.platform}:${r.guildId}:${r.userId}`,
            { count: r.count || 1, userName: r.userName, guildName: r.guildName }
          ])
      )
      // 计算增量并生成记录
      const dailyData = new Map<string, DailyRecord>()
      for (const record of currentStatRecords) {
        if (!(record.platform && record.guildId && record.guildId !== 'private' && record.userId)) continue
        const key = `${record.platform}:${record.guildId}:${record.userId}`
        const prevRecord = previousDailyMap.get(key)
        const oldData = oldDataMap.get(key)
        // 计算增量: 有前天记录则比较差值，否则使用lastTime判断或全部计入
        const dailyCount = prevRecord
          ? Math.max(0, record.count - prevRecord.count)
          : (oldData ? oldData.count : record.count)
        if (dailyCount > 0) {
          dailyData.set(key, {
            platform: record.platform,
            guildId: record.guildId,
            userId: record.userId,
            userName: record.userName || oldData?.userName,
            guildName: record.guildName || oldData?.guildName,
            date: yesterdayStr,
            count: dailyCount
          })
        }
      }
      // 保存结果
      if (dailyData.size > 0) {
        await database.saveDailyRecords(this.ctx, dailyData, yesterdayStr)
      }
    } catch (e) {
      this.ctx.logger.error('日常统计: 执行每日任务失败:', e)
    }
  }

  /**
   * 手动收集指定时间段的统计数据
   * @param periodStr 时间段字符串，如 2h/3d/1w/1m/2024-06-01
   */
  async collectPeriod(periodStr: string = '1d') {
    const now = new Date();
    let start: Date, end: Date, unit: 'h' | 'd' = 'd';
    let steps = 1;
    periodStr = String(periodStr).toLowerCase();
    const match = periodStr.match(/^(\d+)([hdwmy])$/);
    if (match) {
      const num = parseInt(match[1]);
      const type = match[2];
      if (type === 'h') {
        unit = 'h';
        steps = num;
        end = new Date(now);
        start = new Date(now.getTime() - (num - 1) * 60 * 60 * 1000);
      } else {
        let days = 0;
        if (type === 'd') days = num;
        else if (type === 'w') days = num * 7;
        else if (type === 'm') days = num * 30;
        else if (type === 'y') days = num * 365;
        steps = days;
        unit = 'd';
        end = new Date(now);
        end.setDate(end.getDate() - 1);
        start = new Date(end);
        start.setDate(end.getDate() - days + 1);
      }
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(periodStr)) {
      // 指定日期
      start = new Date(periodStr);
      end = new Date(periodStr);
      steps = 1;
      unit = 'd';
    } else if (/^\d+$/.test(periodStr)) {
      // 纯数字，按天处理
      steps = parseInt(periodStr);
      unit = 'd';
      end = new Date(now);
      end.setDate(end.getDate() - 1);
      start = new Date(end);
      start.setDate(end.getDate() - steps + 1);
    } else {
      // 默认1天
      steps = 1;
      unit = 'd';
      end = new Date(now);
      end.setDate(end.getDate() - 1);
      start = new Date(end);
    }

    if (unit === 'h') {
      for (let i = 0; i < steps; i++) {
        const target = new Date(end.getTime() - i * 60 * 60 * 1000);
        const dateStr = Utils.formatDate(target, 'date');
        const hour = target.getHours();
        await this.collectHour(dateStr, hour);
      }
    } else {
      for (let i = 0; i < steps; i++) {
        const target = new Date(end);
        target.setDate(end.getDate() - i);
        const dateStr = Utils.formatDate(target, 'date');
        await this.collectDay(dateStr);
      }
    }
  }

  /**
   * 按天收集统计数据
   * @param dateStr 目标日期字符串 YYYY-MM-DD
   */
  private async collectDay(dateStr: string) {
    // 检查是否已有记录
    const existingRecords = await this.ctx.database.get('analytics.daily', { date: dateStr });
    if (existingRecords.length > 0) return;
    // 获取前一天
    const prevDate = new Date(dateStr);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = Utils.formatDate(prevDate, 'date');
    // 并行获取所有需要的数据
    const [currentStatRecords, previousDailyData, oldYesterdayData] = await Promise.all([
      this.ctx.database.get('analytics.stat', { command: '_message' }),
      this.ctx.database.get('analytics.daily', { date: prevDateStr }),
      this.ctx.database.get('analytics.stat', {
        command: '_message',
        lastTime: {
          $gte: new Date(`${dateStr}T00:00:00`),
          $lte: new Date(`${dateStr}T23:59:59`)
        }
      }).catch(() => [])
    ]);
    const previousDailyMap = new Map(
      previousDailyData.map(r => [`${r.platform}:${r.guildId}:${r.userId}`, r])
    );
    const oldDataMap = new Map(
      oldYesterdayData
        .filter(r => r.platform && r.guildId && r.guildId !== 'private' && r.userId)
        .map(r => [
          `${r.platform}:${r.guildId}:${r.userId}`,
          { count: r.count || 1, userName: r.userName, guildName: r.guildName }
        ])
    );
    const dailyData = new Map<string, DailyRecord>();
    for (const record of currentStatRecords) {
      if (!(record.platform && record.guildId && record.guildId !== 'private' && record.userId)) continue;
      const key = `${record.platform}:${record.guildId}:${record.userId}`;
      const prevRecord = previousDailyMap.get(key);
      const oldData = oldDataMap.get(key);
      const dailyCount = prevRecord
        ? Math.max(0, record.count - prevRecord.count)
        : (oldData ? oldData.count : record.count);
      if (dailyCount > 0) {
        dailyData.set(key, {
          platform: record.platform,
          guildId: record.guildId,
          userId: record.userId,
          userName: record.userName || oldData?.userName,
          guildName: record.guildName || oldData?.guildName,
          date: dateStr,
          count: dailyCount
        });
      }
    }
    if (dailyData.size > 0) {
      await database.saveDailyRecords(this.ctx, dailyData, dateStr);
    }
  }

  /**
   * 按小时收集统计数据（每小时为一条daily，date字段为YYYY-MM-DD HH）
   * @param dateStr 日期字符串 YYYY-MM-DD
   * @param hour 小时数 0-23
   */
  private async collectHour(dateStr: string, hour: number) {
    const hourStr = `${dateStr} ${String(hour).padStart(2, '0')}`;
    // 检查是否已有记录
    const existingRecords = await this.ctx.database.get('analytics.daily', { date: hourStr });
    if (existingRecords.length > 0) return;
    // 获取前一小时
    let prevHour = hour - 1, prevDate = new Date(dateStr);
    if (prevHour < 0) {
      prevHour = 23;
      prevDate.setDate(prevDate.getDate() - 1);
    }
    const prevHourStr = `${Utils.formatDate(prevDate, 'date')} ${String(prevHour).padStart(2, '0')}`;
    // 并行获取所有需要的数据
    const [currentStatRecords, previousDailyData, oldHourData] = await Promise.all([
      this.ctx.database.get('analytics.stat', { command: '_message' }),
      this.ctx.database.get('analytics.daily', { date: prevHourStr }),
      this.ctx.database.get('analytics.stat', {
        command: '_message',
        lastTime: {
          $gte: new Date(`${dateStr}T${String(hour).padStart(2, '0')}:00:00`),
          $lte: new Date(`${dateStr}T${String(hour).padStart(2, '0')}:59:59`)
        }
      }).catch(() => [])
    ]);
    const previousDailyMap = new Map(
      previousDailyData.map(r => [`${r.platform}:${r.guildId}:${r.userId}`, r])
    );
    const oldDataMap = new Map(
      oldHourData
        .filter(r => r.platform && r.guildId && r.guildId !== 'private' && r.userId)
        .map(r => [
          `${r.platform}:${r.guildId}:${r.userId}`,
          { count: r.count || 1, userName: r.userName, guildName: r.guildName }
        ])
    );
    const dailyData = new Map<string, DailyRecord>();
    for (const record of currentStatRecords) {
      if (!(record.platform && record.guildId && record.guildId !== 'private' && record.userId)) continue;
      const key = `${record.platform}:${record.guildId}:${record.userId}`;
      const prevRecord = previousDailyMap.get(key);
      const oldData = oldDataMap.get(key);
      const dailyCount = prevRecord
        ? Math.max(0, record.count - prevRecord.count)
        : (oldData ? oldData.count : record.count);
      if (dailyCount > 0) {
        dailyData.set(key, {
          platform: record.platform,
          guildId: record.guildId,
          userId: record.userId,
          userName: record.userName || oldData?.userName,
          guildName: record.guildName || oldData?.guildName,
          date: hourStr,
          count: dailyCount
        });
      }
    }
    if (dailyData.size > 0) {
      await database.saveDailyRecords(this.ctx, dailyData, hourStr);
    }
  }

  /**
   * 查询指定时间段内的排行数据
   */
  private async getRankDataByPeriod(params: RankQueryParams): Promise<RankResult> {
    let period = params.period || 'yesterday';
    const now = new Date();
    const today = new Date(now);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    let startDate = Utils.formatDate(yesterday);
    let endDate = Utils.formatDate(yesterday);
    let periodLabel = '昨日';

    // 支持 Nh/d/w/m/y 形式和 YYYY-MM-DD
    const periodStr = String(period).toLowerCase();
    const match = periodStr.match(/^(\d+)([hdwmy])$/);
    if (match) {
      const num = parseInt(match[1]);
      const unit = match[2];
      let start: Date;
      if (unit === 'h') {
        start = new Date(now.getTime() - num * 60 * 60 * 1000);
        startDate = Utils.formatDate(start);
        endDate = Utils.formatDate(now);
        periodLabel = `${num}小时内`;
      } else {
        let days = 0;
        if (unit === 'd') days = num;
        else if (unit === 'w') days = num * 7;
        else if (unit === 'm') days = num * 30;
        else if (unit === 'y') days = num * 365;
        if (days > 0 && days <= 365) {
          const customStart = new Date(today);
          customStart.setDate(today.getDate() - days);
          startDate = Utils.formatDate(customStart);
          endDate = Utils.formatDate(yesterday);
          periodLabel = `${num}${unit}内`;
        }
      }
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(periodStr)) {
      startDate = periodStr;
      endDate = periodStr;
      periodLabel = periodStr;
    } else if (/^\d+d$/.test(periodStr)) {
      // 兼容原有 d 结尾
      const days = parseInt(periodStr.replace('d', ''));
      if (days > 0 && days <= 365) {
        const customStart = new Date(today);
        customStart.setDate(today.getDate() - days);
        startDate = Utils.formatDate(customStart);
        endDate = Utils.formatDate(yesterday);
        periodLabel = `${days}天内`;
      }
    }
    // 构建查询条件
    const dateCondition = startDate === endDate
      ? { date: startDate }
      : { date: { $gte: startDate, $lte: endDate } }
    const query = {
      ...dateCondition,
      ...(params.platform && { platform: params.platform }),
      ...(params.guildId && { guildId: params.guildId })
    }
    // 查询记录
    const records = await this.ctx.database.get('analytics.daily', query)
    if (!records?.length) {
      return {
        records: [],
        totalCount: 0,
        guildName: '',
        period: periodLabel,
        startDate,
        endDate
      }
    }
    // 合并同一用户在不同日期的记录
    const userDataByKey = new Map<string, DailyRecord>()
    records.forEach(record => {
      const key = `${record.platform}:${record.guildId}:${record.userId}`
      const existing = userDataByKey.get(key)
      if (existing) {
        existing.count += record.count
      } else {
        userDataByKey.set(key, { ...record })
      }
    })
    // 转换回数组并排序
    const sortedUserData = Array.from(userDataByKey.values())
    sortedUserData.sort((a, b) => params.sortBy === 'name'
      ? (a.userName || a.userId).localeCompare(b.userName || b.userId)
      : b.count - a.count
    )
    // 获取群组信息和统计总数
    const guildName = params.guildId
      ? (records.find(r => r.guildId === params.guildId && r.guildName)?.guildName || params.guildId)
      : ''
    const totalCount = sortedUserData.reduce((sum, record) => sum + record.count, 0)
    return {
      records: sortedUserData,
      totalCount,
      guildName,
      period: periodLabel,
      startDate,
      endDate
    }
  }

  /**
   * 获取分页排行数据
   */
  async getPaginatedRank(params: RankQueryParams = {}): Promise<PaginatedRankResult> {
    // 获取数据
    const { records, totalCount, guildName, period, startDate, endDate } =
      await this.getRankDataByPeriod(params)
    if (!records.length) {
      return { items: [], title: `${period} 暂无发言记录`, totalCount: 0 }
    }
    // 处理分页
    const page = params.page || 1
    const pageSize = 15
    const totalPages = Math.ceil(records.length / pageSize)
    const currentPage = Math.min(Math.max(1, page), totalPages)
    const startIdx = (currentPage - 1) * pageSize
    const pagedRecords = records.slice(startIdx, startIdx + pageSize)
    // 格式化标题
    const dateRange = startDate === endDate ? period : `${startDate} 至 ${endDate}`
    const title = `${dateRange}${guildName ? ` ${guildName}` : ''} 发言排行${totalPages > 1 ? `（${currentPage}/${totalPages}页）` : ''} —— `
    // 格式化排行数据
    const items = pagedRecords.map((record, index) => {
      const rank = startIdx + index + 1;
      const name = Utils.formatDisplayName(record.userName || '', record.userId, true);
      const countStr = `${record.count}条`;
      // 对齐格式化
      const rankWidth = 4, nameWidth = 16, countWidth = 8;
      const rankStr = `${rank}.`;
      const rankPad = ' '.repeat(Math.max(0, rankWidth - Utils.getStringDisplayWidth(rankStr)));
      const nameTrunc = Utils.truncateByDisplayWidth(name, nameWidth);
      const namePad = ' '.repeat(Math.max(0, nameWidth - Utils.getStringDisplayWidth(nameTrunc)));
      const countPad = ' '.repeat(Math.max(0, countWidth - Utils.getStringDisplayWidth(countStr)));
      return `${rankStr}${rankPad}${nameTrunc}${namePad} ${countPad}${countStr}`;
    })
    return { items, title, totalCount, page: currentPage, totalPages }
  }

  /**
   * 注册统计排行命令
   * @param parent - 统计命令对象
   * @returns 创建的子命令对象
   */
  registerCommands(parent: any) {
    const rank = parent.subcommand('.rank [arg:string]', '查看发言排行榜')
      .option('visual', '-v 切换可视化模式')
      .option('platform', '-p [platform:string] 指定平台统计')
      .option('guild', '-g [guild:string] 指定群组统计')
      .option('sort', '-s [method:string] 排序方式(count/name)', { fallback: 'count' })
      .option('date', '-d [period:string] 指定时期（如 2h/2d/3w/1m/2024-06-01）', { fallback: '1d' })
      .usage('支持的时间段格式：Nh（N小时）、Nd（N天）、Nw（N周）、Nm（N月）、Ny（N年），或指定日期如 YYYY-MM-DD。例如：2h 表示近2小时，2d 表示近2天。')
      .action(async ({ session, options, args }) => {
        const arg = args[0]?.toLowerCase()
        let page = 1
        let showAll = false
        if (arg === 'all') {
          showAll = true
        } else if (arg && /^\d+$/.test(arg)) {
          page = parseInt(arg)
        }
        // 获取时间段参数
        const period = options.date || 'yesterday'
        const queryParams: RankQueryParams = {
          period,
          platform: options.platform,
          guildId: options.guild || session?.guildId,
          sortBy: options.sort === 'name' ? 'name' : 'count',
          page: showAll ? undefined : page
        }
        // 选择展示模式
        if (options.visual !== undefined) {
          // 尝试渲染图片
          const renderSuccess = await Utils.tryRenderImage(
            session,
            this.ctx,
            async (renderer) => {
              const data = await this.getRankDataByPeriod(queryParams);
              return await renderer.renderRankingData(data);
            },
            async () => {
              const result = await this.getPaginatedRank(queryParams)
              return result.items.length ? `${result.title}\n${result.items.join('\n')}` : result.title
            }
          );
          if (renderSuccess) return;
        }
        // 文本模式
        const result = await this.getPaginatedRank(queryParams)
        return result.items.length ? `${result.title}\n${result.items.join('\n')}` : result.title
      })
      // 只保留一个手动收集命令
      .subcommand('.collect [period:string]', '手动收集指定时间段的统计数据', { authority: 4 })
      .action(async ({ session, args }) => {
        const period = args[0] || '1d'
        await session.send(`正在收集${period}的统计数据...`)
        await this.collectPeriod(period)
        return `已完成${period}的统计数据收集`
      })
    return rank
  }
}