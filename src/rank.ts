import { Context } from 'koishi'
import { Utils } from './utils'
import { Renderer } from './render'
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
 * 日常统计功能模块
 */
export class DailyStats {
  private readonly CRON_TIME = '0 0 0 * * *'

  constructor(
    private ctx: Context,
    private enableAutoReset: boolean = true
  ) {
    if (this.enableAutoReset && typeof ctx.cron === 'function') {
      ctx.logger.info(`日常统计: 已启用自动统计 (${this.CRON_TIME})`)
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
        this.ctx.logger.info(`日常统计: ${yesterdayStr} 已有记录，跳过统计`)
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
      const dailyStats = new Map<string, DailyRecord>()
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
          dailyStats.set(key, {
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
      if (dailyStats.size > 0) {
        await database.saveDailyRecords(this.ctx, dailyStats, yesterdayStr)
      }
    } catch (e) {
      this.ctx.logger.error('日常统计: 执行每日任务失败:', e)
    }
  }

  /**
   * 查询并处理排行数据
   */
  private async fetchRankingData(options: {
    period?: RankPeriod,
    platform?: string,
    guildId?: string,
    sortBy?: 'count' | 'name'
  }) {
    const period = options.period || 'yesterday';
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    // 默认为昨天
    let startDate = Utils.formatDate(yesterday);
    let endDate = Utils.formatDate(yesterday);
    let description = '昨日';
    if (period === 'yesterday') {
      // 使用默认值
    } else if (period === 'lastweek') {
      // 上周（前7天）
      const lastWeekStart = new Date(today);
      lastWeekStart.setDate(today.getDate() - 7);
      startDate = Utils.formatDate(lastWeekStart);
      endDate = Utils.formatDate(yesterday);
      description = '上周';
    } else if (period === 'lastmonth') {
      // 上月（前30天）
      const lastMonthStart = new Date(today);
      lastMonthStart.setDate(today.getDate() - 30);
      startDate = Utils.formatDate(lastMonthStart);
      endDate = Utils.formatDate(yesterday);
      description = '上月';
    } else if (period === 'lastyear') {
      // 上年（前365天）
      const lastYearStart = new Date(today);
      lastYearStart.setDate(today.getDate() - 365);
      startDate = Utils.formatDate(lastYearStart);
      endDate = Utils.formatDate(yesterday);
      description = '上年';
    } else if (/^\d+d$/.test(period)) {
      // 指定天数
      const days = parseInt(period.replace('d', ''));
      if (days > 0 && days <= 365) {
        const customStart = new Date(today);
        customStart.setDate(today.getDate() - days);
        startDate = Utils.formatDate(customStart);
        endDate = Utils.formatDate(yesterday);
        description = `${days}天内`;
      }
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
      // 指定单日日期
      startDate = period;
      endDate = period;
      description = period;
    }
    // 构建日期条件
    const dateCondition = startDate === endDate
      ? { date: startDate }
      : { date: { $gte: startDate, $lte: endDate } }
    // 构建完整查询条件
    const query = {
      ...dateCondition,
      ...(options.platform && { platform: options.platform }),
      ...(options.guildId && { guildId: options.guildId })
    }
    // 查询记录
    const records = await this.ctx.database.get('analytics.daily', query)
    if (!records?.length) {
      return {
        records: [],
        totalCount: 0,
        guildName: '',
        period: description,
        startDate,
        endDate
      }
    }
    // 合并同一用户在不同日期的记录
    const userStats = new Map<string, DailyRecord>()
    records.forEach(record => {
      const key = `${record.platform}:${record.guildId}:${record.userId}`
      const existing = userStats.get(key)
      if (existing) {
        existing.count += record.count
      } else {
        userStats.set(key, { ...record })
      }
    })
    // 转换回数组并排序
    const mergedRecords = Array.from(userStats.values())
    mergedRecords.sort((a, b) => options.sortBy === 'name'
      ? (a.userName || a.userId).localeCompare(b.userName || b.userId)
      : b.count - a.count
    )
    // 获取群组信息和统计总数
    const guildName = options.guildId
      ? (records.find(r => r.guildId === options.guildId && r.guildName)?.guildName || options.guildId)
      : ''
    const totalCount = mergedRecords.reduce((sum, record) => sum + record.count, 0)
    return {
      records: mergedRecords,
      totalCount,
      guildName,
      period: description,
      startDate,
      endDate
    }
  }

  /**
   * 获取排行数据（分页版）
   */
  async getRanking(options: {
    platform?: string,
    guildId?: string,
    period?: RankPeriod,
    sortBy?: 'count' | 'name',
    page?: number
  } = {}) {
    // 获取数据
    const { records, totalCount, guildName, period, startDate, endDate } = await this.fetchRankingData(options)
    if (!records.length) {
      return { items: [], title: `${period} 暂无发言记录`, totalCount: 0 }
    }
    // 处理分页
    const page = options.page || 1
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
    const rank = parent.subcommand('.rank [period:string]', '查看发言排行榜')
      .option('visual', '-v 切换可视化模式')
      .option('platform', '-p [platform:string] 指定平台')
      .option('guild', '-g [guild:string] 指定群组ID')
      .option('page', '-pg [page:number] 指定页码', { fallback: 1 })
      .option('sort', '-s [method:string] 排序方式(count/name)', { fallback: 'count' })
      .usage('支持的时间段：yesterday(昨天)、lastweek(上周)、lastmonth(上月)、lastyear(上年)、30d(30天内)或YYYY-MM-DD')
      .action(async ({ session, options, args }) => {
        // 获取时间段参数
        const period = args[0] || 'yesterday'
        const queryOptions = {
          period,
          platform: options.platform,
          guildId: options.guild || session?.guildId,
          sortBy: options.sort === 'name' ? 'name' : 'count'
        }
        // 选择展示模式
        if (options.visual !== undefined) {
          // 尝试渲染图片，失败时自动回退文本模式
          const renderSuccess = await Utils.tryRenderImage(
            session,
            this.ctx,
            async (renderer) => {
              const data = await this.fetchRankingData({ ...queryOptions, sortBy: queryOptions.sortBy as 'count' | 'name' });
              return await renderer.renderRankingData(data);
            },
            async () => {
              const result = await this.getRanking({ ...queryOptions, sortBy: queryOptions.sortBy as 'name' | 'count', page: options.page })
              return result.items.length ? `${result.title}\n${result.items.join('\n')}` : result.title
            }
          );
          if (renderSuccess) return;
        }
        // 文本模式
        const result = await this.getRanking({ ...queryOptions, sortBy: queryOptions.sortBy as 'count' | 'name', page: options.page })
        return result.items.length ? `${result.title}\n${result.items.join('\n')}` : result.title
      })
    return rank
  }
}
