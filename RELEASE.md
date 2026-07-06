# XK Radio Release Checklist

## Build

```powershell
npm install
node --check server.js
node --check desktop\main.js
npm run build:win
```

Expected artifacts:

```text
dist/XKRadio-版本号-Setup.exe
dist/latest.yml
dist/*.blockmap
```

## GitHub Release

Release repository:

```text
https://github.com/xk271521-droid/XK-Radio
```

Create a tag such as:

```text
v1.1.1-xk.1
```

Upload:

- `XKRadio-版本号-Setup.exe`
- `latest.yml`
- `.blockmap` file if generated
- optional SHA256 checksum file

## Auto Update

The app checks:

```text
https://api.github.com/repos/xk271521-droid/XK-Radio/releases/latest
```

For electron-builder latest.yml fallback, the app may also request:

```text
https://github.com/xk271521-droid/XK-Radio/releases/latest/download/latest.yml
```

Keep the installer filename consistent with `package.json`:

```text
XKRadio-${version}-Setup.exe
```
