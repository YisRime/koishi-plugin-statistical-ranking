import { Context } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import { StatProcessOptions } from './utils'
import { StatRecord } from './index'
import { utils } from './utils'

/**
 * 将HTML内容转换为图片
 * @param {string} html - 要渲染的HTML内容
 * @param {Context} ctx - Koishi上下文
 * @param {Object} options - 渲染选项
 * @param {number} [options.width] - 图片宽度
 * @param {number} [options.height] - 图片高度
 * @returns {Promise<Buffer>} 图片Buffer数据
 */
export async function htmlToImage(html: string, ctx: Context, options: { width?: number; height?: number } = {}): Promise<Buffer> {
  try {
    const page = await ctx.puppeteer.page()

    // 设置视口大小
    const viewportWidth = options.width
    const viewportHeight = options.height

    await page.setViewport({
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: 2.0
    })

    // 设置简化的HTML内容，引入Chart.js库
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
          <style>
            body {
              margin: 0;
              padding: 0;
              overflow: hidden;
              font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
            }
            .chart-container {
              padding: 20px;
              background: white;
            }
          </style>
        </head>
        <body>
          ${html}
        </body>
      </html>
    `, { waitUntil: 'networkidle0' })

    // 等待图片和图表渲染完成
    await page.evaluate(() => {
      return new Promise(resolve => {
        // 确保所有Chart.js图表都渲染完成
        if (window['chartRenderingComplete']) {
          resolve(true);
          return;
        }

        // 等待图片加载
        const imgPromises = Array.from(document.querySelectorAll('img'))
          .map(img => {
            if (img.complete) return Promise.resolve();
            return new Promise(imgResolve => {
              img.addEventListener('load', imgResolve);
              img.addEventListener('error', imgResolve);
            });
          });

        // 等待图表渲染
        Promise.all(imgPromises).then(() => {
          // 给图表渲染一些额外时间
          setTimeout(resolve, 500);
        });
      });
    });

    // 截取整个页面作为图片
    const imageBuffer = await page.screenshot({
      type: 'png',
      fullPage: false
    })

    await page.close()
    return imageBuffer

  } catch (error) {
    ctx.logger.error('图片渲染出错:', error)
    throw new Error('生成图片时遇到问题，请稍后重试')
  }
}

/**
 * 生成扇形统计图的HTML
 * @param {string} title - 图表标题
 * @param {Array<{name: string, value: number, time: string}>} data - 统计数据
 * @param {string} key - 数据键名
 * @param {Object} options - 图表选项
 * @returns {string} 生成的HTML内容
 */
export function generateStatChartHtml(title: string, data: Array<{name: string, value: number, time: string}>, key: string, options: {
  width?: number;
  height?: number;
  colorPalette?: string[];
  titleColor?: string;
} = {}): string {
  const {
    width = 800,
    titleColor = '#333333',
    colorPalette = [
      '#4d7cfe', '#5dd5a8', '#ff6b81', '#ffa600', '#bc5090',
      '#58508d', '#8ac926', '#ff595e', '#6a4c93', '#2a7de1', '#38a169',
      '#9467bd', '#d62728', '#ff9e7a', '#ffcd69', '#f7b6d2', '#8c564b'
    ]
  } = options;

  // 计算数据总和，用于百分比计算
  const totalValue = data.reduce((sum, item) => sum + item.value, 0);

  // 找出占比少于1%的小数据项
  const smallItems = data.filter(item => (item.value / totalValue) < 0.01);
  const normalItems = data.filter(item => (item.value / totalValue) >= 0.01);

  // 直接使用所有正常项，不再限制数量
  const chartItems = normalItems;

  // 只处理小项合并，不再合并正常项
  let mergedItem = null;
  if (smallItems.length > 0) {
    // 计算需要合并的所有小项的总和
    const mergedValue = smallItems.reduce((sum, item) => sum + item.value, 0);

    if (mergedValue > 0) {
      mergedItem = {
        name: '小项合计(<1%)',
        value: mergedValue,
        time: '小项合并'
      };
      chartItems.push(mergedItem);
    }
  }

  // 准备Chart.js的饼图数据
  const chartLabels = chartItems.map(item => item.name);
  const chartValues = chartItems.map(item => item.value);

  // 扩展调色板处理更多项目
  let extendedColorPalette = [...colorPalette];
  if (chartItems.length > colorPalette.length) {
    // 当项目数量超过调色板时，循环使用颜色，增加透明度来区分
    for (let i = colorPalette.length; i < chartItems.length - 1; i++) {
      const baseColor = colorPalette[i % colorPalette.length];
      const opacity = 0.7 - (Math.floor(i / colorPalette.length) * 0.15);
      extendedColorPalette.push(baseColor);
    }
  }

  // 最后一个项是合并项则使用灰色
  const chartColors = mergedItem
    ? [...extendedColorPalette.slice(0, chartItems.length - 1), '#cccccc']
    : extendedColorPalette.slice(0, chartItems.length);

  // 创建唯一的canvas ID
  const canvasId = `chart-${Math.random().toString(36).substring(2, 9)}`;

  // 生成表格行数据
  // 1. 正常显示的项目（饼图中的项目）
  const chartItemsRows = chartItems.map((item, index) => {
    const colorBox = `<div style="width:12px; height:12px; background-color:${chartColors[index] || '#ccc'}; margin-right:8px; display:inline-block;"></div>`;
    const valueText = key === 'command' ? `${item.value}次` : `${item.value}条`;
    const percentText = `${Math.round((item.value / totalValue) * 100)}%`;
    return `
      <tr>
        <td>${colorBox}${item.name}</td>
        <td>${valueText}</td>
        <td>${percentText}</td>
        <td>${item.time}</td>
      </tr>
    `;
  }).join('');

  // 2. 显示所有小项（<1%的项）
  const smallItemsRows = smallItems.length > 0 ? smallItems.map(item => {
    const valueText = key === 'command' ? `${item.value}次` : `${item.value}条`;
    const percentText = `${(item.value / totalValue * 100).toFixed(2)}%`;
    return `
      <tr class="detail-row">
        <td>${item.name}</td>
        <td>${valueText}</td>
        <td>${percentText}</td>
        <td>${item.time}</td>
      </tr>
    `;
  }).join('') : '';

  // 确定合适的布局方式 - 根据所有项的数量决定
  const totalItems = chartItems.length + (smallItems.length > 0 ? smallItems.length : 0);
  const isManyItems = totalItems > 15 || smallItems.length > 10 || normalItems.length > 12;
  const layoutClass = isManyItems ? 'vertical-layout' : 'horizontal-layout';
  const chartAreaSize = isManyItems ? {width: '100%', height: '350px'} : {width: '55%', height: 'auto'};
  const detailsSize = isManyItems ? {width: '100%', height: 'auto'} : {width: '42%', height: 'auto'};

  return `
    <div class="stat-chart ${layoutClass}" style="width:${width}px;">
      <style>
        .stat-chart {
          font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
          background-color: white;
          border-radius: 12px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
          padding: 24px;
          box-sizing: border-box;
        }
        .chart-title {
          font-size: 22px;
          font-weight: bold;
          color: ${titleColor};
          margin-bottom: 20px;
          text-align: center;
          padding-bottom: 12px;
          border-bottom: 1px solid #eaeaea;
        }
        /* 水平布局 */
        .horizontal-layout .chart-content {
          display: flex;
          flex-direction: row;
          justify-content: space-between;
          align-items: flex-start;
        }
        .horizontal-layout .chart-area {
          width: ${chartAreaSize.width};
          height: ${chartAreaSize.height};
        }
        .horizontal-layout .chart-details {
          width: ${detailsSize.width};
          height: ${detailsSize.height};
        }
        /* 垂直布局 */
        .vertical-layout .chart-content {
          display: flex;
          flex-direction: column;
        }
        .vertical-layout .chart-area {
          width: ${chartAreaSize.width};
          height: ${chartAreaSize.height};
          margin-bottom: 20px;
          display: flex;
          justify-content: center;
        }
        .vertical-layout .chart-details {
          width: 100%;
        }
        /* 共用样式 */
        .chart-area canvas {
          max-width: 100%;
          max-height: 100%;
        }
        .detail-table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 15px;
        }
        .detail-table th {
          text-align: left;
          padding: 8px 4px;
          border-bottom: 1px solid #eaeaea;
          color: #666;
          font-weight: normal;
          font-size: 13px;
        }
        .detail-table td {
          padding: 6px 4px;
          border-bottom: 1px solid #f5f5f5;
          font-size: 13px;
        }
        .section-title {
          font-size: 14px;
          font-weight: bold;
          color: #555;
          margin-top: 15px;
          margin-bottom: 8px;
          padding-bottom: 4px;
          border-bottom: 1px solid #eee;
        }
        .detail-row td {
          color: #666;
          font-size: 12px;
        }
        .stats-summary {
          margin-top: 10px;
          text-align: center;
          font-size: 13px;
          color: #666;
        }
      </style>
      <div class="chart-title">${title}</div>
      <div class="chart-content">
        <div class="chart-area">
          <canvas id="${canvasId}"></canvas>
        </div>
        <div class="chart-details">
          <table class="detail-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>数值</th>
                <th>占比</th>
                <th>最后活动</th>
              </tr>
            </thead>
            <tbody>
              ${chartItemsRows}
            </tbody>
          </table>

          ${smallItems.length > 0 ? `
          <div class="section-title">小于1%占比的数据项 (共${smallItems.length}个)</div>
          <table class="detail-table">
            <tbody>
              ${smallItemsRows}
            </tbody>
          </table>
          ` : ''}

          <div class="stats-summary">
            总计: ${totalValue}${key === 'command' ? '次' : '条'} | ${data.length}个数据项
          </div>
        </div>
      </div>
      <script>
        // 初始化饼图
        const ctx = document.getElementById('${canvasId}');
        new Chart(ctx, {
          type: 'pie',
          data: {
            labels: ${JSON.stringify(chartLabels)},
            datasets: [{
              data: ${JSON.stringify(chartValues)},
              backgroundColor: ${JSON.stringify(chartColors)},
              borderColor: 'white',
              borderWidth: 2
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: ${!isManyItems},
            plugins: {
              legend: {
                display: false
              },
              tooltip: {
                callbacks: {
                  label: function(context) {
                    const label = context.label || '';
                    const value = context.formattedValue || '';
                    const percentage = Math.round((context.raw / ${totalValue}) * 100);
                    return \`\${label}: \${value} (\${percentage}%)\`;
                  }
                }
              }
            }
          }
        });
        window.chartRenderingComplete = true;
      </script>
    </div>
  `;
}

/**
 * 将统计记录转换为图表数据
 * @param {StatRecord[]} records - 统计记录数组
 * @param {keyof StatRecord} key - 统计键名
 * @param {StatProcessOptions} options - 处理选项
 * @returns {Array<{name: string, value: number, time: string}>} 转换后的图表数据
 */
export function recordsToChartData(records: StatRecord[], key: keyof StatRecord, options: StatProcessOptions = {}): Array<{name: string, value: number, time: string}> {
  const {
    sortBy = 'count',
    disableCommandMerge = false,
    truncateId = false,
    displayBlacklist = [],
    displayWhitelist = []
  } = options;

  // 使用相同的StatMap逻辑处理数据聚合
  const keyFormatter = (key === 'command' && !disableCommandMerge)
    ? (k: string) => k?.split('.')[0] || '' : undefined;

  const dataMap = new Map<string, {count: number, lastTime: Date, displayName?: string}>();

  // 过滤记录
  const filteredRecords = (key === 'command' && !disableCommandMerge)
    ? records.filter(r => r.command !== '_message') : records;

  // 聚合记录
  for (const record of filteredRecords) {
    const recordKey = record[key] as string;

    // 优化过滤逻辑
    if (displayWhitelist.length && !displayWhitelist.some(p => recordKey.includes(p))) {
      continue;
    }
    if (displayBlacklist.length && displayBlacklist.some(p => recordKey.includes(p))) {
      continue;
    }

    const formattedKey = keyFormatter ? keyFormatter(recordKey) : recordKey;
    let displayName = formattedKey;

    if (key === 'userId' && record.userName) {
      displayName = truncateId ? record.userName : `${record.userName} (${recordKey})`;
    } else if (key === 'guildId' && record.guildName) {
      displayName = truncateId ? record.guildName : `${record.guildName} (${recordKey})`;
    }

    const current = dataMap.get(formattedKey) || { count: 0, lastTime: record.lastTime, displayName };
    current.count += record.count;
    if (record.lastTime > current.lastTime) {
      current.lastTime = record.lastTime;
    }
    dataMap.set(formattedKey, current);
  }

  // 转换为数组并排序
  let chartData = Array.from(dataMap.entries()).map(([key, data]) => ({
    name: data.displayName || key,
    value: data.count,
    time: utils.formatTimeAgo(data.lastTime)
  }));

  // 排序
  chartData.sort((a, b) => sortBy === 'count' ? b.value - a.value : a.name.localeCompare(b.name));

  return chartData;
}

/**
 * 生成统计表格HTML
 * @param {string} title - 表格标题
 * @param {Array<string[]>} rows - 表格行数据
 * @param {string[]} headers - 表格头部
 * @param {Object} options - 表格选项
 * @returns {string} 生成的表格HTML
 */
export function generateStatTableHtml(title: string, rows: Array<string[]>, headers: string[] = [], options: {
  width?: number;
  height?: number;
  headerBgColor?: string;
  stripedColor?: string;
} = {}): string {
  const {
    width = 800,
    height = 600,
    headerBgColor = '#4d7cfe',
    stripedColor = '#f2f5fc'
  } = options;

  const headerHTML = headers.length
    ? `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`
  : '';

  const rowsHTML = rows.map((row, idx) =>
    `<tr class="${idx % 2 === 0 ? 'even' : 'odd'}">${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`
  ).join('');

  return `
    <div class="stat-table-container" style="width:${width}px; max-height:${height}px;">
      <style>
        .stat-table-container {
          font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
          background-color: white;
          border-radius: 10px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
          padding: 20px;
          box-sizing: border-box;
          overflow: hidden;
        }
        .table-title {
          font-size: 20px;
          font-weight: bold;
          color: #333;
          margin-bottom: 20px;
          text-align: center;
        }
        table.stat-table {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
        }
        table.stat-table th {
          background-color: ${headerBgColor};
          color: white;
          font-weight: normal;
          padding: 10px;
          text-align: left;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        table.stat-table tr.odd {
          background-color: ${stripedColor};
        }
        table.stat-table td {
          padding: 10px;
          border-bottom: 1px solid #eee;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      </style>
      <div class="table-title">${title}</div>
      <table class="stat-table">
        <thead>
          ${headerHTML}
        </thead>
        <tbody>
          ${rowsHTML}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * 生成统计卡片HTML
 * @param {string} title - 卡片标题
 * @param {Array<{label: string, value: string|number}>} items - 卡片项目数据
 * @param {Object} options - 卡片选项
 * @returns {string} 生成的卡片HTML
 */
export function generateStatCardHtml(title: string, items: Array<{label: string, value: string|number}>, options: {
  width?: number;
  accent?: string;
  bgColor?: string;
} = {}): string {
  const {
    width = 400,
    accent = '#4d7cfe',
    bgColor = '#ffffff'
  } = options;

  const itemsHTML = items.map(item => `
    <div class="card-item">
      <div class="item-label">${item.label}</div>
      <div class="item-value">${item.value}</div>
    </div>
  `).join('');

  return `
    <div class="stat-card" style="width:${width}px;">
      <style>
        .stat-card {
          font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
          background-color: ${bgColor};
          border-radius: 10px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
          padding: 20px;
          box-sizing: border-box;
        }
        .card-title {
          font-size: 18px;
          font-weight: bold;
          color: #333;
          padding-bottom: 10px;
          border-bottom: 2px solid ${accent};
          margin-bottom: 15px;
        }
        .card-items {
          display: flex;
          flex-direction: column;
          gap: 15px;
        }
        .card-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .item-label {
          font-size: 14px;
          color: #666;
        }
        .item-value {
          font-size: 16px;
          font-weight: bold;
          color: #333;
        }
      </style>
      <div class="card-title">${title}</div>
      <div class="card-items">
        ${itemsHTML}
      </div>
    </div>
  `;
}

/**
 * 生成统计数据的图片
 * @param {Context} ctx - Koishi上下文
 * @param {StatRecord[]} records - 统计记录数组
 * @param {keyof StatRecord} key - 统计键名
 * @param {string} title - 图表标题
 * @param {StatProcessOptions} options - 处理选项
 * @returns {Promise<Buffer>} 生成的图片Buffer
 */
export async function generateStatImage(
  ctx: Context,
  records: StatRecord[],
  key: keyof StatRecord,
  title: string,
  options: StatProcessOptions = {}
): Promise<Buffer> {
  // 转换记录为图表数据
  const chartData = recordsToChartData(records, key, options);

  // 根据数据量动态调整图片尺寸
  let width = 900;  // 基础宽度

  // 计算适合的高度：基本高度 + 数据项数量因子
  const baseHeight = 620;
  let height = baseHeight;

  // 根据显示的项目数量增加高度
  const normalItems = chartData.filter(item => {
    const total = chartData.reduce((sum, d) => sum + d.value, 0);
    return (item.value / total) >= 0.01;
  });

  if (normalItems.length > 12) {
    // 如果正常项很多，增加更多高度
    height += Math.min(600, (normalItems.length - 12) * 20);
  } else if (chartData.length > 20) {
    // 小项很多时也适当增加高度
    height += Math.min(400, (chartData.length - 20) * 12);
  }

  // 根据数据类型设置不同的颜色主题
  let colorPalette;
  if (key === 'userId') {
    colorPalette = [
      '#ff6b81', '#ff9e7a', '#ffcd69', '#ffa600', '#c44e52',
      '#e377c2', '#f7b6d2', '#8c564b', '#9467bd', '#d62728',
      '#ff7f0e', '#2ca02c', '#1f77b4', '#17becf', '#e377c2'
    ];
  } else if (key === 'guildId') {
    colorPalette = [
      '#5dd5a8', '#7bdcb5', '#8ed1fc', '#00d084', '#0693e3',
      '#4d7cfe', '#8bbafe', '#2a7de1', '#38a169', '#319795',
      '#3182bd', '#6baed6', '#9ecae1', '#c6dbef', '#08519c'
    ];
  } else {
    colorPalette = [
      '#4d7cfe', '#5dd5a8', '#ffa600', '#ff6b81', '#bc5090',
      '#58508d', '#8ac926', '#ff595e', '#6a4c93', '#f4a582',
      '#33a02c', '#984ea3', '#a65628', '#f781bf', '#999999'
    ];
  }

  // 生成HTML图表
  const html = generateStatChartHtml(title, chartData, key, {
    width,
    height,
    colorPalette
  });

  // 渲染为图片
  return await htmlToImage(html, ctx, { width, height });
}

/**
 * 生成综合统计图，将用户的所有统计信息整合到一张图中
 * @param {Context} ctx - Koishi上下文
 * @param {Array<{records: StatRecord[], title: string, key: keyof StatRecord, options?: StatProcessOptions}>} datasets - 多个数据集
 * @param {string} mainTitle - 主标题
 * @param {Object} summaryData - 汇总数据
 * @returns {Promise<Buffer>} 生成的图片Buffer
 */
export async function generateCombinedStatImage(
  ctx: Context,
  datasets: Array<{records: StatRecord[], title: string, key: keyof StatRecord, options?: StatProcessOptions}>,
  mainTitle: string,
  summaryData: {label: string, value: string|number}[]
): Promise<Buffer> {
  // 处理每个数据集，生成图表HTML
  const chartHtmls = [];
  const totalData = {
    totalItems: 0,
    totalCount: 0
  };

  // 转换每个数据集为图表HTML
  for (const dataset of datasets) {
    if (!dataset.records.length) continue;

    const chartData = recordsToChartData(dataset.records, dataset.key, dataset.options || {});
    totalData.totalItems += chartData.length;
    totalData.totalCount += chartData.reduce((sum, item) => sum + item.value, 0);

    // 确定颜色主题
    let colorPalette;
    if (dataset.key === 'userId') {
      colorPalette = [
        '#ff6b81', '#ff9e7a', '#ffcd69', '#ffa600', '#c44e52',
        '#e377c2', '#f7b6d2', '#8c564b', '#9467bd', '#d62728',
        '#ff7f0e', '#2ca02c', '#1f77b4', '#17becf', '#e377c2'
      ];
    } else if (dataset.key === 'guildId') {
      colorPalette = [
        '#5dd5a8', '#7bdcb5', '#8ed1fc', '#00d084', '#0693e3',
        '#4d7cfe', '#8bbafe', '#2a7de1', '#38a169', '#319795',
        '#3182bd', '#6baed6', '#9ecae1', '#c6dbef', '#08519c'
      ];
    } else {
      colorPalette = [
        '#4d7cfe', '#5dd5a8', '#ffa600', '#ff6b81', '#bc5090',
        '#58508d', '#8ac926', '#ff595e', '#6a4c93', '#f4a582',
        '#33a02c', '#984ea3', '#a65628', '#f781bf', '#999999'
      ];
    }

    // 生成内部图表HTML（无外部容器）
    chartHtmls.push({
      title: dataset.title,
      key: dataset.key,
      html: generateInnerChartHtml(dataset.title, chartData, dataset.key, colorPalette)
    });
  }

  // 生成统计卡片内容
  const cardHtml = generateInnerCardHtml(summaryData);

  // 计算合适的高度
  const chartHeight = 400; // 每个图表的基本高度
  const padding = 30; // 顶部和底部的间距
  const spacing = 40; // 元素之间的间距
  const cardHeight = 200; // 卡片区域的高度

  // 根据元素数量计算总高度
  let totalHeight = padding;
  totalHeight += chartHtmls.length * chartHeight;
  totalHeight += (chartHtmls.length - 1) * spacing;
  totalHeight += cardHeight;
  totalHeight += padding;

  // 组合所有图表和卡片
  const width = 1000; // 总宽度

  // 创建主容器HTML
  const mainHtml = `
    <div class="combined-stat-container">
      <style>
        .combined-stat-container {
          font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
          background-color: white;
          border-radius: 12px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
          padding: 30px;
          box-sizing: border-box;
          width: ${width}px;
        }
        .main-title {
          font-size: 24px;
          font-weight: bold;
          color: #333333;
          margin-bottom: 30px;
          text-align: center;
          padding-bottom: 15px;
          border-bottom: 1px solid #eaeaea;
        }
        .chart-section {
          margin-bottom: ${spacing}px;
        }
        .card-section {
          margin-top: 30px;
        }
        .section-title {
          font-size: 20px;
          font-weight: bold;
          color: #555;
          margin-bottom: 15px;
          padding-bottom: 8px;
          border-bottom: 1px solid #eee;
        }
        .chart-content {
          height: ${chartHeight - 50}px;
          display: flex;
        }
        .chart-area {
          flex: 1;
          max-width: 45%;
        }
        .chart-details {
          flex: 1;
          max-width: 55%;
          overflow-y: auto;
          padding-left: 20px;
        }
        .summary {
          margin-top: 20px;
          text-align: center;
          font-size: 14px;
          color: #666;
        }
      </style>
      <div class="main-title">${mainTitle}</div>

      ${chartHtmls.map(chart => `
        <div class="chart-section" data-key="${chart.key}">
          ${chart.html}
        </div>
      `).join('')}

      <div class="card-section">
        ${cardHtml}
      </div>

      <div class="summary">
        生成时间: ${new Date().toLocaleString()}
      </div>
    </div>
  `;

  // 渲染为图片
  return await htmlToImage(mainHtml, ctx, { width, height: totalHeight });
}

/**
 * 生成内部图表HTML（无外部容器，用于综合图表）
 * @private
 */
function generateInnerChartHtml(title: string, data: Array<{name: string, value: number, time: string}>, key: string, colorPalette: string[]): string {
  // 计算数据总和
  const totalValue = data.reduce((sum, item) => sum + item.value, 0);

  // 分离数据
  const smallItems = data.filter(item => (item.value / totalValue) < 0.01);
  const normalItems = data.filter(item => (item.value / totalValue) >= 0.01);

  // 限制饼图中显示的项目数量，以确保可读性
  const maxChartItems = 8;
  let chartItems = [...normalItems];
  let hasMoreNormalItems = false;

  // 如果正常项目太多，只显示前几项
  if (normalItems.length > maxChartItems) {
    chartItems = normalItems.slice(0, maxChartItems);
    hasMoreNormalItems = true;

    // 计算其他项目总和
    const othersValue = normalItems.slice(maxChartItems).reduce((sum, item) => sum + item.value, 0);
    if (othersValue > 0) {
      chartItems.push({
        name: '其他项目',
        value: othersValue,
        time: '合并显示'
      });
    }
  }

  // 合并小项
  if (smallItems.length > 0) {
    const smallItemsValue = smallItems.reduce((sum, item) => sum + item.value, 0);
    if (smallItemsValue > 0) {
      chartItems.push({
        name: '小项(<1%)',
        value: smallItemsValue,
        time: `${smallItems.length}项合并`
      });
    }
  }

  // 准备Chart.js的数据
  const chartLabels = chartItems.map(item => item.name);
  const chartValues = chartItems.map(item => item.value);

  // 调色板处理
  const chartColors = chartItems.map((item, index) => {
    if (item.name === '其他项目') return '#999999';
    if (item.name === '小项(<1%)') return '#cccccc';
    return colorPalette[index % colorPalette.length];
  });

  // 创建唯一canvas ID
  const canvasId = `chart-${Math.random().toString(36).substring(2, 9)}`;

  // 生成表格行数据
  const tableRows = chartItems.map((item, index) => {
    const colorBox = `<div style="width:10px; height:10px; background-color:${chartColors[index]}; margin-right:6px; display:inline-block;"></div>`;
    const valueText = key === 'command' ? `${item.value}次` : `${item.value}条`;
    const percentText = `${Math.round((item.value / totalValue) * 100)}%`;
    return `
      <tr>
        <td>${colorBox}${item.name}</td>
        <td>${valueText}</td>
        <td>${percentText}</td>
        ${item.name.includes('合并') ? '' : `<td>${item.time}</td>`}
      </tr>
    `;
  }).join('');

  // 显示最多几项详情
  const topItems = data.slice(0, 10);
  let hiddenItemsCount = data.length - topItems.length;

  return `
    <div class="section-title">${title}</div>
    <div class="chart-content">
      <div class="chart-area">
        <canvas id="${canvasId}"></canvas>
      </div>
      <div class="chart-details">
        <table class="detail-table" style="width:100%; border-collapse:collapse;">
          <thead>
            <tr>
              <th style="text-align:left; padding:4px; color:#666; font-weight:normal;">名称</th>
              <th style="text-align:right; padding:4px; color:#666; font-weight:normal; width:70px;">数值</th>
              <th style="text-align:right; padding:4px; color:#666; font-weight:normal; width:60px;">占比</th>
              <th style="text-align:right; padding:4px; color:#666; font-weight:normal; width:80px;">最后活动</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
        ${hiddenItemsCount > 0 ?
        `<div style="text-align:center; margin-top:8px; font-size:12px; color:#999;">
          另有 ${hiddenItemsCount} 项未显示
        </div>` : ''}
      </div>
    </div>
    <script>
      // 初始化饼图
      const ctx = document.getElementById('${canvasId}');
      new Chart(ctx, {
        type: 'pie',
        data: {
          labels: ${JSON.stringify(chartLabels)},
          datasets: [{
            data: ${JSON.stringify(chartValues)},
            backgroundColor: ${JSON.stringify(chartColors)},
            borderColor: 'white',
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function(context) {
                  const label = context.label || '';
                  const value = context.formattedValue || '';
                  const percentage = Math.round((context.raw / ${totalValue}) * 100);
                  return \`\${label}: \${value} (\${percentage}%)\`;
                }
              }
            }
          }
        }
      });
    </script>
  `;
}

/**
 * 生成内部卡片HTML（无外部容器，用于综合图表）
 * @private
 */
function generateInnerCardHtml(items: Array<{label: string, value: string|number}>): string {
  const itemsHTML = items.map(item => `
    <div class="card-item">
      <div class="item-label">${item.label}</div>
      <div class="item-value">${item.value}</div>
    </div>
  `).join('');

  return `
    <div class="section-title">统计汇总</div>
    <div class="card-items" style="display:flex; flex-wrap:wrap; gap:20px; justify-content:center;">
      ${itemsHTML}
    </div>
    <style>
      .card-item {
        background-color: #f8f9fa;
        border-radius: 8px;
        padding: 12px 20px;
        min-width: 140px;
        text-align: center;
      }
      .item-label {
        font-size: 14px;
        color: #666;
        margin-bottom: 5px;
      }
      .item-value {
        font-size: 20px;
        font-weight: bold;
        color: #333;
      }
    </style>
  `;
}
