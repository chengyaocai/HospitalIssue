import { config } from '../config.js';
import { createDevScheduleStore } from './devScheduleStore.js';
import { createMssqlScheduleStore } from './mssqlScheduleStore.js';

let store;

// 工厂：dev 用 JSON 文件，生产用 SQL Server（模块级缓存）。
export async function getScheduleStore() {
  if (store) return store;
  store = config.dbDriver === 'dev'
    ? createDevScheduleStore(config.scheduleDevPath)
    : createMssqlScheduleStore(config.mssql);
  return store;
}
