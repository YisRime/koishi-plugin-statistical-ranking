import { Context } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import { StatProcessOptions } from './stat'
import { StatRecord } from './index'
import { Utils } from './utils'

/**
 * 统计数据渲染类
 * 负责将统计数据渲染为可视化图表
 *
 * 图片样式说明:
 * - 整体风格：Material Design风格，白色背景配合Material阴影和圆角设计
 * - 颜色方案：
 *   · 命令统计：蓝色系(#2196F3)表头
 *   · 用户统计：紫色系(#9C27B0)表头
 *   · 群组统计：绿色系(#4CAF50)表头
 * - 布局结构：
 *   · 顶部标题栏：包含总项目数、主标题和时间戳
 *   · 数据表格：四列布局(名称、数量、占比、最后统计时间)
 *   · 综合统计图：多个数据表垂直排列
 */
export class Renderer {
  private ctx: Context

  /**
   * 创建渲染器实例
   * @param {Context} ctx - Koishi上下文
   */
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
  async htmlToImage(html: string, options: { width?: number } = {}): Promise<Buffer> {
    let page: any = null
    try {
      page = await this.ctx.puppeteer.page()
      const initialViewportWidth = options.width || 720
      await page.setViewport({
        width: initialViewportWidth,
        height: 1080,
        deviceScaleFactor: 2.0
      })
      // 设置超时
      await page.setDefaultNavigationTimeout(30000)
      await page.setDefaultTimeout(30000)
      // 设置HTML内容
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body {
                margin: 0;
                padding: 0;
                font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
                background: transparent;
                color: rgba(0, 0, 0, 0.87);
                font-size: 14px;
                line-height: 1.4;
                -webkit-font-smoothing: antialiased;
              }
              table {
                width: 100%;
                table-layout: auto;
                border-collapse: separate;
                border-spacing: 0;
                overflow: hidden;
              }
              h2, h3 {
                margin: 0;
                letter-spacing: 0.5px;
                font-weight: 500;
              }
              .material-card {
                border-radius: 10px;
                overflow: hidden;
                background-color: #fff;
                box-shadow: 0 2px 4px -1px rgba(0,0,0,0.2),
                            0 4px 5px 0 rgba(0,0,0,0.14),
                            0 1px 10px 0 rgba(0,0,0,0.12);
                margin: 4px;
                padding: 12px;
              }
              .stat-chip {
                padding: 0 10px;
                height: 28px;
                display: inline-flex;
                align-items: center;
                border-radius: 14px;
                font-size: 14px;
                line-height: 28px;
                background-color: rgba(0, 0, 0, 0.06);
                color: rgba(0, 0, 0, 0.87);
                white-space: nowrap;
              }
              .stat-table th {
                font-weight: 500;
                color: white;
                padding: 8px 12px;
                position: sticky;
                top: 0;
                box-shadow: 0 1px 2px rgba(0,0,0,0.1);
              }
              .stat-table td {
                padding: 6px 12px;
                border-bottom: 1px solid rgba(0, 0, 0, 0.04);
                position: relative;
              }
              .highlight-row td {
                background-color: rgba(33, 150, 243, 0.03);
                font-weight: 500;
              }
              .table-container {
                border-radius: 8px;
                overflow: hidden;
                border: 1px solid rgba(0, 0, 0, 0.06);
              }
            </style>
          </head>
          <body>${html}</body>
        </html>
      `, { waitUntil: 'networkidle0' })
      // 计算实际内容宽度和高度
      const dimensions = await page.evaluate(() => {
        const contentWidth = Math.max(
          document.body.scrollWidth,
          document.body.offsetWidth,
          document.documentElement.clientWidth,
          document.documentElement.scrollWidth,
          document.documentElement.offsetWidth
        );
        const contentHeight = document.body.scrollHeight;
        return { width: contentWidth, height: contentHeight };
      });
      // 调整视口大小以完全适应内容
      await page.setViewport({
        width: dimensions.width,
        height: dimensions.height,
        deviceScaleFactor: 2.0
      });
      // 等待所有图片加载完成
      await page.evaluate(() => {
        const imgPromises = Array.from(document.querySelectorAll('img'))
          .map(img => img.complete ? Promise.resolve() :
               new Promise(resolve => {
                 img.addEventListener('load', resolve);
                 img.addEventListener('error', resolve);
               })
          );
        return Promise.all(imgPromises);
      });
      // 截取整个页面
      const imageBuffer = await page.screenshot({
        type: 'png',
        fullPage: true,
        omitBackground: true
      });

      return imageBuffer;
    } catch (error) {
      this.ctx.logger.error('图片渲染出错:', error)
      throw new Error(`图片渲染出错: ${error.message || '未知错误'}`)
    } finally {
      if (page) {
        try {
          await page.close().catch(() => {})
        } catch (e) {
          this.ctx.logger.warn('关闭页面失败:', e)
        }
      }
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
    const {
      sortBy = 'count',
      disableCommandMerge = false,
      truncateId = false,
      displayBlacklist = [],
      displayWhitelist = []
    } = options;

    const filteredRecords = Utils.filterStatRecords(records, {
      keyField: key as string,
      displayWhitelist,
      displayBlacklist,
      disableCommandMerge
    });

    const keyFormatter = (key === 'command' && !disableCommandMerge)
      ? (k: string) => k?.split('.')[0] || '' : undefined;

    const dataMap = Utils.generateStatsMap(filteredRecords, key as string, keyFormatter);
    // 转换为图表数据格式
    let chartData = Array.from(dataMap.entries()).map(([key, data]) => {
      let displayName = Utils.formatDisplayName(
        data.displayName,
        key,
        truncateId
      );

      return {
        name: displayName,
        value: data.count,
        time: Utils.formatTimeAgo(data.lastTime),
        rawTime: data.lastTime
      };
    });
    // 排序
    chartData.sort((a, b) => {
      if (sortBy === 'count') return b.value - a.value;
      if (sortBy === 'time') return b.rawTime.getTime() - a.rawTime.getTime();
      return a.name.localeCompare(b.name);
    });

    return chartData;
  }

  /**
   * 将统计记录分页处理
   * @param {Array<{name: string, value: number, time: string, rawTime: Date}>} data - 统计数据
   * @param {number} maxRowsPerPage - 每页最大行数
   * @param {number} minRowsForNewPage - 创建新页面的最小行数
   * @returns {Array<Array<{name: string, value: number, time: string, rawTime: Date}>>} 分页后的数据
   */
  paginateData(
    data: Array<{name: string, value: number, time: string, rawTime: Date}>,
    maxRowsPerPage: number = 200,
    minRowsForNewPage: number = 50
  ): Array<Array<{name: string, value: number, time: string, rawTime: Date}>> {
    if (!data.length) return [[]];
    if (data.length <= maxRowsPerPage) return [data];

    const pages: Array<Array<{name: string, value: number, time: string, rawTime: Date}>> = [];
    const totalRows = data.length;
    // 计算正常情况下需要的页数
    const normalPageCount = Math.ceil(totalRows / maxRowsPerPage);
    // 最后一页的行数
    const lastPageRows = totalRows - (normalPageCount - 1) * maxRowsPerPage;
    // 如果最后一页行数少于最小行数阈值，则将内容合并到倒数第二页
    const actualPageCount = lastPageRows < minRowsForNewPage && normalPageCount > 1
      ? normalPageCount - 1
      : normalPageCount;
    // 特殊情况处理：如果总行数很少，直接返回一页
    if (actualPageCount <= 1) return [data];
    // 计算主要页面大小（平均分布行数）
    const mainPageSize = Math.ceil(totalRows / actualPageCount);
    // 分页处理
    let currentIdx = 0;
    for (let i = 0; i < actualPageCount; i++) {
      // 最后一页获取所有剩余数据
      const pageSize = i === actualPageCount - 1
        ? totalRows - currentIdx
        : mainPageSize;

      pages.push(data.slice(currentIdx, currentIdx + pageSize));
      currentIdx += pageSize;
    }

    return pages;
  }

  /**
   * 生成统计数据的图片
   * @param {StatRecord[]} records - 统计记录数组
   * @param {keyof StatRecord} key - 统计键名
   * @param {string} title - 图表标题
   * @param {StatProcessOptions} options - 处理选项
   * @returns {Promise<Buffer[]>} 生成的图片Buffer数组
   */
  async generateStatImage(
    records: StatRecord[],
    key: keyof StatRecord,
    title: string,
    options: StatProcessOptions = {}
  ): Promise<Buffer[]> {
    // 转换记录为图表数据
    const chartData = this.recordsToChartData(records, key, {
      ...options,
      displayWhitelist: [],
      displayBlacklist: []
    });
    // 设置 Material Design 颜色主题
    const headerColor =
      key === 'userId' ? '#9C27B0' :  // Purple 500
      key === 'guildId' ? '#4CAF50' : // Green 500
      '#2196F3';                     // Blue 500
    // 分页处理
    const pages = this.paginateData(chartData);
    const results: Buffer[] = [];
    // 当前时间
    const currentTime = Utils.formatDateTime(new Date());
    // 计算总次数和总项目数
    const totalItems = chartData.length;
    const totalCount = chartData.reduce((sum, item) => sum + item.value, 0);
    // 为每一页生成图片
    for (let i = 0; i < pages.length; i++) {
      const pageData = pages[i];
      // 只有多页时才显示页码
      const pageTitle = pages.length > 1 ? `${title} (${i+1}/${pages.length})` : title;
      // 生成HTML内容并渲染
      const html = `
        <div class="material-card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid rgba(0,0,0,0.08); flex-wrap:nowrap;">
            <div style="display:flex; gap:8px; flex-shrink:0; margin-right:12px;">
              <div class="stat-chip">
                <span style="color:rgba(0,0,0,0.6);">总项目: </span>
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
      const imageBuffer = await this.htmlToImage(html);
      results.push(imageBuffer);
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
    // 处理所有数据集以获取每个数据集的行数
    const processedDatasets = datasets.map(dataset => {
      if (!dataset.records.length) return { chartData: [], key: dataset.key, title: dataset.title, headerColor: '', totalItems: 0, totalCount: 0 };

      const chartData = this.recordsToChartData(dataset.records, dataset.key, {
        ...dataset.options,
        displayWhitelist: [],
        displayBlacklist: []
      });
      // 设置 Material Design 颜色主题
      const headerColor =
        dataset.key === 'userId' ? '#9C27B0' :  // Purple 500
        dataset.key === 'guildId' ? '#4CAF50' : // Green 500
        '#2196F3';                            // Blue 500
      // 计算总次数和总项目数
      const totalItems = chartData.length;
      const totalCount = chartData.reduce((sum, item) => sum + item.value, 0);

      return { chartData, key: dataset.key, title: dataset.title, headerColor, totalItems, totalCount };
    }).filter(d => d.chartData.length > 0);

    if (processedDatasets.length === 0) return [await this.htmlToImage(`<div style="padding:24px; text-align:center;">没有数据</div>`)];
    // 计算每个数据集的行数并安排页面
    let totalRows = 0;
    processedDatasets.forEach(dataset => {
      totalRows += dataset.chartData.length;
    });
    // 当前时间
    const currentTime = Utils.formatDateTime(new Date());
    // 如果总行数少于200，则一页显示所有内容
    if (totalRows <= 200) {
      const tablesHTML = processedDatasets.map((dataset, index) => {
        // 最后一个数据集不要下边距
        const isLastDataset = index === processedDatasets.length - 1;
        return `
          <div style="margin-bottom:${isLastDataset ? '0' : '16px'};">
            <div style="display:flex; align-items:center; margin:8px 0; flex-wrap:nowrap;">
              <div style="display:flex; gap:8px; flex-shrink:0; margin-right:12px;">
                <div class="stat-chip">
                  <span style="color:rgba(0,0,0,0.6);">总项目: </span>
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
    } else {
      // 尽量让每个表格完整显示在一页上
      const pages: Array<{
        datasets: Array<{chartData: any[], key: keyof StatRecord, title: string, headerColor: string, totalItems: number, totalCount: number}>
      }> = [];

      let currentPage: Array<typeof processedDatasets[0]> = [];
      let currentPageRows = 0;

      for (const dataset of processedDatasets) {
        // 如果添加这个数据集会超过每页行数限制，并且当前页已有内容，则创建新页
        if (currentPageRows + dataset.chartData.length > 200 && currentPage.length > 0) {
          // 除非剩余行数小于50行，且不是唯一的表格
          if (dataset.chartData.length >= 50 || currentPage.length === 0) {
            pages.push({ datasets: [...currentPage] });
            currentPage = [dataset];
            currentPageRows = dataset.chartData.length;
          } else {
            // 剩余行数少于50，合并到当前页
            currentPage.push(dataset);
            currentPageRows += dataset.chartData.length;
          }
        } else {
          // 添加到当前页
          currentPage.push(dataset);
          currentPageRows += dataset.chartData.length;
        }
      }
      // 添加剩余的最后一页
      if (currentPage.length > 0) {
        pages.push({ datasets: currentPage });
      }
      // 生成每页的图片
      const results: Buffer[] = [];

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        // 只有多页时才显示页码
        const pageTitle = pages.length > 1 ? `${mainTitle} (${i+1}/${pages.length})` : mainTitle;

        const tablesHTML = page.datasets.map((dataset, index) => {
          const isLastDataset = index === page.datasets.length - 1;
          return `
            <div style="margin-bottom:${isLastDataset ? '0' : '16px'};">
              <div style="display:flex; align-items:center; margin:8px 0; flex-wrap:nowrap;">
                <div style="display:flex; gap:8px; flex-shrink:0; margin-right:12px;">
                  <div class="stat-chip">
                    <span style="color:rgba(0,0,0,0.6);">总项目: </span>
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

        const imageBuffer = await this.htmlToImage(html);
        results.push(imageBuffer);
      }

      return results;
    }
  }

  /**
   * 生成表格HTML (内部方法)
   * @param {Array<{name: string, value: number, time: string}>} data - 表格数据
   * @param {keyof StatRecord} key - 数据类型
   * @param {string} headerColor - 表头颜色
   * @returns {string} 表格HTML
   * @private
   */
  private generateTableHTML(data: Array<{name: string, value: number, time: string}>, key: keyof StatRecord, headerColor: string = '#2196F3'): string {
    // 计算总值用于百分比
    const totalValue = data.reduce((sum, item) => sum + item.value, 0);
    // 找出最大值用于突出显示前三名
    const maxValues = [...data]
      .sort((a, b) => b.value - a.value)
      .slice(0, 3)
      .map(item => item.value);
    // 生成表格行HTML
    const generateRows = (items) => {
      return items.map((item, index) => {
        const valueText = key === 'command' ? `${item.value}次` : `${item.value}条`;
        const percentValue = (item.value / totalValue) * 100;
        const percentText = `${percentValue.toFixed(1)}%`;
        const isTopThree = maxValues.includes(item.value) && index < 3;
        const bgColor = index % 2 === 0 ? '#ffffff' : 'rgba(0, 0, 0, 0.01)';
        const rowClass = isTopThree ? 'highlight-row' : '';
        // 为百分比数据添加背景进度条
        return `
          <tr class="${rowClass}" style="background-color:${bgColor};">
            <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); font-weight:${isTopThree ? '500' : 'normal'};">
              ${isTopThree ? `<span style="display:inline-block; width:20px; height:20px; border-radius:50%; background-color:${headerColor}; color:white; text-align:center; line-height:20px; margin-right:6px; font-size:12px;">${index+1}</span>` : ''}
              ${item.name}
            </td>
            <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:right; white-space:nowrap; font-weight:${isTopThree ? '500' : 'normal'};">${valueText}</td>
            <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:right; white-space:nowrap; font-family:monospace; color:rgba(0,0,0,0.78); background-image: linear-gradient(to right, ${headerColor}15 ${Math.min(percentValue * 2, 100)}%, transparent ${Math.min(percentValue * 2, 100)}%);">
              ${percentText}
            </td>
            <td style="padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.04); text-align:right; white-space:nowrap; color:rgba(0,0,0,0.6);">${item.time}</td>
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
              <th style="text-align:right; white-space:nowrap; padding:8px 12px;">数量</th>
              <th style="text-align:right; white-space:nowrap; padding:8px 12px;">占比</th>
              <th style="text-align:right; white-space:nowrap; border-radius:0 6px 0 0; padding:8px 12px;">最后时间</th>
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
