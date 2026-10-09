// 解密 loader 登记入口：用 `node --import ./backend/loader.mjs` 引入，注册上面的加载钩子。
// Node ≥ 20.6 走 module.register；旧版（18/19）请改用 `node --experimental-loader ./backend/loader-hooks.mjs`。
import { register } from 'node:module';

// 用绝对 URL 作为 specifier，避免相对路径二次解析出错。
register(new URL('./loader-hooks.mjs', import.meta.url).href);
