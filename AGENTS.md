# XK Radio Project Rules

本项目是 XK Radio（小K电台），基于 Mineradio 二次开发。

## 当前项目

- 本机目录：`C:\Users\xk\Desktop\中转站\Mineradio`
- 目标仓库：`https://github.com/xk271521-droid/XK-Radio.git`
- 上游来源：`https://github.com/XxHuberrr/Mineradio.git`
- 协议：GPL-3.0

## 协作规则

每次写代码前先和用户交流，问清楚需求，先制定方案，得到同意后再开始改，减少返工。

不要做批量爬取版权音乐、绕过会员/付费/DRM、重新分发第三方平台音乐内容、上传用户 Cookie 或账号信息的功能。

## 品牌规则

- 显示名称：XK Radio
- 中文名称：小K电台
- 可执行文件：XKRadio.exe
- appId：com.xk.radio.desktop
- 安装包：XKRadio-${version}-Setup.exe
- 默认安装目录：D:\XKRadio
- 更新仓库：xk271521-droid/XK-Radio

内部历史 key、IPC 名称、函数名如 `mineradio-*` 可以保留，除非确认改动不会破坏存档、登录态、热键或更新逻辑。

## UI 偏好

- 深色、精致、利落，有电蓝色品牌感。
- 按钮偏方，不要大圆角。
- 主按钮可用电蓝渐变或高质量实体色。
- 次按钮使用半透明浅底和细边框。
- 输入框 focus 使用柔和蓝色光环。
- 侧边栏要有渐层、轻雾面、hover 状态和选中态高亮边线。
- 动效控制在 180ms 到 220ms，短促、安静、不要花哨。
- 主内容区保持清晰，毛玻璃只用于顶部栏、侧边栏、浮层、筛选条和辅助信息层。

## 常用命令

```powershell
npm install
npm start
node --check server.js
node --check desktop\main.js
npm run build:win:dir
npm run build:win
```
