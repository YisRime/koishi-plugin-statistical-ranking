import { Context, h } from 'koishi'
import {} from 'koishi-plugin-cron'
import { Utils } from './utils'
import { StatRecord } from './index'
import { Renderer } from './render'

/**
 * 表示排名变化数据的接口
 * @interface RankDiff
 */
interface RankDiff {
  /** 用户ID */
  userId: string
  /** 用户名称 */
  userName: string
  /** 当前计数 */
  currentCount: number
  /** 上一时段计数 */
  previousCount: number
  /** 与上一时段的差值 */
  diff: number
  /** 当前排名 */
  rank: number
  /** 上一时段的排名，可能不存在 */
  prevRank?: number
  /** 排名变化值，正值表示上升，负值表示下降 */
  rankChange?: number
}

/**
 * 排行榜配置接口
 * @interface RankConfig
 */
interface RankConfig {
  /** 更新间隔: 'hourly'(每小时), '6h'(每6小时), '12h'(每12小时), 'daily'(每天零点, 默认) */
  updateInterval?: string
  /** 不显示在排行榜中的用户ID列表 */
  displayBlacklist?: string[]
  /** 仅显示在排行榜中的用户ID列表，优先级高于黑名单 */
  displayWhitelist?: string[]
}

/**
 * 排行榜管理器类，负责生成和查询用户排名数据
 */
export class RankManager {
  private ctx: Context
  private rankConfig: {
    updateFrequency: string
    displayBlacklist: string[]
    displayWhitelist: string[]
  }

  /**
   * 构造一个排行榜管理器实例
   * @param ctx Koishi上下文
   * @param config 排行榜配置
   */
  constructor(ctx: Context, config: RankConfig = {}) {
    this.ctx = ctx

    const updateFrequencyMap = {
      'hourly': '0 * * * *',      // 每小时整点
      '6h': '0 */6 * * *',        // 每6小时
      '12h': '0 */12 * * *',      // 每12小时
      'daily': '0 0 * * *'        // 每天零点
    }

    this.rankConfig = {
      updateFrequency: updateFrequencyMap[config.updateInterval] || updateFrequencyMap.daily,
      displayBlacklist: config.displayBlacklist || [],
      displayWhitelist: config.displayWhitelist || []
    }
  }

  /**
   * 初始化排行榜功能，创建数据库模型并设置定时任务
   */
  async initialize() {
    this.ctx.model.extend('analytics.rank', {
      stat: 'unsigned',
      timestamp: 'timestamp',
      count: 'unsigned',
      delta: 'integer',
      rank: 'unsigned',
      prev: { type: 'unsigned', nullable: true }
    }, {
      primary: ['stat', 'timestamp'],
      unique: [['timestamp', 'rank']]
    })
    this.ctx.cron(this.rankConfig.updateFrequency, () => this.generateRankSnapshot())
  }

  /**
   * 生成排行榜快照，记录当前的统计数据
   * 此方法会定期由cron任务调用
   */
  async generateRankSnapshot() {
    const now = new Date()
    // 标准化为当天0点
    const formattedTimestamp = new Date(now)
    formattedTimestamp.setHours(0, 0, 0, 0)
    // 获取前一天的时间戳
    const prevTimestamp = new Date(formattedTimestamp.getTime() - 86400000)
    try {
      const records = await this.ctx.database.get('analytics.stat', { command: '_message' })
      if (!records.length) return;
      // 按群组分组并获取统计ID
      const guildGroups = new Map<string, StatRecord[]>()
      const statIdSet = new Set<number>()
      records.forEach(record => {
        if (!record.id) return
        const key = `${record.platform}:${record.guildId}`
        if (!guildGroups.has(key)) guildGroups.set(key, [])
        guildGroups.get(key).push(record)
        statIdSet.add(record.id)
      })
      // 获取上次快照记录
      const prevSnapshots = await this.ctx.database.get('analytics.rank', {
        timestamp: prevTimestamp,
        stat: { $in: Array.from(statIdSet) }
      })
      const prevSnapshotMap = new Map(prevSnapshots.map(s => [s.stat, s]))
      // 批量处理数据
      const batchUpsert = []
      for (const [, groupRecords] of guildGroups.entries()) {
        const filteredRecords = Utils.filterStatRecords(groupRecords, {
          displayWhitelist: this.rankConfig.displayWhitelist,
          displayBlacklist: this.rankConfig.displayBlacklist
        })
        if (!filteredRecords.length) continue
        [...filteredRecords]
          .sort((a, b) => b.count - a.count)
          .forEach((record, i) => {
            if (!record.id) return
            const prevSnapshot = prevSnapshotMap.get(record.id)
            batchUpsert.push({
              stat: record.id,
              timestamp: formattedTimestamp,
              count: record.count,
              delta: record.count - (prevSnapshot?.count || 0),
              rank: i + 1,
              prev: prevSnapshot?.rank || null
            })
          })
      }
      if (batchUpsert.length > 0) {
        await this.ctx.database.upsert('analytics.rank', batchUpsert)
      }
    } catch (error) {
      this.ctx.logger.error(`更新排行失败:`, error)
    }
  }

  /**
   * 获取指定群组的排行榜数据
   * @param platform 平台标识
   * @param guildId 群组ID
   * @param days 统计天数，默认为1天
   * @param limit 返回的记录数量上限，默认为10
   * @returns 排行榜差异数据数组
   */
  async getRankingData(platform: string, guildId: string, days: number = 1, limit: number = 10): Promise<RankDiff[]> {
    try {
      // 获取统计记录
      const statRecords = await this.ctx.database.get('analytics.stat', {
        platform, guildId, command: '_message'
      }, ['id', 'userId', 'userName'])
      if (!statRecords.length) return []
      const statIds = statRecords.map(r => r.id).filter(Boolean)
      if (!statIds.length) return []
      // 计算时间戳
      const currentTimestamp = new Date(new Date())
      currentTimestamp.setHours(0, 0, 0, 0)
      const previousTimestamp = new Date(currentTimestamp)
      previousTimestamp.setDate(previousTimestamp.getDate() - days)
      // 查询当前排行数据
      const currentRankData = await this.ctx.database.get('analytics.rank', {
        stat: { $in: statIds },
        timestamp: currentTimestamp
      }, {
        sort: { rank: 'asc' },
        limit
      })
      if (!currentRankData.length) return []
      // 获取上一时段数据
      const relevantStatIds = currentRankData.map(r => r.stat)
      const previousRankData = await this.ctx.database.get('analytics.rank', {
        stat: { $in: relevantStatIds },
        timestamp: previousTimestamp
      })
      const prevRankMap = new Map(previousRankData.map(r => [r.stat, r]))
      const userMap = new Map(
        statRecords
          .filter(r => relevantStatIds.includes(r.id))
          .map(r => [r.id, {
            userId: r.userId,
            userName: Utils.sanitizeString(r.userName || r.userId || '')
          }])
      )
      return currentRankData.map(record => {
        const prevRecord = prevRankMap.get(record.stat)
        const user = userMap.get(record.stat) || { userId: '', userName: '' }
        return {
          userId: user.userId,
          userName: user.userName,
          currentCount: record.count,
          previousCount: prevRecord?.count || record.count - record.delta,
          diff: record.delta,
          rank: record.rank,
          prevRank: record.prev,
          rankChange: record.prev ? record.prev - record.rank : null
        }
      })
    } catch (error) {
      this.ctx.logger.error(`获取排行出错:`, error)
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
        const { days, startDate, endDate } = this.parseTimeRange(options.time || 'd')
        const platform = options.platform || session.platform
        const guildId = options.guild || session.guildId
        if (!guildId) return '暂无数据'
        const guildName = await session.bot.getGuild?.(guildId)
          .then(guild => guild?.name || guildId)
          .catch(() => guildId)
        // 获取排行数据
        const allRankData = await this.getRankingData(platform, guildId, days, showAll ? 100 : pageSize * page)
        if (!allRankData.length) return `${guildName} 暂无数据`
        // 应用分页
        let rankData = allRankData
        if (!showAll) {
          const startIndex = (page - 1) * pageSize
          rankData = allRankData.slice(startIndex, startIndex + pageSize)
        }
        const timeRangeDesc = `${Utils.formatDateTime(startDate).split(' ')[0]} → ${Utils.formatDateTime(endDate).split(' ')[0]}`
        const maxPage = Math.ceil(allRankData.length / pageSize)
        const pageInfo = (showAll || maxPage <= 1) ? '' : `（第${page}/${maxPage}页）`
        const title = `${guildName} 发言排行${pageInfo} (${timeRangeDesc})`
        // 渲染结果
        if (options.visual && this.ctx.puppeteer) {
          try {
            const renderer = new Renderer(this.ctx)
            const buffer = await this.renderRankingImage(renderer, rankData, title)
            return h.image(buffer, 'image/png')
          } catch (error) {
            this.ctx.logger.error('图片渲染失败:', error)
          }
        }
        return this.formatRankingText(rankData, title)
      })
  }

  /**
   * 解析时间范围参数
   * @param timerange 时间范围字符串，如'd'(天),'w'(周),'m'(月)或'3d'(3天)
   * @returns 包含天数和日期范围的对象
   * @private
   */
  private parseTimeRange(timerange: string): { days: number, startDate: Date, endDate: Date } {
    const now = new Date()
    const endDate = new Date(now)
    endDate.setHours(0, 0, 0, 0)
    let days = 1
    if (['d', 'w', 'm'].includes(timerange)) {
      days = timerange === 'd' ? 1 : timerange === 'w' ? 7 : 30
    } else {
      const match = /^(\d+)([hdwmy])$/.exec(timerange)
      if (match) {
        const value = parseInt(match[1], 10)
        const unit = match[2]
        const multipliers = { h: 1/24, d: 1, w: 7, m: 30, y: 365 }
        days = Math.max(1, Math.ceil(value * (multipliers[unit] || 1)))
      }
    }
    const startDate = new Date(endDate)
    startDate.setDate(startDate.getDate() - days)
    return { days, startDate, endDate }
  }

  /**
   * 格式化排行榜数据为文本形式
   * @param data 排行榜数据
   * @param title 标题
   * @returns 格式化后的文本
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
   * 将排行榜数据渲染为图片
   * @param renderer 渲染器实例
   * @param data 排行榜数据
   * @param title 标题
   * @returns 包含图片数据的Buffer
   */
  async renderRankingImage(renderer: Renderer, data: RankDiff[], title: string): Promise<Buffer> {
    const totalMessages = data.reduce((sum, item) => sum + item.currentCount, 0)
    const totalChange = data.reduce((sum, item) => sum + item.diff, 0)
    // 构造表格行数据
    const tableRows = data.map((item, index) => {
      const bgColor = index % 2 === 0 ? '#ffffff' : 'rgba(0, 0, 0, 0.01)'
      const diffColor = item.diff > 0 ? '#4CAF50' : item.diff < 0 ? '#F44336' : '#9E9E9E'
      const diffText = item.diff > 0 ? `+${item.diff}` : item.diff.toString()
      // 排名变化样式
      let rankChangeHtml
      if (item.rankChange === null) {
        rankChangeHtml = `<span style="color:#9C27B0;">新</span>`
      } else if (item.rankChange > 0) {
        rankChangeHtml = `<span style="color:#4CAF50;">↑${item.rankChange}</span>`
      } else if (item.rankChange < 0) {
        rankChangeHtml = `<span style="color:#F44336;">↓${Math.abs(item.rankChange)}</span>`
      } else {
        rankChangeHtml = `<span style="color:#9E9E9E;">-</span>`
      }
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
    const html = `
      <div class="material-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid rgba(0,0,0,0.08); flex-wrap:nowrap;">
          <div style="display:flex; gap:8px; flex-shrink:0; margin-right:12px;">
            <div class="stat-chip">
              <span style="color:rgba(0,0,0,0.6);">总人数: </span>
              <span style="font-weight:500; margin-left:3px;">${data.length}</span>
            </div>
            <div class="stat-chip">
              <span style="color:rgba(0,0,0,0.6);">总消息: </span>
              <span style="font-weight:500; margin-left:3px;">${totalMessages}</span>
            </div>
            <div class="stat-chip">
              <span style="color:rgba(0,0,0,0.6);">变化: </span>
              <span style="font-weight:500; margin-left:3px; color:${totalChange >= 0 ? '#4CAF50' : '#F44336'};">
                ${totalChange >= 0 ? '+' : ''}${totalChange}
              </span>
            </div>
          </div>
          <h2 style="margin:0; font-size:18px; text-align:center; flex-grow:1; font-weight:500;">${title}</h2>
          <div class="stat-chip" style="color:rgba(0,0,0,0.6); margin-left:12px;">${Utils.formatDateTime(new Date())}</div>
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