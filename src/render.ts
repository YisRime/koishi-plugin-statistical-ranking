import { Context } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import { StatProcessOptions } from './stat'
import { StatRecord } from './index'
import { Utils } from './utils'

export class Renderer {
  private ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  /**
   * 将HTML内容转换为图片
   * @param {string} html - 要渲染的HTML内容
   * @param {Object} options - 渲染选项
   * @param {number} [options.width] - 图片宽度
   * @returns {Promise<Buffer>} 图片Buffer数据
   */
  async htmlToImage(html: string): Promise<Buffer> {
    let page = null
    try {
      page = await this.ctx.puppeteer.page()
      await page.setViewport({ width: 720, height: 1080, deviceScaleFactor: 2.0 })
      await page.setDefaultNavigationTimeout(30000)
      await page.setDefaultTimeout(30000)
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { margin: 0; padding: 0; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; background: transparent; color: rgba(0, 0, 0, 0.87); font-size: 14px; line-height: 1.4; -webkit-font-smoothing: antialiased; }
              table { width: 100%; table-layout: auto; border-collapse: separate; border-spacing: 0; overflow: hidden; }
              h2, h3 { margin: 0; letter-spacing: 0.5px; font-weight: 500; }
              .material-card { border-radius: 10px; overflow: hidden; background-color: #fff; box-shadow: 0 2px 4px -1px rgba(0,0,0,0.2), 0 4px 5px 0 rgba(0,0,0,0.14), 0 1px 10px 0 rgba(0,0,0,0.12); margin: 4px; padding: 12px; }
              .stat-chip { padding: 0 10px; height: 28px; display: inline-flex; align-items: center; border-radius: 14px; font-size: 14px; line-height: 28px; background-color: rgba(0, 0, 0, 0.06); color: rgba(0, 0, 0, 0.87); white-space: nowrap; }
              .stat-table th { font-weight: 500; color: white; padding: 8px 12px; position: sticky; top: 0; box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
              .stat-table td { padding: 6px 12px; border-bottom: 1px solid rgba(0, 0, 0, 0.04); position: relative; }
              .highlight-row td { background-color: rgba(33, 150, 243, 0.03); font-weight: 500; }
              .table-container { border-radius: 8px; overflow: hidden; border: 1px solid rgba(0, 0, 0, 0.06); }
            </style>
          </head>
          <body>${html}</body>
        </html>
      `, { waitUntil: 'networkidle0' })
      const dimensions = await page.evaluate(() => {
        const contentWidth = Math.max(
          document.body.scrollWidth, document.body.offsetWidth,
          document.documentElement.clientWidth, document.documentElement.scrollWidth,
          document.documentElement.offsetWidth
        );
        const contentHeight = document.body.scrollHeight;
        return { width: contentWidth, height: contentHeight };
      });
      await page.setViewport({ width: dimensions.width, height: dimensions.height, deviceScaleFactor: 2.0 });
      await page.evaluate(() => {
        const imgPromises = Array.from(document.querySelectorAll('img'))
          .map(img => img.complete ? Promise.resolve() :
               new Promise(resolve => {
                 img.addEventListener('load', resolve);
                 img.addEventListener('error', resolve);
               }));
        return Promise.all(imgPromises);
      });
      return await page.screenshot({ type: 'png', fullPage: true, omitBackground: true });
    } catch (error) {
      this.ctx.logger.error('图片渲染出错:', error)
      throw new Error(`图片渲染出错: ${error.message || '未知错误'}`)
    } finally {
      if (page) await page.close().catch(() => {})
    }
  }

  /**
   * 将统计记录转换为图表数据
   * @param {StatRecord[]} records - 统计记录数组
   * @param {keyof StatRecord} key - 统计键名
   * @param {StatProcessOptions} options - 处理选项
   * @returns {Array<{name: string, value: number, time: string, rawTime: Date}>} 转换后的图表数据
   */
  recordsToChartData(records: StatRecord[], key: keyof StatRecord, options: StatProcessOptions = {}): Array<{name: string, value: number, time: string, rawTime: Date}> {
    const { sortBy = 'count', disableCommandMerge = false, truncateId = false,
            displayBlacklist = [], displayWhitelist = [] } = options;
    const filteredRecords = Utils.filterStatRecords(records, {
      keyField: key as string, displayWhitelist, displayBlacklist, disableCommandMerge
    });
    const keyFormatter = (key === 'command' && !disableCommandMerge) ? (k: string) => k?.split('.')[0] : undefined;
    const dataMap = Utils.generateStatsMap(filteredRecords, key as string, keyFormatter);
    let chartData = Array.from(dataMap.entries()).map(([key, data]) => ({
      name: Utils.formatDisplayName(data.displayName, key, truncateId),
      value: data.count, time: Utils.formatTimeAgo(data.lastTime), rawTime: data.lastTime
    }));
    // 排序
    chartData.sort((a, b) => {
      if (sortBy === 'count') return b.value - a.value;
      if (sortBy === 'time') return b.rawTime.getTime() - a.rawTime.getTime();
      return a.name.localeCompare(b.name);
    });
    return chartData;
  }

  /**
   * 生成统计数据的图片
   * @param {StatRecord[]} records - 统计记录数组
   * @param {keyof StatRecord} key - 统计键名
   * @param {string} title - 图表标题
   * @param {StatProcessOptions} options - 处理选项
   * @returns {Promise<Buffer[]>} 生成的图片Buffer数组
   */
  async generateStatImage(records: StatRecord[], key: keyof StatRecord, title: string, options: StatProcessOptions = {}): Promise<Buffer[]> {
    const chartData = this.recordsToChartData(records, key, options);
    const headerColor = key === 'userId' ? '#9C27B0' : key === 'guildId' ? '#4CAF50' : '#2196F3';
    const pages = Utils.paginateArray(chartData);
    const results: Buffer[] = [];
    const currentTime = Utils.formatDateTime(new Date());
    const totalItems = chartData.length;
    const totalCount = chartData.reduce((sum, item) => sum + item.value, 0);
    for (let i = 0; i < pages.length; i++) {
      const pageData = pages[i];
      const pageTitle = pages.length > 1 ? `${title} (${i+1}/${pages.length})` : title;
      const html = `
        <div class="material-card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid rgba(0,0,0,0.08); flex-wrap:nowrap;">
            <div style="display:flex; gap:8px; flex-shrink:0; margin-right:12px;">
              <div class="stat-chip">
                <span style="color:rgba(0,0,0,0.6);">总计: </span>
                <span style="font-weight:500; margin-left:3px;">${totalItems}</span>
              </div>
              <div class="stat-chip">
                <span style="color:rgba(0,0,0,0.6);">总${key === 'command' ? '次数' : '条数'}: </span>
                <span style="font-weight:500; margin-left:3px;">${totalCount}</span>
              </div>
            </div>
            <h2 style="margin:0; font-size:18px; text-align:center; flex-grow:1; font-weight:500;">${pageTitle}</h2>
            <div class="stat-chip" style="color:rgba(0,0,0,0.6); margin-left:12px;">${currentTime}</div>
          </div>
          ${this.generateTableHTML(pageData, key, headerColor)}
        </div>
      `;
      results.push(await this.htmlToImage(html));
    }
    return results;
  }

  /**
   * 生成综合统计图，将用户的所有统计信息整合到一张图中
   * @param {Array<{records: StatRecord[], title: string, key: keyof StatRecord, options?: StatProcessOptions}>} datasets - 多个数据集
   * @param {string} mainTitle - 主标题
   * @returns {Promise<Buffer[]>} 生成的图片Buffer数组
   */
  async generateCombinedStatImage(
    datasets: Array<{records: StatRecord[], title: string, key: keyof StatRecord, options?: StatProcessOptions}>,
    mainTitle: string
  ): Promise<Buffer[]> {
    const processedDatasets = datasets.map(dataset => {
      if (!dataset.records.length) return { chartData: [], key: dataset.key, title: dataset.title, headerColor: '', totalItems: 0, totalCount: 0 };
      const chartData = this.recordsToChartData(dataset.records, dataset.key, dataset.options);
      const headerColor =
        dataset.key === 'userId' ? '#9C27B0' :
        dataset.key === 'guildId' ? '#4CAF50' :
        '#2196F3';
      const totalItems = chartData.length;
      const totalCount = chartData.reduce((sum, item) => sum + item.value, 0);
      return { chartData, key: dataset.key, title: dataset.title, headerColor, totalItems, totalCount };
    }).filter(d => d.chartData.length > 0);
    if (processedDatasets.length === 0)
      return [await this.htmlToImage(`<div style="padding:24px; text-align:center;">没有数据</div>`)];
    let totalRows = processedDatasets.reduce((sum, dataset) => sum + dataset.chartData.length, 0);
    const currentTime = Utils.formatDateTime(new Date());
    // 少于200行，一页显示所有内容
    if (totalRows <= 200) {
      const tablesHTML = processedDatasets.map((dataset, index) => {
        const isLastDataset = index === processedDatasets.length - 1;
        return `
          <div style="margin-bottom:${isLastDataset ? '0' : '16px'};">
            <div style="display:flex; align-items:center; margin:8px 0; flex-wrap:nowrap;">
              <div style="display:flex; gap:8px; flex-shrink:0; margin-right:12px;">
                <div class="stat-chip">
                  <span style="color:rgba(0,0,0,0.6);">总计: </span>
                  <span style="font-weight:500; margin-left:3px;">${dataset.totalItems}</span>
                </div>
                <div class="stat-chip">
                  <span style="color:rgba(0,0,0,0.6);">${dataset.key === 'command' ? '次数' : '条数'}: </span>
                  <span style="font-weight:500; margin-left:3px;">${dataset.totalCount}</span>
                </div>
              </div>
              <h3 style="margin:0; font-size:16px; text-align:center; flex-grow:1; font-weight:500;">${dataset.title}</h3>
              <div style="flex-shrink:0; margin-left:10px; width:1px;"></div>
            </div>
            ${this.generateTableHTML(dataset.chartData, dataset.key, dataset.headerColor)}
          </div>
        `;
      }).join('');
      const html = `
        <div class="material-card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid rgba(0,0,0,0.08); flex-wrap:nowrap;">
            <div style="min-width:10px; flex-shrink:0;"></div>
            <h2 style="margin:0; font-size:18px; text-align:center; flex-grow:1; font-weight:500; color:rgba(0, 0, 0, 0.87);">${mainTitle}</h2>
            <div class="stat-chip" style="color:rgba(0,0,0,0.6);">${currentTime}</div>
          </div>
          ${tablesHTML}
        </div>
      `;
      return [await this.htmlToImage(html)];
    }
    // 需要分页
    const pages: Array<{datasets: typeof processedDatasets}> = [];
    let currentPage: typeof processedDatasets = [];
    let currentPageRows = 0;
    for (const dataset of processedDatasets) {
      if (currentPageRows + dataset.chartData.length > 200 && currentPage.length > 0) {
        if (dataset.chartData.length >= 50 || currentPage.length === 0) {
          pages.push({ datasets: [...currentPage] });
          currentPage = [dataset];
          currentPageRows = dataset.chartData.length;
        } else {
          currentPage.push(dataset);
          currentPageRows += dataset.chartData.length;
        }
      } else {
        currentPage.push(dataset);
        currentPageRows += dataset.chartData.length;
      }
    }
    if (currentPage.length > 0) {
      pages.push({ datasets: currentPage });
    }
    const results: Buffer[] = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pageTitle = pages.length > 1 ? `${mainTitle} (${i+1}/${pages.length})` : mainTitle;
      const tablesHTML = page.datasets.map((dataset, index) => {
        const isLastDataset = index === page.datasets.length - 1;
        return `
          <div style="margin-bottom:${isLastDataset ? '0' : '16px'};">
            <div style="display:flex; align-items:center; margin:8px 0; flex-wrap:nowrap;">
              <div style="display:flex; gap:8px; flex-shrink:0; margin-right:12px;">
                <div class="stat-chip">
                  <span style="color:rgba(0,0,0,0.6);">总计: </span>
                  <span style="font-weight:500; margin-left:3px;">${dataset.totalItems}</span>
                </div>
                <div class="stat-chip">
                  <span style="color:rgba(0,0,0,0.6);">${dataset.key === 'command' ? '次数' : '条数'}: </span>
                  <span style="font-weight:500; margin-left:3px;">${dataset.totalCount}</span>
                </div>
              </div>
              <h3 style="margin:0; font-size:16px; text-align:center; flex-grow:1; font-weight:500;">${dataset.title}</h3>
              <div style="flex-shrink:0; margin-left:10px; width:1px;"></div>
            </div>
            ${this.generateTableHTML(dataset.chartData, dataset.key, dataset.headerColor)}
          </div>
        `;
      }).join('');
      const html = `
        <div class="material-card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid rgba(0,0,0,0.08); flex-wrap:nowrap;">
            <div style="min-width:10px; flex-shrink:0;"></div>
            <h2 style="margin:0; font-size:18px; text-align:center; flex-grow:1; font-weight:500; color:rgba(0, 0, 0, 0.87);">${pageTitle}</h2>
            <div class="stat-chip" style="color:rgba(0,0,0,0.6);">${currentTime}</div>
          </div>
          ${tablesHTML}
        </div>
      `;
      results.push(await this.htmlToImage(html));
    }
    return results;
  }

  /**
   * 渲染排行榜图片
   * @param {Array} data 排名数据
   * @param {string} title 标题
   * @returns {Promise<Buffer>} 图片 Buffer
   */
  async renderRankingImage(data: Array<{
    userId: string
    userName: string
    currentCount: number
    previousCount: number
    diff: number
    rank: number
    prevRank?: number
    rankChange?: number
  }>, title: string): Promise<Buffer> {
    const totalChange = data.reduce((sum, item) => sum + item.diff, 0)
    const tableRows = data.map((item, index) => {
      const bgColor = index % 2 === 0 ? '#fff' : 'rgba(0,0,0,0.01)'
      const rankChangeHtml =
        item.rankChange === null ? `<span style="color:#9C27B0;">新</span>` :
        item.rankChange > 0 ? `<span style="color:#4CAF50;">↑${item.rankChange}</span>` :
        item.rankChange < 0 ? `<span style="color:#F44336;">↓${Math.abs(item.rankChange)}</span>` :
        `<span style="color:#9E9E9E;">-</span>`;
      return `
        <tr style="background-color:${bgColor};">
          <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:center;">${item.rank}</td>
          <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04);">${item.userName}</td>
          <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:right; white-space:nowrap;">${item.diff > 0 ? '+' : ''}${item.diff}</td>
          <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:center; white-space:nowrap;">${rankChangeHtml}</td>
        </tr>
      `
    }).join('')
    const html = `
      <div class="material-card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid rgba(0,0,0,0.08); flex-wrap:nowrap;">
          <div style="display:flex; gap:8px;">
            <div class="stat-chip" style="color:rgba(0,0,0,0.6);">
              <span>总计: </span>
              <span style="font-weight:500; margin-left:3px;">${data.length}</span>
            </div>
            <div class="stat-chip" style="color:rgba(0,0,0,0.6);">
              <span>总条数: </span>
              <span style="font-weight:500; margin-left:3px;">${totalChange}</span>
            </div>
          </div>
          <h2 style="margin:0; font-size:18px; text-align:center; flex-grow:1; font-weight:500;">${title}</h2>
          <div class="stat-chip" style="color:rgba(0,0,0,0.6);">${Utils.formatDateTime(new Date())}</div>
        </div>
        <div class="table-container">
          <table class="stat-table" style="width:100%; border-collapse:separate; border-spacing:0; background:white;">
            <thead>
              <tr style="background:#2196F3;">
                <th style="text-align:center; border-radius:6px 0 0 0; padding:8px 12px; width:60px;">排名</th>
                <th style="text-align:left; padding:8px 12px;">名称</th>
                <th style="text-align:right; white-space:nowrap; padding:8px 12px;">数量</th>
                <th style="text-align:center; white-space:nowrap; border-radius:0 6px 0 0; padding:8px 12px; width:80px;">排名变化</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </div>
    `
    return await this.htmlToImage(html)
  }

  /**
   * 生成表格HTML
   * @param {Array<{name: string, value: number, time: string}>} data - 表格数据
   * @param {keyof StatRecord} key - 数据类型
   * @param {string} headerColor - 表头颜色
   * @returns {string} 表格HTML
   * @private
   */
  private generateTableHTML(data: Array<{name: string, value: number, time: string}>, key: keyof StatRecord, headerColor: string = '#2196F3'): string {
    const totalValue = data.reduce((sum, item) => sum + item.value, 0);
    const generateRows = (items) => {
      return items.map((item, index) => {
        const valueText = key === 'command' ? `${item.value}次` : `${item.value}条`;
        const percentValue = (item.value / totalValue) * 100;
        const percentText = `${percentValue.toFixed(1)}%`;
        const bgColor = index % 2 === 0 ? '#ffffff' : 'rgba(0, 0, 0, 0.01)';
        return `
          <tr style="background-color:${bgColor};">
            <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04);">
              ${item.name}
            </td>
            <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:right; white-space:nowrap; color:rgba(0,0,0,0.6);">${item.time}</td>
            <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:right; white-space:nowrap;">${valueText}</td>
            <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:right; white-space:nowrap; font-family:monospace; color:rgba(0,0,0,0.78); position:relative;">
              <div style="position:absolute; top:0; right:0; bottom:0; width:${Math.min(percentValue * 2, 100)}%; background-color:${headerColor}15; z-index:0;"></div>
              <span style="position:relative; z-index:1;">${percentText}</span>
            </td>
          </tr>
        `;
      }).join('');
    };
    return `
      <div class="table-container">
        <table class="stat-table" style="width:100%; border-collapse:separate; border-spacing:0; background:white;">
          <thead>
            <tr style="background:${headerColor};">
              <th style="text-align:left; border-radius:6px 0 0 0; padding:8px 12px;">名称</th>
              <th style="text-align:right; white-space:nowrap; padding:8px 12px;">最后时间</th>
              <th style="text-align:right; white-space:nowrap; padding:8px 12px;">数量</th>
              <th style="text-align:right; white-space:nowrap; border-radius:0 6px 0 0; padding:8px 12px;">占比</th>
            </tr>
          </thead>
          <tbody>
            ${generateRows(data)}
          </tbody>
        </table>
      </div>
    `;
  }
}