# Security

## 安装来源

XK Radio 的正式安装包只从你的 GitHub Release 分发：

https://github.com/xk271521-droid/XK-Radio/releases

推荐安装包文件名：

```text
XKRadio-版本号-Setup.exe
```

不要把 `Source code`、`.blockmap`、`latest.yml` 或 `win-unpacked` 当成正式安装包发给普通用户。

## 未签名提示

如果没有购买代码签名证书，Windows SmartScreen、浏览器或杀毒软件可能提示风险。这不等于一定有病毒，但发布时应尽量提供 SHA256 校验值，并提醒用户只从你的 Release 下载。

## 用户账号安全

XK Radio 不应收集或上传用户 Cookie。登录状态应保存在本地用户数据目录中。开发调试时不要打印完整 Cookie，也不要把日志提交到仓库。

## 漏洞处理

如果发现会泄露 Cookie、误删用户文件、错误覆盖安装目录、绕过第三方平台限制或导致远程代码执行的问题，应优先修复再发布。
