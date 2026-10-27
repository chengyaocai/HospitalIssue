import { config } from '../config.js';
import { createDevSvcStore } from './devSvcStore.js';
import { createMssqlSvcStore } from './mssqlSvcStore.js';

let store;

// 工厂：dev 用 JSON 文件，生产用 SQL Server（模块级缓存，与 files/orgs 同款模式）。
export async function getSvcStore() {
  if (store) return store;
  store = config.dbDriver === 'dev'
    ? createDevSvcStore(config.svcDevPath)
    : createMssqlSvcStore(config.mssql);
  await store.init();
  return store;
}
