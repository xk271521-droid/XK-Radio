# XK Radio AI Handoff

当前仓库是 XK Radio（小K电台）二次开发版本。

## 状态

- 本机目录：`C:\Users\xk\Desktop\中转站\Mineradio`
- 目标仓库：`https://github.com/xk271521-droid/XK-Radio.git`
- 上游来源：`https://github.com/XxHuberrr/Mineradio.git`
- 基础版本：Mineradio 1.1.1
- 协议：GPL-3.0

## 已完成的品牌改造

- 应用显示名：XK Radio
- 中文名：小K电台
- appId：com.xk.radio.desktop
- 可执行文件：XKRadio.exe
- 安装包：XKRadio-${version}-Setup.exe
- GitHub 更新源：xk271521-droid/XK-Radio
- 默认安装目录：D:\XKRadio
- 默认节奏缓存：D:\XKRadioCache\beatmaps
- 图标和安装器图片已换成 XK Radio 品牌素材

## 注意

内部 `mineradio-*` localStorage、IPC、滤镜 id、部分函数名可以保留，避免破坏用户存档、热键、登录态和旧逻辑。

不要实现批量爬取版权音乐、绕过会员/付费/DRM、重新分发第三方平台音乐内容或上传用户 Cookie 的功能。

发布前执行：

```powershell
node --check server.js
node --check desktop\main.js
npm run build:win
```
