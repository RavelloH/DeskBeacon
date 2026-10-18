# DeskBeacon npm 发布

只发布 `apps/client/dist/npm` 中的独立包，不要从 `apps/client` 直接发布：源码工作区仍引用未公开的 `@deskbeacon/protocol`。

## 构建与打包

要求 Node.js 24+、pnpm 11。首先执行 `pnpm check`、`pnpm test`、`pnpm test:local`。

Windows x64 NativeAOT 必须存在并通过 `apps/client/scripts/verify-native.mjs` 的检查。如果本机缺少 Visual Studio C++ Build Tools，可从当前 Git commit 对应的 GitHub Actions 工作流 `windows-native.yml` 下载成功构建的 `deskbeacon-windows-native-alpha` artifact；解开其中的 `deskbeacon-0.1.0.tgz`，取得 `package/native/win-x64/deskbeacon-job.exe`。不必覆盖正在运行的 Service 使用的原生文件。

```powershell
pnpm --filter @deskbeacon/protocol build
pnpm --filter deskbeacon build
$env:DESKBEACON_RELEASE_NATIVE = 'E:/DeskBeacon/.test-data/npm-release-ci/unpacked/package/native/win-x64/deskbeacon-job.exe'
node apps/client/scripts/stage-npm.mjs win-x64
New-Item -ItemType Directory -Force .test-data/npm-release-ready | Out-Null
npm pack apps/client/dist/npm --pack-destination .test-data/npm-release-ready
```

变量 `DESKBEACON_RELEASE_NATIVE` 可省略，此时必须保证 `apps/client/dist/native/win-x64/deskbeacon-job.exe` 是可用的 NativeAOT 自包含版本。

检查压缩包仅含 `cli.js`、Windows NativeAOT `exe`、`package.json`、`README.md`、`LICENSE`。通过独立目录的 `npm install --prefix <测试目录> <tgz文件>` 验证安装及 `deskbeacon version`。最后可运行 `npm publish --dry-run`，不会真正上传。

## 发布者执行

```powershell
npm login
npm whoami
npm publish .test-data/npm-release-ready/deskbeacon-0.1.0.tgz --access public
npm view deskbeacon version
```

若 npm 账号未拥有该名称，发布会失败。已发布的版本不可覆盖，后续版本需要同步修改客户端和打包版本。首次 npm 版本重点验证 Windows x64；尚未打包 Windows ARM64 进程监督程序。
