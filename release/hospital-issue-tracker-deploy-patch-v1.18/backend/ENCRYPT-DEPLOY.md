# 后端源码加密（机器指纹绑定）部署说明

> 适用场景：**防范内网程序被拷贝到其它机器后复用 / 反编译**。
> 原理：把 `backend/src` 每个 `.js` 用 **AES-256-GCM** 加密为同名 `.js.enc`，密钥 = `scrypt(本机指纹, PEPPER, 32)`。
> 运行时由自定义 ESM 加载钩子在**内存中解密**后加载，**明文永不落盘**；文件被拷到其它机器 → 指纹不符 → GCM 校验失败 → 程序拒绝启动。

## 一、涉及文件（已全部就位）
- `backend/tools/machine-id.mjs` —— 取稳定机器指纹（Windows 注册表 MachineGuid / Linux `/etc/machine-id` / macOS IOPlatformUUID）。
- `backend/tools/crypto-shared.mjs` —— 加解密核心（PEPPER 常量 + `deriveKey/encryptSource/decryptSource`）。
- `backend/tools/encrypt-src.mjs` —— 加密工具（在本机执行）。
- `backend/loader-hooks.mjs` + `backend/loader.mjs` —— 运行时解密加载钩子。
- `backend/start-enc.mjs` —— 加密态启动入口。
- `backend/package.json` 增加脚本：`start:enc` / `encrypt` / `encrypt:purge` / `encrypt:check`。

> ⚠️ **PEPPER 是编译期常量**（`crypto-shared.mjs` 顶部），与 loader 必须逐字一致。建议按机构替换为你自己的私有值；更换后需在本机重新执行加密（全体重绑）。

## 二、部署流程（在「目标机器」上执行，非开发机）
1. 像往常一样把增量补丁覆盖到目标机的 `backend/`（此时 `backend/src/*.js` 为明文）。
2. **在本机执行加密**（cwd 任意，脚本按自身位置定位 src）：
   ```bash
   # 先只加密、保留明文，便于回退验证
   node backend/tools/encrypt-src.mjs
   # 确认服务能正常启动（见第三节）后，再删除明文：
   node backend/tools/encrypt-src.mjs --purge
   # 校验所有 .enc 能在本机解密（不解压、不落盘）
   node backend/tools/encrypt-src.mjs --check
   ```
3. 之后**只用加密态启动**；明文 `.js` 已从磁盘删除，磁盘上只有 `.js.enc` 密文。

## 三、启动命令
- 从**项目根**目录执行：
  ```bash
  node --import ./backend/loader.mjs backend/start-enc.mjs
  ```
  等价地（cwd = backend/）：`npm run start:enc` 或 `node --import ./loader.mjs start-enc.mjs`。
- 端口 / 驱动 / `.env` 等环境变量与原启动完全一致（`start-enc.mjs` 直接 `import('./src/index.js')`）。
- Node 版本要求：**≥ 20.6**（用 `module.register`）。若生产仍用 Node 18/19，改为：
  ```bash
  node --experimental-loader ./backend/loader-hooks.mjs backend/start-enc.mjs
  ```

## 四、效果与边界（务必知悉）
- ✅ **防「拷到别机复用」**：`.js.enc` 离开授权机器 → 解密 GCM 校验失败 → 服务拒绝启动，不会把源码吐给攻击者。
- ✅ **明文只在内存**：磁盘上无 `.js` 明文，普通 `cat` / 直接打开都看不到源码。
- ✅ **开发 / 明文部署降级兼容**：未加密时 loader 不拦截明文，原 `node backend/start3000.mjs`、`node src/index.js`、测试套件均不受影响。
- 🟡 **不是「防本地管理员」**：对本机拥有完全权限的人（能跑进程、能 dump 内存）仍可能拿到运行期明文——这是任何客户端/服务端代码的物理极限。本方案只挡「拷贝走异地」这一最现实的内网风险。
- 🟡 **前端 bundle 不加密**：前端 JS 本就下发到每台终端浏览器（任何登录用户 DevTools 可拿），加密无意义，保持现状。
- 🟡 **`.env` 另需保管**：DB 密码、各类 token 在 `backend/.env`，不属源码加密范围；请对 `.env` 设好文件权限，并让它留在独立加固主机上（拷贝走应用、拿不到 `.env` 与数据库同样跑不起来）。
- 🔴 **迁移 / 重装系统会改指纹**：换硬件、重装系统可能令 MachineGuid 变化 → 需在本机**重新加密**（或提前备份指纹 / 用 `--check` 验证后再上线）。

## 五、回退
若加密后异常，可用开发机上的明文备份覆盖 `backend/src/*.js`，或保留的明文未被 `--purge` 删除时直接 `node backend/start3000.mjs` 明文启动。
