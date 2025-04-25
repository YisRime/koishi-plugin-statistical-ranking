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
      if (!batchUpsert.length) return
      const statIds = batchUpsert.map(item => item.record.id)
      // 只取每个statId最新的快照
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
      // 只保存有增量的记录
      const filteredBatch = batchUpsert.filter(item => {
        const prev = prevMap.get(item.record.id)
        return !prev || prev.count !== item.record.count
      }).map(item => ({
        stat: item.record.id,
        timestamp: currentTimestamp,
        count: item.record.count,
        rank: item.rank
      }))
      if (!filteredBatch.length) {
        this.ctx.logger.info(`无需更新排行记录`)
        return
      }
      const existing = await this.ctx.database.get('analytics.rank', { timestamp: currentTimestamp }, ['stat'])
      const existSet = new Set(existing.map(r => r.stat))
      const finalBatch = filteredBatch.filter(r => !existSet.has(r.stat))
      if (finalBatch.length) {
        await this.ctx.database.upsert('analytics.rank', finalBatch)
        this.ctx.logger.info(`已更新 ${finalBatch.length} 条排行记录`)
      } else {
        this.ctx.logger.info(`无需更新排行记录`)
      }
    } catch (error) {
      this.ctx.logger.error(`排行更新失败:`, error)
    }
  }

  /**
   * 获取指定群组在指定时间范围内的排行榜数据
   * @param platform 平台
   * @param guildId 群号（全局排行时为null）
   * @param hours 时间范围
   * @param limit 返回条数
   * @param global 是否全局排行
   */
  async getRankingData(platform: string, guildId: string | null, hours = 24, limit = 10, global = false): Promise<RankDiff[]> {
    try {
      const statQuery: any = { platform, command: '_message' }
      if (!global && guildId) statQuery.guildId = guildId
      const statRecords = await this.ctx.database.get('analytics.stat', statQuery, ['id', 'userId', 'userName'])
      if (!statRecords.length) return []
      const statIds = statRecords.filter(r => r.id).map(r => r.id)
      if (!statIds.length) return []
      const currentTimestamp = this.formatToHourPrecision(new Date())
      const previousTimestamp = new Date(currentTimestamp)
      previousTimestamp.setHours(previousTimestamp.getHours() - hours)
      // 获取当前和前一时间点的rank快照
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
      // 只保留每个statId最新的快照
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
      // 统计时间段内的发言增量，只显示有增量的记录
      const intervalRankArr = []
      for (const [statId, curr] of latestRankMap.entries()) {
        const prev = prevRankMap.get(statId)
        const user = userMap.get(statId) || { userId: '', userName: '' }
        const prevCount = prev?.count ?? 0
        const intervalCount = curr.count - prevCount
        if (intervalCount > 0) {
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
      }
      intervalRankArr.sort((a, b) => b.intervalCount - a.intervalCount)
      intervalRankArr.forEach((item, idx) => { item.rank = idx + 1 })
      // 只有当用户之前有发言记录时才计算排名变化，否则标记为"新"
      intervalRankArr.forEach(item => {
        item.rankChange = (item.prevRank !== undefined && item.prevRank !== null && item.previousCount > 0)
          ? item.prevRank - item.rank : null
      })
      // 只返回有增量的记录
      return intervalRankArr
        .slice(0, limit)
        .map(item => ({
          userId: item.userId,
          userName: item.userName,
          currentCount: item.currentCount,
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
      .option('guild', '-g [guild:string] 指定群组排行', { authority: 2 })
      .option('platform', '-p [platform:string] 指定平台排行', { authority: 2 })
      .option('time', '-t [timerange:string] 指定时间范围', { fallback: 'd' })
      .option('visual', '-v 切换可视化模式')
      .option('all', '-a 显示全局排行')
      .action(async ({ session, options, args }) => {
        const arg = args[0]?.toLowerCase()
        const showAll = arg === 'all' || options.all
        let page = arg && /^\d+$/.test(arg) ? parseInt(arg) : 1
        const pageSize = 15
        const minRowsForNewPage = 5
        const { hours, description } = this.parseTimeRange(options.time || 'd')
        const platform = options.platform || session.platform
        const guildId = options.all ? null : (options.guild || session.guildId)
        if (!options.all && !guildId) return '暂无数据'
        try {
          // 获取群名
          let guildName = ''
          if (guildId) {
            guildName = await session.bot.getGuild?.(guildId)
              .then(guild => guild?.name || guildId)
              .catch(() => guildId)
          }
          // 构造条件
          let title = ''
          const showPlatform = !!options.platform
          const conditions = Utils.buildConditions({
            guild: guildId ? guildName || guildId : null,
            platform: showPlatform ? platform : null,
          })
          if (conditions.length) {
            title = `${conditions.join('、')}${description}的发言排行`
          } else {
            title = `全局${description}的发言排行`
          }
          const allRankData = await this.getRankingData(platform, guildId, hours, showAll ? 1000 : 1000, !!options.all)
          if (!allRankData.length) return `${guildName || platform} 暂无数据`
          // 分页
          let pagedRankData: RankDiff[]
          let totalPages = 1
          if (showAll) {
            pagedRankData = allRankData
          } else {
            totalPages = Math.ceil(allRankData.length / pageSize) || 1
            page = Math.min(Math.max(1, page), totalPages)
            const startIdx = (page - 1) * pageSize
            pagedRankData = allRankData.slice(startIdx, startIdx + pageSize)
          }
          const pageInfo = (showAll || totalPages <= 1) ? '' : `（第${page}/${totalPages}页）`
          const finalTitle = `${title}${pageInfo}`
          const useImageMode = options.visual !== undefined ?
            !this.defaultImageMode : this.defaultImageMode
          if (useImageMode && this.ctx.puppeteer) {
            const renderer = new Renderer(this.ctx)
            const imagePages = Utils.paginateArray(allRankData)
            const buffers: Buffer[] = []
            for (let i = 0; i < imagePages.length; i++) {
              const pageTitle = imagePages.length > 1
                ? `${title}（第${i + 1}/${imagePages.length}页）`
                : title
              const buffer = await renderer.renderRankingImage(imagePages[i], pageTitle)
              buffers.push(buffer)
            }
            return buffers.length === 1
              ? h.image(buffers[0], 'image/png')
              : buffers.map(buffer => h.image(buffer, 'image/png')).join('\n')
          }
          return this.formatRankingText(pagedRankData, finalTitle)
        } catch (error) {
          this.ctx.logger.error('排行获取出错:', error)
          return '排行获取出错'
        }
      })
  }

  /**
   * 解析时间范围字符串
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
      return `${item.rank.toString().padStart(2)}. ${name}${padding} +${item.diff}条 ${rankChangeText}`
    }).join('\n')
    return `${title} ——\n${lines}`
  }
}