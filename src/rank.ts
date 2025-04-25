import { Context, h } from 'koishi'
import {} from 'koishi-plugin-cron'
import { Utils } from './utils'
import { StatRecord } from './index'
import { Renderer } from './render'

/**
 * 排名变化数据接口
 */
interface RankDiff {
  userId: string
  userName: string
  currentCount: number
  previousCount: number
  diff: number
  rank: number
  prevRank?: number
  rankChange?: number
}

/**
 * 排行榜配置接口
 */
interface RankConfig {
  updateInterval?: string
  defaultImageMode?: boolean
}

/**
 * 排行榜管理器类
 */
export class Rank {
  private ctx: Context
  private updateCron: string
  private defaultImageMode: boolean
  private updateFrequencyHours: number

  /**
   * 构造排行榜管理器
   * @param ctx Koishi 上下文
   * @param config 排行榜配置
   */
  constructor(ctx: Context, config: RankConfig = {}) {
    this.ctx = ctx

    const updateFrequencyMap = {
      'hourly': { cron: '0 * * * *', hours: 1 },
      '6h': { cron: '0 */6 * * *', hours: 6 },
      '12h': { cron: '0 */12 * * *', hours: 12 },
      'daily': { cron: '0 0 * * *', hours: 24 }
    }

    const frequency = updateFrequencyMap[config.updateInterval] || updateFrequencyMap.daily
    this.updateCron = frequency.cron
    this.updateFrequencyHours = frequency.hours
    this.defaultImageMode = config.defaultImageMode || false
  }

  /**
   * 初始化排行榜功能，扩展数据表并注册定时任务
   */
  async initialize() {
    this.ctx.model.extend('analytics.rank', {
      id: 'unsigned',
      stat: 'unsigned',
      timestamp: 'timestamp',
      count: 'unsigned',
      rank: 'unsigned'
    }, {
      primary: 'id',
      autoInc: true,
      unique: [['stat', 'timestamp']]
    })

    this.ctx.cron(this.updateCron, () => this.generateRankSnapshot())
    await this.generateRankSnapshot()
  }

  /**
   * 格式化日期到小时粒度
   * @param date 原始日期
   * @returns 格式化后的日期
   */
  private formatToHourPrecision(date: Date): Date {
    const formatted = new Date(date)
    formatted.setMinutes(0, 0, 0)
    return formatted
  }

  /**
   * 生成排行榜快照，记录当前各群组的发言排行
   */
  async generateRankSnapshot() {
    const now = new Date()
    this.ctx.logger.info(`开始生成快照: ${now.toISOString()}`)
    // 准备当前时间戳
    const currentTimestamp = this.formatToHourPrecision(now)
    try {
      // 获取发言记录
      const records = await this.ctx.database.get('analytics.stat', { command: '_message' })
      if (!records.length) return
      // 按群组分组并收集ID
      const guildGroups = new Map<string, StatRecord[]>()
      const statIdSet = new Set<number>()
      records.forEach(record => {
        if (!record.id) return
        const key = `${record.platform}:${record.guildId}`
        if (!guildGroups.has(key)) guildGroups.set(key, [])
        guildGroups.get(key).push(record)
        statIdSet.add(record.id)
      })
      const batchUpsert = []
      // 为每个群组生成排名记录
      for (const [, groupRecords] of guildGroups.entries()) {
        if (!groupRecords.length) continue
        groupRecords
          .sort((a, b) => b.count - a.count)
          .forEach((record, i) => {
            if (!record.id) return
            // 确保首次数据也被记录
            batchUpsert.push({
              stat: record.id,
              timestamp: currentTimestamp,
              count: record.count,
              rank: i + 1
            })
          })
      }
      if (batchUpsert.length > 0) {
        // 避免唯一性冲突
        const existingRecords = await this.ctx.database.get('analytics.rank', {
          timestamp: currentTimestamp
        }, ['stat'])
        const existingMap = new Set(existingRecords.map(r => r.stat))
        const filteredBatch = batchUpsert.filter(record => !existingMap.has(record.stat))
        if (filteredBatch.length > 0) {
          await this.ctx.database.upsert('analytics.rank', filteredBatch)
          this.ctx.logger.info(`已更新 ${filteredBatch.length} 条排行记录`)
        } else {
          this.ctx.logger.info(`无需更新排行记录`)
        }
      }
    } catch (error) {
      this.ctx.logger.error(`排行更新失败:`, error)
    }
  }

  /**
   * 获取指定群组的排行榜数据
   * @param platform 平台名
   * @param guildId 群组ID
   * @param hours 查询时间范围（小时）
   * @param limit 返回条数限制
   * @returns 排名变化数据数组
   */
  async getRankingData(platform: string, guildId: string, hours: number = 24, limit: number = 10): Promise<RankDiff[]> {
    try {
      // 获取统计记录
      const statRecords = await this.ctx.database.get('analytics.stat', {
        platform, guildId, command: '_message'
      }, ['id', 'userId', 'userName'])
      if (!statRecords.length) return []
      const statIds = statRecords.filter(r => r.id).map(r => r.id)
      if (!statIds.length) return []
      // 计算时间戳
      const currentTimestamp = this.formatToHourPrecision(new Date())
      const previousTimestamp = new Date(currentTimestamp)
      previousTimestamp.setHours(previousTimestamp.getHours() - hours)
      // 查询当前排行数据
      const currentRankData = await this.ctx.database.get('analytics.rank', {
        stat: { $in: statIds },
        timestamp: { $lte: currentTimestamp }
      }, {
        sort: { timestamp: 'desc', rank: 'asc' },
      })
      if (!currentRankData.length) return []
      // 按统计ID分组并获取最新记录
      const latestRankMap = new Map<number, any>()
      currentRankData.forEach(record => {
        if (!latestRankMap.has(record.stat) ||
            latestRankMap.get(record.stat).timestamp < record.timestamp) {
          latestRankMap.set(record.stat, record)
        }
      })
      // 只取最新的记录并排序
      const latestRanks = Array.from(latestRankMap.values())
        .sort((a, b) => a.rank - b.rank)
        .slice(0, limit)
      // 获取上一个周期的数据
      const relevantStatIds = latestRanks.map(r => r.stat)
      const prevTimestamp = new Date(previousTimestamp)
      prevTimestamp.setHours(prevTimestamp.getHours() - hours)
      const previousRankData = await this.ctx.database.get('analytics.rank', {
        stat: { $in: relevantStatIds },
        timestamp: { $lte: previousTimestamp }
      }, {
        sort: { timestamp: 'desc' }
      })
      // 创建映射
      const prevRankMap = new Map<number, any>()
      previousRankData.forEach(record => {
        if (!prevRankMap.has(record.stat) ||
            prevRankMap.get(record.stat).timestamp < record.timestamp) {
          prevRankMap.set(record.stat, record)
        }
      })
      const userMap = new Map(
        statRecords
          .filter(r => r.id && relevantStatIds.includes(r.id))
          .map(r => [r.id, {
            userId: r.userId,
            userName: Utils.sanitizeString(r.userName || r.userId || '')
          }])
      )
      // 生成结果
      return latestRanks.map(record => {
        const prevRecord = prevRankMap.get(record.stat)
        const user = userMap.get(record.stat) || { userId: '', userName: '' }
        const previousCount = prevRecord?.count ?? 0
        return {
          userId: user.userId,
          userName: user.userName,
          currentCount: record.count,
          previousCount,
          diff: record.count - previousCount,
          rank: record.rank,
          prevRank: prevRecord?.rank,
          rankChange: prevRecord?.rank ? prevRecord.rank - record.rank : null
        }
      })
    } catch (error) {
      this.ctx.logger.error(`排行获取出错:`, error)
      return []
    }
  }

  /**
   * 注册排行榜相关命令
   * @param stat 统计命令对象
   */
  registerRankCommands(stat) {
    stat.subcommand('.rank [arg:string]', '查看发言排行')
      .option('guild', '-g [guild:string] 指定群组统计', { authority: 2 })
      .option('platform', '-p [platform:string] 指定平台统计', { authority: 2 })
      .option('time', '-t [timerange:string] 指定时间范围', { fallback: 'd' })
      .option('visual', '-v 切换可视化模式')
      .action(async ({ session, options, args }) => {
        // 解析参数
        const arg = args[0]?.toLowerCase()
        const showAll = arg === 'all'
        const page = arg && /^\d+$/.test(arg) ? parseInt(arg) : 1
        const pageSize = 10
        // 解析时间范围
        const { hours, description } = this.parseTimeRange(options.time || 'd')
        const platform = options.platform || session.platform
        const guildId = options.guild || session.guildId
        if (!guildId) return '暂无数据'
        try {
          // 获取群组名称
          const guildName = await session.bot.getGuild?.(guildId)
            .then(guild => guild?.name || guildId)
            .catch(() => guildId)
          // 获取排行数据
          const allRankData = await this.getRankingData(platform, guildId, hours, showAll ? 100 : pageSize * page)
          if (!allRankData.length) return `${guildName} 暂无数据`
          // 应用分页
          const rankData = !showAll ? allRankData.slice((page - 1) * pageSize, page * pageSize) : allRankData
          // 生成标题
          const maxPage = Math.ceil(allRankData.length / pageSize)
          const pageInfo = (showAll || maxPage <= 1) ? '' : `（第${page}/${maxPage}页）`
          const title = `${guildName}${description}发言排行${pageInfo}`
          // 确定是否使用图片模式
          const useImageMode = options.visual !== undefined ?
            !this.defaultImageMode : this.defaultImageMode
          // 渲染结果
          if (useImageMode && this.ctx.puppeteer) {
            const renderer = new Renderer(this.ctx)
            const buffer = await this.renderRankingImage(renderer, rankData, title)
            return h.image(buffer, 'image/png')
          }
          return this.formatRankingText(rankData, title)
        } catch (error) {
          this.ctx.logger.error('排行获取出错:', error)
          return '排行获取出错'
        }
      })
  }

  /**
   * 解析时间范围参数
   * @param timerange 时间范围字符串
   * @returns 小时数与描述
   */
  private parseTimeRange(timerange: string): { hours: number, description: string } {
    const hourMap = { h: 1, d: 24, w: 24 * 7, m: 24 * 30, y: 24 * 365 }
    const descMap = { h: '近1时', d: '昨日', w: '近7天', m: '近30天', y: '近1年' }
    if (['h', 'd', 'w', 'm', 'y'].includes(timerange)) {
      return {
        hours: hourMap[timerange],
        description: descMap[timerange]
      }
    }
    const match = /^(\d+)([hdwmy])$/.exec(timerange)
    if (match) {
      const value = parseInt(match[1], 10)
      const unit = match[2]
      const hours = Math.max(1, Math.ceil(value * (hourMap[unit] || 24)))
      const unitNames = { h: '时', d: '天', w: '周', m: '月', y: '年' }
      return {
        hours,
        description: `近${value}${unitNames[unit] || '天'}`
      }
    }
    return { hours: 24, description: '昨日' }
  }

  /**
   * 格式化排行榜数据为文本
   * @param data 排名变化数据
   * @param title 标题
   * @returns 文本格式排行榜
   */
  formatRankingText(data: RankDiff[], title: string): string {
    if (!data.length) return `${title}\n暂无数据`
    const lines = data.map(item => {
      const rankChangeText =
        item.rankChange === null ? '新' :
        item.rankChange > 0 ? `↑${item.rankChange}` :
        item.rankChange < 0 ? `↓${Math.abs(item.rankChange)}` : '-'
      const nameWidth = 15
      const name = Utils.truncateByDisplayWidth(item.userName, nameWidth)
      const padding = ' '.repeat(Math.max(0, nameWidth - Utils.getStringDisplayWidth(name)))
      return `${item.rank.toString().padStart(2)}. ${name}${padding} ${item.diff >= 0 ? '+' : ''}${item.diff}条 ${rankChangeText}`
    }).join('\n')
    return `${title} ——\n${lines}`
  }

  /**
   * 渲染排行榜图片
   * @param renderer 渲染器实例
   * @param data 排名变化数据
   * @param title 标题
   * @returns 图片 Buffer
   */
  async renderRankingImage(renderer: Renderer, data: RankDiff[], title: string): Promise<Buffer> {
    const totalChange = data.reduce((sum, item) => sum + item.diff, 0)
    // 生成表格行
    const tableRows = data.map((item, index) => {
      const bgColor = index % 2 === 0 ? '#ffffff' : 'rgba(0, 0, 0, 0.01)'
      const diffColor = item.diff > 0 ? '#4CAF50' : item.diff < 0 ? '#F44336' : '#9E9E9E'
      const diffText = item.diff > 0 ? `+${item.diff}` : item.diff.toString()
      // 排名变化样式
      const rankChangeHtml =
        item.rankChange === null ? `<span style="color:#9C27B0;">新</span>` :
        item.rankChange > 0 ? `<span style="color:#4CAF50;">↑${item.rankChange}</span>` :
        item.rankChange < 0 ? `<span style="color:#F44336;">↓${Math.abs(item.rankChange)}</span>` :
        `<span style="color:#9E9E9E;">-</span>`;
      return `
        <tr style="background-color:${bgColor};">
          <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:center;">${item.rank}</td>
          <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04);">${Utils.truncateByDisplayWidth(item.userName, 18)}</td>
          <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:right; white-space:nowrap;">${item.currentCount}</td>
          <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:right; white-space:nowrap; color:${diffColor};">${diffText}</td>
          <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:center; white-space:nowrap;">${rankChangeHtml}</td>
        </tr>
      `
    }).join('')
    // 生成完整HTML
    const html = `
      <div class="material-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid rgba(0,0,0,0.08); flex-wrap:nowrap;">
          <div class="stat-chip">
            <span style="color:rgba(0,0,0,0.6);">总计: </span>
            <span style="font-weight:500; margin-left:3px;">${data.length}人 / </span>
            <span style="font-weight:500; margin-left:3px; color:${totalChange >= 0 ? '#4CAF50' : '#F44336'};">
              ${totalChange >= 0 ? '+' : ''}${totalChange}条
            </span>
          </div>
          <h2 style="margin:0; font-size:18px; text-align:center; flex-grow:1; font-weight:500;">${title}</h2>
          <div class="stat-chip" style="color:rgba(0,0,0,0.6);">${Utils.formatDateTime(new Date())}</div>
        </div>
        <div class="table-container">
          <table class="stat-table" style="width:100%; border-collapse:separate; border-spacing:0; background:white;">
            <thead>
              <tr style="background:#2196F3;">
                <th style="text-align:center; border-radius:6px 0 0 0; padding:8px 12px; width:60px;">排名</th>
                <th style="text-align:left; padding:8px 12px;">用户</th>
                <th style="text-align:right; white-space:nowrap; padding:8px 12px;">消息数</th>
                <th style="text-align:right; white-space:nowrap; padding:8px 12px;">变化</th>
                <th style="text-align:center; white-space:nowrap; border-radius:0 6px 0 0; padding:8px 12px; width:80px;">排名变化</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </div>
    `
    return await renderer.htmlToImage(html)
  }
}