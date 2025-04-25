import { Context, h } from 'koishi'
import {} from 'koishi-plugin-cron'
import { Utils } from './utils'
import { StatRecord } from './index'
import { Renderer } from './render'

/**
 * 用户排名变化信息
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
 * 排行榜配置项
 */
interface RankConfig {
  updateInterval?: string
  defaultImageMode?: boolean
}

/**
 * 排行榜主类，负责排行快照生成、查询与展示
 */
export class Rank {
  private ctx: Context
  private updateCron: string
  private defaultImageMode: boolean
  private updateFrequencyHours: number

  /**
   * 构造排行榜实例
   * @param ctx Koishi 上下文
   * @param config 排行榜配置
   */
  constructor(ctx: Context, config: RankConfig = {}) {
    this.ctx = ctx
    const freq = {
      'hourly': { cron: '0 * * * *', hours: 1 },
      '6h': { cron: '0 */6 * * *', hours: 6 },
      '12h': { cron: '0 */12 * * *', hours: 12 },
      'daily': { cron: '0 0 * * *', hours: 24 }
    }[config.updateInterval] || { cron: '0 0 * * *', hours: 24 }
    this.updateCron = freq.cron
    this.updateFrequencyHours = freq.hours
    this.defaultImageMode = !!config.defaultImageMode
  }

  /**
   * 初始化排行榜表结构与定时任务
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
   * 将日期格式化为小时精度
   * @param date 输入日期
   * @returns 小时精度的日期
   */
  private formatToHourPrecision(date: Date): Date {
    const d = new Date(date)
    d.setMinutes(0, 0, 0)
    return d
  }

  /**
   * 生成当前的排行榜快照
   */
  async generateRankSnapshot() {
    const now = new Date()
    const currentTimestamp = this.formatToHourPrecision(now)
    try {
      const records = await this.ctx.database.get('analytics.stat', { command: '_message' })
      if (!records.length) return
      const guildGroups = new Map<string, StatRecord[]>()
      records.forEach(record => {
        if (!record.id) return
        const key = `${record.platform}:${record.guildId}`
        if (!guildGroups.has(key)) guildGroups.set(key, [])
        guildGroups.get(key).push(record)
      })
      const batchUpsert = []
      for (const groupRecords of guildGroups.values()) {
        groupRecords.sort((a, b) => b.count - a.count)
          .forEach((record, i) => {
            if (!record.id) return
            batchUpsert.push({ record, rank: i + 1 })
          })
      }
      if (batchUpsert.length) {
        const statIds = batchUpsert.map(item => item.record.id)
        const prevSnapshots = await this.ctx.database.get('analytics.rank', {
          stat: { $in: statIds },
          timestamp: { $lt: currentTimestamp }
        }, { sort: { timestamp: 'desc' } })
        const prevMap = new Map<number, any>()
        prevSnapshots.forEach(snap => {
          if (!prevMap.has(snap.stat) || prevMap.get(snap.stat).timestamp < snap.timestamp) {
            prevMap.set(snap.stat, snap)
          }
        })
        const filteredBatch = batchUpsert.filter(item => {
          const prev = prevMap.get(item.record.id)
          return !prev || prev.count !== item.record.count
        }).map(item => ({
          stat: item.record.id,
          timestamp: currentTimestamp,
          count: item.record.count,
          rank: item.rank
        }))
        if (filteredBatch.length) {
          const existing = await this.ctx.database.get('analytics.rank', { timestamp: currentTimestamp }, ['stat'])
          const existSet = new Set(existing.map(r => r.stat))
          const finalBatch = filteredBatch.filter(r => !existSet.has(r.stat))
          if (finalBatch.length) {
            await this.ctx.database.upsert('analytics.rank', finalBatch)
            this.ctx.logger.info(`已更新 ${finalBatch.length} 条排行记录`)
          } else {
            this.ctx.logger.info(`无需更新排行记录`)
          }
        }
      }
    } catch (error) {
      this.ctx.logger.error(`排行更新失败:`, error)
    }
  }

  /**
   * 获取指定群组在指定时间范围内的排行榜数据
   * @param platform 平台
   * @param guildId 群组ID
   * @param hours 时间范围（小时）
   * @param limit 返回条数
   * @returns 排名变化数组
   */
  async getRankingData(platform: string, guildId: string, hours = 24, limit = 10): Promise<RankDiff[]> {
    try {
      const statRecords = await this.ctx.database.get('analytics.stat', {
        platform, guildId, command: '_message'
      }, ['id', 'userId', 'userName'])
      if (!statRecords.length) return []
      const statIds = statRecords.filter(r => r.id).map(r => r.id)
      if (!statIds.length) return []
      const currentTimestamp = this.formatToHourPrecision(new Date())
      const previousTimestamp = new Date(currentTimestamp)
      previousTimestamp.setHours(previousTimestamp.getHours() - hours)
      const [currentRankData, previousRankData] = await Promise.all([
        this.ctx.database.get('analytics.rank', {
          stat: { $in: statIds },
          timestamp: { $lte: currentTimestamp }
        }, { sort: { timestamp: 'desc' } }),
        this.ctx.database.get('analytics.rank', {
          stat: { $in: statIds },
          timestamp: { $lte: previousTimestamp }
        }, { sort: { timestamp: 'desc' } })
      ])
      const latestRankMap = new Map<number, any>()
      currentRankData.forEach(r => {
        if (!latestRankMap.has(r.stat) || latestRankMap.get(r.stat).timestamp < r.timestamp)
          latestRankMap.set(r.stat, r)
      })
      const prevRankMap = new Map<number, any>()
      previousRankData.forEach(r => {
        if (!prevRankMap.has(r.stat) || prevRankMap.get(r.stat).timestamp < r.timestamp)
          prevRankMap.set(r.stat, r)
      })
      const userMap = new Map(
        statRecords.filter(r => r.id).map(r => [r.id, {
          userId: r.userId,
          userName: Utils.sanitizeString(r.userName || r.userId || '')
        }])
      )
      const intervalRankArr = []
      for (const [statId, curr] of latestRankMap.entries()) {
        const prev = prevRankMap.get(statId)
        const user = userMap.get(statId) || { userId: '', userName: '' }
        const prevCount = prev?.count ?? 0
        const intervalCount = curr.count - prevCount
        intervalRankArr.push({
          stat: statId,
          userId: user.userId,
          userName: user.userName,
          intervalCount,
          currentCount: curr.count,
          previousCount: prevCount,
          rank: 0,
          prevRank: prev?.rank,
          rankChange: prev?.rank ? prev.rank - 0 : null
        })
      }
      intervalRankArr.sort((a, b) => b.intervalCount - a.intervalCount)
      intervalRankArr.forEach((item, idx) => { item.rank = idx + 1 })
      intervalRankArr.forEach(item => {
        item.rankChange = (item.prevRank !== undefined && item.prevRank !== null)
          ? item.prevRank - item.rank : null
      })
      return intervalRankArr.filter(item => item.intervalCount > 0)
        .slice(0, limit)
        .map(item => ({
          userId: item.userId,
          userName: item.userName,
          currentCount: item.intervalCount,
          previousCount: item.previousCount,
          diff: item.intervalCount,
          rank: item.rank,
          prevRank: item.prevRank,
          rankChange: item.rankChange
        }))
    } catch (error) {
      this.ctx.logger.error(`排行获取出错:`, error)
      return []
    }
  }

  registerRankCommands(stat) {
    stat.subcommand('.rank [arg:string]', '查看发言排行')
      .option('guild', '-g [guild:string] 指定群组统计', { authority: 2 })
      .option('platform', '-p [platform:string] 指定平台统计', { authority: 2 })
      .option('time', '-t [timerange:string] 指定时间范围', { fallback: 'd' })
      .option('visual', '-v 切换可视化模式')
      .action(async ({ session, options, args }) => {
        const arg = args[0]?.toLowerCase()
        const showAll = arg === 'all'
        const page = arg && /^\d+$/.test(arg) ? parseInt(arg) : 1
        const pageSize = 15
        const minRowsForNewPage = 5
        const { hours, description } = this.parseTimeRange(options.time || 'd')
        const platform = options.platform || session.platform
        const guildId = options.guild || session.guildId
        if (!guildId) return '暂无数据'
        try {
          const guildName = await session.bot.getGuild?.(guildId)
            .then(guild => guild?.name || guildId)
            .catch(() => guildId)
          const allRankData = await this.getRankingData(platform, guildId, hours, showAll ? 100 : pageSize * (showAll ? 100 : page))
          if (!allRankData.length) return `${guildName} 暂无数据`
          let pagedRankData: RankDiff[]
          let maxPage = 1
          if (showAll) {
            pagedRankData = allRankData
          } else {
            maxPage = Math.ceil(allRankData.length / pageSize) || 1
            const validPage = Math.min(Math.max(1, page), maxPage)
            pagedRankData = allRankData.slice((validPage - 1) * pageSize, validPage * pageSize)
          }
          const pageInfo = (showAll || maxPage <= 1) ? '' : `（第${showAll ? 1 : page}/${maxPage}页）`
          const title = `${guildName}${description}发言排行${pageInfo}`
          const useImageMode = options.visual !== undefined ?
            !this.defaultImageMode : this.defaultImageMode
          if (useImageMode && this.ctx.puppeteer) {
            const renderer = new Renderer(this.ctx)
            function paginateRankData(data: RankDiff[], maxRowsPerPage = 15, minRowsForNewPage = 5): RankDiff[][] {
              if (!data.length || data.length <= maxRowsPerPage) return [data]
              const totalRows = data.length
              const normalPageCount = Math.ceil(totalRows / maxRowsPerPage)
              const lastPageRows = totalRows - (normalPageCount - 1) * maxRowsPerPage
              const actualPageCount = lastPageRows < minRowsForNewPage && normalPageCount > 1
                ? normalPageCount - 1
                : normalPageCount
              if (actualPageCount <= 1) return [data]
              const mainPageSize = Math.ceil(totalRows / actualPageCount)
              const pages: RankDiff[][] = []
              let currentIdx = 0
              for (let i = 0; i < actualPageCount; i++) {
                const pageSize = i === actualPageCount - 1
                  ? totalRows - currentIdx
                  : mainPageSize
                pages.push(data.slice(currentIdx, currentIdx + pageSize))
                currentIdx += pageSize
              }
              return pages
            }
            const pages = paginateRankData(allRankData, pageSize, minRowsForNewPage)
            const buffers: Buffer[] = []
            for (let i = 0; i < pages.length; i++) {
              const pageTitle = pages.length > 1
                ? `${guildName}${description}发言排行（第${i + 1}/${pages.length}页）`
                : title
              const buffer = await this.renderRankingImage(renderer, pages[i], pageTitle)
              buffers.push(buffer)
            }
            return buffers.length === 1
              ? h.image(buffers[0], 'image/png')
              : buffers.map(buffer => h.image(buffer, 'image/png')).join('\n')
          }
          return this.formatRankingText(pagedRankData, title)
        } catch (error) {
          this.ctx.logger.error('排行获取出错:', error)
          return '排行获取出错'
        }
      })
  }

  /**
   * 解析时间范围字符串
   * @param timerange 时间范围字符串（如 'd', '7d', 'h'）
   * @returns 小时数与描述
   */
  private parseTimeRange(timerange: string): { hours: number, description: string } {
    const hourMap = { h: 1, d: 24, w: 168, m: 720, y: 8760 }
    const descMap = { h: '近1时', d: '昨日', w: '近7天', m: '近30天', y: '近1年' }
    if (hourMap[timerange]) {
      return { hours: hourMap[timerange], description: descMap[timerange] }
    }
    const match = /^(\d+)([hdwmy])$/.exec(timerange)
    if (match) {
      const value = parseInt(match[1], 10)
      const unit = match[2]
      const hours = Math.max(1, Math.ceil(value * (hourMap[unit] || 24)))
      const unitNames = { h: '时', d: '天', w: '周', m: '月', y: '年' }
      return { hours, description: `近${value}${unitNames[unit] || '天'}` }
    }
    return { hours: 24, description: '昨日' }
  }

  /**
   * 文本格式化排行榜
   * @param data 排名数据
   * @param title 标题
   * @returns 格式化文本
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
   * @param data 排名数据
   * @param title 标题
   * @returns 图片 Buffer
   */
  async renderRankingImage(renderer: Renderer, data: RankDiff[], title: string): Promise<Buffer> {
    const totalChange = data.reduce((sum, item) => sum + item.diff, 0)
    const tableRows = data.map((item, index) => {
      const bgColor = index % 2 === 0 ? '#fff' : 'rgba(0,0,0,0.01)'
      const diffColor = item.diff > 0 ? '#4CAF50' : item.diff < 0 ? '#F44336' : '#9E9E9E'
      const diffText = item.diff > 0 ? `+${item.diff}` : item.diff.toString()
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