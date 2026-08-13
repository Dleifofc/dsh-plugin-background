# dsh-plugin-background

DeepSeek Harness Web 界面背景插件：为 Web GUI 的四个界面区域绘制**按区域独立的背景**——对话区、轨迹区、侧边栏、设置页，灵感来自 VSCode 的 [`background`](https://marketplace.visualstudio.com/items?itemName=shalldie.background) 扩展。插件在**设置 → 插件**页注册自己的配置卡片（背景编辑器）。

## 功能

- **四个独立区域**：对话区 / 轨迹区 / 侧边栏 / 设置页，各自独立的媒体组
- **单一媒体组**：每组只含一种媒体——图片组像 PPT 一样轮播切换，视频组静音循环播放；不支持图片与视频混在同一组（混入的不同类型会被过滤并提示）
- **动态背景**：支持 GIF 与常见视频格式（mp4/webm 等，静音循环播放，不发出任何声音）；视频按显示模式映射 object-fit（不支持平铺，界面自动禁用）
- **每图独立显示配置**：填充 / 适应 / 拉伸 / 平铺 / 居中 / 自定义 + 详细参数（坐标 X·Y / 缩放% / 宽度 / 高度 / 重复 / 旋转° / 圆角px）
- **每图独立渲染配置**：不透明度与模糊均为每张图独立配置（非区域级）
- **预加载 + Web Animations API 交叉淡入切换**：任何图片切换（轮播、下一张、点击缩略图）都会先预加载并解码目标图片，再在两层叠层之间交叉淡入（450 ms）——不依赖 CSS transition，不受宿主样式覆盖影响。轮播会在半个间隔时提前预热下一张；若到设定时间仍未就绪，切换会等待加载完成，绝不出现切换瞬间图片缺失
- **本地图片不做 base64 打包**：选中的文件以原始字节存入 IndexedDB，通过懒创建的 object URL 显示——选择即时、无容量爆涨、刷新后保留
- 中英文界面

| | |
|---|---|
| 区域 | 对话区 / 轨迹区 / 侧边栏 / 设置页 — 各自独立的媒体组 |
| 媒体组 | 图片组像 PPT 轮播切换，视频组静音循环播放；不支持图片/视频混播 |
| 播放 | 间隔（0 = 暂停轮播，视频组则持续循环播放）、顺序/随机、下一张、n/m 位置；预加载 + 交叉淡入 |
| 图片来源 | 粘贴 URL（逗号分隔多张）、多选图片文件、或整个文件夹（不递归，仅直接子文件） |
| 持久化 | 配置存 `localStorage`；本地图片字节存 IndexedDB（`dsh-plugin-background` 库） |

## 安装

```bash
# 将 <插件仓库根>/background 替换为本插件的实际位置
dsh plugin --profile web add <插件仓库根>/background
```

然后在 profile 的补丁层挂载（`$DSH_HOME/profiles/web/cordis.patch.yml`）：

```yaml
- insert:
    - id: ui-background
      name: dsh-plugin-background
```

安装后重启一次 Web 界面。此后每次重新构建只需硬刷新（Ctrl+Shift+R）。

## 构建

```bash
npm install          # 开发依赖：esbuild + typescript
npm run build        # esbuild 打包 → lib/client.js
npm run typecheck    # tsc --noEmit
```

`src/` 为 TypeScript 源码；浏览器端被打包成单文件 module-loader bundle `lib/client.js`（构建产物，不提交仓库）。

## 使用

1. 打开 **设置 → 插件 → 背景**，展开配置卡片
2. 顶部选择要配置的区域（对话区 / 轨迹区 / 侧边栏 / 设置页）
3. 粘贴图片或视频链接（逗号分隔多张），或从本地选择图片 / 视频文件 / 整个文件夹
4. 点击缩略图进入编辑器：显示模式、详细参数、每图不透明度与模糊
5. 设置轮播间隔与顺序/随机；间隔设为 0 暂停轮播（视频组则持续循环播放）
6. 点击「启用」，该区域即显示背景

## 目录结构

```
background/
├── src/            TypeScript 源码（入口 entry.ts，服务 BackgroundService 在 service.ts）
├── lib/index.js    服务端 cordis 插件（惰性，负责挂载包）
├── lib/client.js   浏览器端 bundle（npm run build 生成）
├── docs/           界面截图
├── build.mjs       esbuild 构建脚本
└── package.json    dsh.client 元数据 + 构建脚本
```

## License

[MIT](LICENSE)
